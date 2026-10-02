import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchKrakenPrices } from '../prices.js';

test('public API selects USD pairs, maps XBT, reports unavailable assets', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return { ok: true, json: async () => ({
      error: [], result: url.includes('AssetPairs') ? {
        XXBTZUSD: { wsname: 'XBT/USD', altname: 'XBTUSD', status: 'online' },
        XXBTZEUR: { wsname: 'XBT/EUR', altname: 'XBTEUR', status: 'online' },
        OLD: { wsname: 'OLD/USD', altname: 'OLDUSD', status: 'cancel_only' },
      } : { XXBTZUSD: { c: ['60000', '1'] } },
    }) };
  });
  const r = await fetchKrakenPrices(['BTC', 'MIR', 'OLD']);
  assert.equal(r.prices.BTC.value, 60000);
  assert.deepEqual(r.missing, ['MIR', 'OLD']);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].endsWith('Ticker?pair=XBTUSD'));
});
test('API errors are surfaced', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ error: ['EGeneral:Rate limit'], result: {} }) }));
  await assert.rejects(fetchKrakenPrices(['BTC']), /Rate limit/);
});
test('HTTP failure is surfaced', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  await assert.rejects(fetchKrakenPrices(['BTC']), /503/);
});
test('invalid ticker is not coerced to a successful zero price', async t => {
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, json: async () => ({ error: [], result: url.includes('AssetPairs') ? {
    XXBTZUSD: { wsname: 'XBT/USD', altname: 'XBTUSD', status: 'online' },
  } : { XXBTZUSD: { c: ['NaN'] } } }) }));
  const r = await fetchKrakenPrices(['BTC']);
  assert.deepEqual(r.prices, {}); assert.deepEqual(r.missing, ['BTC']);
});
