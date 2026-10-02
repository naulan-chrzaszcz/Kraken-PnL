import { findUSDPair, requestKrakenPublic } from './prices.js';

export const PERIODS = ['1W', '1M', '3M', '6M', '1Y', 'ALL'];
const INTERVALS = { '1W': 60, '1M': 240, '3M': 240, '6M': 1440, '1Y': 1440, ALL: 10080 };
const DAY = 86400000;

export function periodRange(period, end, first) {
  if (!PERIODS.includes(period) || !Number.isFinite(end) || !Number.isFinite(first)) throw new Error('Période du graphique invalide.');
  let start;
  if (period === 'ALL') start = Math.min(first, end);
  else if (period === '1W') start = end - 7 * DAY;
  else {
    const date = new Date(end), day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - ({ '1M': 1, '3M': 3, '6M': 6, '1Y': 12 }[period]));
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
    start = date.getTime();
  }
  const interval = period === 'ALL' && end - start > 710 * 7 * DAY ? 21600 : INTERVALS[period];
  return { start, end, interval };
}

export function ledgerObservations(rows, asset) {
  const values = new Map();
  for (const r of rows.filter(r => r.asset === asset)) {
    const price = r.balance > 0 && r.balanceusd > 0 ? r.balanceusd / r.balance :
      r.amount !== 0 && Math.abs(r.amountusd) > 0 ? Math.abs(r.amountusd / r.amount) : null;
    if (price !== null && Number.isFinite(price)) values.set(r.timestamp, { time: r.timestamp, price });
  }
  return [...values.values()].sort((a, b) => a.time - b.time);
}

export function tradeMarkers(rows, asset) {
  const groups = new Map();
  for (const r of rows.filter(r => ['trade', 'spend', 'receive'].includes(r.type) && r.amount !== 0)) {
    const key = r.refid || r.txid;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const markers = [];
  for (const [refid, group] of groups) {
    for (const side of ['buy', 'sell']) {
      const legs = group.filter(r => r.asset === asset && (side === 'buy' ? r.amount > 0 : r.amount < 0));
      if (!legs.length) continue;
      const quantity = legs.reduce((sum, r) => sum + Math.abs(r.amount), 0);
      const fees = legs.reduce((sum, r) => sum + r.fee, 0);
      const usdKnown = legs.every(r => r.amountusd !== null && r.amountusd !== 0);
      const amountUSD = usdKnown ? legs.reduce((sum, r) => sum + Math.abs(r.amountusd), 0) : null;
      markers.push({
        refid, side, time: Math.min(...legs.map(r => r.timestamp)), quantity, fees,
        price: amountUSD === null ? null : amountUSD / quantity, amountUSD,
        matched: group.some(r => r.amount > 0) && group.some(r => r.amount < 0),
        dust: legs.some(r => r.subtype === 'dustsweeping'),
      });
    }
  }
  return markers.sort((a, b) => a.time - b.time);
}

export function parseCandles(result, pair) {
  const raw = result[pair.key] || result[pair.altname];
  if (!Array.isArray(raw)) throw new Error('Kraken : série de bougies absente pour cette paire.');
  const seen = new Set();
  const candles = raw.map((r, index) => {
    if (!Array.isArray(r) || r.length < 8) throw new Error('Kraken : format OHLC invalide.');
    const values = [r[0], r[1], r[2], r[3], r[4], r[6]].map(v => (v === '' || v === null || v === undefined) ? NaN : Number(v));
    if (values.some(v => !Number.isFinite(v))) throw new Error('Kraken : OHLC contient une valeur non numérique.');
    const [seconds, open, high, low, close, volume] = values;
    if (!Number.isSafeInteger(seconds) || seconds < 0 || low <= 0 || high < Math.max(open, close) ||
      low > Math.min(open, close) || volume < 0 || seen.has(seconds)) throw new Error('Kraken : bougie incohérente ou dupliquée.');
    seen.add(seconds);
    return { time: seconds * 1000, open, high, low, close, volume, provisional: index === raw.length - 1 };
  });
  for (let i = 1; i < candles.length; i++) if (candles[i].time <= candles[i - 1].time) throw new Error('Kraken : bougies non chronologiques.');
  return candles;
}

export function chartWindow(candles, markers, range) {
  const duration = range.interval * 60000;
  const visible = candles.filter(c => c.time + duration > range.start && c.time <= range.end);
  const inRange = markers.filter(m => m.time >= range.start && m.time <= range.end);
  const buckets = new Map();
  const excluded = [];
  for (const marker of inRange) {
    let index = -1;
    // Half-open candle intervals keep boundary trades in the next candle, never across a data gap.
    for (let i = 0; i < visible.length; i++) if (marker.time >= visible[i].time && marker.time < visible[i].time + duration) { index = i; break; }
    if (index < 0) { excluded.push(marker); continue; }
    const key = `${index}|${marker.side}`;
    if (!buckets.has(key)) buckets.set(key, { index, side: marker.side, trades: [] });
    buckets.get(key).trades.push(marker);
  }
  return {
    candles: visible, markers: [...buckets.values()], excluded, trades: inRange,
    truncated: visible.length > 0 && visible[0].time > range.start + duration,
  };
}

export async function fetchCandles(asset, range, { pairs = null, signal } = {}) {
  const timeout = AbortSignal.timeout(20000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const catalog = pairs || await requestKrakenPublic('AssetPairs', requestSignal);
  const pair = findUSDPair(catalog, asset);
  if (!pair) throw new Error(`${asset} : aucune paire USD Kraken active. Les observations du fichier restent accessibles, mais aucune bougie ne sera inventée.`);
  const query = new URLSearchParams({ pair: pair.altname, interval: String(range.interval), since: String(Math.max(0, Math.floor(range.start / 1000) - range.interval * 60)) });
  const result = await requestKrakenPublic(`OHLC?${query}`, requestSignal);
  return { candles: parseCandles(result, pair), pair: pair.wsname, pairs: catalog, fetchedAt: Date.now() };
}
