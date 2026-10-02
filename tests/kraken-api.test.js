import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { adaptAccount, createKrakenReader, readAccount, signRequest, validateCredentials } from '../kraken-api.js';
import { analyze, parseCSV } from '../ledger.js';

const credentials = () => ({ key: 'TESTKEYONLY', secret: Buffer.alloc(64, 17).toString('base64') });
const entry = overrides => ({ refid: 'buy', time: 1735689600, type: 'trade', subtype: '', aclass: 'currency', asset: 'XXBT', amount: '1', fee: '0', balance: '1', ...overrides });
test('signature follows Kraken nonce + payload SHA256, then path + digest HMAC-SHA512', () => {
  const secret = credentials().secret, body = 'nonce=123&ofs=0';
  const digest = createHash('sha256').update('123nonce=123&ofs=0').digest();
  const expected = createHmac('sha512', Buffer.alloc(64, 17)).update(Buffer.concat([Buffer.from('/0/private/Ledgers'), digest])).digest('base64');
  assert.equal(signRequest('/0/private/Ledgers', body, secret), expected);
  assert.notEqual(signRequest('/0/private/Balance', body, secret), expected);
});
test('credentials validation rejects malformed key, secret and OTP', () => {
  assert.throws(() => validateCredentials({ ...credentials(), key: 'line\nbreak' }), /Clé/);
  assert.throws(() => validateCredentials({ ...credentials(), secret: 'notbase64!' }), /Secret/);
  assert.throws(() => validateCredentials({ ...credentials(), otp: 'abcd' }), /2FA/);
});
test('reader only allows read endpoints, never sends the secret to Kraken, and increments nonces', async () => {
  const calls = [], waits = [], auth = credentials();
  const read = createKrakenReader(auth, { wait: async ms => waits.push(ms), fetchImpl: async (url, options) => {
    calls.push({ url, ...options }); return { ok: true, json: async () => ({ error: [], result: {} }) };
  } });
  await assert.rejects(read('AddOrder'), /interdit/);
  await assert.rejects(read('Withdraw'), /interdit/);
  await read('Ledgers'); await read('Balance');
  assert.equal(calls.length, 2); assert.deepEqual(waits, [4250]);
  assert.equal(calls[0].headers['API-Key'], auth.key);
  for (const call of calls) {
    assert.equal(call.body.includes(auth.secret), false);
    assert.equal(JSON.stringify(call.headers).includes(auth.secret), false);
    assert.equal(call.redirect, 'error');
  }
  assert.ok(BigInt(new URLSearchParams(calls[1].body).get('nonce')) > BigInt(new URLSearchParams(calls[0].body).get('nonce')));
});
test('permission, rate limit and authentication errors are explicit', async () => {
  for (const [message, match] of [['EGeneral:Permission denied', /Query ledger/], ['EAPI:Rate limit exceeded', /Limite/], ['EAPI:Invalid key', /Authentification/]]) {
    const read = createKrakenReader(credentials(), { fetchImpl: async () => ({ ok: true, json: async () => ({ error: [message], result: {} }) }) });
    await assert.rejects(read('Ledgers'), match);
  }
});
test('authentication diagnostics identify the exact known failure without exposing response details or credentials', async () => {
  for (const [code, expected] of [
    ['EAPI:Invalid key', /clé invalide/],
    ['EAPI:Invalid signature', /secret incorrect/],
    ['EAPI:Invalid nonce', /autre application/],
    ['EGeneral:Invalid arguments:otp', /2FA API/],
  ]) {
    const auth = credentials();
    const read = createKrakenReader(auth, { fetchImpl: async () => ({
      ok: true, json: async () => ({ error: [`${code}: confidential-upstream-details`], result: {} }),
    }) });
    await assert.rejects(read('Ledgers'), error => {
      assert.match(error.message, expected);
      assert.ok(error.message.includes(code));
      assert.ok(!error.message.includes('confidential-upstream-details'));
      assert.ok(!error.message.includes(auth.key) && !error.message.includes(auth.secret));
      return true;
    });
  }
});
test('API pagination reads every page, a fixed end, then balances', async () => {
  const calls = [];
  const read = async (method, params) => {
    calls.push([method, params]);
    if (method === 'Balance') return { XXBT: '1', ZUSD: '0' };
    return params.ofs === 0 ? { count: 2, ledger: { usd: entry({ asset: 'ZUSD', amount: '-100', balance: '0', fee: '1' }) } } :
      { count: 2, ledger: { btc: entry({ asset: 'XXBT', amount: '1', balance: '1' }) } };
  };
  const data = await readAccount(read, { now: 1735689700000 });
  assert.equal(calls.length, 3); assert.equal(calls[1][1].ofs, 1);
  assert.equal(calls[0][1].end, calls[1][1].end);
  const r = analyze(parseCSV(data.csv), { snapshot: data.snapshot, notes: data.notes });
  assert.equal(r.assets[0].cost, 101); assert.equal(r.assets[0].unknown, 0);
  assert.equal(r.assets[0].quantity, 1); assert.equal(r.assets[0].unrealized, -1);
});
test('pagination never returns a partial success on empty, repeated or changing pages', async () => {
  let calls = 0;
  await assert.rejects(readAccount(async () => ++calls === 1 ? { count: 2, ledger: { a: entry() } } : { count: 2, ledger: {} }), /vide/);
  calls = 0;
  await assert.rejects(readAccount(async () => ++calls === 1 ? { count: 2, ledger: { a: entry() } } : { count: 2, ledger: { a: entry() } }), /répétée/);
  calls = 0;
  await assert.rejects(readAccount(async () => ++calls === 1 ? { count: 2, ledger: { a: entry() } } : { count: 1, ledger: { b: entry() } }), /changé/);
  await assert.rejects(readAccount(async () => ({ count: 10001, ledger: {} })), /CSV complet/);
});
test('EUR purchases stay USD-unknown rather than being valued at present exchange rates', () => {
  const data = adaptAccount({ a: entry({ asset: 'ZEUR', amount: '-100', balance: '0' }), b: entry() }, { XXBT: '1', ZEUR: '0' });
  const r = analyze(parseCSV(data.csv), { snapshot: data.snapshot, notes: data.notes });
  assert.equal(r.assets[0].unknown, 1); assert.equal(r.assets[0].cost, 0);
  assert.equal(r.assets[0].price, null); assert.equal(r.totals.incomplete, true);
  assert.ok(r.warnings.some(w => w.includes('Import API')));
});
test('balance-only assets are imported as unknown deposits, aliases and Earn balances summed', () => {
  const data = adaptAccount({}, { XXBT: '1', 'XXBT.F': '0.5', ETH: '2' }, 1735689700000);
  assert.equal(data.snapshot.BTC, 1.5);
  const r = analyze(parseCSV(data.csv), { snapshot: data.snapshot });
  assert.equal(r.assets.find(a => a.asset === 'BTC').quantity, 1.5);
  assert.equal(r.assets.find(a => a.asset === 'ETH').unknown, 2);
});
test('API rejects negative balance, empty accounts and corrupt numeric ledgers', () => {
  assert.throws(() => adaptAccount({}, { BTC: '-1' }), /négatif/);
  assert.throws(() => adaptAccount({}, {}), /aucun ledger/);
  assert.throws(() => adaptAccount({ a: entry({ amount: 'not a number' }) }, { XXBT: '1' }), /numérique/);
});
test('API snapshot mismatch adds unknown units, never pretends to know their cost', () => {
  const data = adaptAccount({ a: entry({ asset: 'ZUSD', amount: '-100', balance: '0' }), b: entry() }, { XXBT: '2', ZUSD: '0' });
  const r = analyze(parseCSV(data.csv), { snapshot: data.snapshot });
  assert.equal(r.assets[0].quantity, 2); assert.equal(r.assets[0].cost, 100);
  assert.equal(r.assets[0].unknown, 1);
  assert.ok(r.warnings.some(w => w.includes('solde API différent')));
});
test('API Spot snapshot is reconciled separately from reconstructed Hybrid capital and its purchase cost', () => {
  const data = adaptAccount({
    usd: entry({ asset: 'ZUSD', amount: '-100', balance: '0' }),
    btc: entry(),
    hybrid: entry({ refid: 'hybrid', time: 1735776000, type: 'hybridearnwithdrawal', amount: '-1', balance: '0' }),
  }, { XXBT: '0', ZUSD: '0' });
  const r = analyze(parseCSV(data.csv), { snapshot: data.snapshot, includeHybrid: true, prices: { BTC: { value: 120 } } });
  assert.equal(r.assets[0].quantity, 1);
  assert.equal(r.assets[0].ledgerQuantity, 0);
  assert.equal(r.assets[0].hybridQuantity, 1);
  assert.equal(r.assets[0].economicCost, 100);
  assert.equal(r.assets[0].economicUnrealized, 20);
  assert.ok(!r.warnings.some(w => w.includes('solde API différent')));
});
test('API and valued CSV give the same economic gains for airdrops, bonuses, staking and USD sales', () => {
  const ledger = {
    gift: entry({ refid: 'gift', type: 'transfer', subtype: 'airdrop', amount: '4', balance: '4' }),
    bonus: entry({ refid: 'bonus', type: 'reward', subtype: 'invitebonus', amount: '2', balance: '6' }),
    staking: entry({ refid: 'staking', type: 'staking', amount: '2', balance: '8' }),
    sale: entry({ refid: 'sale', type: 'trade', amount: '-4', balance: '4' }),
    cash: entry({ refid: 'sale', type: 'trade', asset: 'ZUSD', amount: '40', fee: '1', balance: '39' }),
  };
  const data = adaptAccount(ledger, { XXBT: '4', ZUSD: '39' });
  const parsed = parseCSV(data.csv);
  const api = analyze(parsed, { snapshot: data.snapshot, prices: { BTC: { value: 5 } } });
  const valued = { ...parsed, rows: parsed.rows.map(r => r.fiat ? r : ({ ...r, amountusd: r.amount * 10, feeusd: r.fee * 10, balanceusd: r.balance * 10 })) };
  const csv = analyze(valued, { prices: { BTC: { value: 5 } } });
  for (const result of [api, csv]) {
    assert.equal(result.totals.economicUnrealized, 20);
    assert.equal(result.totals.economicRealized, 39);
    assert.equal(result.totals.economicIncomplete, false);
    assert.equal(result.assets[0].economicUnknown, 0);
    assert.equal(result.assets[0].giftRemaining, 4);
  }
  assert.equal(api.totals.rewardsIncomplete, true);
  assert.equal(csv.totals.rewardsIncomplete, false);
});
