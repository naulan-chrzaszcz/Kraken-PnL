import test from 'node:test';
import assert from 'node:assert/strict';
import { PERIODS, periodRange, ledgerObservations, tradeMarkers, parseCandles, chartWindow, fetchCandles } from '../market.js';

const end = Date.UTC(2026, 9, 2, 12);
const first = Date.UTC(2024, 8, 1);
const pair = { key: 'XXBTZUSD', altname: 'XBTUSD', wsname: 'XBT/USD', status: 'online' };
const candle = (time, overrides = {}) => ({ time, open: 100, high: 110, low: 95, close: 105, volume: 4, provisional: false, ...overrides });
test('requested periods use bounded Kraken resolutions and calendar month dates', () => {
  assert.deepEqual(PERIODS, ['1W', '1M', '3M', '6M', '1Y', 'ALL']);
  assert.deepEqual(PERIODS.map(p => periodRange(p, end, first).interval), [60, 240, 240, 1440, 1440, 10080]);
  assert.equal(periodRange('1W', end, first).start, end - 7 * 86400000);
  assert.equal(periodRange('1M', Date.UTC(2025, 2, 31, 12), first).start, Date.UTC(2025, 1, 28, 12));
  assert.equal(periodRange('1Y', Date.UTC(2024, 1, 29), first).start, Date.UTC(2023, 1, 28));
  assert.equal(periodRange('ALL', end, first).start, first);
  assert.equal(periodRange('ALL', end, Date.UTC(2000, 0, 1)).interval, 21600);
  assert.throws(() => periodRange('bogus', end, first), /invalide/);
});
test('observations only use real ledger values, no invented points or prices', () => {
  const rows = [
    { asset: 'BTC', timestamp: 1, balance: 1, balanceusd: 100, amount: 1, amountusd: 100 },
    { asset: 'BTC', timestamp: 1, balance: 0, balanceusd: 0, amount: -1, amountusd: -101 },
    { asset: 'BTC', timestamp: 3, balance: 1, balanceusd: null, amount: 1, amountusd: null },
    { asset: 'ETH', timestamp: 4, balance: 1, balanceusd: 50, amount: 1, amountusd: 50 },
  ];
  assert.deepEqual(ledgerObservations(rows, 'BTC'), [{ time: 1, price: 101 }]);
});
test('trade markers exclude deposits, rewards, Earn and fee-only rows, include conversions and dust', () => {
  const rows = [
    { txid: 'a', refid: 'b', type: 'spend', asset: 'USD', timestamp: 1, amount: -200, amountusd: -200, fee: 2 },
    { txid: 'b', refid: 'b', type: 'receive', asset: 'BTC', timestamp: 1, amount: 2, amountusd: 198, fee: .01 },
    { txid: 'c', refid: 's', type: 'trade', asset: 'BTC', timestamp: 2, amount: -.5, amountusd: -75, fee: .001 },
    { txid: 'd', refid: 's', type: 'trade', asset: 'ETH', timestamp: 2, amount: 1, amountusd: 75, fee: 0 },
    { txid: 'e', refid: 'earn', type: 'earn', asset: 'BTC', timestamp: 3, amount: .001, amountusd: .2, fee: 0 },
    { txid: 'f', refid: 'deposit', type: 'deposit', asset: 'BTC', timestamp: 4, amount: 1, amountusd: 150, fee: 0 },
    { txid: 'g', refid: 'dust', type: 'spend', subtype: 'dustsweeping', asset: 'BTC', timestamp: 5, amount: -.001, amountusd: -.15, fee: 0 },
    { txid: 'h', refid: 'dust', type: 'receive', subtype: 'dustsweeping', asset: 'EUR', timestamp: 5, amount: .1, amountusd: .15, fee: 0 },
    { txid: 'i', refid: 'fee', type: 'trade', asset: 'BTC', timestamp: 6, amount: 0, amountusd: 0, fee: .001 },
  ];
  const markers = tradeMarkers(rows, 'BTC');
  assert.equal(markers.length, 3);
  assert.deepEqual(markers.map(m => m.side), ['buy', 'sell', 'sell']);
  assert.equal(markers[0].price, 99); assert.equal(markers[0].fees, .01);
  assert.equal(markers[1].quantity, .5); assert.equal(markers[2].dust, true);
  assert.ok(markers.every(m => m.matched));
});
test('same refid trade legs for one asset are consolidated; unpaired and missing prices retained', () => {
  const rows = [
    { txid: 'a', refid: 'multi', type: 'spend', asset: 'BTC', timestamp: 1, amount: -.1, amountusd: -10, fee: 0 },
    { txid: 'b', refid: 'multi', type: 'spend', asset: 'BTC', timestamp: 1, amount: -.2, amountusd: -20, fee: 0 },
    { txid: 'c', refid: '', type: 'receive', asset: 'BTC', timestamp: 2, amount: 1, amountusd: null, fee: 0 },
  ];
  const m = tradeMarkers(rows, 'BTC');
  assert.equal(m.length, 2); assert.ok(Math.abs(m[0].quantity - .3) < 1e-12);
  assert.equal(m[1].price, null); assert.equal(m[1].matched, false);
});
test('OHLC validates prices, order and volume, marks only the final candle provisional', () => {
  const raw = { XXBTZUSD: [[1, '100', '110', '95', '105', '103', '4', 12], [2, '105', '115', '100', '110', '108', '2', 10]] };
  const parsed = parseCandles(raw, pair);
  assert.equal(parsed[0].time, 1000); assert.equal(parsed[0].provisional, false); assert.equal(parsed[1].provisional, true);
  assert.throws(() => parseCandles({ XXBTZUSD: [[1, '100', '90', '95', '105', '103', '4', 12]] }, pair), /incohérente/);
  assert.throws(() => parseCandles({ XXBTZUSD: [[1, 'NaN', '110', '95', '105', '103', '4', 12]] }, pair), /numérique/);
  assert.throws(() => parseCandles({ XXBTZUSD: [raw.XXBTZUSD[0], raw.XXBTZUSD[0]] }, pair), /dupliquée/);
  assert.throws(() => parseCandles({ XXBTZUSD: [...raw.XXBTZUSD].reverse() }, pair), /chronologiques/);
  assert.throws(() => parseCandles({}, pair), /absente/);
});
test('markers use containing candle, preserve exact boundary and report gaps, no nearest-date snapping', () => {
  const hour = 3600000, range = { start: 0, end: hour * 4, interval: 60 };
  const candles = [candle(0), candle(hour), candle(hour * 3)];
  const markers = [
    { time: 1, side: 'buy' }, { time: 2, side: 'buy' }, { time: hour, side: 'sell' },
    { time: hour * 2 + 1, side: 'buy' }, { time: hour * 5, side: 'sell' },
  ];
  const r = chartWindow(candles, markers, range);
  assert.equal(r.markers.length, 2); assert.equal(r.markers[0].trades.length, 2);
  assert.equal(r.markers[1].index, 1); assert.equal(r.excluded.length, 1);
  assert.equal(r.excluded[0].time, hour * 2 + 1); assert.equal(r.trades.length, 4);
});
test('old history truncation is explicit, never synthesized from ledger transactions', () => {
  const range = { start: 0, end: 100 * 3600000, interval: 60 };
  const r = chartWindow([candle(90 * 3600000)], [{ time: 10, side: 'buy' }], range);
  assert.equal(r.truncated, true); assert.equal(r.markers.length, 0); assert.equal(r.excluded.length, 1);
});
test('market API requests only asset symbol, resolution and since, without private history', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ error: [], result: url.includes('AssetPairs') ? { XXBTZUSD: pair } : {
      XXBTZUSD: [[Math.floor(end / 1000), '100', '110', '95', '105', '103', '4', 12]], last: Math.floor(end / 1000),
    } }) };
  });
  const data = await fetchCandles('BTC', periodRange('1W', end, first));
  assert.equal(data.pair, 'XBT/USD'); assert.equal(data.candles.length, 1);
  assert.equal(calls.length, 2);
  const url = new URL(calls[1]); assert.equal(url.searchParams.get('pair'), 'XBTUSD'); assert.equal(url.searchParams.get('interval'), '60');
  assert.deepEqual([...url.searchParams.keys()], ['pair', 'interval', 'since']);
});
test('missing USD pairs and server errors are surfaced, no fake candle fallback', async t => {
  await assert.rejects(fetchCandles('MIR', periodRange('ALL', end, first), { pairs: {} }), /aucune paire USD/);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  await assert.rejects(fetchCandles('BTC', periodRange('1M', end, first)), /503/);
});
