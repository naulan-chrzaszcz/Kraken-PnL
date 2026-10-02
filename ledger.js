const FIAT = new Set(['EUR', 'USD', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'AED']);
const ALIASES = { XXBT: 'BTC', XBT: 'BTC', XETH: 'ETH', XXDG: 'DOGE', XDG: 'DOGE', ZEUR: 'EUR', ZUSD: 'USD', XXTZ: 'XTZ', XXMR: 'XMR', XLTC: 'LTC', XXRP: 'XRP', ZGBP: 'GBP', ZCAD: 'CAD', ZAUD: 'AUD', ZJPY: 'JPY', ZCHF: 'CHF', XZEC: 'ZEC', XETC: 'ETC', XXLM: 'XLM' };
const TRADE = new Set(['trade', 'spend', 'receive']);
const TRANSFER_TYPES = new Set(['transfer', 'earn', 'staking', 'unstaking', 'hybridearnwithdrawal', 'hybridearndeposit']);
const REWARD = new Set(['reward', 'airdrop', 'invitebonus', 'welcomebonus']);
const EPS = 1e-12;

export function isReward(r) {
  const type = r.type.replace(/[\s_-]/g, '').toLowerCase();
  const subtype = r.subtype.replace(/[\s_-]/g, '').toLowerCase();
  return REWARD.has(type) || REWARD.has(subtype) || (type === 'staking' && !subtype);
}

export function normalizeAsset(asset) {
  const base = asset.replace(/\.(HOLD|S|M|F|B)$/, '');
  return ALIASES[base] || base;
}

export function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const delimiter = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n')).includes(';') ? ';' : ',';
  const records = [];
  let row = [], cell = '', quoted = false, closed = false;
  const endCell = () => { row.push(cell); cell = ''; closed = false; };
  const endRow = () => { endCell(); if (row.some(v => v.trim())) records.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (c === delimiter) endCell();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else if (closed || c === '"') throw new Error('CSV invalide : guillemets ou caractères après un champ cité.');
    else cell += c;
  }
  if (quoted) throw new Error('CSV invalide : guillemet non fermé.');
  if (cell || row.length || closed) endRow();
  if (records.length < 2) throw new Error('Le fichier ne contient aucune opération.');
  const headers = records.shift().map(h => h.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error('CSV invalide : colonnes dupliquées.');
  const required = ['txid', 'refid', 'time', 'type', 'asset', 'amount', 'fee', 'balance', 'amountusd', 'feeusd', 'balanceusd'];
  const missing = required.filter(h => !headers.includes(h));
  if (missing.length) throw new Error(`Colonnes manquantes : ${missing.join(', ')}. Exportez les Ledgers avec les valeurs USD depuis Kraken.`);
  const seen = new Map();
  const rows = [];
  let duplicates = 0;
  for (const [index, cells] of records.entries()) {
    const line = index + 2;
    if (cells.length !== headers.length) throw new Error(`Ligne ${line} : nombre de colonnes incorrect.`);
    const raw = Object.fromEntries(headers.map((h, i) => [h, cells[i].trim()]));
    if (!raw.txid || !raw.asset || !raw.type || !/^[A-Z0-9._-]+$/.test(raw.asset)) throw new Error(`Ligne ${line} : identifiant, type ou actif invalide.`);
    const signature = JSON.stringify(raw);
    if (seen.has(raw.txid)) {
      if (seen.get(raw.txid) !== signature) throw new Error(`Ligne ${line} : identifiant ${raw.txid} dupliqué avec des valeurs différentes.`);
      duplicates++; continue;
    }
    seen.set(raw.txid, signature);
    const timestamp = Date.parse(raw.time.includes('T') ? raw.time : raw.time.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(timestamp)) throw new Error(`Ligne ${line} : date invalide.`);
    for (const field of ['amount', 'fee', 'balance', 'amountusd', 'feeusd', 'balanceusd']) {
      if (field.endsWith('usd') && ['-', ''].includes(raw[field])) {
        raw[field] = null;
        continue;
      }
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw[field])) throw new Error(`Ligne ${line} : ${field} doit être numérique.`);
      raw[field] = Number(raw[field]);
      if (!Number.isFinite(raw[field])) throw new Error(`Ligne ${line} : ${field} hors limites.`);
    }
    if (raw.fee < 0 || raw.feeusd < 0 || raw.balance < -EPS) throw new Error(`Ligne ${line} : frais ou solde négatif non pris en charge.`);
    if (raw.amount > 0 && raw.fee > raw.amount + EPS) throw new Error(`Ligne ${line} : Frais supérieurs à la quantité reçue.`);
    const asset = normalizeAsset(raw.asset);
    if (raw.fee > 0 && raw.feecurrency && normalizeAsset(raw.feecurrency) !== asset) {
      throw new Error(`Ligne ${line} : frais dans une autre devise non pris en charge ; importez un ledger avec frais débités sur leur propre ligne.`);
    }
    rows.push({ ...raw, rawAsset: raw.asset, asset, timestamp, index, wallet: raw.wallet || 'spot / main', subtype: raw.subtype || '', fiat: raw.subclass === 'fiat' || FIAT.has(asset) });
  }
  rows.sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
  return { rows, duplicates };
}

// Unknown units retain a separate basis: missing history never becomes a zero-cost purchase.
export function analyze(parsed, options = {}) {
  const { rows } = parsed;
  if (!rows.length) throw new Error('Aucune opération à analyser.');
  const states = new Map(), wallets = new Map(), groups = new Map(), warnings = [];
  const warning = (message) => warnings.push(message);
  const state = (r) => {
    if (!states.has(r.asset)) states.set(r.asset, {
      asset: r.asset, fiat: r.fiat, quantity: 0, cost: 0, unknown: 0, bought: 0, sold: 0,
      realized: 0, realizedIncomplete: false, rewards: 0, fees: 0, unknownAdded: 0,
      estimated: false, price: null, priceDate: null, priceSource: 'Export', opening: 0,
      rewardsIncomplete: false,
      missingValuations: 0,
      economicCost: 0, economicUnknown: 0, economicRealized: 0, economicRealizedIncomplete: false,
      economicEstimated: false, economicUnknownAdded: 0,
      gifted: 0, giftRemaining: 0, giftRealized: 0, giftRealizedIncomplete: false,
      hybridQuantity: 0,
    });
    return states.get(r.asset);
  };
  function addUnknown(s, quantity) {
    if (quantity <= EPS) return;
    s.quantity += quantity; s.unknownAdded += quantity; s.economicUnknownAdded += quantity;
    const basis = options.basis?.[s.asset];
    if (Number.isFinite(basis) && basis >= 0) {
      s.cost += quantity * basis; s.economicCost += quantity * basis;
      s.estimated = true; s.economicEstimated = true;
    } else { s.unknown += quantity; s.economicUnknown += quantity; }
  }
  function remove(s, quantity, proceeds, sale = false) {
    if (quantity <= EPS) return;
    if (quantity > s.quantity + Math.max(EPS, s.quantity * 1e-8)) {
      warning(`${s.asset} : sortie supérieure au stock connu ; historique incomplet.`);
      addUnknown(s, quantity - s.quantity);
    }
    const fraction = s.quantity > EPS ? Math.min(1, quantity / s.quantity) : 0;
    const removedCost = s.cost * fraction, removedUnknown = s.unknown * fraction;
    const removedEconomicCost = s.economicCost * fraction, removedEconomicUnknown = s.economicUnknown * fraction;
    const removedGift = s.giftRemaining * fraction;
    if (sale) {
      s.realized += proceeds * (quantity > EPS ? Math.max(0, 1 - removedUnknown / quantity) : 0) - removedCost;
      if (removedUnknown > EPS) s.realizedIncomplete = true;
      s.economicRealized += proceeds * Math.max(0, 1 - removedEconomicUnknown / quantity) - removedEconomicCost;
      if (removedEconomicUnknown > EPS) s.economicRealizedIncomplete = true;
      s.giftRealized += proceeds * removedGift / quantity;
    }
    s.cost = Math.max(0, s.cost - removedCost);
    s.unknown = Math.max(0, s.unknown - removedUnknown);
    s.quantity = Math.max(0, s.quantity - quantity);
    s.economicCost = Math.max(0, s.economicCost - removedEconomicCost);
    s.economicUnknown = Math.max(0, s.economicUnknown - removedEconomicUnknown);
    s.giftRemaining = Math.max(0, s.giftRemaining - removedGift);
  }
  for (const r of rows) {
    const s = state(r), key = `${r.rawAsset}|${r.wallet}`;
    if (!wallets.has(key)) {
      const opening = r.balance - r.amount + r.fee;
      wallets.set(key, { balance: Math.max(0, opening), asset: r.asset, opening: Math.max(0, opening), initialized: false });
      if (opening < -EPS) warning(`${r.asset} : solde d'ouverture incohérent dans ${r.wallet}.`);
    }
    const groupKey = r.refid ? `${r.refid}|${TRADE.has(r.type) ? 'trade' : 'other'}` : `row:${r.index}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(r);
    if (r.balance > EPS && r.balanceusd > 0) {
      s.price = r.balanceusd / r.balance; s.priceDate = r.timestamp;
    } else if (Math.abs(r.amount) > EPS && Math.abs(r.amountusd) > 0) {
      s.price = Math.abs(r.amountusd / r.amount); s.priceDate = r.timestamp;
    }
    s.fees += r.feeusd ?? 0;
    if (r.amountusd === null || r.feeusd === null || r.balanceusd === null) {
      s.missingValuations++;
    }
  }
  const ordered = [...groups.values()].sort((a, b) => a[0].timestamp - b[0].timestamp || a[0].index - b[0].index);
  for (const group of ordered) {
    for (const r of group) {
      const w = wallets.get(`${r.rawAsset}|${r.wallet}`);
      if (!w.initialized) {
        if (w.opening > EPS) {
          addUnknown(state(r), w.opening);
          state(r).opening += w.opening;
          if (r.timestamp > rows[0].timestamp) warning(`${r.asset} : solde initial découvert tardivement dans ${r.wallet} ; il est ajouté à la première ligne disponible, pas rétroactivement aux ventes précédentes.`);
        }
        w.initialized = true;
      }
      const expected = w.balance + r.amount - r.fee;
      const gap = r.balance - expected;
      if (Math.abs(gap) > Math.max(1e-9, Math.abs(r.balance) * 1e-8)) {
        warning(`${r.asset} : rupture de solde le ${r.time} (${r.wallet}) ; stock ajusté, coût incomplet.`);
        if (gap > 0) addUnknown(state(r), gap);
        else remove(state(r), -gap, 0);
      }
      w.balance = r.balance;
    }
    if (group.every(r => TRADE.has(r.type))) {
      const outgoing = group.filter(r => r.amount < 0), incoming = group.filter(r => r.amount > 0);
      const missingValuation = group.some(r => r.amountusd === null || (r.amount !== 0 && r.amountusd === 0) || (r.fee > 0 && r.feeusd === null));
      if (!outgoing.length || !incoming.length || missingValuation) {
        warning(`Transaction ${[...new Set(group.map(r => r.asset))].sort().join('/')} ${missingValuation ? 'sans valorisation complète' : 'non appariée'} : coût ou produit de vente inconnu.`);
        for (const r of group) {
          const s = state(r);
          if (r.amount > 0) addUnknown(s, Math.max(0, r.amount - r.fee));
          else {
            if (s.giftRemaining > EPS && r.amount < 0) s.giftRealizedIncomplete = true;
            remove(s, -r.amount + r.fee, 0);
            s.realizedIncomplete = true; s.economicRealizedIncomplete = true;
          }
        }
        continue;
      }
      const outgoingValue = outgoing.reduce((sum, r) => sum + Math.abs(r.amountusd), 0);
      const incomingValue = incoming.reduce((sum, r) => sum + Math.abs(r.amountusd), 0);
      const outgoingFiatFees = group.filter(r => r.fiat && r.amount <= 0).reduce((sum, r) => sum + (r.feeusd ?? 0), 0);
      const incomingFiatFees = incoming.filter(r => r.fiat).reduce((sum, r) => sum + (r.feeusd ?? 0), 0);
      const fiatOut = outgoing.every(r => r.fiat), fiatIn = incoming.every(r => r.fiat);
      // Crypto outgoing fees already leave the disposed basis; incoming fees already reduce acquired units.
      const purchaseCost = outgoingValue + outgoingFiatFees;
      const saleProceeds = (fiatIn ? incomingValue : outgoingValue) - incomingFiatFees - (fiatIn ? outgoingFiatFees : 0);
      for (const r of outgoing) {
        const s = state(r);
        const proceeds = outgoingValue > 0 ? saleProceeds * Math.abs(r.amountusd) / outgoingValue : 0;
        remove(s, -r.amount + r.fee, proceeds, !s.fiat);
        if (!s.fiat) s.sold += proceeds;
      }
      for (const r of incoming) {
        const s = state(r), q = r.amount - r.fee;
        if (q < -EPS) throw new Error(`Frais supérieurs à la quantité reçue : ${r.txid}.`);
        const cost = incomingValue > 0 ? purchaseCost * Math.abs(r.amountusd) / incomingValue : 0;
        if (incomingValue <= 0 || (!fiatOut && outgoingValue <= 0)) addUnknown(s, q);
        else { s.quantity += q; s.cost += cost; s.economicCost += cost; }
        if (!s.fiat) s.bought += cost;
      }
      for (const r of group.filter(r => r.amount === 0 && r.fee > 0)) {
        remove(state(r), r.fee, 0, !r.fiat);
      }
    } else {
      const internal = new Set();
      for (const asset of new Set(group.map(r => r.asset))) {
        const same = group.filter(r => r.asset === asset);
        if (same.length > 1 && same.every(r => TRANSFER_TYPES.has(r.type) && (!isReward(r) || (r.type === 'staking' && !r.subtype))) &&
          same.some(r => r.amount > 0) && same.some(r => r.amount < 0) &&
          Math.abs(same.reduce((sum, r) => sum + r.amount, 0)) <= Math.max(EPS, Math.max(...same.map(r => Math.abs(r.amount))) * 1e-9)) internal.add(asset);
      }
      for (const r of group) {
        const s = state(r);
        if (internal.has(r.asset)) { remove(s, r.fee, 0); continue; }
        if (options.includeHybrid && ['hybridearnwithdrawal', 'hybridearndeposit'].includes(r.type)) {
          if (r.type === 'hybridearnwithdrawal' && r.amount < 0) {
            s.hybridQuantity += -r.amount;
            remove(s, r.fee, 0);
          } else if (r.type === 'hybridearndeposit' && r.amount > 0) {
            const returned = Math.min(s.hybridQuantity, r.amount);
            s.hybridQuantity = Math.max(0, s.hybridQuantity - returned);
            addUnknown(s, r.amount - returned);
            if (r.amount - returned > EPS) warning(`${s.asset} : retour Hybrid Earn supérieur au capital transféré visible ; excédent à coût inconnu, pas une récompense supposée.`);
            remove(s, r.fee, 0);
          } else {
            throw new Error(`${s.asset} : sens du mouvement Hybrid Earn inattendu ; import interrompu pour éviter un solde inventé.`);
          }
          continue;
        }
        if (r.amount > 0) {
          const q = Math.max(0, r.amount - r.fee);
          if (isReward(r)) {
            // Both books share quantities; only the reception-value book capitalizes free distributions.
            const previousEconomicCost = s.economicCost, previousEconomicUnknown = s.economicUnknown;
            const previousEconomicEstimated = s.economicEstimated, previousEconomicUnknownAdded = s.economicUnknownAdded;
            if (r.amountusd === null || (r.fee > 0 && r.feeusd === null)) {
              addUnknown(s, q); s.rewardsIncomplete = true;
            } else {
              const value = Math.max(0, Math.abs(r.amountusd) - (r.feeusd ?? 0));
              s.quantity += q; s.cost += value; s.rewards += value;
            }
            s.economicCost = previousEconomicCost; s.economicUnknown = previousEconomicUnknown;
            s.economicEstimated = previousEconomicEstimated; s.economicUnknownAdded = previousEconomicUnknownAdded;
            s.gifted += q; s.giftRemaining += q;
          } else {
            addUnknown(s, q);
            if (r.type !== 'deposit') warning(`${r.asset} : entrée ${r.type}/${r.subtype || 'sans sous-type'} traitée comme apport à coût inconnu.`);
          }
        } else remove(s, -r.amount + r.fee, 0);
        if (!isReward(r) && !['deposit', 'withdrawal', 'transfer', 'earn', 'reward', 'staking', 'unstaking', 'hybridearnwithdrawal', 'hybridearndeposit'].includes(r.type)) {
          warning(`${r.asset} : type ${r.type} non interprété comme achat/vente ; mouvement à vérifier.`);
        }
      }
    }
  }
  for (const s of states.values()) {
    const ledgerBalance = [...wallets.values()].filter(w => w.asset === s.asset).reduce((sum, w) => sum + w.balance, 0);
    const spotBalance = options.snapshot ? options.snapshot[s.asset] ?? 0 : ledgerBalance;
    const balance = spotBalance + s.hybridQuantity;
    if (!Number.isFinite(balance) || balance < 0) throw new Error(`Solde de rapprochement invalide pour ${s.asset}.`);
    if (options.snapshot && Math.abs(spotBalance - ledgerBalance) > Math.max(1e-8, spotBalance * 1e-8)) {
      warning(`${s.asset} : solde API différent du dernier ledger ; mouvements récents ou historiques manquants, coût ajusté et potentiellement incomplet.`);
    }
    if (Math.abs(balance - s.quantity) > Math.max(1e-8, balance * 1e-8)) {
      warning(`${s.asset} : écart de rapprochement ; quantité finale alignée sur les soldes Kraken.`);
      if (balance > s.quantity) addUnknown(s, balance - s.quantity);
      else remove(s, s.quantity - balance, 0);
    }
    s.quantity = balance;
    s.ledgerQuantity = spotBalance;
    if (s.hybridQuantity > EPS) warning(`${s.asset} : ${s.hybridQuantity} unités Hybrid Earn reconstituées à partir des transferts nets, coût conservé. Ce n’est pas un solde actuel confirmé : rendement, pertes et mouvements hors ledger ne sont pas disponibles. Désactivez l’inclusion si ce produit est déjà compris dans votre solde API.`);
    const manual = options.prices?.[s.asset];
    if (manual && Number.isFinite(manual.value) && manual.value >= 0) {
      s.price = manual.value; s.priceSource = manual.source || 'Manuel'; s.priceDate = manual.date || Date.now();
    }
    s.knownQuantity = Math.max(0, s.quantity - s.unknown);
    s.averageCost = s.knownQuantity > EPS ? s.cost / s.knownQuantity : null;
    s.value = s.price === null ? null : s.quantity * s.price;
    s.unrealized = s.price === null ? null : s.knownQuantity * s.price - s.cost;
    s.unrealizedPercent = s.cost > EPS && s.unrealized !== null ? 100 * s.unrealized / s.cost : null;
    s.economicKnownQuantity = Math.max(0, s.quantity - s.economicUnknown);
    s.economicAverageCost = s.economicKnownQuantity > EPS ? s.economicCost / s.economicKnownQuantity : null;
    s.economicUnrealized = s.price === null ? null : s.economicKnownQuantity * s.price - s.economicCost;
    s.economicUnrealizedPercent = s.economicCost > EPS && s.economicUnrealized !== null ? 100 * s.economicUnrealized / s.economicCost : null;
    s.giftValue = s.giftRemaining <= EPS ? 0 : s.price === null ? null : s.giftRemaining * s.price;
    s.feesIncomplete = rows.some(r => r.asset === s.asset && r.fee > 0 && r.feeusd === null);
    if (s.missingValuations) warning(`${s.asset} : valorisation USD absente sur ${s.missingValuations} ligne(s) ; les montants concernés restent inconnus.`);
  }
  const assets = [...states.values()].filter(s => !s.fiat).sort((a, b) => (b.value || 0) - (a.value || 0));
  const held = assets.filter(s => s.quantity > EPS);
  const totals = assets.reduce((t, s) => ({
    value: t.value + (s.value || 0), cost: t.cost + s.cost, unrealized: t.unrealized + (s.unrealized || 0),
    realized: t.realized + s.realized, rewards: t.rewards + s.rewards, fees: t.fees + s.fees,
    bought: t.bought + s.bought, sold: t.sold + s.sold,
  }), { value: 0, cost: 0, unrealized: 0, realized: 0, rewards: 0, fees: 0, bought: 0, sold: 0 });
  totals.fees = rows.reduce((sum, r) => sum + (r.feeusd ?? 0), 0);
  totals.feesIncomplete = rows.some(r => r.fee > 0 && r.feeusd === null);
  totals.rewardsIncomplete = assets.some(s => s.rewardsIncomplete);
  totals.cash = [...states.values()].filter(s => s.fiat).reduce((sum, s) => sum + (s.value || 0), 0);
  totals.incomplete = held.some(s => s.unknown > EPS || s.price === null);
  totals.unpricedAssets = held.filter(s => s.price === null).map(s => s.asset);
  totals.realizedIncomplete = assets.some(s => s.realizedIncomplete);
  totals.estimated = assets.some(s => s.estimated);
  totals.knownValue = held.reduce((sum, s) => sum + (s.price === null ? 0 : s.knownQuantity * s.price), 0);
  totals.coverage = totals.value > EPS ? totals.knownValue / totals.value * 100 : 0;
  totals.economicCost = assets.reduce((sum, s) => sum + s.economicCost, 0);
  totals.economicUnrealized = assets.reduce((sum, s) => sum + (s.economicUnrealized || 0), 0);
  totals.economicRealized = assets.reduce((sum, s) => sum + s.economicRealized, 0);
  totals.economicIncomplete = held.some(s => s.economicUnknown > EPS || s.price === null);
  totals.economicRealizedIncomplete = assets.some(s => s.economicRealizedIncomplete);
  totals.economicEstimated = assets.some(s => s.economicEstimated);
  totals.hybridReconstructed = held.some(s => s.hybridQuantity > EPS);
  totals.economicKnownValue = held.reduce((sum, s) => sum + (s.price === null ? 0 : s.economicKnownQuantity * s.price), 0);
  totals.economicCoverage = totals.value > EPS ? totals.economicKnownValue / totals.value * 100 : 0;
  totals.giftValue = held.reduce((sum, s) => sum + (s.giftValue || 0), 0);
  totals.giftValueIncomplete = held.some(s => s.giftRemaining > EPS && s.price === null);
  totals.giftRealized = assets.reduce((sum, s) => sum + s.giftRealized, 0);
  totals.giftRealizedIncomplete = assets.some(s => s.giftRealizedIncomplete);
  if (assets.some(s => s.economicUnknownAdded > EPS && !s.economicEstimated)) warning('Historique partiel : soldes initiaux et apports externes sans prix d’achat. Leurs unités sont exclues des gains au coût connu ; seules les distributions explicitement identifiées sont gratuites dans le mode économique.');
  if (totals.estimated) warning('Coûts estimés : les coûts unitaires saisis remplacent les coûts inconnus des soldes initiaux et apports externes, y compris pour les ventes passées. Les gains correspondants restent des estimations.');
  if (held.some(s => s.price === null)) warning('Certains actifs n’ont pas de prix : leur valeur et leur gain sont exclus des totaux. Renseignez un prix manuel.');
  if (!options.includeHybrid && rows.some(r => r.type === 'hybridearnwithdrawal' && r.amount < 0)) {
    warning('Des transferts vers Hybrid Earn sont exclus du solde suivi. Un solde Spot nul ne signifie pas que vous ne détenez plus cet actif dans un coffre DeFi. Activez la reconstitution Hybrid Earn pour inclure le capital net transféré, sans inventer son rendement.');
  }
  if (parsed.duplicates) warning(`${parsed.duplicates} ligne(s) identique(s) dédupliquée(s).`);
  return { assets, totals, warnings: [...new Set([...warnings, ...(options.notes || [])])], rows, start: rows[0].timestamp, end: rows.at(-1).timestamp };
}
