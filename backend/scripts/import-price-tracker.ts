#!/usr/bin/env tsx
/**
 * Import the price-tracker catalogue into PriceGhost.
 *
 * price-tracker (~/dev/price-tracker) is a Python + static-artifact pipeline:
 * every collection run writes `build/data.json` and commits it. That file, plus
 * the side catalogues next to it, holds ~700 tracked items with a store, a
 * price and a product URL — which is exactly a PriceGhost product list.
 *
 * READ-ONLY on price-tracker. This script only reads files and runs
 * `git -C <dir> show`/`log`, which never write. It never checks out, stashes,
 * fetches or commits anything there.
 *
 * Two things get imported:
 *
 *  1. The current catalogue — one PriceGhost product per distinct URL, with
 *     name, store, image where known, and one price_history point dated from
 *     that row's `data_coleta`.
 *
 *  2. Real price history (--history) — each commit that touched
 *     `build/data.json` is one collection run, so walking the git log of that
 *     one file reconstructs a genuine per-URL price series instead of starting
 *     every product from a single point. 46 runs were available on 06/11/2026.
 *
 * Usage:
 *   npx tsx scripts/import-price-tracker.ts                   # dry run
 *   npx tsx scripts/import-price-tracker.ts --write
 *   npx tsx scripts/import-price-tracker.ts --write --history
 *   npx tsx scripts/import-price-tracker.ts --from /path/to/price-tracker
 *   npx tsx scripts/import-price-tracker.ts --user me@example.com
 *
 * Needs the backend to have booted once, so index.ts has run its migrations.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import pool from '../src/config/database';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const WRITE = flag('write');
const WITH_HISTORY = flag('history');
const SOURCE_DIR = path.resolve(
  opt('from') || process.env.PRICE_TRACKER_DIR || path.join(process.env.HOME || '', 'dev/price-tracker')
);
const USER_EMAIL = opt('user');

// ---------------------------------------------------------------------------
// What counts as a store
// ---------------------------------------------------------------------------

/** Editorial, spec and video sources. Real links, but nothing to price-track. */
const NON_STORE_HOSTS = [
  'tweakers.net',
  'techspot.com',
  'kitguru.net',
  'hardwareluxx.de',
  'computerbase.de',
  'pcgamer.com',
  'nvidianews.nvidia.com',
  'nvidia.com',
  'youtube.com',
  'youtu.be',
  'images.apple.com',
  'apple.com',
  'hardwarebarato.com',
];

/**
 * Stores PriceGhost cannot currently scrape. Imported anyway — the owner's
 * catalogue should not lose rows silently — but created paused, so the
 * scheduler does not spend a browser launch failing on them every hour.
 *
 * Facebook Marketplace is login-gated and has no stable product URL;
 * Magazine Luiza answers 403 to every path tried; Shopee serves an anti-bot
 * payload instead of its price API. See docs/LOJAS-BR.md.
 */
const PAUSED_HOSTS = ['facebook.com', 'magazineluiza.com.br', 'magalu.com', 'shopee.com.br'];

/**
 * Default check interval in seconds: one collection run per day, for every
 * store. This matches the price-tracker's own cadence (a manual round per day
 * at most) and keeps the daily scrape volume predictable: one pass over the
 * catalogue, not four. Per-product overrides stay available in the UI.
 */
const INTERVAL_DAILY = 24 * 3600;

const SIDE_CATALOGS = [
  'suplementos.json',
  'reforma.json',
  'ar_condicionado.json',
  'raquetes.json',
  'academia.json',
];

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface Item {
  url: string;
  name: string;
  store: string | null;
  price: number;
  category: string | null;
  collectedAt: string | null;
  inStock: boolean | null;
  source: string;
}

type Json = Record<string, unknown>;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function matchesHost(url: string, list: string[]): boolean {
  const host = hostOf(url);
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v) && v > 0) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.'));
    if (isFinite(n) && n > 0) return n;
  }
  return null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Normalize to ISO. price-tracker writes both `2026-11-04` (per-row
 * `data_coleta`) and `04/11/2026` (the top-level `coleta`), and handing the
 * latter to Postgres would read it as April 11 under the default MDY
 * datestyle.
 */
function normalizeDate(v: string | null): string | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const br = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!br) return null;
  const year = br[3].length === 2 ? `20${br[3]}` : br[3];
  return `${year}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
}

/** ISO date from price-tracker's date fields, which vary by catalogue. */
function asDate(o: Json): string | null {
  for (const key of ['data_coleta', 'preco_data', 'data']) {
    const iso = normalizeDate(asString(o[key]));
    if (iso) return iso;
  }
  return null;
}

function asStock(o: Json): boolean | null {
  const raw = o.estoque ?? o.status;
  if (typeof raw === 'boolean') return raw;
  const s = asString(raw);
  if (!s) return null;
  if (/^(sim|true|em estoque|dispon)/i.test(s)) return true;
  if (/^(n[ãa]o|false|esgotad|indispon|sem estoque)/i.test(s)) return false;
  return null;
}

function nameOf(o: Json): string | null {
  const parts = [
    asString(o.modelo),
    asString(o.produto),
    asString(o.nome),
    asString(o.name),
    [asString(o.marca), asString(o.modelo)].filter(Boolean).join(' ') || null,
    asString(o.titulo),
  ];
  const best = parts.find((p) => p && p.length > 2);
  return best || null;
}

/**
 * Walk any of price-tracker's JSON files and pull out every object that is a
 * priced, linked item. Deliberately shape-agnostic: the catalogues differ
 * (`precos[]`, `itens[].opcoes[]`, `produtos[]`, `ofertas[]`, …) and new tabs
 * get added without notice, so matching on the FIELDS rather than the path
 * means a new tab is picked up for free.
 */
function extractItems(root: unknown, source: string, fallbackDate: string | null): Item[] {
  const out: Item[] = [];

  const visit = (node: unknown, trail: string) => {
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, `${trail}[]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = node as Json;

    const url = asString(o.url);
    const price = asNumber(o.preco ?? o.price ?? o.total);
    const name = nameOf(o);

    if (url && url.startsWith('http') && price !== null && name) {
      if (!matchesHost(url, NON_STORE_HOSTS)) {
        out.push({
          url: url.split('#')[0],
          name,
          store: asString(o.loja) ?? asString(o.vendedor) ?? null,
          price,
          category:
            asString(o.tipo) ?? asString(o.categoria) ?? asString(o.cat) ?? asString(o.etapa) ?? null,
          collectedAt: asDate(o) ?? fallbackDate,
          inStock: asStock(o),
          source: `${source}${trail}`,
        });
      }
    }

    for (const [key, value] of Object.entries(o)) visit(value, `${trail}.${key}`);
  };

  visit(root, '');
  return out;
}

function readJson(file: string): unknown | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`  ! could not parse ${path.basename(file)}: ${(e as Error).message}`);
    return null;
  }
}

/** Latest row per URL wins; a URL repeats across tabs and collection runs. */
function dedupe(items: Item[]): Item[] {
  const byUrl = new Map<string, Item>();
  for (const item of items) {
    const prev = byUrl.get(item.url);
    if (!prev) {
      byUrl.set(item.url, item);
      continue;
    }
    const a = prev.collectedAt || '';
    const b = item.collectedAt || '';
    if (b >= a) byUrl.set(item.url, item);
  }
  return [...byUrl.values()];
}

// ---------------------------------------------------------------------------
// git history
// ---------------------------------------------------------------------------

function git(args: string[]): string {
  return execFileSync('git', ['-C', SOURCE_DIR, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

interface HistoryPoint {
  url: string;
  price: number;
  date: string;
}

/**
 * One collection run per commit that touched build/data.json. Several commits
 * on the same day are the same run being corrected, so the last one of each
 * day wins — the same rule price-tracker's own build/historico_git.py uses.
 */
function collectHistory(): HistoryPoint[] {
  let log: string;
  try {
    log = git(['log', '--reverse', '--format=%H|%ad', '--date=short', '--', 'build/data.json']);
  } catch (e) {
    console.warn(`  ! git log failed, skipping history: ${(e as Error).message.split('\n')[0]}`);
    return [];
  }

  const perDay = new Map<string, string>();
  for (const line of log.split('\n').filter(Boolean)) {
    const [hash, date] = line.split('|');
    if (hash && date) perDay.set(date, hash);
  }

  const points: HistoryPoint[] = [];
  const dates = [...perDay.keys()].sort();
  for (const date of dates) {
    const hash = perDay.get(date)!;
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(git(['show', `${hash}:build/data.json`]));
    } catch {
      continue;
    }
    // Each snapshot's own `data_coleta` values can lag the commit; the commit
    // date is when that run actually landed, so it is what we date points by.
    for (const item of extractItems(snapshot, 'git', date)) {
      points.push({ url: item.url, price: item.price, date });
    }
  }
  console.log(`  ${dates.length} collection runs in git → ${points.length} raw history points`);
  return points;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

async function resolveUserId(): Promise<number> {
  if (USER_EMAIL) {
    const r = await pool.query('SELECT id FROM users WHERE email = $1', [USER_EMAIL]);
    if (!r.rows.length) throw new Error(`No PriceGhost user with email ${USER_EMAIL}`);
    return r.rows[0].id as number;
  }
  const r = await pool.query(
    'SELECT id, email FROM users ORDER BY is_admin DESC NULLS LAST, id ASC LIMIT 1'
  );
  if (!r.rows.length) {
    throw new Error('No users in the database yet. Register one in the UI first, then re-run.');
  }
  console.log(`  importing as user ${r.rows[0].email} (id ${r.rows[0].id}) — override with --user`);
  return r.rows[0].id as number;
}

async function assertSchema(): Promise<void> {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'products' AND column_name IN ('checking_paused', 'stock_status')`
  );
  const have = new Set(r.rows.map((x) => x.column_name as string));
  const missing = ['checking_paused', 'stock_status'].filter((c) => !have.has(c));
  if (missing.length) {
    throw new Error(
      `products table is missing ${missing.join(', ')}. Start the backend once ` +
        '(npm run dev) so its migrations run, then re-run this import.'
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`price-tracker → PriceGhost import${WRITE ? '' : '  (DRY RUN)'}`);
  console.log(`  source: ${SOURCE_DIR}`);

  const buildDir = path.join(SOURCE_DIR, 'build');
  if (!fs.existsSync(buildDir)) {
    throw new Error(`No build/ directory under ${SOURCE_DIR}. Pass --from <price-tracker dir>.`);
  }

  // --- read the catalogue -------------------------------------------------
  const raw: Item[] = [];

  const dataJson = readJson(path.join(buildDir, 'data.json')) as Json | null;
  if (dataJson) {
    const runDate = normalizeDate(asString(dataJson.coleta));
    const items = extractItems(dataJson, 'data.json', runDate);
    console.log(`  data.json: ${items.length} priced items (run ${runDate ?? 'unknown'})`);
    raw.push(...items);
  }

  for (const file of SIDE_CATALOGS) {
    const parsed = readJson(path.join(buildDir, file)) as Json | null;
    if (!parsed) continue;
    const items = extractItems(parsed, file, normalizeDate(asString(parsed.data)));
    console.log(`  ${file}: ${items.length} priced items`);
    raw.push(...items);
  }

  const items = dedupe(raw);

  const byStore = new Map<string, number>();
  for (const item of items) {
    const key = hostOf(item.url);
    byStore.set(key, (byStore.get(key) || 0) + 1);
  }
  const pausedCount = items.filter((i) => matchesHost(i.url, PAUSED_HOSTS)).length;

  console.log(
    `\n  ${raw.length} rows → ${items.length} distinct products across ${byStore.size} hosts`
  );
  console.log(`  ${pausedCount} will be created paused (store not scrapeable)`);
  console.log('\n  top hosts:');
  for (const [host, n] of [...byStore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    const tag = matchesHost(`https://${host}/`, PAUSED_HOSTS) ? '  [paused]' : '';
    console.log(`    ${String(n).padStart(4)}  ${host}${tag}`);
  }

  // --- history ------------------------------------------------------------
  let history: HistoryPoint[] = [];
  if (WITH_HISTORY) {
    console.log('\n  reconstructing price history from git...');
    history = collectHistory();
    const urls = new Set(items.map((i) => i.url));
    const before = history.length;
    history = history.filter((p) => urls.has(p.url));
    console.log(`  ${history.length} points match a current product (dropped ${before - history.length} for URLs no longer tracked)`);
  }

  if (!WRITE) {
    console.log('\n  dry run — nothing written. Re-run with --write (add --history for the git series).');
    await pool.end();
    return;
  }

  // --- write --------------------------------------------------------------
  await assertSchema();
  const userId = await resolveUserId();

  const client = await pool.connect();
  let created = 0;
  let updated = 0;
  let pricePoints = 0;

  try {
    await client.query('BEGIN');

    const idByUrl = new Map<string, number>();

    for (const [index, item] of items.entries()) {
      const paused = matchesHost(item.url, PAUSED_HOSTS);
      const interval = INTERVAL_DAILY;
      const stock =
        item.inStock === true ? 'in_stock' : item.inStock === false ? 'out_of_stock' : 'unknown';

      // Spread the first check evenly over the interval instead of making the
      // whole catalogue due at once. Importing ~550 products with
      // next_check_at = now turns the next backend boot into one multi-hour
      // burst against every store; spread, it is roughly one product every
      // two minutes, forever, which is what the daily interval means.
      const firstCheckOffset = Math.round((index / Math.max(items.length, 1)) * interval);

      const res = await client.query(
        `INSERT INTO products (user_id, url, name, refresh_interval, stock_status, checking_paused, next_check_at)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP + ($7 || ' seconds')::interval)
         ON CONFLICT (user_id, url) DO UPDATE
           SET name = COALESCE(EXCLUDED.name, products.name),
               stock_status = EXCLUDED.stock_status
         RETURNING id, (xmax = 0) AS inserted`,
        [userId, item.url, item.name.slice(0, 255), interval, stock, paused, firstCheckOffset]
      );
      const row = res.rows[0];
      idByUrl.set(item.url, row.id as number);
      if (row.inserted) created++;
      else updated++;

      // Current price, dated from the collection run that produced it.
      const at = item.collectedAt;
      const inserted = await client.query(
        `INSERT INTO price_history (product_id, price, currency, recorded_at)
         SELECT $1, $2, 'BRL', COALESCE($3::date, CURRENT_TIMESTAMP)
         WHERE NOT EXISTS (
           SELECT 1 FROM price_history
            WHERE product_id = $1
              AND price = $2
              AND recorded_at::date = COALESCE($3::date, CURRENT_DATE)
         )`,
        [row.id, item.price, at]
      );
      pricePoints += inserted.rowCount ?? 0;
    }

    for (const point of history) {
      const productId = idByUrl.get(point.url);
      if (!productId) continue;
      const inserted = await client.query(
        `INSERT INTO price_history (product_id, price, currency, recorded_at)
         SELECT $1, $2, 'BRL', $3::date
         WHERE NOT EXISTS (
           SELECT 1 FROM price_history
            WHERE product_id = $1 AND recorded_at::date = $3::date
         )`,
        [productId, point.price, point.date]
      );
      pricePoints += inserted.rowCount ?? 0;
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  console.log(
    `\n  done: ${created} products created, ${updated} updated, ${pricePoints} price points written`
  );
  await pool.end();
}

main().catch((e) => {
  console.error(`\nimport failed: ${(e as Error).message}`);
  process.exit(1);
});
