import axios, { AxiosError } from 'axios';
import { load, type CheerioAPI } from 'cheerio';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import {
  parsePrice,
  ParsedPrice,
  findMostLikelyPrice,
} from '../utils/priceParser';
import {
  brSiteScrapers,
  brStockStatusFromText,
  brPageNotFound,
  brStoreFor,
  pageLocale,
  brUnsupportedReason,
  brWaitSelector,
  shopeeIds,
  BR_SITE_CONFIDENCE,
  BR_BROWSER_SITES,
  BR_LOGGED_PROFILE_SITES,
} from './scrapers-br';

// Add stealth plugin to avoid bot detection (Cloudflare, etc.)
puppeteer.use(StealthPlugin());

export type StockStatus = 'in_stock' | 'out_of_stock' | 'unknown';

// Extraction method types for multi-strategy voting
export type ExtractionMethod = 'json-ld' | 'site-specific' | 'generic-css' | 'ai';

// Price candidate from a single extraction method
export interface PriceCandidate {
  price: number;
  currency: string;
  method: ExtractionMethod;
  context?: string; // Text around the price for user context
  confidence: number; // 0-1 confidence score
}

// Extended scrape result with candidates for voting
export interface ScrapedProductWithCandidates {
  name: string | null;
  price: ParsedPrice | null;
  imageUrl: string | null;
  url: string;
  stockStatus: StockStatus;
  aiStatus: 'verified' | 'corrected' | null;
  priceCandidates: PriceCandidate[];
  needsReview: boolean;
  selectedMethod?: ExtractionMethod; // Which method was used for final price
}

// Check if two prices are "close enough" to be considered the same (within 5%)
function pricesMatch(price1: number, price2: number): boolean {
  if (price1 === price2) return true;
  const diff = Math.abs(price1 - price2);
  const avg = (price1 + price2) / 2;
  return (diff / avg) < 0.05; // Within 5%
}

// Find consensus among price candidates
function findPriceConsensus(candidates: PriceCandidate[]): { price: PriceCandidate | null; hasConsensus: boolean; groups: PriceCandidate[][] } {
  if (candidates.length === 0) return { price: null, hasConsensus: false, groups: [] };
  if (candidates.length === 1) return { price: candidates[0], hasConsensus: true, groups: [[candidates[0]]] };

  // Group prices that match
  const groups: PriceCandidate[][] = [];
  for (const candidate of candidates) {
    let foundGroup = false;
    for (const group of groups) {
      if (pricesMatch(candidate.price, group[0].price)) {
        group.push(candidate);
        foundGroup = true;
        break;
      }
    }
    if (!foundGroup) {
      groups.push([candidate]);
    }
  }

  // Sort groups by size (most votes first), then by confidence
  groups.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    const avgConfA = a.reduce((sum, c) => sum + c.confidence, 0) / a.length;
    const avgConfB = b.reduce((sum, c) => sum + c.confidence, 0) / b.length;
    return avgConfB - avgConfA;
  });

  const largestGroup = groups[0];
  // Consensus if majority agrees (>= 50% of methods) OR if top group has significantly more votes
  const hasConsensus = largestGroup.length >= Math.ceil(candidates.length / 2) ||
                       (groups.length > 1 && largestGroup.length > groups[1].length);

  // Pick the highest confidence candidate from the winning group
  const winner = largestGroup.sort((a, b) => b.confidence - a.confidence)[0];

  return { price: winner, hasConsensus, groups };
}

// Number/currency convention of the page being parsed, from pageLocale().
// Threaded into every extractor that has to guess a currency: the fallback
// used to be a hardcoded 'USD', which mislabelled every Brazilian store
// outside scrapers-br.ts — and the imported price-tracker catalogue spans 53
// Brazilian hosts, only six of which have a site-specific scraper.
type PageLocale = ReturnType<typeof pageLocale>;

/**
 * Currency named by the text around a price, else the page's own.
 * 'R$' is tested before the bare symbols because it contains '$' — the same
 * ordering priceParser.ts depends on.
 */
function currencyFromText(sources: Array<string | undefined>, locale: PageLocale): string {
  for (const source of sources) {
    if (!source) continue;
    if (/R\$/.test(source)) return 'BRL';
    const codeMatch = source.match(/\b(BRL|CHF|EUR|GBP|USD|CAD|AUD|JPY|INR)\b/i);
    if (codeMatch) return codeMatch[1].toUpperCase();
    const symbolMatch = source.match(/([$€£¥₹])/);
    if (symbolMatch) {
      const symbolMap: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };
      return symbolMap[symbolMatch[1]] || locale.currency;
    }
  }
  return locale.currency;
}

// Extract price candidates from JSON-LD structured data
function extractJsonLdCandidates($: CheerioAPI, locale: PageLocale): PriceCandidate[] {
  const candidates: PriceCandidate[] = [];
  try {
    const scripts = $('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length; i++) {
      const content = $(scripts[i]).html();
      if (!content) continue;

      const data = JSON.parse(content) as JsonLdProduct | JsonLdProduct[];
      const product = findProduct(data);

      if (product?.offers) {
        const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
        const priceValue = offer.lowPrice || offer.price || offer.priceSpecification?.price;
        const currency = offer.priceCurrency || offer.priceSpecification?.priceCurrency || locale.currency;

        if (priceValue) {
          const price = parseFloat(String(priceValue));
          if (!isNaN(price) && price > 0) {
            candidates.push({
              price,
              currency,
              method: 'json-ld',
              context: `Structured data: ${product.name || 'Product'}`,
              confidence: 0.9, // JSON-LD is highly reliable
            });
          }
        }
      }
    }
  } catch (_e) {
    // JSON parse error
  }
  return candidates;
}

// Extract price candidates from site-specific scraper
function extractSiteSpecificCandidates($: CheerioAPI, url: string, locale: PageLocale): { candidates: PriceCandidate[]; name: string | null; imageUrl: string | null; stockStatus: StockStatus } {
  const candidates: PriceCandidate[] = [];
  let name: string | null = null;
  let imageUrl: string | null = null;
  let stockStatus: StockStatus = 'unknown';

  const siteScraper = siteScrapers.find((s) => s.match(url));
  if (siteScraper) {
    const siteResult = siteScraper.scrape($, url) as {
      price?: ParsedPrice | null;
      name?: string | null;
      imageUrl?: string | null;
      stockStatus?: StockStatus;
      allPrices?: ParsedPrice[];  // Some scrapers return multiple prices (e.g., Amazon)
    };

    // A Brazilian store's structured data routinely carries the installment
    // total (Pichau) or a figure left stale by a seller edit (OLX) rather than
    // the advertised cash price, so there the site-specific extractor outranks
    // JSON-LD's 0.9 instead of sitting below it. See services/scrapers-br.ts.
    const brStore = brStoreFor(url);
    const confidence = brStore ? BR_SITE_CONFIDENCE : 0.85;
    const context = brStore
      ? `${brStore} extractor (preço à vista)`
      : `Site-specific extractor for ${new URL(url).hostname}`;

    // Amazon .com.br is read by the upstream Amazon scraper, which calls
    // parsePrice with no locale: a price written without "R$" in its element
    // comes back labelled USD (measured: a USD 1711 candidate next to the
    // correct BRL 1625.45 on the same page). Nothing priced in dollars is sold
    // on a .com.br storefront, so on a Brazilian page the label is corrected
    // rather than carried into the price-selection modal.
    const currencyFor = (c: string) => (locale.currency === 'BRL' && c === 'USD' ? 'BRL' : c);

    // If scraper returned multiple prices, add them all as candidates
    if (siteResult.allPrices && siteResult.allPrices.length > 0) {
      for (const p of siteResult.allPrices) {
        candidates.push({
          price: p.price,
          currency: currencyFor(p.currency),
          method: 'site-specific',
          context,
          confidence,
        });
      }
    } else if (siteResult.price) {
      // Single price result
      candidates.push({
        price: siteResult.price.price,
        currency: currencyFor(siteResult.price.currency),
        method: 'site-specific',
        context,
        confidence,
      });
    }
    name = siteResult.name || null;
    imageUrl = siteResult.imageUrl || null;
    stockStatus = siteResult.stockStatus || 'unknown';
  }

  return { candidates, name, imageUrl, stockStatus };
}

// Extract price candidates from generic CSS selectors
function extractGenericCssCandidates($: CheerioAPI, locale: PageLocale): PriceCandidate[] {
  const candidates: PriceCandidate[] = [];
  const seen = new Set<number>();

  // Hard cap on how many guesses this method may contribute.
  //
  // Why: findPriceConsensus() groups candidates by value and lets the biggest
  // group win. A broad selector like [class*="price" i] matches every card in
  // a "recommended products" carousel — measured at 35 candidates on a single
  // Brazilian store page — and three unrelated carousel prices that happen to
  // land within 5% of each other then form a group of 3 that outvotes the
  // JSON-LD and site-specific candidates, which sit in groups of 1. The result
  // is a confident, wrong price from a product the user is not tracking.
  //
  // The outer `candidates.length >= 3` break below only ran BETWEEN selectors,
  // after .each() had already pushed every match for the current one.
  const MAX_GENERIC_CANDIDATES = 3;

  for (const selector of genericPriceSelectors) {
    const elements = $(selector);
    elements.each((_, el) => {
      if (candidates.length >= MAX_GENERIC_CANDIDATES) return false;
      const $el = $(el);
      // Skip if this looks like an "original" or "was" price
      const classAttr = $el.attr('class') || '';
      const parentClass = $el.parent().attr('class') || '';
      if (/original|was|old|regular|compare|strikethrough|line-through/i.test(classAttr + parentClass)) {
        return;
      }

      // Check various attributes where price might be stored
      const priceAmount = $el.attr('data-price-amount');
      const dataPrice = $el.attr('data-price');
      const content = $el.attr('content');
      const text = $el.text();

      let parsed: ParsedPrice | null = null;
      let context = selector;

      // Try data-price-amount first (Magento stores numeric value here)
      if (priceAmount) {
        const price = parseFloat(priceAmount);
        if (!isNaN(price) && price > 0) {
          const currency = currencyFromText(
            [text, $el.parent().text(), $el.closest('.price-box').text()],
            locale
          );
          parsed = { price, currency };
          context = `data-price-amount attribute`;
        }
      }

      if (!parsed) {
        const priceStr = content || dataPrice || text;
        parsed = parsePrice(priceStr, locale.hint, locale.currency);
        if (parsed) {
          context = text.trim().slice(0, 50);
        }
      }

      if (parsed && parsed.price > 0 && !seen.has(parsed.price)) {
        seen.add(parsed.price);
        candidates.push({
          price: parsed.price,
          currency: parsed.currency,
          method: 'generic-css',
          context,
          confidence: 0.6, // Generic CSS is less reliable
        });
      }
    });

    // Only take first few generic candidates to avoid noise
    if (candidates.length >= MAX_GENERIC_CANDIDATES) break;
  }

  return candidates;
}

// Browser-based scraping for sites that block HTTP requests (e.g., Cloudflare)
async function scrapeWithBrowser(url: string): Promise<string> {
  // Amazon .com.br and Mercado Livre refuse a clean stealth profile but serve
  // a browser carrying a real, logged-in one. Point PUPPETEER_USER_DATA_DIR at
  // that profile (on this machine: ~/.config/chromium-wsl) to unlock them.
  const userDataDir = process.env.PUPPETEER_USER_DATA_DIR || undefined;
  // Brazilian stores serve a different (and sometimes en-US formatted) page
  // when the client does not ask for pt-BR. OLX in particular renders a
  // different component tree — its headline price element never appears when
  // navigator.language is en-US — so the locale has to be set at launch, not
  // only through the Accept-Language header.
  const isBrazilian = /\.com\.br(\/|$|:)/i.test(url) || /\.br\//i.test(url);
  const needsLoggedProfile = BR_LOGGED_PROFILE_SITES.some((re) => re.test(url));
  // Not a problem when driving a browser over CDP: that one carries its own
  // profile, which is the point of connecting to it.
  if (needsLoggedProfile && !userDataDir && !process.env.PUPPETEER_CDP_URL) {
    console.warn(
      `[Browser] ${new URL(url).hostname} normally requires a logged-in browser profile. ` +
        'Set PUPPETEER_USER_DATA_DIR to avoid a bot wall.'
    );
  }

  // A Chrome already running on a profile holds an exclusive lock on its
  // directory, so launching a second one against the same PUPPETEER_USER_DATA_DIR
  // aborts with "Failed to create SingletonLock: File exists" — which is how
  // this fails whenever the owner has that browser open. Set PUPPETEER_CDP_URL
  // to the running browser's debugging endpoint (`chrome-wsl --cdp` exposes
  // http://127.0.0.1:9222) and the scraper drives that browser instead of
  // launching its own, with the same logged-in session and no conflict.
  const cdpUrl = process.env.PUPPETEER_CDP_URL;
  const browser = cdpUrl
    ? await puppeteer.connect({ browserURL: cdpUrl })
    : await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--disable-crash-reporter',
          '--window-size=1920,1080',
          '--start-maximized',
          ...(userDataDir ? ['--password-store=basic'] : []),
          ...(isBrazilian ? ['--lang=pt-BR'] : []),
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        userDataDir,
        ignoreDefaultArgs: ['--enable-automation'],
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (/SingletonLock|ProcessSingleton/i.test(message)) {
          throw new Error(
            `Chrome is already running on ${userDataDir ?? 'this profile'}; one Chrome per ` +
              'profile directory. Close it, or set PUPPETEER_CDP_URL to drive the running ' +
              'one (chrome-wsl --cdp). Original error: ' +
              message
          );
        }
        throw error;
      });

  let page: Awaited<ReturnType<typeof browser.newPage>> | null = null;
  try {
    page = await browser.newPage();

    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    if (isBrazilian) {
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' });
    }

    // Shopee renders no price into the HTML at all and its PDP API rejects a
    // direct fetch (403 without the anti-bot signature header the page
    // computes). Capture the page's own call and splice the payload back into
    // the HTML, where the Shopee site scraper reads it.
    const shopee = shopeeIds(url);
    // Held in an object so TypeScript does not narrow it to `never`: it is
    // only ever assigned from inside the response listener.
    const capture: { pdp: string | null } = { pdp: null };
    if (shopee) {
      page.on('response', (response) => {
        if (capture.pdp) return;
        if (!/\/api\/v4\/pdp\/get_pc/.test(response.url())) return;
        if (response.status() !== 200) return;
        void response
          .text()
          .then((body) => {
            if (body && (body.includes('"item"') || body.includes('"price"'))) {
              capture.pdp = body;
            }
          })
          .catch(() => undefined);
      });
    }

    // Navigate to the page and wait for content to load
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 45000,
    });

    // Add some human-like behavior
    await page.mouse.move(100, 200);
    await new Promise(resolve => setTimeout(resolve, 500));
    await page.mouse.move(300, 400);

    // Wait for Cloudflare challenge to complete if present
    // Check if we're on a challenge page and wait for it to resolve
    const maxWaitTime = 20000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const title = await page.title();
      // Cloudflare challenge pages have titles like "Just a moment..."
      if (!title.toLowerCase().includes('just a moment') &&
          !title.toLowerCase().includes('checking your browser')) {
        break;
      }
      console.log(`[Browser] Waiting for Cloudflare challenge to complete... (${title})`);
      // Move mouse randomly while waiting
      await page.mouse.move(
        100 + Math.random() * 500,
        100 + Math.random() * 400
      );
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Scroll down a bit like a human would
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    await page.evaluate('window.scrollBy(0, 300)');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Brazilian stores render the price after networkidle2 resolves — OLX in
    // particular paints the headline price late enough that page.content()
    // would capture the page without it. Wait for a "R$ 1.234,56"-shaped
    // string to show up, then give the layout one more tick.
    if (isBrazilian) {
      const waitSelector = brWaitSelector(url);
      try {
        if (waitSelector) {
          await page.waitForSelector(waitSelector, { timeout: 15000 });
        } else {
          // Passed as a string: the backend tsconfig has no DOM lib, same
          // reason the scroll below is a string too.
          await page.waitForFunction(
            '/R\\$\\s?\\d{1,3}(\\.\\d{3})*(,\\d{2})?/.test((document.body && document.body.innerText) || "")',
            { timeout: 10000, polling: 500 }
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 800));
      } catch {
        console.warn(
          `[Browser] ${new URL(url).hostname}: price element did not appear` +
            (waitSelector ? ` (${waitSelector})` : '') +
            '; reading the page as-is.'
        );
      }
    }

    if (shopee) {
      // Shopee's PDP XHR lands well after networkidle2 (measured ~8-14s), and
      // the page can be bounced to /verify/traffic/error before it does. Nudge
      // the page and wait for the capture BEFORE reading the HTML.
      await page.evaluate('window.scrollBy(0, 600)').catch(() => undefined);
      for (let i = 0; i < 18 && !capture.pdp; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // Get the full HTML content
    let html = await page.content();

    if (shopee) {
      if (capture.pdp) {
        const safe = capture.pdp.replace(/<\/script/gi, '<\\/script');
        html = html.replace(
          '</body>',
          `<script id="__SHOPEE_PDP__" type="application/json">${safe}</script></body>`
        );
      } else {
        console.warn(`[Browser] Shopee PDP API response not captured for ${url}`);
      }
    }

    return html;
  } finally {
    // A browser we connected to belongs to the owner: close only our own tab
    // and let go of it. One we launched is ours to close.
    if (cdpUrl) {
      await page?.close().catch(() => undefined);
      await browser.disconnect();
    } else {
      await browser.close();
    }
  }
}

export type AIStatus = 'verified' | 'corrected' | null;

export interface ScrapedProduct {
  name: string | null;
  price: ParsedPrice | null;
  imageUrl: string | null;
  url: string;
  stockStatus: StockStatus;
  aiStatus: AIStatus;
}

// Site-specific scraper configurations
interface SiteScraper {
  match: (url: string) => boolean;
  scrape: ($: CheerioAPI, url: string) => Partial<Omit<ScrapedProduct, 'url'>>;
}

const siteScrapers: SiteScraper[] = [
  // Brazilian retailers first: the Amazon matcher below also matches
  // `amazon.com.br`, and several BR stores quote a cash ("à vista") price that
  // the generic extractors would miss. See services/scrapers-br.ts.
  ...brSiteScrapers,

  // Amazon
  {
    match: (url) => /amazon\.(com|co\.uk|ca|de|fr|es|it|co\.jp|in|com\.au)/i.test(url),
    scrape: ($) => {
      // Helper to check if element is inside a coupon/savings container
      const isInCouponContainer = (el: ReturnType<typeof $>) => {
        const parents = el.parents().toArray();
        for (const parent of parents) {
          const id = $(parent).attr('id') || '';
          const className = $(parent).attr('class') || '';
          const text = $(parent).text().toLowerCase();
          if (/coupon|savings|save\s*\$|clipcoupon|promoprice/i.test(id + className)) {
            return true;
          }
          // Check if the immediate container mentions "save" or "coupon"
          if (text.includes('save $') || text.includes('coupon') || text.includes('clip')) {
            // Only consider it a coupon if it's a small container
            if (text.length < 100) return true;
          }
        }
        return false;
      };

      // Collect ALL prices found on the page (for variant/seller support)
      const allPrices: ParsedPrice[] = [];
      const seenPrices = new Set<number>();

      const addPrice = (parsed: ParsedPrice | null) => {
        if (parsed && parsed.price >= 2 && !seenPrices.has(parsed.price)) {
          seenPrices.add(parsed.price);
          allPrices.push(parsed);
        }
      };

      // 1. Main buy box price
      const primaryPriceContainers = [
        '#corePrice_feature_div',
        '#corePriceDisplay_desktop_feature_div',
        '#apex_desktop_newAccordionRow',
        '#apex_offerDisplay_desktop',
      ];

      let mainPrice: ParsedPrice | null = null;

      for (const containerId of primaryPriceContainers) {
        const container = $(containerId);
        if (!container.length) continue;

        const priceElements = container.find('.a-price .a-offscreen');

        for (let i = 0; i < priceElements.length; i++) {
          const el = $(priceElements[i]);
          if (isInCouponContainer(el)) continue;

          const parentClass = el.parent().attr('class') || '';
          if (/savings|coupon|save/i.test(parentClass)) continue;

          const text = el.text().trim();
          const parsed = parsePrice(text);

          if (parsed && parsed.price >= 2) {
            if (!mainPrice) mainPrice = parsed;
            addPrice(parsed);
          }
        }
      }

      // 2. "Other Sellers" / "New & Used" prices
      // Look for "Other Sellers on Amazon" section
      const otherSellersSelectors = [
        '#aod-offer-price .a-offscreen',  // "All Offers" display
        '#olp-upd-new .a-color-price',     // "New from $X"
        '#olp-upd-used .a-color-price',    // "Used from $X"
        '#usedBuySection .a-color-price',
        '#newBuySection .a-color-price',
        '.olp-from-new-price',
        '.olp-from-used-price',
        '#buyNew_noncbb .a-color-price',   // "Buy New" non-buy-box
      ];

      for (const selector of otherSellersSelectors) {
        $(selector).each((_, el) => {
          const text = $(el).text().trim();
          addPrice(parsePrice(text));
        });
      }

      // 3. "New & Used from $X" link text
      const newUsedLink = $('#usedAndNewBuySection, #newUsedBuyBox, [id*="olp"]').text();
      const newUsedMatch = newUsedLink.match(/\$[\d,]+\.?\d*/g);
      if (newUsedMatch) {
        for (const priceStr of newUsedMatch) {
          addPrice(parsePrice(priceStr));
        }
      }

      // 4. Subscribe & Save price
      const snsPrice = $('#subscribeAndSavePrice, #sns-price, .sns-price-block .a-offscreen').first().text();
      if (snsPrice) {
        addPrice(parsePrice(snsPrice));
      }

      // 5. Fallback selectors
      const fallbackSelectors = [
        '#priceblock_dealprice',
        '#priceblock_saleprice',
        '#priceblock_ourprice',
        '#price_inside_buybox',
        '#newBuyBoxPrice',
        'span[data-a-color="price"] .a-offscreen',
      ];

      for (const selector of fallbackSelectors) {
        const el = $(selector).first();
        if (el.length && !isInCouponContainer(el)) {
          const text = el.text().trim();
          const parsed = parsePrice(text);
          if (parsed && parsed.price >= 2) {
            if (!mainPrice) mainPrice = parsed;
            addPrice(parsed);
          }
        }
      }

      // 6. Whole/fraction price format
      if (!mainPrice) {
        const whole = $('#corePrice_feature_div .a-price-whole').first().text().replace(',', '');
        const fraction = $('#corePrice_feature_div .a-price-fraction').first().text();
        if (whole) {
          const priceStr = `$${whole}${fraction ? '.' + fraction : ''}`;
          const parsed = parsePrice(priceStr);
          if (parsed && parsed.price >= 2) {
            mainPrice = parsed;
            addPrice(parsed);
          }
        }
      }

      // Use main price as the primary, but we've collected all prices for candidate matching
      const price = mainPrice;

      // Log what we found for debugging
      if (allPrices.length > 1) {
        console.log(`[Amazon] Found ${allPrices.length} prices: ${allPrices.map(p => p.price).join(', ')}`);
      }

      // Product name
      const name = $('#productTitle').text().trim() ||
                   $('h1.a-size-large').text().trim() ||
                   null;

      // Image
      const imageUrl = $('#landingImage').attr('src') ||
                       $('#imgBlkFront').attr('src') ||
                       $('img[data-a-dynamic-image]').attr('src') ||
                       null;

      // Stock status detection
      let stockStatus: StockStatus = 'unknown';
      const availabilityText = $('#availability').text().toLowerCase();
      const outOfStockDiv = $('#outOfStock').length > 0;
      const unavailableText = $('body').text().toLowerCase();

      if (
        outOfStockDiv ||
        availabilityText.includes('currently unavailable') ||
        availabilityText.includes('out of stock') ||
        availabilityText.includes('not available') ||
        ($('#add-to-cart-button').length === 0 && $('#buy-now-button').length === 0)
      ) {
        if (
          unavailableText.includes('currently unavailable') ||
          unavailableText.includes("we don't know when or if this item will be back in stock") ||
          outOfStockDiv ||
          availabilityText.includes('out of stock')
        ) {
          stockStatus = 'out_of_stock';
        }
      } else if (
        availabilityText.includes('in stock') ||
        availabilityText.includes('available') ||
        $('#add-to-cart-button').length > 0
      ) {
        stockStatus = 'in_stock';
      }

      return { name, price, imageUrl, stockStatus, allPrices };
    },
  },

  // Walmart
  {
    match: (url) => /walmart\.com/i.test(url),
    scrape: ($) => {
      let price: ParsedPrice | null = null;
      let name: string | null = null;
      let imageUrl: string | null = null;
      let stockStatus: StockStatus = 'unknown';

      // Walmart embeds product data in a __NEXT_DATA__ script tag
      try {
        const nextDataScript = $('#__NEXT_DATA__').html();
        if (nextDataScript) {
          const nextData = JSON.parse(nextDataScript);
          const productData = nextData?.props?.pageProps?.initialData?.data?.product ||
                              nextData?.props?.pageProps?.initialProps?.data?.product;

          if (productData) {
            // Get price from embedded data
            const priceInfo = productData.priceInfo?.currentPrice ||
                              productData.priceInfo?.priceRange?.minPrice;
            if (priceInfo) {
              price = {
                price: typeof priceInfo.price === 'number' ? priceInfo.price : parseFloat(priceInfo.price),
                currency: priceInfo.currencyCode || 'USD',
              };
            }

            // Get name
            name = productData.name || null;

            // Get image
            imageUrl = productData.imageInfo?.thumbnailUrl ||
                       productData.imageInfo?.allImages?.[0]?.url ||
                       null;

            // Get stock status
            const availability = productData.availabilityStatus ||
                                 productData.fulfillment?.availabilityStatus;
            if (availability) {
              const availLower = availability.toLowerCase();
              if (availLower === 'in_stock' || availLower === 'available') {
                stockStatus = 'in_stock';
              } else if (availLower === 'out_of_stock' || availLower === 'not_available') {
                stockStatus = 'out_of_stock';
              }
            }
          }
        }
      } catch (_e) {
        // JSON parse error, fall back to HTML scraping
      }

      // Fallback: Try HTML selectors if __NEXT_DATA__ didn't work
      if (!price) {
        const priceSelectors = [
          '[itemprop="price"]',
          '[data-testid="price-wrap"] span[class*="price"]',
          '.price-characteristic',
          '[data-automation="product-price"]',
          'span[data-automation-id="product-price"]',
        ];

        for (const selector of priceSelectors) {
          const el = $(selector).first();
          if (el.length) {
            const content = el.attr('content');
            const text = content || el.text().trim();
            price = parsePrice(text);
            if (price) break;
          }
        }
      }

      // Fallback: Try price from whole dollars + cents pattern
      if (!price) {
        const priceText = $('[itemprop="price"]').attr('content');
        if (priceText) {
          price = parsePrice(priceText);
        }
      }

      if (!name) {
        name = $('h1[itemprop="name"]').text().trim() ||
               $('h1#main-title').text().trim() ||
               $('[data-testid="product-title"]').text().trim() ||
               null;
      }

      if (!imageUrl) {
        imageUrl = $('[data-testid="hero-image-container"] img').attr('src') ||
                   $('img[data-testid="hero-image"]').attr('src') ||
                   $('meta[property="og:image"]').attr('content') ||
                   null;
      }

      // Fallback stock status from HTML if not found
      if (stockStatus === 'unknown') {
        const addToCartBtn = $('[data-testid="add-to-cart-button"]').length > 0 ||
                             $('button[aria-label*="Add to cart"]').length > 0;
        const outOfStockText = $('[data-testid="out-of-stock-message"]').length > 0 ||
                               $('body').text().toLowerCase().includes('out of stock');

        if (addToCartBtn) {
          stockStatus = 'in_stock';
        } else if (outOfStockText) {
          // Only mark as out of stock if we're confident
          const bodyText = $('body').text().toLowerCase();
          // Check specifically for this product being out of stock
          if (bodyText.includes('this item is currently out of stock') ||
              bodyText.includes('this product is currently unavailable') ||
              $('[data-testid="out-of-stock-message"]').length > 0) {
            stockStatus = 'out_of_stock';
          }
        }
      }

      return { name, price, imageUrl, stockStatus };
    },
  },

  // Best Buy
  {
    match: (url) => /bestbuy\.com/i.test(url),
    scrape: ($) => {
      const priceSelectors = [
        '[data-testid="customer-price"] span',
        '.priceView-customer-price span',
        '.priceView-hero-price span',
        '[class*="customerPrice"]',
        '[class*="priceView"] span[aria-hidden="true"]',
        '.pricing-price__regular-price',
        '[data-testid="product-price"]',
        '.price-box span',
      ];

      let price: ParsedPrice | null = null;
      for (const selector of priceSelectors) {
        const elements = $(selector);
        console.log(`[BestBuy] Selector "${selector}" found ${elements.length} elements`);
        // Check each element, skip payment plan prices (contain "/mo", "per month", etc.)
        elements.each((_, el) => {
          if (price) return false; // Already found a valid price
          const text = $(el).text().trim();
          if (!text) return true;
          console.log(`[BestBuy] Found text: "${text.slice(0, 50)}"`);
          const lowerText = text.toLowerCase();
          // Skip if it looks like a monthly payment plan
          if (lowerText.includes('/mo') ||
              lowerText.includes('per month') ||
              lowerText.includes('monthly') ||
              lowerText.includes('financing') ||
              lowerText.includes('payment')) {
            console.log(`[BestBuy] Skipping payment plan price: "${text.slice(0, 30)}"`);
            return true; // Continue to next element
          }
          const parsed = parsePrice(text);
          if (parsed) {
            console.log(`[BestBuy] Parsed price: ${parsed.price} ${parsed.currency}`);
            price = parsed;
            return false; // Break the loop
          }
        });
        if (price) break;
      }

      const name = $('h1.heading-5').text().trim() ||
                   $('.sku-title h1').text().trim() ||
                   $('[data-testid="product-title"]').text().trim() ||
                   $('h1').first().text().trim() ||
                   null;
      console.log(`[BestBuy] Found name: "${name?.slice(0, 50)}"`);

      const imageUrl = $('img.primary-image').attr('src') ||
                       $('[data-testid="image-gallery-image"]').attr('src') ||
                       $('img[class*="product-image"]').attr('src') ||
                       null;

      console.log(`[BestBuy] Final result - name: ${!!name}, price: ${price ? (price as ParsedPrice).price : null}, image: ${!!imageUrl}`);
      return { name, price, imageUrl };
    },
  },

  // Target
  {
    match: (url) => /target\.com/i.test(url),
    scrape: ($) => {
      const priceSelectors = [
        '[data-test="product-price"]',
        '[data-test="current-price"]',
        '.styles__CurrentPriceFontSize-sc-1qc6t3e-1',
      ];

      let price: ParsedPrice | null = null;
      for (const selector of priceSelectors) {
        const el = $(selector).first();
        if (el.length) {
          price = parsePrice(el.text().trim());
          if (price) break;
        }
      }

      const name = $('[data-test="product-title"]').text().trim() ||
                   $('h1[class*="Heading"]').text().trim() ||
                   null;

      const imageUrl = $('[data-test="image-gallery-item-0"] img').attr('src') ||
                       null;

      return { name, price, imageUrl };
    },
  },

  // eBay
  {
    match: (url) => /ebay\.(com|co\.uk|de|fr|ca|com\.au)/i.test(url),
    scrape: ($) => {
      const priceSelectors = [
        '[data-testid="x-price-primary"] .ux-textspans',
        '.x-price-primary .ux-textspans',
        '#prcIsum',
        '#mm-saleDscPrc',
        '.vi-price .notranslate',
      ];

      let price: ParsedPrice | null = null;
      for (const selector of priceSelectors) {
        const el = $(selector).first();
        if (el.length) {
          price = parsePrice(el.text().trim());
          if (price) break;
        }
      }

      const name = $('h1.x-item-title__mainTitle span').text().trim() ||
                   $('h1[itemprop="name"]').text().trim() ||
                   null;

      const imageUrl = $('[data-testid="ux-image-carousel"] img').attr('src') ||
                       $('#icImg').attr('src') ||
                       null;

      return { name, price, imageUrl };
    },
  },

  // Newegg
  {
    match: (url) => /newegg\.com/i.test(url),
    scrape: ($) => {
      // Helper to check if element is inside a savings/combo container
      const isInSavingsContainer = (el: ReturnType<typeof $>) => {
        const parents = el.parents().toArray();
        for (const parent of parents) {
          const className = $(parent).attr('class') || '';
          const id = $(parent).attr('id') || '';
          // Skip elements inside combo deals, savings sections, or "you save" areas
          if (/combo|save|saving|deal|bundle|discount/i.test(className + id)) {
            return true;
          }
          // Check for specific Newegg combo/savings containers
          if (className.includes('item-combo') || className.includes('product-combo')) {
            return true;
          }
        }
        // Also check the element's surrounding text for "save" context
        const parentText = el.parent().text().toLowerCase();
        if (parentText.includes('you save') || parentText.includes('save $')) {
          return true;
        }
        return false;
      };

      let price: ParsedPrice | null = null;

      // First, try JSON-LD data - most reliable source
      try {
        const scripts = $('script[type="application/ld+json"]');
        scripts.each((_, script) => {
          if (price) return; // Already found
          const jsonLd = $(script).html();
          if (jsonLd) {
            const data = JSON.parse(jsonLd);
            // Handle array of JSON-LD objects
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
              if (item['@type'] === 'Product' && item.offers) {
                const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
                if (offer?.price) {
                  price = {
                    price: parseFloat(String(offer.price)),
                    currency: offer.priceCurrency || 'USD',
                  };
                  break;
                }
              }
            }
          }
        });
      } catch (_e) {
        // Ignore JSON parse errors
      }

      // Fallback: Try HTML selectors, but be careful to avoid savings amounts
      if (!price) {
        // Target main product buy box price specifically
        const mainPriceContainers = [
          '.product-buy-box .price-current',
          '.price-main-product .price-current',
          '.product-price .price-current',
          '#app .price-current', // Main app container
        ];

        for (const selector of mainPriceContainers) {
          const elements = $(selector);
          elements.each((_, el) => {
            if (price) return; // Already found

            const $el = $(el);
            // Skip if inside a savings/combo container
            if (isInSavingsContainer($el)) return;

            // Combine dollar and cents parts
            const strong = $el.find('strong').text().trim() || $el.text().trim();
            const sup = $el.find('sup').text().trim();
            if (strong) {
              // Clean the strong text - remove any non-numeric chars except comma
              const cleanStrong = strong.replace(/[^0-9,]/g, '');
              if (cleanStrong) {
                const priceText = `$${cleanStrong}${sup ? '.' + sup : ''}`;
                const parsed = parsePrice(priceText);
                // Validate this looks like a real product price (Ryzen 9 should be $500+)
                if (parsed && parsed.price > 50) {
                  price = parsed;
                }
              }
            }
          });

          if (price) break;
        }
      }

      // Last resort: itemprop price
      if (!price) {
        const itemprop = $('[itemprop="price"]').first();
        if (itemprop.length) {
          const content = itemprop.attr('content');
          if (content) {
            price = parsePrice(content);
          }
        }
      }

      const name = $('h1.product-title').text().trim() ||
                   $('.product-title').text().trim() ||
                   $('[itemprop="name"]').text().trim() ||
                   null;

      const imageUrl = $('img.product-view-img-original').attr('src') ||
                       $('.product-view-img-original').attr('src') ||
                       $('[itemprop="image"]').attr('content') ||
                       null;

      // Stock status detection for Newegg
      let stockStatus: StockStatus = 'unknown';
      const buyButton = $('.btn-primary.btn-wide').text().toLowerCase();
      const soldOutBanner = $('.product-inventory').text().toLowerCase();
      const outOfStockText = $('.product-flag-text').text().toLowerCase();

      if (
        soldOutBanner.includes('out of stock') ||
        soldOutBanner.includes('sold out') ||
        outOfStockText.includes('out of stock') ||
        $('.product-buy-box .btn-message-error').length > 0
      ) {
        stockStatus = 'out_of_stock';
      } else if (
        buyButton.includes('add to cart') ||
        buyButton.includes('buy now') ||
        $('.product-buy-box .btn-primary').length > 0
      ) {
        stockStatus = 'in_stock';
      }

      return { name, price, imageUrl, stockStatus };
    },
  },

  // Home Depot
  {
    match: (url) => /homedepot\.com/i.test(url),
    scrape: ($) => {
      const priceSelectors = [
        '[data-testid="price-format"] span',
        '.price-format__main-price span',
        '#ajaxPrice',
      ];

      let price: ParsedPrice | null = null;
      for (const selector of priceSelectors) {
        const el = $(selector).first();
        if (el.length) {
          price = parsePrice(el.text().trim());
          if (price) break;
        }
      }

      const name = $('h1.product-title__title').text().trim() ||
                   $('h1[class*="product-details"]').text().trim() ||
                   null;

      const imageUrl = $('img[data-testid="media-gallery-image"]').attr('src') || null;

      return { name, price, imageUrl };
    },
  },

  // Costco
  {
    match: (url) => /costco\.com/i.test(url),
    scrape: ($) => {
      const price = parsePrice($('[automation-id="productPriceOutput"]').text().trim()) ||
                    parsePrice($('.price').first().text().trim());

      const name = $('h1[itemprop="name"]').text().trim() ||
                   $('h1.product-title').text().trim() ||
                   null;

      const imageUrl = $('img.product-image').attr('src') || null;

      return { name, price, imageUrl };
    },
  },

  // AliExpress
  {
    match: (url) => /aliexpress\.com/i.test(url),
    scrape: ($) => {
      const priceSelectors = [
        '.product-price-value',
        '[class*="uniformBannerBoxPrice"]',
        '.snow-price_SnowPrice__mainS__1occeh',
      ];

      let price: ParsedPrice | null = null;
      for (const selector of priceSelectors) {
        const el = $(selector).first();
        if (el.length) {
          price = parsePrice(el.text().trim());
          if (price) break;
        }
      }

      const name = $('h1[data-pl="product-title"]').text().trim() ||
                   $('h1.product-title-text').text().trim() ||
                   null;

      const imageUrl = $('img.magnifier-image').attr('src') || null;

      return { name, price, imageUrl };
    },
  },

  // Magento 2 (generic - covers many sites including Degussa)
  {
    match: (url) => {
      // Match common Magento indicators in URL or just try for any .html product page
      return /\.(html|htm)$/i.test(url) || /\/catalog\/product\//i.test(url);
    },
    scrape: ($) => {
      let price: ParsedPrice | null = null;
      let name: string | null = null;
      let imageUrl: string | null = null;

      // Magento 2 stores prices in data-price-amount attribute
      // Look for the final/special price first, then regular price
      const priceSelectors = [
        '.price-box .special-price [data-price-amount]',
        '.price-box .price-final_price [data-price-amount]',
        '.price-box [data-price-type="finalPrice"] [data-price-amount]',
        '.price-box [data-price-amount]',
        '[data-price-amount]',
      ];

      for (const selector of priceSelectors) {
        const el = $(selector).first();
        if (el.length) {
          const priceAmount = el.attr('data-price-amount');
          if (priceAmount) {
            const priceValue = parseFloat(priceAmount);
            if (!isNaN(priceValue) && priceValue > 0) {
              // Detect currency from the page
              let currency = 'USD';
              const priceText = el.closest('.price-box').text() || el.parent().text() || '';
              const currencyMatch = priceText.match(/\b(CHF|EUR|GBP|USD|CAD|AUD)\b/i);
              if (currencyMatch) {
                currency = currencyMatch[1].toUpperCase();
              } else {
                // Check for currency symbols
                const symbolMatch = priceText.match(/([$€£])/);
                if (symbolMatch) {
                  currency = symbolMatch[1] === '€' ? 'EUR' : symbolMatch[1] === '£' ? 'GBP' : 'USD';
                }
              }
              price = { price: priceValue, currency };
              break;
            }
          }
        }
      }

      // Get product name
      name = $('h1.page-title span').text().trim() ||
             $('h1.product-name').text().trim() ||
             $('.product-info-main h1').text().trim() ||
             $('[data-ui-id="page-title-wrapper"]').text().trim() ||
             null;

      // Get product image
      imageUrl = $('[data-gallery-role="gallery"] img').first().attr('src') ||
                 $('.product.media img').first().attr('src') ||
                 $('.fotorama__stage img').first().attr('src') ||
                 null;

      // Stock status detection for Magento 2
      let stockStatus: StockStatus = 'unknown';

      // Check for Magento's stock status elements
      const stockElement = $('.product-info-stock-sku .stock').first();
      const stockText = stockElement.text().toLowerCase();
      const stockClass = stockElement.attr('class')?.toLowerCase() || '';

      // Magento uses "available" class for in-stock items
      if (stockClass.includes('available') || stockText.includes('in stock')) {
        stockStatus = 'in_stock';
      } else if (stockClass.includes('unavailable') || stockText.includes('out of stock')) {
        stockStatus = 'out_of_stock';
      }

      // Also check for add to cart button as backup
      if (stockStatus === 'unknown') {
        const addToCartBtn = $('#product-addtocart-button, button.tocart, button[title="Add to Cart"], button[title="Add to Basket"]').length > 0;
        const outOfStockMsg = $('.out-of-stock, .unavailable, [class*="outofstock"]').length > 0;

        if (addToCartBtn && !outOfStockMsg) {
          stockStatus = 'in_stock';
        } else if (outOfStockMsg) {
          stockStatus = 'out_of_stock';
        }
      }

      // Only return if we found a price (indicates it's likely a Magento site)
      if (price) {
        return { name, price, imageUrl, stockStatus };
      }
      return {};
    },
  },

];

// Generic selectors as fallback
const genericPriceSelectors = [
  '[itemprop="price"]',
  '[data-price-amount]',  // Magento 2
  '[data-price]',
  '[data-product-price]',
  '.price-wrapper [data-price-amount]',  // Magento 2 price wrapper
  '.price-box .price',  // Magento price box
  '.special-price .price',  // Magento special/sale price
  '.price',
  '.product-price',
  '.current-price',
  '.sale-price',
  '.final-price',
  '.offer-price',
  '#price',
  '[class*="price" i]',
  '[class*="Price" i]',
];

const genericNameSelectors = [
  '[itemprop="name"]',
  'h1[class*="product"]',
  'h1[class*="title"]',
  '.product-title',
  '.product-name',
  'h1',
];

const genericImageSelectors = [
  '[itemprop="image"]',
  '[property="og:image"]',
  '.product-image img',
  '.main-image img',
  '[data-zoom-image]',
  'img[class*="product"]',
];

/** Internal sentinel: the browser already produced the HTML, skip the HTTP GET. */
class SkipHttpFetch extends Error {}

export async function scrapeProduct(url: string, userId?: number): Promise<ScrapedProduct> {
  const result: ScrapedProduct = {
    name: null,
    price: null,
    imageUrl: null,
    url,
    stockStatus: 'unknown',
    aiStatus: null,
  };

  let html: string = '';

  const unsupported = brUnsupportedReason(url);
  if (unsupported) {
    throw new Error(unsupported);
  }

  // Brazilian stores that 403 plain HTTP (Terabyte, Pichau, OLX) or, worse,
  // answer 200 with a bot-wall page that no status-code fallback can detect
  // (Amazon .com.br, Mercado Livre, Shopee). Go straight to the browser.
  const brNeedsBrowser = BR_BROWSER_SITES.some((re) => re.test(url));
  const isBrazilian = /\.com\.br(\/|$|:)/i.test(url);

  try {
    let usedBrowser = false;

    if (brNeedsBrowser) {
      console.log(`${new URL(url).hostname} requires browser rendering, using Puppeteer...`);
      html = await scrapeWithBrowser(url);
      usedBrowser = true;
    }

    try {
      if (usedBrowser) throw new SkipHttpFetch();
      const response = await axios.get<string>(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': isBrazilian ? 'pt-BR,pt;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
        },
        timeout: 20000,
        maxRedirects: 5,
      });
      html = response.data;
    } catch (axiosError) {
      if (axiosError instanceof SkipHttpFetch) {
        // Already fetched with the browser above.
      } else if (axiosError instanceof AxiosError && axiosError.response?.status === 403) {
        // If we get a 403 (Forbidden), try using a headless browser
        console.log(`HTTP request blocked (403) for ${url}, falling back to browser scraping...`);
        html = await scrapeWithBrowser(url);
        usedBrowser = true;
      } else {
        throw axiosError;
      }
    }

    const $ = load(html);

    if (usedBrowser) {
      console.log(`Successfully scraped ${url} using headless browser`);
    }

    // Try site-specific scraper first
    const siteScraper = siteScrapers.find((s) => s.match(url));
    if (siteScraper) {
      const siteResult = siteScraper.scrape($, url);
      if (siteResult.name) result.name = siteResult.name;
      if (siteResult.price) result.price = siteResult.price;
      if (siteResult.imageUrl) result.imageUrl = siteResult.imageUrl;
      if (siteResult.stockStatus) result.stockStatus = siteResult.stockStatus;
    }

    // Try JSON-LD structured data
    if (!result.price || !result.name || result.stockStatus === 'unknown') {
      const jsonLdData = extractJsonLd($, pageLocale($, url));
      if (jsonLdData) {
        if (!result.name && jsonLdData.name) result.name = jsonLdData.name;
        if (!result.price && jsonLdData.price) result.price = jsonLdData.price;
        if (!result.imageUrl && jsonLdData.image) result.imageUrl = jsonLdData.image;
        if (result.stockStatus === 'unknown' && jsonLdData.stockStatus) {
          result.stockStatus = jsonLdData.stockStatus;
        }
      }
    }

    // Fallback to generic scraping
    if (!result.name) {
      result.name = extractGenericName($);
    }

    if (!result.price) {
      result.price = extractGenericPrice($, pageLocale($, url));
    }

    if (!result.imageUrl) {
      result.imageUrl = extractGenericImage($, url);
    }

    // Generic stock status detection if not already set
    if (result.stockStatus === 'unknown') {
      result.stockStatus = extractGenericStockStatus($);
    }

    // Try Open Graph meta tags as last resort
    if (!result.name) {
      result.name = $('meta[property="og:title"]').attr('content') || null;
    }
    if (!result.imageUrl) {
      result.imageUrl = $('meta[property="og:image"]').attr('content') || null;
    }

    // If no price found and we haven't tried browser yet, try Puppeteer
    // This handles JavaScript-rendered prices (Magento, React, Vue, etc.)
    if (!result.price && !usedBrowser) {
      console.log(`[Scraper] No price found in static HTML for ${url}, trying headless browser...`);
      try {
        html = await scrapeWithBrowser(url);
        usedBrowser = true;
        const $browser = load(html);

        // Re-try extraction with browser-rendered HTML
        // Try site-specific scraper
        const siteScraper = siteScrapers.find((s) => s.match(url));
        if (siteScraper) {
          const siteResult = siteScraper.scrape($browser, url);
          if (!result.name && siteResult.name) result.name = siteResult.name;
          if (!result.price && siteResult.price) result.price = siteResult.price;
          if (!result.imageUrl && siteResult.imageUrl) result.imageUrl = siteResult.imageUrl;
          if (result.stockStatus === 'unknown' && siteResult.stockStatus) {
            result.stockStatus = siteResult.stockStatus;
          }
        }

        // Try JSON-LD from browser-rendered HTML
        if (!result.price) {
          const jsonLdData = extractJsonLd($browser, pageLocale($browser, url));
          if (jsonLdData) {
            if (!result.name && jsonLdData.name) result.name = jsonLdData.name;
            if (!result.price && jsonLdData.price) result.price = jsonLdData.price;
            if (!result.imageUrl && jsonLdData.image) result.imageUrl = jsonLdData.image;
            if (result.stockStatus === 'unknown' && jsonLdData.stockStatus) {
              result.stockStatus = jsonLdData.stockStatus;
            }
          }
        }

        // Try generic extraction from browser-rendered HTML
        if (!result.price) {
          result.price = extractGenericPrice($browser, pageLocale($browser, url));
        }
        if (!result.name) {
          result.name = extractGenericName($browser);
        }
        if (!result.imageUrl) {
          result.imageUrl = extractGenericImage($browser, url);
        }
        if (result.stockStatus === 'unknown') {
          result.stockStatus = extractGenericStockStatus($browser);
        }

        if (result.price) {
          console.log(`[Scraper] Successfully extracted price ${result.price.price} ${result.price.currency} using headless browser`);
        }
      } catch (browserError) {
        console.error(`[Scraper] Browser fallback failed for ${url}:`, browserError);
      }
    }

    // If we have a price and userId is provided, try AI verification
    if (result.price && userId && html) {
      try {
        const { tryAIVerification } = await import('./ai-extractor');
        const verifyResult = await tryAIVerification(
          url,
          html,
          result.price.price,
          result.price.currency,
          userId
        );

        if (verifyResult) {
          if (verifyResult.isCorrect) {
            console.log(`[AI Verify] Confirmed price $${result.price.price} is correct (confidence: ${verifyResult.confidence})`);
            result.aiStatus = 'verified';
          } else if (verifyResult.suggestedPrice && verifyResult.confidence > 0.6) {
            console.log(`[AI Verify] Price correction: $${result.price.price} -> $${verifyResult.suggestedPrice.price} (${verifyResult.reason})`);
            result.price = verifyResult.suggestedPrice;
            result.aiStatus = 'corrected';
          } else {
            console.log(`[AI Verify] Price might be incorrect but no confident suggestion: ${verifyResult.reason}`);
            // Don't set aiStatus if verification was inconclusive
          }

          // Use AI-detected stock status if we don't have a definitive one yet
          // or if AI says it's out of stock (AI can catch pre-order/coming soon)
          if (verifyResult.stockStatus && verifyResult.stockStatus !== 'unknown') {
            if (result.stockStatus === 'unknown' || verifyResult.stockStatus === 'out_of_stock') {
              console.log(`[AI Verify] Stock status: ${verifyResult.stockStatus} (was: ${result.stockStatus})`);
              result.stockStatus = verifyResult.stockStatus;
            }
          }
        }
      } catch (verifyError) {
        console.error(`[AI Verify] Verification failed for ${url}:`, verifyError);
      }
    }

    // If we still don't have a price and userId is provided, try AI extraction as fallback
    if (!result.price && userId && html) {
      try {
        const { tryAIExtraction } = await import('./ai-extractor');
        const aiResult = await tryAIExtraction(url, html, userId);

        if (aiResult && aiResult.price && aiResult.confidence > 0.5) {
          console.log(`[AI] Successfully extracted price for ${url}: ${aiResult.price.price} (confidence: ${aiResult.confidence})`);
          result.price = aiResult.price;
          if (!result.name && aiResult.name) result.name = aiResult.name;
          if (!result.imageUrl && aiResult.imageUrl) result.imageUrl = aiResult.imageUrl;
          if (result.stockStatus === 'unknown' && aiResult.stockStatus !== 'unknown') {
            result.stockStatus = aiResult.stockStatus;
          }
        }
      } catch (aiError) {
        console.error(`[AI] Extraction failed for ${url}:`, aiError);
      }
    }
  } catch (error) {
    console.error(`Error scraping ${url}:`, error);
  }

  return result;
}

/**
 * Multi-strategy voting scraper with user review support.
 * Runs all extraction methods, finds consensus, and flags ambiguous cases for user review.
 *
 * @param anchorPrice - The price the user previously confirmed. Used to select the correct
 *                      variant on refresh when multiple prices are found.
 * @param skipAiVerification - If true, skip AI verification entirely for this product.
 * @param skipAiExtraction - If true, skip AI extraction fallback for this product.
 */
export async function scrapeProductWithVoting(
  url: string,
  userId?: number,
  preferredMethod?: ExtractionMethod,
  anchorPrice?: number,
  skipAiVerification?: boolean,
  skipAiExtraction?: boolean
): Promise<ScrapedProductWithCandidates> {
  const result: ScrapedProductWithCandidates = {
    name: null,
    price: null,
    imageUrl: null,
    url,
    stockStatus: 'unknown',
    aiStatus: null,
    priceCandidates: [],
    needsReview: false,
  };

  let html: string = '';

  const isBrazilian = /\.com\.br(\/|$|:)/i.test(url);

  // Sites known to require JavaScript rendering
  const jsHeavySites = [
    /bestbuy\.com/i,
    /target\.com/i,
    /walmart\.com/i,
    /costco\.com/i,
    // Brazilian stores behind Cloudflare / bot walls (see scrapers-br.ts)
    ...BR_BROWSER_SITES,
  ];
  const requiresBrowser = jsHeavySites.some(pattern => pattern.test(url));

  try {
    let usedBrowser = false;

    // For JS-heavy sites, go straight to browser
    if (requiresBrowser) {
      console.log(`[Voting] ${new URL(url).hostname} requires browser rendering, using Puppeteer...`);
      html = await scrapeWithBrowser(url);
      usedBrowser = true;
    } else {
      // Fetch HTML
      try {
        const response = await axios.get<string>(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': isBrazilian ? 'pt-BR,pt;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
        },
        timeout: 20000,
        maxRedirects: 5,
      });
      html = response.data;
      } catch (axiosError) {
        if (axiosError instanceof AxiosError && axiosError.response?.status === 403) {
          console.log(`[Voting] HTTP blocked (403) for ${url}, using browser...`);
          html = await scrapeWithBrowser(url);
          usedBrowser = true;
        } else {
          throw axiosError;
        }
      }
    }

    let $ = load(html);
    let locale = pageLocale($, url);

    // A dead Brazilian product URL is not an empty page: it is a 404 with a
    // carousel of other products, every card carrying a price element. Reading
    // one would write a confident wrong price into this product's history, so
    // stop here and report no price. See brPageNotFound() in scrapers-br.ts.
    if (locale.currency === 'BRL' && brPageNotFound($)) {
      console.warn(`[Voting] ${new URL(url).hostname}: product page not found (404); no price read.`);
      return result;
    }

    // Collect candidates from all methods
    const allCandidates: PriceCandidate[] = [];

    // 1. JSON-LD extraction (highest reliability)
    const jsonLdCandidates = extractJsonLdCandidates($, locale);
    allCandidates.push(...jsonLdCandidates);
    console.log(`[Voting] JSON-LD found ${jsonLdCandidates.length} candidates`);

    // 2. Site-specific extraction
    const siteResult = extractSiteSpecificCandidates($, url, locale);
    allCandidates.push(...siteResult.candidates);
    if (siteResult.name) result.name = siteResult.name;
    if (siteResult.imageUrl) result.imageUrl = siteResult.imageUrl;
    if (siteResult.stockStatus !== 'unknown') result.stockStatus = siteResult.stockStatus;
    console.log(`[Voting] Site-specific found ${siteResult.candidates.length} candidates`);

    // 3. Generic CSS extraction
    const genericCandidates = extractGenericCssCandidates($, locale);
    allCandidates.push(...genericCandidates);
    console.log(`[Voting] Generic CSS found ${genericCandidates.length} candidates`);

    // If no candidates found in static HTML, try browser rendering
    if (allCandidates.length === 0 && !usedBrowser) {
      console.log(`[Voting] No candidates in static HTML, trying browser...`);
      try {
        html = await scrapeWithBrowser(url);
        usedBrowser = true;
        $ = load(html);
        locale = pageLocale($, url);

        // Re-run all extraction methods
        allCandidates.push(...extractJsonLdCandidates($, locale));
        const browserSiteResult = extractSiteSpecificCandidates($, url, locale);
        allCandidates.push(...browserSiteResult.candidates);
        if (!result.name && browserSiteResult.name) result.name = browserSiteResult.name;
        if (!result.imageUrl && browserSiteResult.imageUrl) result.imageUrl = browserSiteResult.imageUrl;
        if (result.stockStatus === 'unknown' && browserSiteResult.stockStatus !== 'unknown') {
          result.stockStatus = browserSiteResult.stockStatus;
        }
        allCandidates.push(...extractGenericCssCandidates($, locale));
        console.log(`[Voting] Browser found ${allCandidates.length} total candidates`);
      } catch (browserError) {
        console.error(`[Voting] Browser fallback failed:`, browserError);
      }
    }

    // Fill in missing metadata
    if (!result.name) {
      result.name = extractGenericName($) || $('meta[property="og:title"]').attr('content') || null;
    }
    if (!result.imageUrl) {
      result.imageUrl = extractGenericImage($, url) || $('meta[property="og:image"]').attr('content') || null;
    }
    if (result.stockStatus === 'unknown') {
      result.stockStatus = extractGenericStockStatus($);
    }

    // Store all candidates
    result.priceCandidates = allCandidates;

    // Track if we used anchor price (to prevent AI from overriding user's choice)
    let usedAnchorPrice = false;

    // PRIORITY 1: If we have an anchor price, it takes precedence (user confirmed this price)
    // This handles variant products where multiple prices exist on the page
    if (anchorPrice && allCandidates.length > 0) {
      console.log(`[Voting] Have anchor price ${anchorPrice}, searching ${allCandidates.length} candidates: ${allCandidates.map(c => c.price).join(', ')}`);

      // Find the candidate closest to the anchor price
      const closestCandidate = allCandidates.reduce((closest, candidate) => {
        const closestDiff = Math.abs(closest.price - anchorPrice);
        const candidateDiff = Math.abs(candidate.price - anchorPrice);
        return candidateDiff < closestDiff ? candidate : closest;
      });

      const priceDiff = Math.abs(closestCandidate.price - anchorPrice) / anchorPrice;

      // Use anchor matching if within 15% (allows for small sales)
      // or if it's an exact match
      if (closestCandidate.price === anchorPrice || priceDiff < 0.15) {
        console.log(`[Voting] Found match for anchor price ${anchorPrice}: ${closestCandidate.price} via ${closestCandidate.method} (${(priceDiff * 100).toFixed(1)}% diff)`);
        result.price = { price: closestCandidate.price, currency: closestCandidate.currency };
        result.selectedMethod = closestCandidate.method;
        usedAnchorPrice = true;
        result.aiStatus = 'verified';  // Mark as verified to skip AI price override

        // Use AI to verify stock status for this specific variant (price matched, but stock might be wrong)
        if (userId && html && !skipAiVerification) {
          try {
            const { tryAIStockStatusVerification } = await import('./ai-extractor');
            const stockResult = await tryAIStockStatusVerification(
              url,
              html,
              closestCandidate.price,
              closestCandidate.currency,
              userId
            );
            if (stockResult && stockResult.confidence > 0.6) {
              console.log(`[Voting] AI stock status for $${closestCandidate.price} variant: ${stockResult.stockStatus} (${stockResult.reason})`);
              result.stockStatus = stockResult.stockStatus;
            }
          } catch (stockError) {
            console.error(`[Voting] AI stock status verification failed:`, stockError);
          }
        }

        return result;
      } else {
        // No close match - still use the closest candidate
        // This prevents AI from picking a completely different price (like main buy box vs other sellers)
        console.log(`[Voting] No close match for anchor ${anchorPrice}, using closest: ${closestCandidate.price} (${(priceDiff * 100).toFixed(1)}% diff) - may be a price change`);
        result.price = { price: closestCandidate.price, currency: closestCandidate.currency };
        result.selectedMethod = closestCandidate.method;
        usedAnchorPrice = true;
        // IMPORTANT: Mark as verified to prevent AI from overriding user's deliberate choice
        // The user selected a specific price (e.g., "other sellers" on Amazon), don't let AI
        // "correct" it to the main buy box price
        result.aiStatus = 'verified';

        // Use AI to verify stock status for this specific variant
        if (userId && html && !skipAiVerification) {
          try {
            const { tryAIStockStatusVerification } = await import('./ai-extractor');
            const stockResult = await tryAIStockStatusVerification(
              url,
              html,
              closestCandidate.price,
              closestCandidate.currency,
              userId
            );
            if (stockResult && stockResult.confidence > 0.6) {
              console.log(`[Voting] AI stock status for $${closestCandidate.price} variant: ${stockResult.stockStatus} (${stockResult.reason})`);
              result.stockStatus = stockResult.stockStatus;
            }
          } catch (stockError) {
            console.error(`[Voting] AI stock status verification failed:`, stockError);
          }
        }

        return result;
      }
    }

    // PRIORITY 2: If user has a preferred method and no anchor match, try that method
    if (preferredMethod && allCandidates.length > 0) {
      const preferredCandidates = allCandidates.filter(c => c.method === preferredMethod);
      if (preferredCandidates.length > 0) {
        // Use highest confidence candidate from preferred method
        const selectedCandidate = preferredCandidates.sort((a, b) => b.confidence - a.confidence)[0];
        console.log(`[Voting] Using preferred method ${preferredMethod}: ${selectedCandidate.price}`);
        result.price = { price: selectedCandidate.price, currency: selectedCandidate.currency };
        result.selectedMethod = preferredMethod;
        return result;
      }
    }

    // Find consensus
    const { price: consensusPrice, hasConsensus, groups } = findPriceConsensus(allCandidates);
    console.log(`[Voting] Consensus: ${hasConsensus}, Groups: ${groups.length}, Winner: ${consensusPrice?.price}`);

    if (hasConsensus && consensusPrice) {
      // Clear consensus - use the winning price
      result.price = { price: consensusPrice.price, currency: consensusPrice.currency };
      result.selectedMethod = consensusPrice.method;
      console.log(`[Voting] Consensus price: ${consensusPrice.price} via ${consensusPrice.method}`);
    } else if (allCandidates.length > 0) {
      // No consensus - try AI arbitration if available
      if (userId && html) {
        console.log(`[Voting] No consensus, trying AI arbitration...`);
        try {
          const { tryAIArbitration } = await import('./ai-extractor');
          const aiResult = await tryAIArbitration(url, html, allCandidates, userId);

          if (aiResult && aiResult.selectedPrice) {
            console.log(`[Voting] AI selected price: ${aiResult.selectedPrice.price} (reason: ${aiResult.reason})`);
            result.price = { price: aiResult.selectedPrice.price, currency: aiResult.selectedPrice.currency };
            result.selectedMethod = aiResult.selectedPrice.method;
            result.aiStatus = 'verified';

            // Add AI as a candidate for transparency
            if (!allCandidates.find(c => c.method === 'ai')) {
              result.priceCandidates.push({
                price: aiResult.selectedPrice.price,
                currency: aiResult.selectedPrice.currency,
                method: 'ai',
                context: `AI arbitration: ${aiResult.reason}`,
                confidence: aiResult.confidence || 0.8,
              });
            }
          } else {
            // AI couldn't decide either - flag for user review
            console.log(`[Voting] AI couldn't decide, flagging for user review`);
            result.needsReview = true;
            // Use the most confident candidate as default
            const bestCandidate = allCandidates.sort((a, b) => b.confidence - a.confidence)[0];
            result.price = { price: bestCandidate.price, currency: bestCandidate.currency };
            result.selectedMethod = bestCandidate.method;
          }
        } catch (aiError) {
          console.error(`[Voting] AI arbitration failed:`, aiError);
          // Fall back to flagging for user review
          result.needsReview = true;
          const bestCandidate = allCandidates.sort((a, b) => b.confidence - a.confidence)[0];
          result.price = { price: bestCandidate.price, currency: bestCandidate.currency };
          result.selectedMethod = bestCandidate.method;
        }
      } else {
        // No AI available - flag for user review if multiple prices differ significantly
        if (groups.length > 1) {
          result.needsReview = true;
          console.log(`[Voting] Multiple price groups found, flagging for user review`);
        }
        // Use the most confident candidate as default
        const bestCandidate = allCandidates.sort((a, b) => b.confidence - a.confidence)[0];
        result.price = { price: bestCandidate.price, currency: bestCandidate.currency };
        result.selectedMethod = bestCandidate.method;
      }
    } else {
      // No candidates at all - try pure AI extraction (unless disabled for this product)
      if (userId && html && !skipAiExtraction) {
        console.log(`[Voting] No candidates found, trying AI extraction...`);
        try {
          const { tryAIExtraction } = await import('./ai-extractor');
          const aiResult = await tryAIExtraction(url, html, userId);

          if (aiResult && aiResult.price && aiResult.confidence > 0.5) {
            console.log(`[Voting] AI extracted price: ${aiResult.price.price}`);
            result.price = aiResult.price;
            result.selectedMethod = 'ai';
            result.priceCandidates.push({
              price: aiResult.price.price,
              currency: aiResult.price.currency,
              method: 'ai',
              context: 'AI extraction (no other methods found price)',
              confidence: aiResult.confidence,
            });
            if (!result.name && aiResult.name) result.name = aiResult.name;
            if (!result.imageUrl && aiResult.imageUrl) result.imageUrl = aiResult.imageUrl;
            if (result.stockStatus === 'unknown' && aiResult.stockStatus !== 'unknown') {
              result.stockStatus = aiResult.stockStatus;
            }
          }
        } catch (aiError) {
          console.error(`[Voting] AI extraction failed:`, aiError);
        }
      }
    }

    // If we have a price but AI is available, verify it
    // SKIP verification if:
    // - User disabled AI verification for this product
    // - We have multiple candidates (let user choose from modal instead)
    // This prevents AI from "correcting" valid alternative prices (e.g., other sellers on Amazon)
    const hasMultipleCandidates = allCandidates.length > 1;
    if (result.price && userId && html && !result.aiStatus && !hasMultipleCandidates && !skipAiVerification) {
      try {
        const { tryAIVerification } = await import('./ai-extractor');
        const verifyResult = await tryAIVerification(
          url,
          html,
          result.price.price,
          result.price.currency,
          userId
        );

        if (verifyResult) {
          if (verifyResult.isCorrect) {
            result.aiStatus = 'verified';
          } else if (verifyResult.suggestedPrice && verifyResult.confidence > 0.7) {
            // AI suggests a different price - this might indicate we need review
            const existingCandidate = allCandidates.find(c =>
              pricesMatch(c.price, verifyResult.suggestedPrice!.price)
            );
            if (existingCandidate) {
              // AI agrees with one of our candidates - use that
              result.price = verifyResult.suggestedPrice;
              result.selectedMethod = existingCandidate.method;
              result.aiStatus = 'corrected';
            } else if (!result.needsReview) {
              // AI suggests a price we didn't find - flag for review
              result.needsReview = true;
              result.priceCandidates.push({
                price: verifyResult.suggestedPrice.price,
                currency: verifyResult.suggestedPrice.currency,
                method: 'ai',
                context: `AI suggestion: ${verifyResult.reason}`,
                confidence: verifyResult.confidence,
              });
            }
          }

          // Update stock status from AI
          if (verifyResult.stockStatus && verifyResult.stockStatus !== 'unknown') {
            if (result.stockStatus === 'unknown' || verifyResult.stockStatus === 'out_of_stock') {
              result.stockStatus = verifyResult.stockStatus;
            }
          }
        }
      } catch (verifyError) {
        console.error(`[Voting] AI verification failed:`, verifyError);
      }
    }

  } catch (error) {
    console.error(`[Voting] Error scraping ${url}:`, error);
  }

  return result;
}

interface JsonLdProduct {
  '@type'?: string;
  '@graph'?: JsonLdProduct[];
  name?: string;
  image?: string | string[] | { url?: string };
  offers?: JsonLdOffer | JsonLdOffer[];
}

interface JsonLdPriceSpecification {
  price?: string | number;
  priceCurrency?: string;
}

interface JsonLdOffer {
  '@type'?: string;
  price?: string | number;
  priceCurrency?: string;
  lowPrice?: string | number;
  priceSpecification?: JsonLdPriceSpecification;
  availability?: string;
}

function extractJsonLd(
  $: CheerioAPI,
  locale: PageLocale
): { name?: string; price?: ParsedPrice; image?: string; stockStatus?: StockStatus } | null {
  try {
    const scripts = $('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length; i++) {
      const content = $(scripts[i]).html();
      if (!content) continue;

      const data = JSON.parse(content) as JsonLdProduct | JsonLdProduct[];
      const product = findProduct(data);

      if (product) {
        const result: { name?: string; price?: ParsedPrice; image?: string; stockStatus?: StockStatus } = {};

        if (product.name) {
          result.name = product.name;
        }

        if (product.offers) {
          const offer = Array.isArray(product.offers)
            ? product.offers[0]
            : product.offers;

          // Get price, checking multiple locations:
          // 1. lowPrice (for price ranges)
          // 2. price (direct)
          // 3. priceSpecification.price (nested format used by some sites)
          const priceValue = offer.lowPrice || offer.price || offer.priceSpecification?.price;
          const currency = offer.priceCurrency || offer.priceSpecification?.priceCurrency || locale.currency;

          if (priceValue) {
            result.price = {
              price: parseFloat(String(priceValue)),
              currency,
            };
          }

          // Extract stock status from availability
          if (offer.availability) {
            const avail = offer.availability.toLowerCase();
            if (avail.includes('instock') || avail.includes('in_stock')) {
              result.stockStatus = 'in_stock';
            } else if (avail.includes('outofstock') || avail.includes('out_of_stock') ||
                       avail.includes('soldout') || avail.includes('sold_out')) {
              result.stockStatus = 'out_of_stock';
            }
          }
        }

        if (product.image) {
          if (Array.isArray(product.image)) {
            result.image = product.image[0];
          } else if (typeof product.image === 'string') {
            result.image = product.image;
          } else if (product.image.url) {
            result.image = product.image.url;
          }
        }

        return result;
      }
    }
  } catch (_e) {
    // JSON parse error, continue with other methods
  }
  return null;
}

function findProduct(data: JsonLdProduct | JsonLdProduct[]): JsonLdProduct | null {
  if (!data) return null;

  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findProduct(item);
      if (found) return found;
    }
    return null;
  }

  if (data['@type'] === 'Product') {
    return data;
  }

  if (data['@graph'] && Array.isArray(data['@graph'])) {
    for (const item of data['@graph']) {
      const found = findProduct(item);
      if (found) return found;
    }
  }

  return null;
}

function extractGenericPrice($: CheerioAPI, locale: PageLocale): ParsedPrice | null {
  const prices: ParsedPrice[] = [];

  for (const selector of genericPriceSelectors) {
    const elements = $(selector);
    elements.each((_, el) => {
      const $el = $(el);
      // Skip if this looks like an "original" or "was" price
      const classAttr = $el.attr('class') || '';
      const parentClass = $el.parent().attr('class') || '';
      if (/original|was|old|regular|compare|strikethrough|line-through/i.test(classAttr + parentClass)) {
        return;
      }

      // Check various attributes where price might be stored
      const priceAmount = $el.attr('data-price-amount');  // Magento 2
      const dataPrice = $el.attr('data-price');
      const content = $el.attr('content');
      const text = $el.text();

      // Try data-price-amount first (Magento stores numeric value here)
      if (priceAmount) {
        const price = parseFloat(priceAmount);
        if (!isNaN(price) && price > 0) {
          // Try to detect currency from nearby elements, parent, or page
          let currency = 'USD';

          // Look for currency in the element's text, parent, and price-box container
          const textSources = [
            text,
            $el.parent().text(),
            $el.closest('.price-box').text(),
            $el.closest('.price-wrapper').text(),
            $el.closest('[class*="price"]').text(),
          ];

          currency = currencyFromText(textSources, locale);

          prices.push({ price, currency });
          return;
        }
      }

      const priceStr = content || dataPrice || text;
      const parsed = parsePrice(priceStr, locale.hint, locale.currency);
      if (parsed && parsed.price > 0) {
        prices.push(parsed);
      }
    });

    if (prices.length > 0) break;
  }

  return findMostLikelyPrice(prices);
}

function extractGenericName($: CheerioAPI): string | null {
  for (const selector of genericNameSelectors) {
    const element = $(selector).first();
    if (element.length) {
      const text = element.text().trim();
      if (text && text.length > 0 && text.length < 500) {
        return text;
      }
    }
  }
  return null;
}

function extractGenericImage($: CheerioAPI, baseUrl: string): string | null {
  for (const selector of genericImageSelectors) {
    const element = $(selector).first();
    if (element.length) {
      const src =
        element.attr('src') ||
        element.attr('content') ||
        element.attr('data-zoom-image') ||
        element.attr('data-src');
      if (src) {
        try {
          return new URL(src, baseUrl).href;
        } catch (_e) {
          return src;
        }
      }
    }
  }
  return null;
}

function extractGenericStockStatus($: CheerioAPI): StockStatus {
  // First, check for schema.org availability - most reliable
  const availability = $('[itemprop="availability"]').attr('content') ||
                       $('[itemprop="availability"]').attr('href') || '';
  if (availability.toLowerCase().includes('outofstock') ||
      availability.toLowerCase().includes('discontinued') ||
      availability.toLowerCase().includes('preorder')) {
    return 'out_of_stock';
  }
  if (availability.toLowerCase().includes('instock') ||
      availability.toLowerCase().includes('available')) {
    return 'in_stock';
  }

  // Brazilian Portuguese wording. The English heuristics below never fire on a
  // pt-BR page: BR stores say "Produto indisponível" / "Esgotado" /
  // "Avise-me quando chegar", not "out of stock". Checked before the English
  // pass and only acted on when it actually decides something, so English
  // pages are unaffected.
  const htmlLang = ($('html').attr('lang') || '').toLowerCase();
  if (htmlLang.startsWith('pt')) {
    const ptArea = $('main, [role="main"], #main, .product-detail, .pdp-main, body')
      .first()
      .text()
      .slice(0, 8000);
    const ptStatus = brStockStatusFromText(ptArea);
    if (ptStatus !== 'unknown') {
      return ptStatus;
    }
  }

  // Be conservative - only check main product area text, not entire body
  // to avoid false positives from sidebar recommendations, etc.
  const mainContent = $('main, [role="main"], #main, .main-content, .product-detail, .pdp-main').text().toLowerCase();
  const textToCheck = mainContent || $('body').text().toLowerCase().slice(0, 5000);

  // Check for pre-order / coming soon indicators BEFORE checking add to cart
  // Some sites show a "Pre-order" button that looks like add to cart
  // NOTE: Be careful with generic phrases - "available in" matches "available in stock"!
  const preOrderComingSoonPhrases = [
    'coming soon',
    'available soon',
    'arriving soon',
    'releases on',
    'release date',
    'expected release',
    'launches on',
    'launching soon',
    'pre-order',
    'preorder',
    'pre order',
    'notify me when available',
    'notify when available',
    'sign up to be notified',
    'sign up for availability',
    'email me when available',
    'get notified when',
    'join the waitlist',
    'join waitlist',
    'not yet released',
    'not yet available',
    // Specific future availability phrases (avoid generic "available in" which matches "available in stock")
    'available starting',
    'available from',  // Usually followed by a date
    'ships in',        // Usually indicates future shipping
    'expected to ship',
    'estimated arrival',
  ];

  // Phrases that indicate the product is NOT coming soon (should not trigger out of stock)
  const inStockPhrases = [
    'in stock',
    'add to cart',
    'add to basket',
    'buy now',
    'available now',
    'ships today',
    'ships immediately',
    'ready to ship',
  ];

  // First, check if the page has strong in-stock indicators
  // If so, don't let pre-order phrase matching override it
  let hasInStockIndicator = false;
  for (const phrase of inStockPhrases) {
    if (textToCheck.includes(phrase)) {
      hasInStockIndicator = true;
      break;
    }
  }

  // Only check for pre-order/coming soon if we don't have a clear in-stock indicator
  if (!hasInStockIndicator) {
    for (const phrase of preOrderComingSoonPhrases) {
      if (textToCheck.includes(phrase)) {
        // Double check it's not just a section about pre-orders in general
        // by looking for the phrase near price/product context
        const phraseIndex = textToCheck.indexOf(phrase);
        const contextStart = Math.max(0, phraseIndex - 200);
        const contextEnd = Math.min(textToCheck.length, phraseIndex + 200);
        const context = textToCheck.substring(contextStart, contextEnd);

        // If the context mentions price, buy, cart, or product, it's likely about this product
        if (context.includes('$') || context.includes('price') ||
            context.includes('buy') || context.includes('cart') ||
            context.includes('order') || context.includes('purchase')) {
          return 'out_of_stock';
        }
      }
    }
  }

  // Check for explicit pre-order/coming soon elements
  const hasPreOrderBadge = $('[class*="pre-order" i]').length > 0 ||
                           $('[class*="preorder" i]').length > 0 ||
                           $('[class*="coming-soon" i]').length > 0 ||
                           $('[class*="comingsoon" i]').length > 0 ||
                           $('[data-testid*="pre-order" i]').length > 0 ||
                           $('[data-testid*="coming-soon" i]').length > 0 ||
                           $('button:contains("Pre-order")').length > 0 ||
                           $('button:contains("Preorder")').length > 0 ||
                           $('button:contains("Notify Me")').length > 0;

  if (hasPreOrderBadge) {
    return 'out_of_stock';
  }

  // Check for add to cart button - strong indicator of in stock
  // But make sure it's not a pre-order button
  const addToCartButtons = $('button[class*="add-to-cart" i], button[id*="add-to-cart" i], [data-testid*="add-to-cart" i], button:contains("Add to Cart"), input[value*="Add to Cart" i]');
  let hasRealAddToCart = false;

  addToCartButtons.each((_, el) => {
    const buttonText = $(el).text().toLowerCase();
    const buttonClass = $(el).attr('class')?.toLowerCase() || '';
    // Make sure it's not a pre-order or notify button
    if (!buttonText.includes('pre-order') &&
        !buttonText.includes('preorder') &&
        !buttonText.includes('notify') &&
        !buttonText.includes('waitlist') &&
        !buttonClass.includes('pre-order') &&
        !buttonClass.includes('preorder')) {
      hasRealAddToCart = true;
    }
  });

  if (hasRealAddToCart) {
    return 'in_stock';
  }

  // Check for explicit out-of-stock elements - be specific
  const hasOutOfStockBadge = $('[class*="out-of-stock" i]').length > 0 ||
                              $('[class*="sold-out" i]').length > 0 ||
                              $('[data-testid*="out-of-stock" i]').length > 0;

  if (hasOutOfStockBadge) {
    return 'out_of_stock';
  }

  // Strong out-of-stock phrases (must be exact matches to avoid false positives)
  const strongOutOfStockPhrases = [
    'this item is out of stock',
    'this product is out of stock',
    'currently out of stock',
    'this item is currently unavailable',
    'this product is currently unavailable',
    'temporarily out of stock',
    'this item is sold out',
  ];

  for (const phrase of strongOutOfStockPhrases) {
    if (textToCheck.includes(phrase)) {
      return 'out_of_stock';
    }
  }

  // Default to unknown rather than guessing
  return 'unknown';
}

export async function scrapePrice(url: string): Promise<ParsedPrice | null> {
  const product = await scrapeProduct(url);
  return product.price;
}
