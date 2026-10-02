const DATABASE = 'ledgerlens-credentials';
const STORE = 'credentials';
const RECORD = 'kraken';
const CONTEXT = new TextEncoder().encode('LedgerLens credentials v1');
let pendingWrite = Promise.resolve();

function write(operation) {
  const next = pendingWrite.then(operation, operation);
  pendingWrite = next;
  return next;
}

function openDatabase() {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle) throw new Error('La mémorisation chiffrée nécessite IndexedDB et Web Crypto sur une page HTTPS ou localhost.');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Impossible d’ouvrir le stockage local des identifiants.'));
    request.onblocked = () => reject(new Error('Le stockage des identifiants est bloqué par un autre onglet.'));
  });
}

async function transaction(mode, action) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(new Error('Échec du stockage local des identifiants.'));
      tx.onabort = () => reject(new Error('Stockage local des identifiants interrompu.'));
    });
  } finally { database.close(); }
}

export function rememberCredentials({ key, secret }) {
  return write(async () => {
    const encryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const payload = new TextEncoder().encode(JSON.stringify({ key, secret }));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: CONTEXT }, encryptionKey, payload);
    await transaction('readwrite', store => store.put({ version: 1, encryptionKey, iv, ciphertext }, RECORD));
  });
}

export async function restoreCredentials() {
  const record = await transaction('readonly', store => store.get(RECORD));
  if (!record) return null;
  if (record.version !== 1 || !(record.encryptionKey instanceof CryptoKey) || record.encryptionKey.extractable) {
    throw new Error('Identifiants mémorisés invalides. Oubliez-les puis saisissez à nouveau votre clé.');
  }
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: CONTEXT }, record.encryptionKey, record.ciphertext);
  } catch {
    throw new Error('Impossible de déchiffrer les identifiants mémorisés. Oubliez-les puis saisissez à nouveau votre clé.');
  }
  const credentials = JSON.parse(new TextDecoder().decode(plaintext));
  if (typeof credentials.key !== 'string' || typeof credentials.secret !== 'string') throw new Error('Identifiants mémorisés incomplets.');
  return { key: credentials.key, secret: credentials.secret };
}

export function forgetCredentials() {
  return write(() => transaction('readwrite', store => store.delete(RECORD)));
}
