/**
 * Coins named after a real company or one of its products (the owner, 5 Oct: "these are scam coins, not interested in
 * trading memecoin APPLE NVIDIA, makes no sense"): never bought by any strategy, never sent to the phone. That evening
 * AAPLE AI fell −89 % and Grok AI −98 % within a minute of a TEST entry, and Addidas went $877K → $122K.
 *
 * Matched on the coin's name and symbol, word by word, and inside one-word names for brands of 6+ letters ("NvidiaAI").
 * A few often-misspelled brands also match one letter off ("Addidas"); others only as written or as a listed misspelling
 * ("AAPLE"), so "Finance", "Phone", "Metal" or "Pineapple" are not caught by Binance, iPhone, Meta or Apple.
 */
export const BRANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Apple: ['apple', 'aaple', 'appl', 'iphone', 'macbook'], NVIDIA: ['nvidia', 'nvda', 'nvida'], Adidas: ['adidas'], Nike: ['nike'],
  Google: ['google', 'alphabet', 'gemini', 'youtube'], Microsoft: ['microsoft', 'msft', 'xbox'], OpenAI: ['openai', 'chatgpt'],
  Anthropic: ['anthropic', 'claude'], xAI: ['grok', 'xai'], Tesla: ['tesla', 'tsla', 'cybertruck'], SpaceX: ['spacex', 'starlink', 'neuralink'],
  Amazon: ['amazon', 'amzn'], Meta: ['meta', 'facebook', 'instagram', 'whatsapp'], TikTok: ['tiktok', 'bytedance'], Netflix: ['netflix'],
  Disney: ['disney', 'pixar'], 'Coca-Cola': ['cocacola'], Pepsi: ['pepsi'], "McDonald's": ['mcdonalds', 'mcdonald'], Starbucks: ['starbucks'],
  Samsung: ['samsung'], Sony: ['sony', 'playstation'], Nintendo: ['nintendo'], AMD: ['amd'], IBM: ['ibm'],
  TSMC: ['tsmc'], DeepSeek: ['deepseek'], Perplexity: ['perplexity'], Gucci: ['gucci'], Prada: ['prada'], Chanel: ['chanel'],
  'Louis Vuitton': ['louisvuitton'], Rolex: ['rolex'], Ferrari: ['ferrari'], Lamborghini: ['lamborghini'], Porsche: ['porsche'], BMW: ['bmw'],
  Mercedes: ['mercedes'], Visa: ['visa'], Mastercard: ['mastercard'], PayPal: ['paypal'], BlackRock: ['blackrock'], JPMorgan: ['jpmorgan'],
  Robinhood: ['robinhood'], Coinbase: ['coinbase'], Binance: ['binance'], Airbnb: ['airbnb'], Spotify: ['spotify'],
  Walmart: ['walmart'], 'Red Bull': ['redbull'], Boeing: ['boeing'],
});

/** Brands written wrong on purpose often enough to match one letter off. */
const FUZZY = new Set(['adidas', 'nvidia', 'google', 'amazon', 'samsung', 'chatgpt', 'anthropic', 'robinhood', 'coinbase', 'starbucks', 'mcdonalds',
  'lamborghini', 'netflix', 'microsoft', 'nintendo', 'playstation', 'instagram', 'facebook', 'deepseek']);

const words = (s: string): string[] => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/** One edit (insert, delete or replace a letter) or none between a and b. */
function oneOff(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** The company a coin's name or symbol names, as a reason text, or null. */
export function brandName(...texts: Array<string | null | undefined>): string | null {
  const ws = texts.flatMap(t => t ? words(t) : []);
  // Names written as one word ("NvidiaAI", "ChatGPTCoin") are caught by the joined text for brands of 6+ letters.
  const joined = texts.map(t => (t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')).join(' ');
  for (const [brand, variants] of Object.entries(BRANDS)) {
    for (const v of variants) {
      const hit = ws.find(w => w === v || (FUZZY.has(v) && w.length >= 6 && oneOff(w, v))) ?? (v.length >= 6 && joined.includes(v) ? v : null);
      if (hit) return `BRAND_NAME: "${hit}" names ${brand}, a real company: brand-name coins are scams (owner, 5 Oct)`;
    }
  }
  return null;
}
