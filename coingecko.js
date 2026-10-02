import { normalizeAsset } from './ledger.js';

const DAY = 86400000;
export const COINGECKO_IDS = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', TAO: 'bittensor',
  HYPE: 'hyperliquid', LINEA: 'linea', ONDO: 'ondo-finance', USDC: 'usd-coin', USDT: 'tether', DOGE: 'dogecoin' };

async function request(endpoint, signal) {
  let response;
  try { response = await fetch(`https://api.coingecko.com/api/v3/${endpoint}`, { signal }); }
  catch (error) {
    if (signal.aborted) throw error;
    throw new Error('CoinGecko inaccessible : connexion ou accès navigateur (CORS). Aucun cours de remplacement inventé.');
  }
  if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}${response.status === 429 ? ' : limite de requêtes, patientez avant de réessayer' : ''}.`);
  const data = await response.json();
  if (!data || typeof data !== 'object') throw new Error('CoinGecko : réponse de marché invalide.');
  if (data.error || data.status?.error_code) throw new Error('CoinGecko : requête refusée ou accès public indisponible.');
  return data;
}

export function parseGeckoPrices(data) {
  if (!data || !Array.isArray(data.prices) || !data.prices.length) throw new Error('CoinGecko : historique de prix absent.');
  const points = data.prices.map(row => {
    if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] < 0 ||
      typeof row[1] !== 'number' || !Number.isFinite(row[1]) || row[1] <= 0) {
      throw new Error('CoinGecko : prix ou date invalide.');
    }
    return { time: row[0], price: row[1] };
  });
  for (let i = 1; i < points.length; i++) {
    if (points[i].time <= points[i - 1].time) throw new Error('CoinGecko : prix dupliqués ou non chronologiques.');
  }
  return points;
}

export function geckoDays(range, now = Date.now()) {
  if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start || !Number.isFinite(now)) {
    throw new Error('CoinGecko : période de marché invalide.');
  }
  const requested = Math.max(2, Math.ceil((now - range.start) / DAY) + 1);
  return requested > 90 ? 365 : requested;
}

function findGeckoCoin(coins, asset, id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`${asset} : indiquez l’identifiant CoinGecko exact, pas seulement son symbole.`);
  const coin = coins.find(c => c?.id === id);
  if (!coin || typeof coin.symbol !== 'string' || normalizeAsset(coin.symbol.toUpperCase()) !== asset) {
    throw new Error(`CoinGecko : l’identifiant ${id} ne correspond pas au symbole ${asset}. Vérifiez l’actif exact ; les symboles peuvent être ambigus.`);
  }
  return coin;
}

export async function fetchGeckoQuotes(assets, { ids = {}, catalog = null, now = Date.now() } = {}) {
  const prices = {}, missing = [], wanted = new Map();
  for (const asset of new Set(assets)) {
    const id = ids[asset] ?? COINGECKO_IDS[asset];
    if (!id) missing.push(asset);
    else wanted.set(asset, id);
  }
  if (!wanted.size) return { prices, missing };
  const signal = AbortSignal.timeout(20000);
  const coins = catalog || await request('coins/list', signal);
  if (!Array.isArray(coins)) throw new Error('CoinGecko : catalogue invalide.');
  for (const [asset, id] of wanted) findGeckoCoin(coins, asset, id);
  const query = new URLSearchParams({
    ids: [...new Set(wanted.values())].join(','), vs_currencies: 'usd', include_last_updated_at: 'true',
  });
  const data = await request(`simple/price?${query}`, signal);
  for (const [asset, id] of wanted) {
    const quote = data[id];
    if (!quote || typeof quote.usd !== 'number' || !Number.isFinite(quote.usd) || quote.usd <= 0 ||
      !Number.isSafeInteger(quote.last_updated_at) || quote.last_updated_at <= 0 ||
      quote.last_updated_at * 1000 > now + 300000) {
      missing.push(asset);
    } else prices[asset] = { value: quote.usd, date: quote.last_updated_at * 1000, source: `CoinGecko · prix agrégé (${id})` };
  }
  return { prices, missing };
}

export async function fetchGeckoPrices(asset, range, { id, catalog = null, signal, now = Date.now() } = {}) {
  const days = geckoDays(range, now);
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`${asset} : indiquez l’identifiant CoinGecko exact, pas seulement son symbole.`);
  const timeout = AbortSignal.timeout(20000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const coins = catalog || await request('coins/list', requestSignal);
  if (!Array.isArray(coins)) throw new Error('CoinGecko : catalogue invalide.');
  const coin = findGeckoCoin(coins, asset, id);
  const query = new URLSearchParams({ vs_currency: 'usd', days: String(days) });
  const data = await request(`coins/${encodeURIComponent(id)}/market_chart?${query}`, requestSignal);
  return { source: 'coingecko', points: parseGeckoPrices(data), id, name: coin.name,
    catalog: coins, days, maxGap: (days > 90 ? DAY : 3600000) * 3, fetchedAt: Date.now() };
}

export function geckoWindow(points, trades, range, maxGap) {
  const atTime = time => {
    const right = points.findIndex(p => p.time >= time);
    if (right >= 0 && points[right].time === time) return points[right];
    if (right <= 0) return null;
    const before = points[right - 1], after = points[right];
    if (after.time - before.time > maxGap) return null;
    return { time, price: before.price + (after.price - before.price) * (time - before.time) / (after.time - before.time), interpolated: true };
  };
  const visible = points.filter(p => p.time >= range.start && p.time <= range.end);
  for (const time of [range.start, range.end]) {
    const boundary = atTime(time);
    if (boundary && !visible.some(p => p.time === time)) visible.push(boundary);
  }
  visible.sort((a, b) => a.time - b.time);
  const segments = [];
  for (const point of visible) {
    const previous = segments.at(-1)?.at(-1);
    if (!previous || point.time - previous.time > maxGap) segments.push([]);
    segments.at(-1).push(point);
  }
  const inRange = trades.filter(t => t.time >= range.start && t.time <= range.end);
  const markers = [], excluded = [];
  for (const trade of inRange) {
    const point = atTime(trade.time);
    if (!point) excluded.push(trade);
    else markers.push({ time: trade.time, price: point.price, side: trade.side, trades: [trade] });
  }
  return { points: visible, segments, markers, excluded,
    truncated: !visible.length || visible[0].time > range.start + maxGap || visible.at(-1).time < range.end - maxGap };
}
