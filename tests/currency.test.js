import test from 'node:test';
import assert from 'node:assert/strict';
import { CurrencyDisplay, fetchEURRate } from '../currency.js';

test('EUR display converts values and entered costs reciprocally, preserving signs, zero and unknowns', () => {
  const display = new CurrencyDisplay();
  assert.equal(display.convert(100), 100);
  display.set('EUR', { eurPerUSD: .8, date: 1735689600000 });
  assert.equal(display.convert(100), 80);
  assert.equal(display.convert(-50), -40);
  assert.equal(display.toUSD(80), 100);
  assert.equal(display.convert(0), 0);
  assert.equal(display.convert(null), null);
  assert.equal(display.toUSD(null), null);
  assert.match(display.money(100), /80,00.*€/);
  assert.match(display.money(.00001, true), /0,000008.*€/);
  display.set('USD');
  assert.equal(display.convert(100), 100);
  assert.equal(display.eurPerUSD, .8);
  assert.equal(display.money(null), '—');
});
test('missing or invalid FX cannot silently become a one-to-one rate or replace a valid display', () => {
  const display = new CurrencyDisplay();
  assert.throws(() => display.set('EUR'), /nécessaire/);
  for (const rate of [0, -1, NaN, Infinity]) {
    assert.throws(() => display.set('EUR', { eurPerUSD: rate, date: Date.now() }), /invalide/);
    assert.equal(display.currency, 'USD');
    assert.equal(display.eurPerUSD, null);
  }
  assert.throws(() => display.set('GBP'), /non prise/);
  assert.throws(() => display.convert(NaN), /invalide/);
  assert.throws(() => display.set('EUR', { eurPerUSD: .9, date: 1e20 }), /invalide/);
});
test('Kraken EUR/USD quote is inverted once, using public endpoints without account data', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ error: [], result: url.includes('AssetPairs') ?
      { ZEURZUSD: { wsname: 'EUR/USD', altname: 'EURUSD', status: 'online' } } :
      { ZEURZUSD: { c: ['1.25', '1'] } } }) };
  });
  const quote = await fetchEURRate();
  assert.equal(quote.eurPerUSD, .8);
  assert.ok(Number.isFinite(quote.date));
  assert.equal(calls.length, 2);
  assert.match(calls[1], /Ticker\?pair=EURUSD$/);
});
test('FX HTTP failure and missing EUR pairs are explicit, not success-shaped defaults', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  await assert.rejects(fetchEURRate(), /503/);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ error: [], result: {} }) }));
  await assert.rejects(fetchEURRate(), /indisponible/);
});
