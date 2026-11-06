export interface ParsedPrice {
  price: number;
  currency: string;
}

// Decimal-separator convention of the page/currency.
//   'dot'   -> en-US style: 1,234.56
//   'comma' -> pt-BR / EU style: 1.234,56
export type DecimalHint = 'dot' | 'comma';

// Currency symbols and their codes.
// NOTE: 'R$' must be looked up before '$' — see parsePrice().
const currencyMap: Record<string, string> = {
  'R$': 'BRL',
  'BRL': 'BRL',
  '$': 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  'Fr.': 'CHF',
  'CHF': 'CHF',
  'CAD': 'CAD',
  'AUD': 'AUD',
  'USD': 'USD',
  'EUR': 'EUR',
  'GBP': 'GBP',
};

// Currencies whose locale writes 1.234,56 (dot = thousands, comma = decimal).
const COMMA_DECIMAL_CURRENCIES = new Set(['BRL', 'EUR']);

// Patterns to match prices in text.
// Order matters: the R$ pattern comes first because 'R$' contains '$', so the
// bare-symbol pattern below would otherwise match it and report USD.
const pricePatterns: Array<{ re: RegExp; hint?: DecimalHint }> = [
  // R$ 1.234,56 / R$1.234,56 / R$&nbsp;1.234,56 (Brazilian real)
  { re: /(?<currency>R\$)\s*(?<price>[\d.,]+)/, hint: 'comma' },
  // $29.99 or $29,99 or $ 29.99
  { re: /(?<currency>[$€£¥₹])\s*(?<price>[\d,]+\.?\d*)/ },
  // CHF 29.99 or Fr. 29.99 (Swiss franc prefix)
  { re: /(?<currency>CHF|Fr\.)\s*(?<price>[\d'\u2019.,]+)/i },
  // 1.234,56 BRL / 29.99 USD / 29,99 EUR
  { re: /(?<price>[\d.,]+)\s*(?<currency>BRL|USD|EUR|GBP|CAD|AUD|JPY|INR|CHF)/i },
  // Plain number, with or without grouping (fallback).
  //
  // Two alternatives on purpose. The first needs a real group separator, so it
  // reads 2.376,00 / 1,234.56 / 1 234,56. The second takes an ungrouped number
  // like 2376.00 — which is how a machine-readable price is written
  // (<meta itemprop="price" content="2376.00">), and what the single pattern
  // this replaces got wrong: it required grouping to be optional but a group
  // to be 3 digits, so "2376.00" matched only its first three characters and a
  // R$ 2.376,00 product was recorded as R$ 237. Any price over 999 written
  // without a separator was truncated, in every currency.
  { re: /(?<price>\d{1,3}(?:[,.\s]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/ },
];

// Monthly-payment / financing noise, English and Brazilian Portuguese.
// Brazilian stores print "10x de R$ 176,20 sem juros" right next to the real
// price, and "no cartão" / "parcelado" for the installment total, which is
// higher than the cash (PIX / "à vista") price.
const FINANCING_PATTERNS: RegExp[] = [
  /\/mo\b/,
  /per month/,
  /monthly payment/,
  /a month/,
  /payments starting/,
  /payment of/,
  /payments of/,
  /\d+\s*payments?\b/,
  /\d+\s*mo\b/,
  // pt-BR
  /\/m[êe]s\b/,
  /por m[êe]s\b/,
  /sem juros/,
  /\d+\s*x\s*(?:de\s*)?r?\$/,
  /\d+\s*x\s*sem/,
  /em at[ée]\s*\d+\s*x/,
  /parcelad[oa]/,
  /no cart[ãa]o/,
  /juros/,
];

function isFinancingText(lowerText: string): boolean {
  return FINANCING_PATTERNS.some((re) => re.test(lowerText));
}

/**
 * Parse a price out of a string.
 *
 * `fallbackCurrency` is what to report when the text carries no currency at
 * all — a bare "237,00" in its own element, which is how most storefronts mark
 * up a price. It used to be hardcoded USD (the plain-number pattern below has
 * no currency group, so it fell through to the '$' default), which labelled
 * Brazilian prices as dollars on any store without a site-specific scraper.
 * The caller knows the page's locale; pass it.
 */
export function parsePrice(
  text: string,
  hint?: DecimalHint,
  fallbackCurrency = 'USD'
): ParsedPrice | null {
  if (!text) return null;

  // Clean up the text. &nbsp; (U+00A0) is what Amazon/Pichau put between the
  // currency symbol and the number, and \s does not match it in every engine.
  const cleanText = text.replace(/[\u00a0\u202f\u2007]/g, ' ').trim().replace(/\s+/g, ' ');

  // Reject monthly payment/financing prices
  const lowerText = cleanText.toLowerCase();
  if (isFinancingText(lowerText)) {
    return null;
  }

  for (const { re, hint: patternHint } of pricePatterns) {
    const match = cleanText.match(re);
    if (match && match.groups) {
      const priceStr = match.groups.price || match[1];
      const currencySymbol = match.groups.currency;

      if (priceStr) {
        const currency = currencySymbol
          ? currencyMap[currencySymbol] ||
            currencyMap[currencySymbol.toUpperCase()] ||
            fallbackCurrency
          : fallbackCurrency;
        // Precedence: explicit caller hint > hint attached to the pattern >
        // hint implied by the currency we just resolved.
        const effectiveHint: DecimalHint | undefined =
          hint ||
          patternHint ||
          (COMMA_DECIMAL_CURRENCIES.has(currency) ? 'comma' : undefined);
        const price = normalizePrice(priceStr, effectiveHint);
        if (price !== null && price > 0) {
          return { price, currency };
        }
      }
    }
  }

  // Try to extract just a number as fallback
  const numberMatch = cleanText.match(/[\d.,]+/);
  if (numberMatch) {
    const price = normalizePrice(numberMatch[0], hint);
    if (price !== null && price > 0) {
      return { price, currency: fallbackCurrency };
    }
  }

  return null;
}

export function normalizePrice(priceStr: string, hint?: DecimalHint): number | null {
  if (!priceStr) return null;

  // Remove spaces (including the non-breaking kind used as a group separator)
  // Swiss grouping uses an apostrophe: CHF 1'234.56
  let normalized = priceStr.replace(/[\s\u00a0\u202f\u2007'\u2019]/g, '');
  if (!/\d/.test(normalized)) return null;

  const lastDot = normalized.lastIndexOf('.');
  const lastComma = normalized.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    // Both separators present: the LAST one is the decimal separator.
    // "1.234,56" -> comma decimal.  "1,234.56" -> dot decimal.
    if (lastComma > lastDot) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = normalized.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    // Only commas. "1.234,56" can't happen here; "176,20" is decimal,
    // "1,234" is a thousands group.
    normalized = /,\d{1,2}$/.test(normalized)
      ? normalized.replace(/,/g, '.')
      : normalized.replace(/,/g, '');
  } else if (lastDot !== -1) {
    // Only dots — the ambiguous case. "7.700" is R$ 7.700 in Brazil and
    // $7.70 nowhere: a 3-digit group after the last dot is a thousands
    // separator in every locale. More than one dot is always thousands.
    //
    // Nothing else is: a group separator is exactly three digits, so with one
    // dot and one or two digits after it the dot is a decimal point whatever
    // the page's locale. This used to also treat any 2-digit tail as thousands
    // on a comma-decimal page, which turned the machine-readable "2376.00"
    // into 237600.
    const dots = (normalized.match(/\./g) || []).length;
    const trailingGroup = normalized.slice(lastDot + 1);
    const dotIsThousands = dots > 1 || trailingGroup.length === 3;
    if (dotIsThousands) {
      normalized = normalized.replace(/\./g, '');
    }
  }

  const price = parseFloat(normalized);
  return isNaN(price) ? null : Math.round(price * 100) / 100;
}

export function extractPricesFromText(html: string, hint?: DecimalHint): ParsedPrice[] {
  const prices: ParsedPrice[] = [];
  const seen = new Set<number>();

  // Match all price-like patterns in the HTML
  const allMatches = html.matchAll(
    /R\$[\s\u00a0]*[\d.,]+|(?:[$€£¥₹])\s*[\d,]+\.?\d*|(?:CHF|Fr\.)\s*[\d,]+\.?\d*|[\d,]+\.?\d*\s*(?:USD|EUR|GBP|CAD|AUD|CHF|BRL)/gi
  );

  for (const match of allMatches) {
    const parsed = parsePrice(match[0], hint);
    if (parsed && !seen.has(parsed.price)) {
      seen.add(parsed.price);
      prices.push(parsed);
    }
  }

  return prices;
}

export function findMostLikelyPrice(prices: ParsedPrice[]): ParsedPrice | null {
  if (prices.length === 0) return null;
  if (prices.length === 1) return prices[0];

  // Filter out very small prices (likely coupons, savings amounts, not actual
  // product prices). The floor is currency-aware: R$ 5 buys nothing, and a
  // real BRL product price is practically never below ~R$ 20.
  const floorFor = (currency: string) => (currency === 'BRL' ? 20 : 5);

  const validPrices = prices.filter((p) => p.price >= floorFor(p.currency));

  // If nothing clears the floor, try a lower threshold but above typical
  // coupon amounts
  if (validPrices.length === 0) {
    const lowThresholdPrices = prices.filter((p) => p.price >= 2);
    if (lowThresholdPrices.length > 0) {
      lowThresholdPrices.sort((a, b) => a.price - b.price);
      return lowThresholdPrices[0];
    }
    // Fall back to original list if nothing matches
    return prices[0];
  }

  // Sort by price - the lowest valid price is often the sale/current price
  validPrices.sort((a, b) => a.price - b.price);

  return validPrices[0];
}
