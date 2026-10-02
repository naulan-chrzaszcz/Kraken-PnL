import { normalizeAsset } from './ledger.js';

export async function requestKrakenPublic(endpoint, signal) {
  const response = await fetch(`https://api.kraken.com/0/public/${endpoint}`, { signal });
  if (!response.ok) throw new Error(`API Kraken : HTTP ${response.status}.`);
  const data = await response.json();
  if (!Array.isArray(data.error) || data.error.length || !data.result) throw new Error(`API Kraken : ${data.error?.join(', ') || 'réponse invalide'}.`);
  return data.result;
}

export function findUSDPair(pairs, asset) {
  const entry = Object.entries(pairs).find(([, pair]) => {
    if (!pair.wsname || pair.status !== 'online') return false;
    const [base, quote] = pair.wsname.split('/');
    return quote === 'USD' && normalizeAsset(base) === asset;
  });
  return entry ? { key: entry[0], ...entry[1] } : null;
}

export async function fetchKrakenPrices(assets) {
  const signal = AbortSignal.timeout(20000);
  const pairs = await requestKrakenPublic('AssetPairs', signal);
  const wanted = new Map();
  for (const pair of Object.values(pairs)) {
    if (!pair.wsname || pair.status !== 'online') continue;
    const [base, quote] = pair.wsname.split('/');
    const symbol = normalizeAsset(base);
    if (quote === 'USD' && assets.includes(symbol) && !wanted.has(symbol)) wanted.set(symbol, pair.altname);
  }
  const prices = {}, missing = assets.filter(a => !wanted.has(a));
  if (!wanted.size) return { prices, missing };
  const tickers = await requestKrakenPublic(`Ticker?pair=${encodeURIComponent([...wanted.values()].join(','))}`, signal);
  const date = Date.now();
  for (const [asset, name] of wanted) {
    const key = Object.keys(pairs).find(k => pairs[k].altname === name);
    const ticker = tickers[name] || tickers[key];
    const value = Number(ticker?.c?.[0]);
    if (!Number.isFinite(value) || value <= 0) missing.push(asset);
    else prices[asset] = { value, date, source: 'Kraken · dernier échange' };
  }
  return { prices, missing };
}
