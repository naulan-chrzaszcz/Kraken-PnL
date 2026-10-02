import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, analyze, normalizeAsset } from '../ledger.js';

const headers = ['txid', 'refid', 'time', 'type', 'subtype', 'aclass', 'subclass', 'asset', 'wallet', 'amount', 'fee', 'balance', 'amountusd', 'feeusd', 'balanceusd', 'feecurrency'];
const row = (id, overrides) => ({
  txid: id, refid: id, time: '2025-01-01 00:00:00', type: 'deposit', subtype: '',
  aclass: 'currency', subclass: 'crypto', asset: 'BTC', wallet: 'spot / main',
  amount: 1, fee: 0, balance: 1, amountusd: 100, feeusd: 0, balanceusd: 100, feecurrency: '',
  ...overrides,
});
const csv = rows => [headers.join(','), ...rows.map(r => headers.map(h => `"${String(r[h]).replaceAll('"', '""')}"`).join(','))].join('\n');
const calc = (rows, options) => analyze(parseCSV(csv(rows)), options);
const get = (r, asset = 'BTC') => r.assets.find(a => a.asset === asset);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≠ ${expected}`);
function purchase(id = 'buy', amount = 2, cost = 200, balance = 2, fee = 0) {
  return [
    row(`${id}-usd`, { refid: id, type: 'spend', asset: 'USD', subclass: 'fiat', amount: -cost, amountusd: -cost, fee, feeusd: fee, balance: 1000 - cost - fee, balanceusd: 1000 - cost - fee, feecurrency: 'USD' }),
    row(`${id}-btc`, { refid: id, type: 'receive', amount, balance, amountusd: cost, balanceusd: balance * cost / amount }),
  ];
}
test('CSV: BOM, CRLF, delimiters, escaped quotes, duplicate lines', () => {
  const r = row('x', { wallet: 'spot, "main"\nwallet' });
  const p = parseCSV('\uFEFF' + csv([r, r]).replaceAll('\n', '\r\n'));
  assert.equal(p.rows.length, 1); assert.equal(p.duplicates, 1);
  assert.equal(p.rows[0].wallet, 'spot, "main"\r\nwallet');
  assert.equal(parseCSV(csv([row('z')]).replaceAll(',', ';')).rows.length, 1);
});
test('CSV rejects malformed, missing USD, invalid dates/numbers and conflicting duplicates', () => {
  assert.throws(() => parseCSV('txid,type\nx,deposit'), /manquantes/);
  assert.throws(() => parseCSV(csv([row('x', { amount: 'NaN' })])), /numérique/);
  assert.equal(parseCSV(csv([row('x', { amountusd: '' })])).rows[0].amountusd, null);
  assert.throws(() => parseCSV(csv([row('x', { time: 'not a date' })])), /date/);
  assert.throws(() => parseCSV(csv([row('x'), row('x', { balance: 2 })])), /différentes/);
  assert.throws(() => parseCSV('txid\n"unclosed'), /non fermé/);
  assert.throws(() => parseCSV(csv([row('x')]) + ',extra'), /colonnes incorrect/);
  assert.throws(() => parseCSV(csv([row('x', { fee: .1, feecurrency: 'ETH' })])), /autre devise/);
});
test('aliases and hold balances normalize without merging wallet ledger keys', () => {
  assert.equal(normalizeAsset('XXBT.S'), 'BTC');
  assert.equal(normalizeAsset('EUR.HOLD'), 'EUR');
  const r = calc([row('a', { asset: 'XXBT', amount: 1, balance: 1 }), row('b', { asset: 'BTC.S', amount: 2, balance: 2 })]);
  close(get(r).quantity, 3); close(get(r).unknown, 3);
});
test('purchase includes spend fees and excludes fiat from crypto stats', () => {
  const r = calc(purchase('buy', 2, 200, 2, 2));
  close(get(r).cost, 202); close(get(r).unknown, 0);
  close(get(r).unrealized, -2); close(r.totals.fees, 2);
  assert.equal(r.assets.length, 1); assert.equal(r.totals.incomplete, false);
});
test('receipt fees reduce quantity without reducing the purchase cost', () => {
  const rows = purchase();
  Object.assign(rows[1], { fee: .02, feeusd: 2, balance: 1.98, balanceusd: 198, feecurrency: 'BTC' });
  const r = calc(rows);
  close(get(r).quantity, 1.98); close(get(r).cost, 200); close(get(r).unrealized, -2);
});
test('partial sale removes proportional average cost and net fiat proceeds', () => {
  const r = calc([...purchase(), row('sellbtc', { refid: 'sell', type: 'spend', amount: -.5, amountusd: -75, balance: 1.5, balanceusd: 225 }),
    row('sellusd', { refid: 'sell', type: 'receive', asset: 'USD', subclass: 'fiat', amount: 75, amountusd: 75, fee: 1, feeusd: 1, balance: 874, balanceusd: 874, feecurrency: 'USD' })]);
  close(get(r).quantity, 1.5); close(get(r).cost, 150); close(get(r).realized, 24); close(get(r).unrealized, 75);
});
test('multiple buys use weighted average, not FIFO', () => {
  const b = purchase('buy2', 1, 200, 3);
  b[0].balance = 600; b[0].balanceusd = 600;
  const r = calc([...purchase(), ...b,
    row('s1', { refid: 'sale', type: 'spend', amount: -1, amountusd: -180, balance: 2, balanceusd: 360 }),
    row('s2', { refid: 'sale', type: 'receive', asset: 'EUR', amount: 160, amountusd: 180, balance: 160, balanceusd: 180, subclass: 'fiat' })]);
  close(get(r).cost, 400 * 2 / 3); close(get(r).realized, 180 - 400 / 3);
});
test('internal Earn transfers keep cost and do not create purchases or rewards', () => {
  const r = calc([...purchase(),
    row('t1', { refid: 't', type: 'earn', subtype: 'autoallocation', amount: -2, amountusd: -200, balance: 0, balanceusd: 0 }),
    row('t2', { refid: 't', type: 'earn', subtype: 'autoallocation', amount: 2, amountusd: 200, balance: 2, balanceusd: 200, wallet: 'earn / liquid' })]);
  close(get(r).quantity, 2); close(get(r).cost, 200); close(get(r).unknown, 0); close(get(r).bought, 200);
  assert.equal(r.warnings.length, 0);
});
test('net rewards are separate income and enter basis at reception value', () => {
  const r = calc([...purchase(), row('reward', { type: 'earn', subtype: 'reward', amount: .1, fee: .02, balance: 2.08, amountusd: 15, feeusd: 3, balanceusd: 312, feecurrency: 'BTC' })]);
  close(get(r).rewards, 12); close(get(r).cost, 212); close(get(r).quantity, 2.08); close(get(r).unrealized, 100);
  close(get(r).economicCost, 200); close(get(r).economicUnrealized, 112);
  close(get(r).giftRemaining, .08); close(get(r).giftValue, 12);
});
test('free distribution sold below its reception price is still an economic gain, never counted twice', () => {
  const r = calc([
    row('gift', { type: 'transfer', subtype: 'airdrop', amount: 10, balance: 10, amountusd: 100, balanceusd: 100 }),
    row('sale', { refid: 's', type: 'spend', amount: -10, balance: 0, amountusd: -50, balanceusd: 0 }),
    row('cash', { refid: 's', type: 'receive', asset: 'USD', subclass: 'fiat', amount: 50, fee: 1, feeusd: 1, balance: 49, amountusd: 50, balanceusd: 49 }),
  ]);
  close(get(r).realized, -51); close(get(r).economicRealized, 49);
  close(get(r).economicUnrealized, 0); close(get(r).giftRemaining, 0);
  close(get(r).giftRealized, 49); close(r.totals.rewards, 100);
});
test('free units and paid units use parallel proportional books on partial sales and withdrawals', () => {
  const r = calc([...purchase('b', 2, 200, 2),
    row('gift', { type: 'reward', subtype: 'welcomebonus', amount: 2, balance: 4, amountusd: 400, balanceusd: 800 }),
    row('sale', { refid: 's', type: 'spend', amount: -1, balance: 3, amountusd: -150, balanceusd: 450 }),
    row('cash', { refid: 's', type: 'receive', asset: 'USD', subclass: 'fiat', amount: 150, amountusd: 150, balance: 950, balanceusd: 950 }),
    row('withdraw', { type: 'withdrawal', amount: -1, balance: 2, amountusd: -150, balanceusd: 300 }),
  ]);
  close(get(r).economicRealized, 100); close(get(r).realized, 0);
  close(get(r).economicCost, 100); close(get(r).economicUnrealized, 200);
  close(get(r).giftRemaining, 1); close(get(r).giftValue, 150); close(get(r).giftRealized, 75);
});
test('missing reception USD does not make a documented airdrop an unknown economic acquisition', () => {
  const r = calc([
    row('gift', { type: 'transfer', subtype: 'airdrop', amount: 4, balance: 4, amountusd: '-', balanceusd: '-' }),
    row('unknown', { type: 'deposit', amount: 2, balance: 6, amountusd: 20, balanceusd: 60 }),
    row('sale', { refid: 's', type: 'spend', amount: -3, balance: 3, amountusd: -30, balanceusd: 30 }),
    row('cash', { refid: 's', type: 'receive', asset: 'USD', subclass: 'fiat', amount: 30, amountusd: 30, balance: 30, balanceusd: 30 }),
  ]);
  close(get(r).economicUnknown, 1); close(get(r).economicRealized, 20);
  close(get(r).economicUnrealized, 20); close(get(r).giftRemaining, 2);
  assert.equal(r.totals.economicIncomplete, true); assert.equal(r.totals.rewardsIncomplete, true);
  close(get(r).unknown, 3);
});
test('free-only basis is zero even with a manual reference estimate and a missing fee valuation', () => {
  const r = calc([row('gift', { type: 'reward', amount: 10, fee: 1, balance: 9, amountusd: '-', feeusd: '-', balanceusd: '-' })],
    { prices: { BTC: { value: 5 } }, basis: { BTC: 20 } });
  close(get(r).economicCost, 0); close(get(r).economicUnrealized, 45);
  close(get(r).economicUnknown, 0); assert.equal(get(r).economicEstimated, false);
  assert.equal(r.totals.economicIncomplete, false); assert.equal(get(r).economicUnrealizedPercent, null);
});
test('converting a free asset realizes its full value and gives the acquired asset a paid reference', () => {
  const r = calc([
    row('gift', { type: 'airdrop', amount: 2, balance: 2, amountusd: 200, balanceusd: 200 }),
    row('out', { refid: 'c', type: 'trade', amount: -1, fee: .1, feeusd: 5, balance: .9, amountusd: -50, balanceusd: 45 }),
    row('in', { refid: 'c', type: 'trade', asset: 'ETH', amount: 2, fee: .1, feeusd: 2.5, balance: 1.9, amountusd: 50, balanceusd: 47.5 }),
  ]);
  close(get(r).economicRealized, 50); close(get(r, 'ETH').economicCost, 50);
  close(r.totals.economicRealized + r.totals.economicUnrealized, 92.5);
  close(get(r, 'ETH').giftRemaining, 0);
});
test('legacy staking rewards are free but balanced legacy staking transfers are neutral', () => {
  const r = calc([...purchase(),
    row('out', { refid: 't', type: 'staking', amount: -2, balance: 0, amountusd: -200, balanceusd: 0 }),
    row('in', { refid: 't', type: 'staking', amount: 2, balance: 2, amountusd: 200, balanceusd: 200, wallet: 'earn' }),
    row('reward', { type: 'staking', amount: .1, balance: 2.1, amountusd: 10, balanceusd: 210, wallet: 'earn' }),
  ]);
  close(get(r).economicCost, 200); close(get(r).giftRemaining, .1);
  close(get(r).rewards, 10); close(get(r).economicUnrealized, 10);
});
test('unknown sale proceeds keep the free-distribution breakdown explicitly partial', () => {
  const r = calc([
    row('gift', { type: 'reward', amountusd: '-' }),
    row('sale', { refid: 's', type: 'spend', amount: -1, balance: 0, amountusd: '-', balanceusd: 0 }),
    row('cash', { refid: 's', type: 'receive', asset: 'EUR', subclass: 'fiat', amount: 30, balance: 30, amountusd: '-', balanceusd: '-' }),
  ]);
  assert.equal(r.totals.giftRealizedIncomplete, true);
  assert.equal(r.totals.economicRealizedIncomplete, true);
  close(r.totals.economicRealized, 0);
});
test('50 mixed purchase, sale and free-income histories conserve economic gains without adding rewards twice', () => {
  for (let scenario = 1; scenario <= 50; scenario++) {
    let quantity = 0, cash = 10000, spent = 0, received = 0;
    const rows = [];
    for (let i = 0; i < 30; i++) {
      const price = 20 + (scenario * 17 + i * 13) % 100;
      const time = `2025-01-${String(i + 1).padStart(2, '0')} 00:00:00`;
      const refid = `event-${i}`;
      if (i % 3 === 0) {
        const amount = .2 + scenario / 1000, fee = amount / 20;
        quantity += amount - fee;
        rows.push(row(refid, { time, type: 'earn', subtype: 'reward', amount, fee, balance: quantity,
          amountusd: amount * price, feeusd: fee * price, balanceusd: quantity * price }));
      } else if (i % 3 === 1) {
        quantity += .3; const cost = .3 * price + 1; cash -= cost; spent += cost;
        rows.push(row(`${refid}-usd`, { refid, time, type: 'spend', asset: 'USD', subclass: 'fiat',
          amount: -.3 * price, amountusd: -.3 * price, fee: 1, feeusd: 1, balance: cash, balanceusd: cash }),
        row(`${refid}-btc`, { refid, time, type: 'receive', amount: .3, amountusd: .3 * price, balance: quantity, balanceusd: quantity * price }));
      } else {
        const amount = quantity / 3, proceeds = amount * price - .1;
        quantity -= amount; cash += proceeds; received += proceeds;
        rows.push(row(`${refid}-btc`, { refid, time, type: 'spend', amount: -amount,
          amountusd: -amount * price, balance: quantity, balanceusd: quantity * price }),
        row(`${refid}-usd`, { refid, time, type: 'receive', asset: 'USD', subclass: 'fiat',
          amount: amount * price, amountusd: amount * price, fee: .1, feeusd: .1, balance: cash, balanceusd: cash }));
      }
    }
    const r = calc(rows, { prices: { BTC: { value: 75 } } });
    const expected = quantity * 75 + received - spent;
    close(r.totals.economicRealized + r.totals.economicUnrealized, expected);
    close(r.totals.realized + r.totals.unrealized + r.totals.rewards, expected);
    assert.equal(r.totals.economicIncomplete, false);
    assert.equal(r.totals.giftRealizedIncomplete, false);
  }
});
test('unknown opening stock is not assigned zero cost; unknown and known removed pro rata', () => {
  const rows = purchase('buy', 2, 200, 3);
  const r = calc([...rows,
    row('s1', { refid: 'sale', type: 'spend', amount: -1.5, amountusd: -225, balance: 1.5, balanceusd: 225 }),
    row('s2', { refid: 'sale', type: 'receive', subclass: 'fiat', asset: 'EUR', amount: 200, amountusd: 225, balance: 200, balanceusd: 225 })]);
  close(get(r).unknown, .5); close(get(r).cost, 100); close(get(r).realized, 50); close(get(r).unrealized, 50);
  assert.equal(get(r).realizedIncomplete, true); assert.equal(r.totals.incomplete, true);
  close(r.totals.coverage, 100 * 2 / 3);
});
test('manual estimated basis affects opening units and historic sales', () => {
  const rows = [...purchase('buy', 2, 200, 3),
    row('s1', { refid: 'sale', type: 'spend', amount: -1.5, amountusd: -225, balance: 1.5, balanceusd: 225 }),
    row('s2', { refid: 'sale', type: 'receive', subclass: 'fiat', asset: 'EUR', amount: 200, amountusd: 225, balance: 200, balanceusd: 225 })];
  const r = calc(rows, { basis: { BTC: 80 }, prices: { BTC: { value: 200, source: 'Manuel', date: 1 } } });
  close(get(r).unknown, 0); close(get(r).cost, 140); close(get(r).realized, 85); close(get(r).unrealized, 160);
  assert.equal(r.totals.estimated, true); assert.equal(r.totals.incomplete, false);
});
test('external deposits stay unknown and withdrawals are not sales', () => {
  const r = calc([...purchase(), row('d', { amount: 1, balance: 3, amountusd: 150, balanceusd: 450 }),
    row('w', { type: 'withdrawal', amount: -.6, fee: .03, feeusd: 4.5, balance: 2.37, amountusd: -90, balanceusd: 355.5, feecurrency: 'BTC' })]);
  close(get(r).quantity, 2.37); close(get(r).unknown, .79); close(get(r).cost, 158); close(get(r).realized, 0);
});
test('Hybrid BTC capital remains held with its paid cost, independently of a zero Spot balance', () => {
  const rows = [...purchase('buy', 2, 200, 2),
    row('hybrid', { type: 'hybridearnwithdrawal', amount: -2, balance: 0, amountusd: -300, balanceusd: 0 })];
  const excluded = calc(rows);
  close(get(excluded).quantity, 0); close(get(excluded).cost, 0);
  assert.ok(excluded.warnings.some(w => w.includes('Hybrid Earn sont exclus')));
  const included = calc(rows, { includeHybrid: true });
  close(get(included).quantity, 2); close(get(included).ledgerQuantity, 0);
  close(get(included).hybridQuantity, 2); close(get(included).cost, 200);
  close(get(included).economicCost, 200); close(get(included).economicUnrealized, 100);
  close(get(included).realized, 0); assert.equal(included.totals.hybridReconstructed, true);
  assert.ok(!included.warnings.some(w => /écart de rapprochement|supérieure au stock/.test(w)));
});
test('Hybrid returns preserve basis, fees reduce units and ordinary withdrawals remain external', () => {
  const r = calc([...purchase(),
    row('h1', { type: 'hybridearnwithdrawal', amount: -1.5, fee: .1, feeusd: 10, balance: .4, amountusd: -150, balanceusd: 40 }),
    row('h2', { type: 'hybridearndeposit', amount: 1, balance: 1.4, amountusd: 100, balanceusd: 140 }),
    row('w', { type: 'withdrawal', amount: -.4, balance: 1, amountusd: -40, balanceusd: 100 }),
  ], { includeHybrid: true });
  close(get(r).quantity, 1.5); close(get(r).hybridQuantity, .5);
  close(get(r).cost, 150); close(get(r).economicCost, 150); close(get(r).bought, 200);
  close(get(r).unknown, 0); close(get(r).realized, 0);
});
test('BTC PnL separates paid-cost profit from reception-value changes and follows the valuation price', () => {
  const rows = [...purchase('buy', 2, 200, 2),
    row('reward', { type: 'earn', subtype: 'reward', amount: 1, balance: 3, amountusd: 100, balanceusd: 300 }),
    row('vault', { type: 'hybridearnwithdrawal', amount: -3, balance: 0, amountusd: -300, balanceusd: 0 }),
  ];
  const historical = calc(rows, { includeHybrid: true });
  close(get(historical).economicUnrealized, 100); close(get(historical).unrealized, 0);
  const current = calc(rows, { includeHybrid: true, prices: { BTC: { value: 150 } } });
  close(get(current).economicUnrealized, 250); close(get(current).unrealized, 150);
  close(get(current).economicUnrealized - get(current).unrealized, 100);
  close(get(current).economicUnrealized, 3 * 150 - 200);
  close(get(current).economicCost, 200);
});
test('partial Spot sales with a Hybrid holding follow the documented global average without creating gains on transfers', () => {
  const r = calc([...purchase(),
    row('vault', { type: 'hybridearnwithdrawal', amount: -1, balance: 1, amountusd: -100, balanceusd: 100 }),
    row('sale', { refid: 's', type: 'spend', amount: -.5, balance: .5, amountusd: -75, balanceusd: 75 }),
    row('cash', { refid: 's', type: 'receive', asset: 'USD', subclass: 'fiat', amount: 75, amountusd: 75, balance: 875, balanceusd: 875 }),
  ], { includeHybrid: true });
  close(get(r).quantity, 1.5); close(get(r).hybridQuantity, 1);
  close(get(r).economicCost, 150); close(get(r).economicRealized, 25);
  close(get(r).economicUnrealized, 75);
  close(r.totals.economicRealized + r.totals.economicUnrealized, 1.5 * 150 + 75 - 200);
});
test('Hybrid excess return is unknown income and balanced counterpart legs never double count', () => {
  const r = calc([...purchase(),
    row('h1', { type: 'hybridearnwithdrawal', amount: -2, balance: 0, amountusd: -200, balanceusd: 0 }),
    row('h2', { type: 'hybridearndeposit', amount: 2.1, balance: 2.1, amountusd: 210, balanceusd: 210 }),
  ], { includeHybrid: true });
  close(get(r).quantity, 2.1); close(get(r).hybridQuantity, 0);
  close(get(r).cost, 200); close(get(r).unknown, .1); close(get(r).rewards, 0);
  const paired = calc([...purchase(),
    row('out', { refid: 't', type: 'hybridearnwithdrawal', amount: -2, balance: 0, amountusd: -200, balanceusd: 0 }),
    row('in', { refid: 't', type: 'hybridearndeposit', amount: 2, balance: 2, wallet: 'vault', amountusd: 200, balanceusd: 200 }),
  ], { includeHybrid: true });
  close(get(paired).quantity, 2); close(get(paired).hybridQuantity, 0); close(get(paired).cost, 200);
  assert.throws(() => calc([row('bad', { type: 'hybridearnwithdrawal' })], { includeHybrid: true }), /sens du mouvement/);
});
test('crypto conversion realizes the disposed asset and adds cost to the acquired one', () => {
  const r = calc([...purchase(),
    row('c1', { refid: 'convert', type: 'trade', amount: -1, amountusd: -150, balance: 1, balanceusd: 150 }),
    row('c2', { refid: 'convert', type: 'trade', asset: 'ETH', amount: 3, amountusd: 153, balance: 3, balanceusd: 153 })]);
  close(get(r).realized, 50); close(get(r).cost, 100); close(get(r, 'ETH').cost, 150);
});
test('dust sweep distributes net proceeds among multiple assets', () => {
  const ethBuy = [
    row('eb1', { refid: 'eb', type: 'spend', asset: 'EUR', subclass: 'fiat', amount: -50, amountusd: -50, balance: 0, balanceusd: 0 }),
    row('eb2', { refid: 'eb', type: 'receive', asset: 'ETH', amount: 1, amountusd: 50, balance: 1, balanceusd: 50 }),
  ];
  const r = calc([...purchase('buy', 1, 100, 1), ...ethBuy,
    row('d1', { refid: 'dust', type: 'spend', subtype: 'dustsweeping', amount: -1, amountusd: -120, balance: 0, balanceusd: 0 }),
    row('d2', { refid: 'dust', type: 'spend', subtype: 'dustsweeping', asset: 'ETH', amount: -1, amountusd: -60, balance: 0, balanceusd: 0 }),
    row('d3', { refid: 'dust', type: 'receive', subtype: 'dustsweeping', asset: 'EUR', subclass: 'fiat', amount: 180, amountusd: 180, fee: 3, feeusd: 3, balance: 177, balanceusd: 177, feecurrency: 'EUR' })]);
  close(get(r).realized, 18); close(get(r, 'ETH').realized, 9); close(r.totals.realized, 27);
  close(get(r).cost, 0); close(get(r).quantity, 0);
});
test('closed assets still retain partial realized flag', () => {
  const r = calc([row('d'),
    row('s1', { refid: 's', type: 'spend', amount: -1, amountusd: -150, balance: 0, balanceusd: 0 }),
    row('s2', { refid: 's', type: 'receive', asset: 'EUR', subclass: 'fiat', amount: 150, amountusd: 150, balance: 150, balanceusd: 150 })]);
  close(get(r).realized, 0); assert.equal(r.totals.realizedIncomplete, true); close(get(r).unknown, 0);
});
test('missing prices stay missing; manual zero price is valid', () => {
  const rows = [row('d', { amountusd: 0, balanceusd: 0 })];
  const r = calc(rows);
  assert.equal(get(r).price, null); assert.equal(get(r).unrealized, null); assert.equal(r.totals.incomplete, true);
  const manual = calc(rows, { prices: { BTC: { value: 0 } }, basis: { BTC: 10 } });
  close(get(manual).unrealized, -10); assert.equal(manual.totals.incomplete, false);
});
test('unpaired trades are warned about instead of fabricating purchases', () => {
  const r = calc([row('r', { type: 'receive' })]);
  close(get(r).unknown, 1); assert.ok(r.warnings.some(w => w.includes('non appariée')));
});
test('balance gaps adjust inventory and warn', () => {
  const r = calc([...purchase(), row('r', { type: 'earn', subtype: 'reward', amount: .1, balance: 3.1, amountusd: 10, balanceusd: 310 })]);
  close(get(r).quantity, 3.1); close(get(r).unknown, 1);
  assert.ok(r.warnings.some(w => w.includes('rupture de solde')));
});
test('rows are chronological, stablecoins included and latest export prices dated', () => {
  const r = calc([
    row('later', { time: '2025-02-01 00:00:00', amount: 1, balance: 2, amountusd: 120, balanceusd: 240 }),
    row('early'),
    row('stable', { asset: 'USDC', subclass: 'stable_coin', amount: 10, balance: 10, amountusd: 10, balanceusd: 10 }),
  ]);
  assert.equal(r.rows[0].txid, 'early'); close(get(r).price, 120); assert.equal(r.assets.length, 2);
});
test('Kraken dash valuations on airdrops preserve unknown basis and partial income', () => {
  const r = calc([row('airdrop', { type: 'transfer', subtype: 'airdrop', asset: 'RIZE', amount: 746, balance: 746, amountusd: '-', balanceusd: '-' })]);
  const a = get(r, 'RIZE');
  assert.equal(a.price, null); close(a.unknown, 746); close(a.cost, 0);
  assert.equal(r.totals.rewardsIncomplete, true); assert.equal(r.totals.incomplete, true);
  assert.ok(r.warnings.some(w => w.includes('valorisation USD absente')));
});
test('missing USD in trade never creates zero-cost purchases or fake realized gains', () => {
  const rows = purchase(); rows[0].amountusd = '-';
  const r = calc(rows);
  close(get(r).unknown, 2); close(get(r).cost, 0);
  assert.ok(r.warnings.some(w => w.includes('sans valorisation complète')));
});
test('conversion with outgoing crypto fee counts the fee once across realized and unrealized gains', () => {
  const r = calc([...purchase(),
    row('c1', { refid: 'convert', type: 'trade', amount: -1, fee: .1, feeusd: 15, balance: .9, amountusd: -150, balanceusd: 135, feecurrency: 'BTC' }),
    row('c2', { refid: 'convert', type: 'trade', asset: 'ETH', amount: 3, balance: 3, amountusd: 150, balanceusd: 150 }),
  ]);
  close(get(r).cost, 90); close(get(r).realized, 40);
  close(get(r, 'ETH').cost, 150);
  // With no outside flows: gains equal final holdings minus the initial fiat investment.
  close(r.totals.realized + r.totals.unrealized, 285 - 200);
});
test('conversion with incoming crypto fee does not subtract it from both proceeds and new basis', () => {
  const r = calc([...purchase(),
    row('c1', { refid: 'convert', type: 'trade', amount: -1, balance: 1, amountusd: -150, balanceusd: 150 }),
    row('c2', { refid: 'convert', type: 'trade', asset: 'ETH', amount: 3, fee: .1, feeusd: 5, balance: 2.9, amountusd: 150, balanceusd: 145, feecurrency: 'ETH' }),
  ]);
  close(get(r).realized, 50); close(get(r, 'ETH').cost, 150);
  close(r.totals.realized + r.totals.unrealized, 295 - 200);
});
test('unknown reward income is independently marked in per-asset results', () => {
  const r = calc([row('a', { type: 'transfer', subtype: 'airdrop', amountusd: '-', balanceusd: '-' })], { basis: { BTC: 10 }, prices: { BTC: { value: 20 } } });
  assert.equal(get(r).rewardsIncomplete, true);
  assert.equal(r.totals.rewardsIncomplete, true);
  assert.equal(r.totals.incomplete, false);
});
test('an inflow cannot charge more fee units than it receives', () => {
  assert.throws(() => calc([row('r', { type: 'earn', subtype: 'reward', amount: .1, fee: .2, balance: 0, feeusd: 20, feecurrency: 'BTC' })]), /Frais supérieurs/);
});
test('mixed crypto and fiat funding capitalizes fiat fee once, including fee-only lines', () => {
  const r = calc([...purchase('buy', 1, 100, 1),
    row('c1', { refid: 'convert', type: 'trade', amount: -1, balance: 0, amountusd: -150, balanceusd: 0 }),
    row('c2', { refid: 'convert', type: 'trade', asset: 'USD', subclass: 'fiat', amount: -50, balance: 850, amountusd: -50, balanceusd: 850 }),
    row('cfee', { refid: 'convert', type: 'trade', asset: 'USD', subclass: 'fiat', amount: 0, fee: 2, feeusd: 2, balance: 848, amountusd: 0, balanceusd: 848, feecurrency: 'USD' }),
    row('c3', { refid: 'convert', type: 'trade', asset: 'ETH', amount: 4, balance: 4, amountusd: 200, balanceusd: 200 }),
  ]);
  close(get(r).realized, 50); close(get(r, 'ETH').cost, 202);
  close(r.totals.realized + r.totals.unrealized, 200 - 100 - 52);
});
test('conservation holds for 100 varying crypto conversion fee scenarios', () => {
  for (let i = 1; i <= 100; i++) {
    const sourcePrice = 100 + i, targetPrice = 50, spent = .5, outgoingFee = i / 10000, received = spent * sourcePrice / targetPrice, incomingFee = received / 100;
    const remainder = 2 - spent - outgoingFee;
    const r = calc([...purchase(),
      row('c1', { refid: 'convert', type: 'trade', amount: -spent, fee: outgoingFee, feeusd: outgoingFee * sourcePrice, balance: remainder, amountusd: -spent * sourcePrice, balanceusd: remainder * sourcePrice, feecurrency: 'BTC' }),
      row('c2', { refid: 'convert', type: 'trade', asset: 'ETH', amount: received, fee: incomingFee, feeusd: incomingFee * targetPrice, balance: received - incomingFee, amountusd: received * targetPrice, balanceusd: (received - incomingFee) * targetPrice, feecurrency: 'ETH' }),
    ]);
    close(r.totals.realized + r.totals.unrealized, remainder * sourcePrice + (received - incomingFee) * targetPrice - 200);
    assert.equal(r.totals.incomplete, false);
  }
});
test('an opening balance first seen later cannot alter an earlier sale average', () => {
  const r = calc([...purchase(),
    row('sale', { time: '2025-01-02 00:00:00', refid: 's', type: 'spend', amount: -1, balance: 1, amountusd: -150, balanceusd: 150 }),
    row('usd', { time: '2025-01-02 00:00:00', refid: 's', type: 'receive', asset: 'USD', subclass: 'fiat', amount: 150, balance: 950, amountusd: 150, balanceusd: 950 }),
    row('late', { time: '2025-02-01 00:00:00', wallet: 'earn / liquid', type: 'earn', subtype: 'reward', amount: .1, balance: 10.1, amountusd: 15, balanceusd: 1515 }),
  ]);
  close(get(r).realized, 50); close(get(r).cost, 115); close(get(r).unknown, 10);
});
test('a nonzero fiat spend valued at zero is not a free acquisition', () => {
  const rows = purchase(); rows[0].amountusd = 0;
  const r = calc(rows);
  close(get(r).cost, 0); close(get(r).unknown, 2);
  assert.equal(r.totals.incomplete, true);
});
test('missing fees on non-trade rewards cannot silently make a zero reference cost', () => {
  const r = calc([row('reward', { type: 'earn', subtype: 'reward', fee: .1, amountusd: 0, feeusd: '-', balance: .9, balanceusd: 90, feecurrency: 'BTC' })]);
  close(get(r).unknown, .9); assert.equal(r.totals.rewardsIncomplete, true);
});
test('repeated buys and sales conserve cash plus holdings over 120 independent scenarios', () => {
  for (let scenario = 1; scenario <= 120; scenario++) {
    const rows = [];
    let cash = 100000, stock = 0, cashSpent = 0, cashReceived = 0, currentPrice = 0;
    for (let event = 0; event < 30; event++) {
      currentPrice = 50 + ((scenario * 17 + event * 31) % 150);
      const buy = event % 3 !== 2, q = buy ? 1 + (event % 5) / 10 : stock / 3;
      const value = q * currentPrice, fee = value * .002;
      const time = new Date(Date.UTC(2025, 0, 1 + event)).toISOString(), refid = `${scenario}-${event}`;
      stock += buy ? q : -q; cash += buy ? -value - fee : value - fee;
      if (buy) cashSpent += value + fee; else cashReceived += value - fee;
      rows.push(row(`crypto-${event}`, { refid, time, type: 'trade', amount: buy ? q : -q, amountusd: buy ? value : -value, balance: stock, balanceusd: stock * currentPrice }),
        row(`fiat-${event}`, { refid, time, type: 'trade', asset: 'USD', subclass: 'fiat', amount: buy ? -value : value, amountusd: buy ? -value : value, fee, feeusd: fee, balance: cash, balanceusd: cash, feecurrency: 'USD' }));
    }
    const r = calc(rows);
    close(r.totals.realized + r.totals.unrealized, stock * currentPrice + cashReceived - cashSpent);
    close(get(r).quantity, stock); assert.equal(get(r).unknown, 0);
    assert.equal(r.warnings.length, 0);
  }
});
