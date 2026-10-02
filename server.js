import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createKrakenReader, readAccount } from './kraken-api.js';

const allowed = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/ledger.js', ['ledger.js', 'text/javascript']],
  ['/prices.js', ['prices.js', 'text/javascript']],
  ['/vault.js', ['vault.js', 'text/javascript']],
  ['/market.js', ['market.js', 'text/javascript']],
  ['/chart.js', ['chart.js', 'text/javascript']],
  ['/currency.js', ['currency.js', 'text/javascript']],
  ['/coingecko.js', ['coingecko.js', 'text/javascript']],
]);
const port = Number(process.env.PORT || 4173);
const apiEnabled = process.argv.includes('--kraken');
const localOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
if (process.env.CONNECTOR_ORIGIN) {
  const origin = new URL(process.env.CONNECTOR_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== process.env.CONNECTOR_ORIGIN) throw new Error('CONNECTOR_ORIGIN doit être une origine HTTPS exacte, sans chemin.');
  localOrigins.add(origin.origin);
}
let busy = false;
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) { res.writeHead(403); res.end('Host forbidden'); return; }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const origin = req.headers.origin;
    const permitted = localOrigins.has(origin);
    if (origin && !permitted) { res.writeHead(403); res.end(JSON.stringify({ error: 'Origine non autorisée par le connecteur local.' })); return; }
    if (permitted) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') { res.writeHead(permitted ? 204 : 403); res.end(); return; }
    if (pathname === '/api/status' && req.method === 'GET') { res.end(JSON.stringify({ enabled: apiEnabled, busy })); return; }
    if (pathname !== '/api/import' || req.method !== 'POST') { res.writeHead(404); res.end(JSON.stringify({ error: 'Endpoint inconnu.' })); return; }
    if (!apiEnabled || !permitted) { res.writeHead(403); res.end(JSON.stringify({ error: 'Connexion désactivée ou origine non autorisée. Lancez npm run connect et utilisez son adresse locale.' })); return; }
    if (busy) { res.writeHead(409); res.end(JSON.stringify({ error: 'Une synchronisation est déjà en cours.' })); return; }
    if (req.headers['content-type'] !== 'application/json') { res.writeHead(415); res.end(JSON.stringify({ error: 'Format JSON requis.' })); return; }
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    busy = true;
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > 16384) throw new Error('Requête trop volumineuse.');
      }
      let credentials;
      try { credentials = JSON.parse(body); }
      catch { throw new Error('Requête JSON invalide.'); }
      const reader = createKrakenReader(credentials, { signal: abort.signal, wait: ms => delay(ms, undefined, { signal: abort.signal }) });
      body = ''; credentials = null;
      const data = await readAccount(reader);
      res.end(JSON.stringify(data));
    } catch (error) {
      if (!abort.signal.aborted) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: error instanceof SyntaxError ? 'Réponse Kraken illisible.' : error.message }));
      }
    } finally { busy = false; }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('Method not allowed'); return; }
  const entry = allowed.get(pathname);
  if (!entry) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const data = await readFile(new URL(entry[0], import.meta.url));
    res.writeHead(200, { 'Content-Type': `${entry[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (error) {
    console.error(error);
    res.writeHead(500); res.end('Server error');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}${apiEnabled ? ' · connecteur Kraken lecture seule activé' : ''}`));
