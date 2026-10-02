import { createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeAsset, parseCSV } from './ledger.js';

const READ_METHODS = new Set(['Ledgers', 'Balance']);
const MAX_ENTRIES = 10000;
const headers = ['txid', 'refid', 'time', 'type', 'subtype', 'aclass', 'asset', 'wallet', 'amount', 'fee', 'balance', 'amountusd', 'feeusd', 'balanceusd', 'feecurrency'];
let lastNonce = 0n;

export function validateCredentials(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Identifiants API invalides.');
  const { key, secret, otp } = input;
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/=]{8,256}$/.test(key)) throw new Error('Clé API Kraken invalide.');
  if (typeof secret !== 'string' || secret.length > 1024 || !/^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(secret)) throw new Error('Secret API Kraken invalide (Base64 attendu).');
  if (otp && (typeof otp !== 'string' || !/^\d{6,8}$/.test(otp))) throw new Error('Code 2FA API invalide.');
  return { key, secret, otp: otp || '' };
}

export function signRequest(path, body, secret) {
  const nonce = new URLSearchParams(body).get('nonce');
  const hash = createHash('sha256').update(nonce + body).digest();
  return createHmac('sha512', Buffer.from(secret, 'base64')).update(path).update(hash).digest('base64');
}

export function createKrakenReader(credentials, { fetchImpl = fetch, wait = ms => delay(ms), signal } = {}) {
  const auth = validateCredentials(credentials);
  let previous = false;
  return async (method, params = {}) => {
    if (!READ_METHODS.has(method)) throw new Error('Endpoint interdit : ce connecteur est exclusivement en lecture seule.');
    if (previous) await wait(4250);
    previous = true;
    signal?.throwIfAborted();
    const now = BigInt(Date.now()) * 1000n;
    lastNonce = now > lastNonce ? now : lastNonce + 1n;
    const body = new URLSearchParams({ ...params, nonce: lastNonce.toString(), ...(auth.otp ? { otp: auth.otp } : {}) }).toString();
    const path = `/0/private/${method}`;
    const response = await fetchImpl(`https://api.kraken.com${path}`, {
      method: 'POST', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'API-Key': auth.key, 'API-Sign': signRequest(path, body, auth.secret) },
      body,
    });
    if (!response.ok) throw new Error(`Kraken répond HTTP ${response.status}. Import interrompu, aucune donnée partielle chargée.`);
    const data = await response.json();
    if (!Array.isArray(data.error) || !data.result || data.error.length) {
      const errors = Array.isArray(data.error) ? data.error : [];
      if (errors.some(e => /Permission denied/i.test(e))) throw new Error('Permission Kraken refusée : activez Query ledger entries et Query funds sur cette clé.');
      const authenticationErrors = [
        ['EAPI:Invalid key', 'clé invalide, désactivée ou expirée'],
        ['EAPI:Invalid signature', 'signature refusée : secret incorrect ou clé/secret non associés'],
        ['EAPI:Invalid nonce', 'nonce refusé : évitez de partager cette clé avec une autre application'],
        ['EAPI:Invalid arguments:otp', 'code 2FA API absent ou invalide'],
        ['EGeneral:Invalid arguments:otp', 'code 2FA API absent ou invalide'],
        ['EAPI:Invalid otp', 'code 2FA API invalide'],
      ].filter(([code]) => errors.some(error => error.toLowerCase().startsWith(code.toLowerCase())));
      if (authenticationErrors.length) throw new Error(`Authentification Kraken refusée (${authenticationErrors.map(([code, explanation]) => `${code} : ${explanation}`).join(' ; ')}). Vérifiez la clé dédiée et sa configuration sur Kraken.`);
      if (errors.some(e => /Rate limit/i.test(e))) throw new Error('Limite API Kraken atteinte. Patientez puis réessayez ; aucune donnée partielle chargée.');
      throw new Error('Réponse Kraken invalide ou erreur API. Import interrompu.');
    }
    return data.result;
  };
}

export async function readAccount(reader, { now = Date.now() } = {}) {
  const ledger = {};
  const end = Math.floor(now / 1000);
  let expected = null, offset = 0;
  while (true) {
    const page = await reader('Ledgers', { type: 'all', start: 0, end, ofs: offset });
    if (!page.ledger || typeof page.ledger !== 'object' || Array.isArray(page.ledger) || !Number.isSafeInteger(page.count) || page.count < 0) throw new Error('Pagination Kraken invalide.');
    if (page.count > MAX_ENTRIES) throw new Error(`Plus de ${MAX_ENTRIES} écritures : utilisez un export CSV complet. Aucun historique tronqué ne sera importé.`);
    if (expected === null) expected = page.count;
    if (expected !== page.count) throw new Error('L’historique Kraken a changé pendant la lecture. Réessayez ou utilisez un CSV.');
    const entries = Object.entries(page.ledger);
    if (!entries.length && offset < expected) throw new Error('Page Kraken vide avant la fin de l’historique.');
    for (const [id, entry] of entries) {
      if (Object.hasOwn(ledger, id)) throw new Error('Pagination Kraken incohérente : écriture répétée.');
      ledger[id] = entry;
    }
    offset += entries.length;
    if (offset === expected) break;
    if (offset > expected || offset > MAX_ENTRIES) throw new Error('Nombre d’écritures Kraken incohérent.');
  }
  const balances = await reader('Balance');
  return adaptAccount(ledger, balances, now);
}

export function adaptAccount(ledger, balances, now = Date.now()) {
  if (!balances || typeof balances !== 'object' || Array.isArray(balances)) throw new Error('Soldes Kraken invalides.');
  const notes = [
    'Import API : Kraken Ledgers ne fournit pas les valorisations historiques USD. Seuls les échanges simples avec USD peuvent avoir leur coût USD reconstitué ; les autres achats et apports restent à coût inconnu. Les distributions explicitement identifiées sont gratuites dans le mode économique, mais leur valeur à réception reste inconnue. Actualisez ou saisissez les cours pour valoriser les actifs détenus ; utilisez le CSV avec valeurs USD pour une analyse plus complète.',
    'Périmètre API : portefeuille par défaut de la clé Kraken, Spot et actifs Earn visibles par l’API. Les autres comptes, Futures et avoirs externes ne sont pas inclus.',
    'Les soldes sont lus après l’historique. Une différence est signalée et ajustée sans inventer de transaction ; évitez d’effectuer des opérations pendant la synchronisation.',
  ];
  const snapshot = {};
  for (const [rawAsset, rawBalance] of Object.entries(balances)) {
    if (typeof rawBalance !== 'string' || !/^\d+(?:\.\d+)?$/.test(rawBalance)) throw new Error('Solde Kraken invalide ou négatif : import non pris en charge.');
    const value = Number(rawBalance);
    if (!Number.isFinite(value)) throw new Error('Solde Kraken hors limites.');
    const asset = normalizeAsset(rawAsset);
    snapshot[asset] = (snapshot[asset] || 0) + value;
  }
  const rows = Object.entries(ledger).map(([id, r]) => {
    if (!r || !Number.isFinite(r.time)) throw new Error('Date de ledger Kraken invalide.');
    const usd = normalizeAsset(r.asset || '') === 'USD';
    return {
      txid: id, refid: r.refid || '', time: new Date(r.time * 1000).toISOString(),
      type: r.type, subtype: r.subtype || '', aclass: r.aclass, asset: r.asset,
      wallet: r.wallet || `API / ${r.aclass || 'currency'}`,
      amount: r.amount, fee: r.fee, balance: r.balance,
      amountusd: usd ? r.amount : '-', feeusd: usd ? r.fee : Number(r.fee) === 0 ? '0' : '-',
      balanceusd: usd ? r.balance : '-', feecurrency: Number(r.fee) > 0 ? r.asset : '',
    };
  });
  const groups = new Map();
  for (const r of rows.filter(r => ['trade', 'spend', 'receive'].includes(r.type) && r.refid)) {
    if (!groups.has(r.refid)) groups.set(r.refid, []);
    groups.get(r.refid).push(r);
  }
  for (const group of groups.values()) {
    if (group.length !== 2) continue;
    const usd = group.find(r => normalizeAsset(r.asset) === 'USD');
    const other = group.find(r => normalizeAsset(r.asset) !== 'USD');
    if (!usd || !other || Number(usd.amount) * Number(other.amount) >= 0) continue;
    const value = Math.abs(Number(usd.amount));
    const price = value / Math.abs(Number(other.amount));
    other.amountusd = Math.sign(Number(other.amount)) * value;
    other.feeusd = price * Number(other.fee);
  }
  const present = new Set(rows.map(r => normalizeAsset(r.asset)));
  for (const [asset, quantity] of Object.entries(snapshot)) {
    if (present.has(asset) || quantity === 0) continue;
    rows.push({ txid: `api-snapshot-${asset}`, refid: '', time: new Date(now).toISOString(), type: 'deposit', subtype: '', aclass: 'currency', asset, wallet: 'API / snapshot', amount: quantity, fee: 0, balance: quantity, amountusd: asset === 'USD' ? quantity : '-', feeusd: 0, balanceusd: asset === 'USD' ? quantity : '-', feecurrency: '' });
    notes.push(`${asset} : solde présent sans ledger ; quantité importée comme apport de coût inconnu.`);
  }
  if (!rows.length) throw new Error('Ce compte Kraken ne contient aucun ledger ni solde à analyser.');
  const csv = [headers, ...rows.map(r => headers.map(h => r[h]))].map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
  parseCSV(csv);
  return { csv, snapshot, notes, importedAt: now };
}
