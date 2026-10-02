import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeckoPrices, fetchGeckoPrices, fetchGeckoQuotes, geckoWindow, geckoDays } from '../coingecko.js';
import { parseCSV, analyze } from '../ledger.js';

test('CoinGecko prices are real chronological positive samples, not fabricated OHLC', () => {
  assert.deepEqual(parseGeckoPrices({ prices: [[1, 10], [2, 20]] }), [{ time: 1, price: 10 }, { time: 2, price: 20 }]);
  for (const prices of [[], [[1, 0]], [[1, '10']], [[1, NaN]], [[2, 10], [1, 20]], [[1, 10], [1, 20]]]) {
    assert.throws(() => parseGeckoPrices({ prices }), /CoinGecko/);
  }
  assert.throws(() => parseGeckoPrices(null), /CoinGecko/);
});
test('daily CoinGecko history uses a common 365-day request for all long periods', () => {
  const now = 700 * 86400000;
  for (const days of [91, 180, 365, 700]) assert.equal(geckoDays({ start: now - days * 86400000, end: now }, now), 365);
  assert.equal(geckoDays({ start: now - 89 * 86400000, end: now }, now), 90);
  for (const range of [null, { start: NaN, end: now }, { start: now, end: now - 1 }]) assert.throws(() => geckoDays(range, now), /période/);
});
test('CoinGecko markers retain exact trade dates and interpolate only within nearby market samples', () => {
  const points = [{ time: 1000, price: 10 }, { time: 2000, price: 20 }, { time: 10000, price: 40 }];
  const trades = [{ time: 1500, side: 'buy' }, { time: 2000, side: 'sell' },
    { time: 5000, side: 'sell' }, { time: 11000, side: 'buy' }, { time: 500, side: 'buy' }];
  const data = geckoWindow(points, trades, { start: 0, end: 12000 }, 3000);
  assert.equal(data.markers.length, 2);
  assert.equal(data.markers[0].time, 1500);
  assert.equal(data.markers[0].price, 15);
  assert.equal(data.markers[1].price, 20);
  assert.equal(data.excluded.length, 3);
  assert.equal(data.segments.length, 2);
  assert.deepEqual(data.segments[1], [points[2]]);
});
test('period boundaries clip the curve by nearby interpolation, preserving exact trade dates', () => {
  const data = geckoWindow([{ time: 1000, price: 10 }, { time: 2000, price: 20 }],
    [{ time: 1500, side: 'buy' }], { start: 1500, end: 2000 }, 1000);
  assert.equal(data.markers.length, 1);
  assert.equal(data.markers[0].price, 15);
  assert.deepEqual(data.points[0], { time: 1500, price: 15, interpolated: true });
  assert.equal(data.excluded.length, 0);
  const boundaryOnly = geckoWindow([{ time: 1000, price: 10 }, { time: 2000, price: 20 }],
    [{ time: 1750, side: 'sell' }], { start: 1500, end: 1750 }, 1000);
  assert.equal(boundaryOnly.points.length, 2);
  assert.equal(boundaryOnly.markers[0].price, 17.5);
  assert.equal(geckoWindow([], [], { start: 0, end: 1000 }, 1000).truncated, true);
});
test('CoinGecko requires exact ID matching instead of selecting a duplicate symbol arbitrarily', async t => {
  const coins = [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }, { id: 'fake-bitcoin', symbol: 'btc', name: 'Duplicate' }];
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return { ok: true, json: async () => url.endsWith('/coins/list') ? coins : { prices: [[1000, 10], [2000, 20]] } };
  });
  const data = await fetchGeckoPrices('BTC', { start: 0, end: 2000 }, { id: 'bitcoin', now: 1000 });
  assert.equal(data.id, 'bitcoin');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /\/coins\/bitcoin\/market_chart\?vs_currency=usd&days=2$/);
  assert.equal(new URL(calls[1]).searchParams.has('transactions'), false);
  await assert.rejects(fetchGeckoPrices('ETH', { start: 0, end: 1 }, { id: 'bitcoin', catalog: coins }), /ne correspond pas/);
  await assert.rejects(fetchGeckoPrices('BTC', { start: 0, end: 1 }, { id: '' }), /identifiant/);
});
test('CoinGecko public history is bounded to 365 days, old ALL coverage remains explicit', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ prices: [[500 * 86400000, 10], [501 * 86400000, 20]] }) };
  });
  const range = { start: 0, end: 700 * 86400000 };
  const data = await fetchGeckoPrices('BTC', range, {
    id: 'bitcoin', catalog: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }], now: range.end,
  });
  assert.equal(data.days, 365);
  assert.equal(new URL(calls[0]).searchParams.get('days'), '365');
  assert.equal(geckoWindow(data.points, [], range, data.maxGap).truncated, true);
});
test('CoinGecko rate limits and access errors are explicit, without silent provider switching', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 429 }));
  await assert.rejects(fetchGeckoPrices('BTC', { start: 0, end: 1000 }, { id: 'bitcoin' }), /429.*limite/);
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(fetchGeckoPrices('BTC', { start: 0, end: 1000 }, { id: 'bitcoin' }), /CORS/);
});
test('CoinGecko invalid responses and aborted requests never become successful empty series', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => null }));
  await assert.rejects(fetchGeckoPrices('BTC', { start: 0, end: 1000 }, { id: 'bitcoin' }), /réponse.*invalide/);
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    signal.throwIfAborted();
    throw new Error('Unexpected active request');
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchGeckoPrices('BTC', { start: 0, end: 1000 }, { id: 'bitcoin', signal: controller.signal }), { name: 'AbortError' });
});
test('portfolio CoinGecko quotes batch exact IDs and preserve provider timestamps without private data', async t => {
  const calls = [], now = Date.now(), seconds = Math.floor(now / 1000);
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return { ok: true, json: async () => url.endsWith('/coins/list') ?
      [{ id: 'bitcoin', symbol: 'btc' }, { id: 'ethereum', symbol: 'eth' }, { id: 'custom-token', symbol: 'custom' }] :
      { bitcoin: { usd: 60000, last_updated_at: seconds - 5 }, ethereum: { usd: 3000, last_updated_at: seconds },
        'custom-token': { usd: 2, last_updated_at: seconds } } };
  });
  const update = await fetchGeckoQuotes(['BTC', 'ETH', 'CUSTOM', 'UNKNOWN', 'BTC'], { ids: { CUSTOM: 'custom-token' }, now });
  assert.equal(calls.length, 2);
  const url = new URL(calls[1]);
  assert.deepEqual([...url.searchParams.keys()], ['ids', 'vs_currencies', 'include_last_updated_at']);
  assert.equal(url.searchParams.get('ids'), 'bitcoin,ethereum,custom-token');
  assert.equal(url.searchParams.get('vs_currencies'), 'usd');
  assert.equal(url.searchParams.get('include_last_updated_at'), 'true');
  assert.deepEqual(update.prices.BTC, { value: 60000, date: (seconds - 5) * 1000, source: 'CoinGecko · prix agrégé (bitcoin)' });
  assert.equal(update.prices.CUSTOM.value, 2);
  assert.deepEqual(update.missing, ['UNKNOWN']);
});
test('ambiguous symbols never choose an arbitrary asset and wrong explicit IDs fail before quotes', async t => {
  const calls = [];
  const catalog = [{ id: 'first', symbol: 'dup' }, { id: 'second', symbol: 'dup' }, { id: 'bitcoin', symbol: 'btc' }];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ second: { usd: 5, last_updated_at: 1000 } }) };
  });
  assert.deepEqual(await fetchGeckoQuotes(['DUP'], { catalog }), { prices: {}, missing: ['DUP'] });
  assert.equal(calls.length, 0);
  await assert.rejects(fetchGeckoQuotes(['BTC'], { catalog, ids: { BTC: 'second' } }), /ne correspond pas/);
  await assert.rejects(fetchGeckoQuotes(['BTC'], { catalog, ids: { BTC: 'bad/id' } }), /identifiant/);
  assert.equal(calls.length, 0);
  assert.equal((await fetchGeckoQuotes(['DUP'], { catalog, ids: { DUP: 'second' } })).prices.DUP.value, 5);
});
test('CoinGecko missing or invalid current quotes remain unavailable, never zero or dated at click time', async t => {
  const catalog = [{ id: 'bitcoin', symbol: 'btc' }];
  const seconds = Math.floor(Date.now() / 1000);
  for (const quote of [undefined, { usd: 0, last_updated_at: seconds }, { usd: '10', last_updated_at: seconds },
    { usd: Infinity, last_updated_at: seconds }, { usd: 10 }, { usd: 10, last_updated_at: null },
    { usd: 10, last_updated_at: seconds + 3600 }]) {
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ bitcoin: quote }) }));
    assert.deepEqual(await fetchGeckoQuotes(['BTC'], { catalog }), { prices: {}, missing: ['BTC'] });
  }
});
test('CoinGecko current quote network errors propagate without requesting Kraken', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return { ok: false, status: 429 };
  });
  await assert.rejects(fetchGeckoQuotes(['BTC'], { catalog: [{ id: 'bitcoin', symbol: 'btc' }] }), /429/);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/api.coingecko.com\/api\/v3\/simple\/price/);
});
test('CoinGecko valuation changes holdings and unrealized profit, never quantity, cost or realized profit', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ bitcoin: { usd: 60000, last_updated_at: 1000 } }) }));
  const parsed = parseCSV('txid,refid,time,type,asset,amount,fee,balance,amountusd,feeusd,balanceusd\n' +
    '1,b,2025-01-01 12:00:00,spend,USD,-1000,0,0,-1000,0,0\n' +
    '2,b,2025-01-01 12:00:00,receive,BTC,0.02,0,0.02,1000,0,1000');
  const previous = analyze(parsed).assets[0];
  const update = await fetchGeckoQuotes(['BTC'], { catalog: [{ id: 'bitcoin', symbol: 'btc' }] });
  const current = analyze(parsed, { prices: update.prices }).assets[0];
  assert.equal(current.value, 1200);
  assert.equal(current.economicUnrealized, 200);
  assert.equal(current.quantity, previous.quantity);
  assert.equal(current.economicCost, previous.economicCost);
  assert.equal(current.economicRealized, previous.economicRealized);
  assert.equal(current.priceDate, 1000000);
  assert.match(current.priceSource, /CoinGecko/);
});
