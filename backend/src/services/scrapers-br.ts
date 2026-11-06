/**
 * Site-specific scrapers for Brazilian retailers.
 *
 * Why a separate module: the upstream `siteScrapers` array in scraper.ts is
 * tuned for US/EU stores and is already 650 lines. These entries are
 * PREPENDED to it (see scraper.ts) because the upstream Amazon matcher,
 * /amazon\.(com|co\.uk|...)/, also matches `amazon.com.br` — a BR entry has to
 * win the `.find()` when it wants to.
 *
 * ACCESS MATRIX — measured 06/11/2026 against live product pages.
 * See docs/LOJAS-BR.md for the full write-up.
 *
 *   store            plain HTTP        puppeteer-stealth   logged WSL profile
 *   Kabum            OK                OK                  OK
 *   Terabyte         403 (Cloudflare)  OK                  OK
 *   Pichau           403 (Cloudflare)  OK                  OK
 *   Mercado Livre    account-verif.    redirect loop       OK
 *   Amazon .com.br   bot wall          bot wall            OK
 *   OLX              403 (Cloudflare)  OK                  OK
 *   Shopee           JS shell, no $    anti-bot payload    anti-bot payload
 *   Magazine Luiza   403               403                 403  (unsupported)
 *
 * TWO PRICES PER PRODUCT, AND JSON-LD PICKS THE WRONG ONE. Brazilian stores
 * quote a cash price ("à vista", usually with a PIX/boleto discount) and a
 * higher card/installment total ("no cartão" / "em até 12x").
 * price-tracker's convention, which this follows, is that THE price is the
 * à vista/PIX one.
 *
 * Measured 06/11/2026, the stores do not agree on which one goes into
 * structured data:
 *
 *   Terabyte  JSON-LD 2599.99 == à vista 2599.99          (agrees)
 *   Pichau    JSON-LD 2082.34 vs à vista 1769.99          (card total)
 *   OLX       JSON-LD "7800"  vs displayed 7700           (stale after an edit)
 *
 * So on a BR page the site-specific extractor is the MORE reliable source,
 * not the less — the opposite of the upstream assumption, where JSON-LD is
 * ranked highest. scraper.ts therefore scores a BR site-specific candidate
 * above JSON-LD (see BR_SITE_CONFIDENCE).
 *
 * These scrapers deliberately return a SINGLE price, the à vista one, and do
 * not fill `allPrices` with the card total. Emitting both made the card total
 * appear twice — once from here, once from JSON-LD — and findPriceConsensus()
 * lets the larger group win, so the wrong price won on vote count. The card
 * total still reaches the voting modal on its own, through JSON-LD.
 */

import type { Cheerio, CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { parsePrice, type DecimalHint, type ParsedPrice } from '../utils/priceParser';

export type StockStatus = 'in_stock' | 'out_of_stock' | 'unknown';

export interface BrScrapeResult {
  name?: string | null;
  /** The à vista / PIX price. Single on purpose — see the note above. */
  price?: ParsedPrice | null;
  imageUrl?: string | null;
  stockStatus?: StockStatus;
}

export interface BrSiteScraper {
  /** Short store label, matching the `loja` values used by price-tracker. */
  store: string;
  match: (url: string) => boolean;
  scrape: ($: CheerioAPI, url: string) => BrScrapeResult;
}

/**
 * Confidence for a BR site-specific candidate, deliberately above the 0.9 the
 * JSON-LD extractor uses. On a Brazilian store page JSON-LD systematically
 * carries the installment total (Pichau) or a figure left stale by an edit
 * (OLX), while these scrapers target the advertised cash price.
 */
export const BR_SITE_CONFIDENCE = 0.95;

/** Hosts that only answer a real browser (Cloudflare / bot walls). */
export const BR_BROWSER_SITES: RegExp[] = [
  /terabyteshop\.com\.br/i,
  /pichau\.com\.br/i,
  /amazon\.com\.br/i,
  /mercadolivre\.com\.br/i,
  /mercadolibre\.com/i,
  /olx\.com\.br/i,
  /shopee\.com\.br/i,
];

/**
 * Hosts that need a browser carrying a real, logged-in profile — a clean
 * stealth profile is not enough. Point PUPPETEER_USER_DATA_DIR at the
 * persistent WSL Chrome profile (~/.config/chromium-wsl) for these.
 */
export const BR_LOGGED_PROFILE_SITES: RegExp[] = [
  /amazon\.com\.br/i,
  /mercadolivre\.com\.br/i,
  /mercadolibre\.com/i,
];

/**
 * Per-host element to wait for before reading the HTML. Some BR pages paint a
 * price into the layout well after networkidle2 and after OTHER R$ strings are
 * already on the page, so a generic "any R$ text" wait finishes too early.
 *
 * OLX is the measured case: the secondary "R$ 7.800" line
 * (.typo-body-medium) renders before the headline .typo-display-large price,
 * so without this the scraper fell back to the JSON-LD offer, which on an
 * edited ad is stale (7800 vs the live 7700).
 */
export const BR_WAIT_SELECTORS: Array<{ re: RegExp; selector: string }> = [
  // OLX is responsive and renames the headline price class by breakpoint:
  // .typo-display-large under ~1000px, .typo-title-large at desktop width.
  { re: /olx\.com\.br/i, selector: '.typo-display-large, .typo-title-large' },
  { re: /pichau\.com\.br/i, selector: '[class*="price_vista"]' },
  { re: /terabyteshop\.com\.br/i, selector: '#valVista' },
];

export function brWaitSelector(url: string): string | null {
  return BR_WAIT_SELECTORS.find((w) => w.re.test(url))?.selector ?? null;
}

/** Hosts measured as not reachable by any path available here. */
export const BR_UNSUPPORTED_SITES: Array<{ re: RegExp; reason: string }> = [
  {
    re: /magazineluiza\.com\.br|magalu\.com/i,
    reason:
      'Magazine Luiza answers 403 to plain HTTP, to puppeteer-stealth and to the logged WSL profile alike. No scraping path found on 06/11/2026.',
  },
];

export function brStoreFor(url: string): string | null {
  return brSiteScrapers.find((s) => s.match(url))?.store ?? null;
}

export function brUnsupportedReason(url: string): string | null {
  return BR_UNSUPPORTED_SITES.find((s) => s.re.test(url))?.reason ?? null;
}

/**
 * Does this page say the product is gone?
 *
 * A Brazilian store rotates product slugs (Pichau and Kabum both do), so a
 * tracked URL goes 404 eventually — and a 404 page is not empty: Pichau serves
 * its "Página não encontrada" with a full carousel of recommended products,
 * each one carrying a `price_vista` element. Read naively, a dead URL returns
 * a confident wrong price (measured: R$ 249,99 from a recommendation on the
 * 404 page of a R$ 1.769,99 processor) and that price lands in the history as
 * if it were a crash. Checked on the title, which every platform sets.
 */
const PT_NOT_FOUND = [
  /\b404\b/,
  /p[áa]gina n[ãa]o encontrada/i,
  /produto n[ãa]o encontrado/i,
  /n[ãa]o encontrad[oa]/i,
  /page not found/i,
];

export function brPageNotFound($: CheerioAPI): boolean {
  const title = ($('title').first().text() || '').trim();
  if (!title) return false;
  return PT_NOT_FOUND.some((re) => re.test(title));
}

/**
 * Number and currency convention of a page, for the generic extractors.
 *
 * The six stores in `brSiteScrapers` are the measured ones, but a catalogue
 * imported from price-tracker spans 53 Brazilian hosts: supplement shops,
 * Leroy Merlin, Decathlon, music stores. Those fall through to `generic-css`,
 * which called `parsePrice` with no hint and read the `$` inside `R$` as a
 * dollar sign — the same trap `priceParser.ts` fixes for `R$` itself. Result:
 * a correct number labelled USD, on roughly half the catalogue.
 *
 * Decided from the host (`.com.br`, `.br`) and from `<html lang>`, so a
 * Brazilian store on a `.com` domain is still read as pt-BR.
 */
export function pageLocale(
  $: CheerioAPI,
  url: string
): { hint?: DecimalHint; currency: string } {
  let brazilian = /\.com\.br(\/|$|:)/i.test(url) || /\.br(\/|$|:)/i.test(url);
  if (!brazilian) {
    const lang = $('html').attr('lang');
    brazilian = !!lang && lang.toLowerCase().startsWith('pt');
  }
  return brazilian ? { hint: 'comma', currency: 'BRL' } : { currency: 'USD' };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Parse a pt-BR price string; dot is always the thousands separator. */
function brl(text: string | undefined | null): ParsedPrice | null {
  if (!text) return null;
  const parsed = parsePrice(text, 'comma');
  if (!parsed) return null;
  return { price: parsed.price, currency: 'BRL' };
}

function num(value: unknown): ParsedPrice | null {
  const n = typeof value === 'string' ? parseFloat(value) : (value as number);
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return null;
  return { price: Math.round(n * 100) / 100, currency: 'BRL' };
}

/** First non-empty trimmed text for any of the selectors. */
function firstText($: CheerioAPI, selectors: string[]): string | null {
  for (const sel of selectors) {
    const t = $(sel).first().text().trim();
    if (t) return t;
  }
  return null;
}

/**
 * First element matching any selector whose text actually parses as a BRL
 * price. Needed because semantic class matching catches labels as well as
 * values: Pichau's [class*="price_vista"] matches the literal text "à vista"
 * (class `…-price_vista_text-…`) before it reaches the number
 * (class `…-price_vista-…`).
 */
function firstPrice(
  $: CheerioAPI,
  selectors: string[],
  scope?: Cheerio<Element>
): ParsedPrice | null {
  for (const sel of selectors) {
    const matches = scope ? scope.find(sel).toArray() : $(sel).toArray();
    for (const el of matches) {
      const text = $(el).text().trim();
      // "15% de desconto no PIX" sits in a price element and parses as 15.
      // A percentage is not a price; a string carrying both ("R$ 329,99 no
      // PIX com 15% desconto") still is, so only skip when there is no R$.
      if (text.includes('%') && !text.includes('R$')) continue;
      const parsed = brl(text);
      if (parsed) return parsed;
    }
  }
  return null;
}

/**
 * The block of the page that describes THIS product.
 *
 * Needed because a storefront's price classes are reused by every card in its
 * "quem viu também viu" carousel, and the carousel is usually earlier in the
 * DOM than the product itself: reading document-wide, `.product-price .price`
 * returned R$ 5.391,00 — another product entirely — for a R$ 2.789,10
 * interface, with the top confidence in the system behind it.
 *
 * Anchored on the <h1>: climb from the title to the first ancestor that also
 * contains a "R$" and treat that as the product block. Falls back to <body>
 * when the page has no h1 or no price near it, in which case only the
 * à vista/PIX selectors are trusted — never the broad ones.
 */
function productScope($: CheerioAPI): { scope: Cheerio<Element>; narrow: boolean } {
  const h1 = $('h1').first();
  let el = h1.parent();
  for (let i = 0; i < 7 && el.length && el.get(0)?.tagName !== 'body'; i++) {
    if (/R\$\s?\d/.test(el.text())) {
      return { scope: el as Cheerio<Element>, narrow: false };
    }
    el = el.parent();
  }
  return { scope: $('body') as Cheerio<Element>, narrow: true };
}

function readJsonScript($: CheerioAPI, selector: string): unknown | null {
  const raw = $(selector).first().html();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * pt-BR stock wording. Brazilian stores say "Produto indisponível",
 * "Esgotado", "Avise-me quando chegar" — none of which the upstream
 * English-only matchers catch.
 */
const PT_OUT_OF_STOCK = [
  'produto indisponível',
  'produto indisponivel',
  'indisponível',
  'indisponivel',
  'esgotado',
  'sem estoque',
  'fora de estoque',
  'avise-me quando chegar',
  'avise-me',
  'me avise quando chegar',
  'produto esgotado',
  'anúncio pausado',
  'anuncio pausado',
  'sem anúncios ativos',
];

const PT_IN_STOCK = [
  'em estoque',
  'disponível',
  'disponivel',
  'comprar agora',
  'adicionar ao carrinho',
  'adicionar à sacola',
  'comprar',
  'estoque disponível',
];

export function brStockStatusFromText(text: string): StockStatus {
  const t = text.toLowerCase();
  if (PT_OUT_OF_STOCK.some((w) => t.includes(w))) return 'out_of_stock';
  if (PT_IN_STOCK.some((w) => t.includes(w))) return 'in_stock';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Kabum — plain HTTP is enough. Price lives in __NEXT_DATA__.
// ---------------------------------------------------------------------------

interface KabumProduct {
  title?: string;
  price?: number;
  prices?: { price?: number; priceWithDiscount?: number; oldPrice?: number };
  available?: boolean;
  thumbnail?: string;
  sellerName?: string;
  installment?: { installment?: number; amount?: number };
}

const kabum: BrSiteScraper = {
  store: 'Kabum',
  match: (url) => /(^|\/\/|\.)kabum\.com\.br/i.test(url),
  scrape: ($) => {
    const next = readJsonScript($, 'script#__NEXT_DATA__') as
      | { props?: { pageProps?: { product?: KabumProduct } } }
      | null;
    const p = next?.props?.pageProps?.product;

    if (p) {
      // priceWithDiscount is the à vista price Kabum advertises; `price` is
      // the pre-discount one. NEVER read `installment.amount` — that is the
      // per-instalment figure (R$ 176,20 on a R$ 1.762,00 product) and it is
      // exactly the trap generic CSS extraction falls into here.
      const vista = num(p.prices?.priceWithDiscount ?? p.price);
      const full = num(p.prices?.price);
      return {
        name: p.title ?? null,
        price: vista,
        imageUrl: p.thumbnail ?? null,
        stockStatus: p.available === true ? 'in_stock' : p.available === false ? 'out_of_stock' : 'unknown',
      };
    }

    // Fallback if Kabum drops __NEXT_DATA__
    const vista = firstPrice($, ['[class*="finalPrice"]', '[class*="priceCard"] h4', 'h4[class*="price"]']);
    return {
      name: $('h1').first().text().trim() || null,
      price: vista,
      imageUrl: $('meta[property="og:image"]').attr('content') ?? null,
      stockStatus: brStockStatusFromText($('body').text()),
    };
  },
};

// ---------------------------------------------------------------------------
// Terabyte — Cloudflare, needs a browser. #valVista is the PIX price and it
// agrees with the JSON-LD offer; #valParc is the card total.
// ---------------------------------------------------------------------------

const terabyte: BrSiteScraper = {
  store: 'Terabyte',
  match: (url) => /terabyteshop\.com\.br/i.test(url),
  scrape: ($) => {
    const vista = firstPrice($, ['#valVista', '.val-prod']);
    const parc = firstPrice($, ['#valParc', '.valParc']);
    const name =
      $('h1.tit-prod').first().text().trim() ||
      $('h1').first().text().trim() ||
      null;
    const bodyText = $('.tbt-prod, #estoque, .prod-stock, body').first().text();

    return {
      name,
      price: vista,
      imageUrl:
        $('#imgProduto img').first().attr('src') ||
        $('meta[property="og:image"]').attr('content') ||
        null,
      stockStatus: brStockStatusFromText(bodyText),
    };
  },
};

// ---------------------------------------------------------------------------
// Pichau — Cloudflare, needs a browser. MUI class names are build-hashed
// (`mui-1jk88bq-price_vista-extraSpacePriceVista`), so we match on the stable
// semantic suffix via [class*=]. The JSON-LD offer is the CARD total here, not
// the à vista price — which is why this scraper exists at all.
// ---------------------------------------------------------------------------

const pichau: BrSiteScraper = {
  store: 'Pichau',
  match: (url) => /pichau\.com\.br/i.test(url),
  scrape: ($) => {
    const vista = firstPrice($, ['[class*="price_vista"]']);
    const total = firstPrice($, ['[class*="price_total"]']);
    return {
      name: $('h1').first().text().trim() || null,
      price: vista ?? total,
      imageUrl: $('meta[property="og:image"]').attr('content') ?? null,
      stockStatus: brStockStatusFromText($('body').text()),
    };
  },
};

// ---------------------------------------------------------------------------
// Mercado Livre — needs the logged-in profile; a clean profile gets bounced to
// /gz/account-verification. With it, the JSON-LD Product offer is clean and
// carries priceCurrency BRL + availability.
// ---------------------------------------------------------------------------

interface MlOffer {
  price?: number | string;
  priceCurrency?: string;
  availability?: string;
}

const mercadoLivre: BrSiteScraper = {
  store: 'Mercado Livre',
  match: (url) => /mercadolivre\.com\.br|mercadolibre\.com/i.test(url),
  scrape: ($) => {
    let jsonLdPrice: ParsedPrice | null = null;
    let name: string | null = null;
    let image: string | null = null;
    let stock: StockStatus = 'unknown';

    $('script[type="application/ld+json"]').each((_, el) => {
      if (jsonLdPrice) return;
      let data: unknown;
      try {
        data = JSON.parse($(el).html() || '');
      } catch {
        return;
      }
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const o = item as { '@type'?: string; name?: string; image?: unknown; offers?: MlOffer | MlOffer[] };
        if (!o?.offers) continue;
        const offer = Array.isArray(o.offers) ? o.offers[0] : o.offers;
        const p = num(offer?.price);
        if (!p) continue;
        jsonLdPrice = p;
        name = o.name ?? null;
        if (typeof o.image === 'string') image = o.image;
        else if (Array.isArray(o.image) && typeof o.image[0] === 'string') image = o.image[0] as string;
        const avail = String(offer?.availability || '').toLowerCase();
        if (avail.includes('instock')) stock = 'in_stock';
        else if (avail.includes('outofstock') || avail.includes('soldout')) stock = 'out_of_stock';
        break;
      }
    });

    // DOM fallback: ML splits the price into an integer and a cents span, so
    // reading text alone gives "72" and "90" separately. itemprop="price"
    // carries the whole number.
    const metaPrice = num($('[itemprop="price"]').first().attr('content'));
    const fraction = $('.andes-money-amount__fraction').first().text().replace(/\./g, '');
    const cents = $('.andes-money-amount__cents').first().text();
    const domPrice =
      metaPrice ?? (fraction ? num(`${fraction}.${cents || '00'}`) : null);

    if (stock === 'unknown') {
      stock = brStockStatusFromText($('.ui-pdp-buybox, .ui-pdp-container, body').first().text());
    }

    return {
      name: name ?? $('h1.ui-pdp-title').first().text().trim() ?? null,
      price: jsonLdPrice ?? domPrice,
      imageUrl: image ?? $('meta[property="og:image"]').attr('content') ?? null,
      stockStatus: stock,
    };
  },
};

// ---------------------------------------------------------------------------
// OLX — classifieds, needs a browser (Cloudflare on plain HTTP). Measured
// 06/11/2026: the displayed price and the JSON-LD offer DISAGREE on edited ads
// (ad 1538940901 showed R$ 7.700 in the DOM and "7800" in JSON-LD). The DOM
// figure is the live one, so it is the only one returned here; the JSON-LD
// figure still reaches the voting modal through the JSON-LD extractor, so the
// discrepancy is surfaced rather than hidden.
//
// OLX ads EXPIRE. A dead ad renders a real 200 page titled "Anúncio não
// encontrado" — reported here as out_of_stock rather than as a scrape failure.
// ---------------------------------------------------------------------------

const olx: BrSiteScraper = {
  store: 'OLX',
  match: (url) => /olx\.com\.br/i.test(url),
  scrape: ($) => {
    const pageText = $('body').text();
    const gone = /an[úu]ncio n[ãa]o encontrado|an[úu]ncio (?:foi )?(?:exclu[íi]do|encerrado|removido)/i.test(
      pageText
    );

    // OLX omits cents: "R$ 7.700" is seven thousand seven hundred.
    // OLX renames the headline price class by breakpoint — .typo-display-large
    // on narrow viewports, .typo-title-large at desktop width (measured
    // 06/11/2026 at 800px vs 1920px on the same ad). Both are listed; the
    // secondary "original price" line is .typo-body-medium and is left out on
    // purpose, since on a reduced ad it is the HIGHER, stale figure.
    const domPrice = firstPrice($, [
      '.typo-display-large',
      '.typo-title-large',
      '[class*="typo-display-large"]',
      '[class*="typo-title-large"]',
      'h2[class*="price"]',
    ]);

    let ldPrice: ParsedPrice | null = null;
    let name: string | null = null;
    let image: string | null = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (ldPrice) return;
      try {
        const o = JSON.parse($(el).html() || '') as {
          name?: string;
          image?: Array<{ contentUrl?: string }> | string;
          offers?: { price?: string | number };
        };
        const p = num(o?.offers?.price);
        if (!p) return;
        ldPrice = p;
        name = o.name ?? null;
        if (Array.isArray(o.image)) image = o.image[0]?.contentUrl ?? null;
        else if (typeof o.image === 'string') image = o.image;
      } catch {
        /* not the product block */
      }
    });

    return {
      name: name ?? $('h1').first().text().trim() ?? null,
      price: gone ? null : domPrice ?? ldPrice,
      imageUrl: image ?? $('meta[property="og:image"]').attr('content') ?? null,
      stockStatus: gone ? 'out_of_stock' : domPrice || ldPrice ? 'in_stock' : 'unknown',
    };
  },
};

// ---------------------------------------------------------------------------
// Shopee — the product page is a JS shell with no price in the HTML at all,
// and the PDP API (/api/v4/pdp/get_pc) answers 403 to a direct fetch: it wants
// an anti-bot signature header the page computes. The only path that works is
// letting the page call its own API and capturing the response.
//
// scrapeWithBrowser() injects any captured payload back into the HTML as
// <script id="__SHOPEE_PDP__" type="application/json">, which is what this
// reads. Without that tag there is nothing to extract and we return {} so the
// AI fallback gets a turn.
//
// Shopee quotes prices in micro-units (price * 100000).
// ---------------------------------------------------------------------------

const SHOPEE_PRICE_SCALE = 100000;

const shopee: BrSiteScraper = {
  store: 'Shopee',
  match: (url) => /shopee\.com\.br/i.test(url),
  scrape: ($) => {
    const payload = readJsonScript($, 'script#__SHOPEE_PDP__') as
      | { data?: { item?: Record<string, unknown> } | Record<string, unknown> }
      | null;
    const data = payload?.data as Record<string, unknown> | undefined;
    const item = ((data?.item as Record<string, unknown>) ?? data) as Record<string, unknown> | undefined;
    if (!item) return {};

    const scaled = (v: unknown) => {
      const n = typeof v === 'number' ? v : NaN;
      if (!isFinite(n) || n <= 0) return null;
      return num(n / SHOPEE_PRICE_SCALE);
    };

    const price = scaled(item.price) ?? scaled(item.price_min);
    const stockRaw = item.stock ?? item.normal_stock;
    const stock = typeof stockRaw === 'number' ? stockRaw : null;

    return {
      name: typeof item.title === 'string' ? item.title : null,
      price,
      imageUrl: typeof item.image === 'string' ? `https://down-br.img.susercontent.com/file/${item.image}` : null,
      stockStatus: stock === null ? 'unknown' : stock > 0 ? 'in_stock' : 'out_of_stock',
    };
  },
};

/** Parse Shopee's shop_id / item_id out of a product URL slug (…-i.<shop>.<item>). */
export function shopeeIds(url: string): { shopId: string; itemId: string } | null {
  const m = url.match(/-i\.(\d+)\.(\d+)/);
  return m ? { shopId: m[1], itemId: m[2] } : null;
}

// ---------------------------------------------------------------------------
// Smaller BR shops that price-tracker already tracks and that serve a usable
// JSON-LD offer or an obvious à vista element. Grouped because they share the
// same shape: Nuvemshop / VTEX / Shopify storefronts.
// ---------------------------------------------------------------------------

const brGenericStorefront: BrSiteScraper = {
  store: 'Loja BR (genérica)',
  match: (url) =>
    /(^|\/\/|\.)(decathlon\.com\.br|netshoes\.com\.br|leroymerlin\.com\.br|telhanorte\.com\.br|upliftfitness\.com\.br|ropestore\.com\.br|wct\.com\.br|equipamentoslinefitness\.com\.br|focuseletronicos\.com\.br|ateliedosom\.com\.br|musiccompany\.com\.br|lojashure\.com\.br|uaudiobrasil\.com\.br|madeinbrazil\.com\.br|showpoint\.com\.br|brasiltronic\.com\.br|horizonplay\.com\.br|waz\.com\.br|mimilon\.com\.br|prospin\.com\.br|planetabeachsports\.com\.br|courtstore\.com\.br|oficinadotenista\.com\.br|bottchertenis\.com\.br|maxtitanium\.com\.br|vitafor\.com\.br|essentialnutrition\.com\.br|duxhumanhealth\.com|3vsnutrition\.com\.br|integralmedica\.com\.br|gsuplementos\.com\.br|setyou\.com\.br|unicpharma\.com\.br|mejoy\.com\.br|drogariaultra\.com|beneplaca\.com\.br|colai\.com\.br)/i.test(
      url
    ),
  scrape: ($, url) => {
    // Prefer an explicit à vista / PIX element, then JSON-LD, then meta tags.
    //
    // Measured on five of these stores (06/11/2026): the à vista element in the
    // product block is the price the owner tracks (focuseletronicos 2789.10
    // where JSON-LD says 3099 — the card total; ateliedosom 1422), and where
    // there is no such element JSON-LD or the og meta is right (uaudiobrasil
    // 1899, musiccompany 2554.44, lojashure 1099). Hence this order.
    const { scope, narrow } = productScope($);
    const vistaSelectors = [
      '[class*="pix" i] [class*="price" i]',
      '[class*="pix" i]',
      '[class*="vista" i]',
      '[data-price-type="finalPrice"]',
    ];
    // Only inside a real product block: these match carousel cards too.
    const blockSelectors = ['.price__current', '.product-price .price', '.current-price'];
    const vista = firstPrice($, narrow ? vistaSelectors : [...vistaSelectors, ...blockSelectors], scope);

    let ld: ParsedPrice | null = null;
    let name: string | null = null;
    let image: string | null = null;
    let stock: StockStatus = 'unknown';
    $('script[type="application/ld+json"]').each((_, el) => {
      if (ld) return;
      try {
        const data = JSON.parse($(el).html() || '');
        for (const item of Array.isArray(data) ? data : [data]) {
          const o = item as {
            '@type'?: string;
            name?: string;
            image?: unknown;
            offers?: { price?: number | string; lowPrice?: number | string; priceCurrency?: string; availability?: string } | Array<{ price?: number | string; availability?: string }>;
          };
          if (!o?.offers) continue;
          const offer = Array.isArray(o.offers) ? o.offers[0] : o.offers;
          const p = num(offer?.price ?? (offer as { lowPrice?: number }).lowPrice);
          if (!p) continue;
          ld = p;
          name = o.name ?? null;
          if (typeof o.image === 'string') image = o.image;
          const avail = String(offer?.availability || '').toLowerCase();
          if (avail.includes('instock')) stock = 'in_stock';
          else if (avail.includes('outofstock') || avail.includes('soldout')) stock = 'out_of_stock';
          break;
        }
      } catch {
        /* skip */
      }
    });

    const meta = brl($('meta[property="product:price:amount"]').attr('content'));

    if (stock === 'unknown') stock = brStockStatusFromText($('body').text());

    const price = vista ?? ld ?? meta;
    if (!price) return {};

    return {
      name: name ?? $('h1').first().text().trim() ?? null,
      price,
      imageUrl: image ?? $('meta[property="og:image"]').attr('content') ?? null,
      stockStatus: stock,
      ...(url ? {} : {}),
    };
  },
};

export const brSiteScrapers: BrSiteScraper[] = [
  kabum,
  terabyte,
  pichau,
  mercadoLivre,
  olx,
  shopee,
  brGenericStorefront,
];
