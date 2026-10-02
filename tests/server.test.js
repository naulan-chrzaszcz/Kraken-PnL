import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { analyze, parseCSV } from '../ledger.js';

test('local connector imports a complete mocked Kraken account over HTTP and rejects unsafe routes/origins', async t => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const entry = overrides => ({ refid: 'gift', time: 1735689600, type: 'transfer', subtype: 'airdrop',
    aclass: 'currency', asset: 'XXBT', amount: '4', fee: '0', balance: '4', ...overrides });
  const ledger = {
    gift: entry({}),
    bonus: entry({ refid: 'bonus', type: 'reward', subtype: 'invitebonus', amount: '2', balance: '6' }),
    stake: entry({ refid: 'stake', type: 'staking', subtype: '', amount: '2', balance: '8' }),
    sale: entry({ refid: 'sale', type: 'trade', subtype: '', amount: '-4', balance: '4' }),
    cash: entry({ refid: 'sale', type: 'trade', subtype: '', asset: 'ZUSD', amount: '40', fee: '1', balance: '39' }),
  };
  const script = `
    const ledger = ${JSON.stringify(ledger)};
    globalThis.fetch = async (url, options) => {
      if (!url.startsWith('https://api.kraken.com/0/private/') || !options.headers['API-Sign']) throw new Error('Unexpected unsigned upstream request');
      const result = url.endsWith('/Ledgers') ? { ledger, count: 5 } :
        url.endsWith('/Balance') ? { XXBT: '4', ZUSD: '39' } : null;
      if (!result) throw new Error('Unexpected upstream endpoint');
      return { ok: true, json: async () => ({ error: [], result }) };
    };
    process.argv.push('--kraken');
    await import(${JSON.stringify(new URL('../server.js', import.meta.url).href)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PORT: String(port), CONNECTOR_ORIGIN: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connector did not start')), 5000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Connector exited ${code}: ${stderr}`)); });
    child.stdout.on('data', data => {
      if (data.toString().includes(`127.0.0.1:${port}`)) { clearTimeout(timeout); resolve(); }
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await (await fetch(`${origin}/api/status`)).json()).enabled, true);
  for (const path of ['/kraken-api.js', '/server.js', '/private-export.csv']) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404);
  }
  assert.equal((await fetch(`${origin}/api/import`, { method: 'POST', headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const invalid = await fetch(`${origin}/api/import`, { method: 'POST', headers, body: '{"key":"","secret":""}' });
  assert.equal(invalid.status, 400); assert.match((await invalid.json()).error, /Clé API/);
  const response = await fetch(`${origin}/api/import`, {
    method: 'POST', headers, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ key: 'TESTKEYONLY', secret: Buffer.alloc(64, 17).toString('base64') }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(data.notes.join(' '), /distributions explicitement identifiées/);
  const result = analyze(parseCSV(data.csv), { snapshot: data.snapshot, notes: data.notes });
  assert.equal(result.rows.length, 5);
  assert.equal(result.assets[0].quantity, 4);
  assert.equal(result.totals.economicUnrealized, 40);
  assert.equal(result.totals.economicRealized, 39);
  assert.equal(result.totals.economicIncomplete, false);
  assert.equal(result.totals.rewardsIncomplete, true);
});
