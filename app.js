import { parseCSV, analyze } from './ledger.js';
import { fetchKrakenPrices } from './prices.js';
import { rememberCredentials, restoreCredentials, forgetCredentials } from './vault.js';
import { PortfolioChart } from './chart.js';
import { displayCurrency, fetchEURRate } from './currency.js';
import { COINGECKO_IDS, fetchGeckoQuotes } from './coingecko.js';

const $ = id => document.getElementById(id);
const units = new Intl.NumberFormat('fr-FR', { maximumSignificantDigits: 10 });
const percent = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const date = value => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(value);
const dollars = value => displayCurrency.money(value);
const signed = value => value === null ? '—' : `${value > 0 ? '+' : ''}${dollars(value)}`;
const COLORS = ['#138777', '#5eae98', '#253f51', '#7596ab', '#b6c8d1', '#d6e2e5'];
let parsed = null, result = null, filename = '', prices = {}, basis = {}, requestId = 0, priceMessage = '', sourceOptions = {}, apiAbort = null;
let memoryRevision = 0;
const portfolioChart = new PortfolioChart();

function connectorAddress() {
  const connector = new URL($('connector-url').value);
  if (connector.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(connector.hostname) ||
    connector.username || connector.password || connector.pathname !== '/' || connector.search || connector.hash) {
    throw new Error('Utilisez uniquement l’adresse HTTP de votre connecteur local (127.0.0.1 ou localhost), sans chemin ni identifiants.');
  }
  return connector;
}
async function checkConnector(connector, signal) {
  let response;
  try {
    response = await fetch(`${connector.origin}/api/status`, {
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Connecteur inaccessible à ${connector.origin}. Lancez npm run connect sur cet ordinateur ; depuis GitHub Pages, vérifiez CONNECTOR_ORIGIN et les restrictions d’accès au réseau local. Aucune clé n’a été envoyée.`);
  }
  if (!response.ok) throw new Error(`Connecteur HTTP ${response.status} : origine refusée ou mauvaise adresse. Vérifiez CONNECTOR_ORIGIN ou ouvrez son interface locale.`);
  const health = await response.json();
  if (typeof health.enabled !== 'boolean' || typeof health.busy !== 'boolean') throw new Error('Réponse de diagnostic du connecteur invalide.');
  if (!health.enabled) throw new Error('Connecteur Kraken désactivé. Lancez npm run connect, pas npm start.');
  if (health.busy) throw new Error('Le connecteur effectue déjà une synchronisation.');
  return health;
}
$('api-check').addEventListener('click', async () => {
  $('api-check').disabled = true;
  $('api-status').textContent = 'Vérification locale sans clé ni appel à Kraken…';
  try {
    const connector = connectorAddress();
    await checkConnector(connector);
    $('api-status').textContent = `Connecteur ${connector.origin} accessible et activé. Ce test ne valide ni la clé ni ses permissions Kraken.`;
  } catch (error) {
    $('api-status').textContent = `Diagnostic : ${error.message}`;
  } finally { $('api-check').disabled = false; }
});

function analysisOptions(options = sourceOptions) {
  return { ...options, includeHybrid: $('include-hybrid').checked, prices, basis };
}

function gainView(a) {
  if (!$('include-rewards').checked) return a;
  return { ...a, cost: a.economicCost, unknown: a.economicUnknown, averageCost: a.economicAverageCost,
    unrealized: a.economicUnrealized, unrealizedPercent: a.economicUnrealizedPercent,
    realized: a.economicRealized, realizedIncomplete: a.economicRealizedIncomplete,
    incomplete: a.economicIncomplete, coverage: a.economicCoverage, estimated: a.economicEstimated };
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}
function gain(node, value) {
  node.textContent = signed(value);
  node.classList.toggle('positive', value > 0);
  node.classList.toggle('negative', value < 0);
}
function inputValue(input) {
  if (!input.value.trim()) return null;
  const value = Number(input.value);
  if (!input.checkValidity() || !Number.isFinite(value) || value < 0) {
    input.reportValidity();
    throw new Error('Saisissez une valeur numérique positive ou nulle.');
  }
  return value;
}
function numberInput(value, label, onChange) {
  const input = element('input');
  input.type = 'number'; input.min = '0'; input.step = 'any';
  input.value = value ?? ''; input.setAttribute('aria-label', label);
  input.addEventListener('change', () => {
    try { const next = inputValue(input); showError(''); onChange(next); }
    catch (error) { showError(error.message); }
  });
  return input;
}
function renderHoldings() {
  const body = $('holdings-body');
  body.replaceChildren();
  const statistics = $('statistics-body');
  statistics.replaceChildren();
  const query = $('search').value.trim().toUpperCase();
  const assets = result.assets.filter(a => a.asset.includes(query) && ($('show-closed').checked || a.quantity > 1e-12));
  for (const asset of assets) {
    const a = gainView(asset);
    const row = element('tr');
    const assetCell = element('td'), coin = element('div', undefined, 'coin-cell');
    const assetButton = element('button', a.asset, 'coin-link');
    assetButton.type = 'button'; assetButton.setAttribute('aria-label', `Voir le graphique de ${a.asset}`);
    assetButton.addEventListener('click', () => portfolioChart.selectAsset(a.asset));
    coin.append(element('span', a.asset.slice(0, 2), 'coin-icon'), assetButton);
    assetCell.append(coin);
    if (a.quantity <= 1e-12) assetCell.append(element('span', 'Solde nul · historique conservé', 'cell-note'));
    const quantity = element('td', units.format(a.quantity));
    if (a.hybridQuantity > 1e-12) quantity.append(element('span',
      `${units.format(a.ledgerQuantity)} ledger/API + ${units.format(a.hybridQuantity)} Hybrid reconstitué`, 'cell-note'));
    const priceCell = element('td');
    const priceInput = numberInput(displayCurrency.convert(prices[a.asset]?.value ?? a.price), `Prix ${displayCurrency.currency} de ${a.asset}`, value => {
      if (value === null) delete prices[a.asset];
      else prices[a.asset] = { value: displayCurrency.toUSD(value), date: Date.now(), source: 'Manuel' };
      render();
    });
    priceInput.className = 'price-input';
    priceCell.append(priceInput, element('span', `${a.priceSource}${a.priceDate ? ` · ${date(a.priceDate)} UTC` : ''}`, 'cell-note'));
    const value = element('td', dollars(a.value));
    const cost = element('td', dollars(a.cost));
    if (a.unknown > 1e-12) cost.append(element('span', 'Part connue uniquement', 'cell-note'));
    const unrealized = element('td');
    gain(unrealized, a.unrealized);
    unrealized.append(element('span', [
      a.unrealizedPercent === null ? null : `${percent.format(a.unrealizedPercent)} %`,
      a.unknown > 1e-12 ? 'Partiel' : null, a.estimated ? 'Estimé' : null,
    ].filter(Boolean).join(' · '), 'cell-note'));
    const realized = element('td');
    gain(realized, a.realized);
    if (a.realizedIncomplete || a.estimated) realized.append(element('span', a.realizedIncomplete ? 'Partiel' : 'Estimé', 'cell-note'));
    const unknown = element('td', a.unknown > 1e-12 ? `${units.format(a.unknown)} ${a.asset}` : '—');
    row.append(assetCell, quantity, priceCell, value, cost, unrealized, realized, unknown);
    body.append(row);
    const details = element('tr');
    for (const text of [a.asset, dollars(a.averageCost), dollars(a.bought), dollars(a.sold),
      `${dollars(a.rewards)}${a.rewardsIncomplete ? ' · partiel' : ''}`, `${dollars(a.fees)}${a.feesIncomplete ? ' · partiel' : ''}`,
      units.format(a.gifted), units.format(a.giftRemaining), dollars(a.giftValue),
      `${dollars(a.giftRealized)}${a.giftRealizedIncomplete ? ' · partiel' : ''}`,
      a.estimated ? 'Estimé' : a.unknownAdded > 1e-12 ? 'Historique partiel' : 'Connu']) details.append(element('td', text));
    statistics.append(details);
  }
  if (!assets.length) {
    const row = element('tr'), cell = element('td', 'Aucun actif à afficher.');
    cell.colSpan = 8; row.append(cell); body.append(row);
    const detailRow = element('tr'), detailCell = element('td', 'Aucun actif à afficher.');
    detailCell.colSpan = 11; detailRow.append(detailCell); statistics.append(detailRow);
  }
}
function renderAllocation() {
  const held = result.assets.filter(a => a.quantity > 1e-12);
  $('asset-count').textContent = held.length;
  const priced = held.filter(a => a.value > 0);
  const slices = priced.slice(0, 5).map(a => ({ name: a.asset, value: a.value }));
  if (priced.length > 5) slices.push({ name: 'Autres', value: priced.slice(5).reduce((sum, a) => sum + a.value, 0) });
  $('allocation-legend').replaceChildren();
  let cursor = 0;
  const stops = slices.map((slice, i) => {
    const share = slice.value / result.totals.value * 100;
    const item = element('div', undefined, 'legend-item'), name = element('span', undefined, 'legend-name'), swatch = element('span', undefined, 'swatch');
    swatch.style.backgroundColor = COLORS[i];
    name.append(swatch, element('span', slice.name));
    item.append(name, element('span', `${percent.format(share)} %`, 'legend-value'));
    $('allocation-legend').append(item);
    const start = cursor; cursor += share;
    return `${COLORS[i]} ${start}% ${cursor}%`;
  });
  $('donut').style.background = stops.length ? `conic-gradient(${stops.join(',')})` : '#e6edef';
  if (!slices.length) $('allocation-legend').append(element('p', 'Aucune valeur positive disponible.', 'small'));
}
function renderBasis() {
  const root = $('basis-inputs'); root.replaceChildren();
  for (const a of result.assets.filter(a => a.unknownAdded > 1e-12)) {
    const label = element('label', undefined, 'basis-field');
    const input = numberInput(displayCurrency.convert(basis[a.asset] ?? null), `Coût de référence estimé ${displayCurrency.currency} par unité de ${a.asset}`, value => {
      if (value === null) delete basis[a.asset]; else basis[a.asset] = displayCurrency.toUSD(value);
      render();
    });
    input.placeholder = `Coût / unité en ${displayCurrency.currency}`;
    label.append(element('strong', a.asset), input, element('span', `${units.format(a.unknownAdded)} unités à référence historique inconnue${a.economicUnknownAdded <= 1e-12 ? ' · distributions gratuites, mode de référence uniquement' : ''}`, 'small'));
    root.append(label);
  }
  if (!root.children.length) root.append(element('p', 'Aucun coût manquant détecté.', 'small'));
}
function renderHistory() {
  const body = $('history-body'); body.replaceChildren();
  for (const r of result.rows.slice(-500).reverse()) {
    const row = element('tr');
    for (const text of [date(r.timestamp), `${r.type}${r.subtype ? ` / ${r.subtype}` : ''}`, r.asset, r.wallet, units.format(r.amount), units.format(r.fee), dollars(r.amountusd)]) row.append(element('td', text));
    body.append(row);
  }
}
function renderPnL() {
  if (!result) return;
  const original = result.assets.find(a => a.asset === $('chart-asset').value);
  if (!original) return;
  const a = gainView(original), root = $('pnl-detail');
  root.replaceChildren();
  $('pnl-title').textContent = `Décomposition du PnL · ${a.asset}`;
  for (const text of [
    `Prix utilisé : ${dollars(a.price)} par unité · ${a.priceSource}${a.priceDate ? ` · ${date(a.priceDate)} UTC` : ''}. Le graphique ne change pas ce prix : utilisez « Actualiser les cours » pour le mettre à jour.`,
    `Quantité : ${units.format(a.quantity)} ${a.asset}, dont ${units.format(a.hybridQuantity)} Hybrid reconstitué. Unités au coût connu : ${units.format(a.quantity - a.unknown)} ; au coût inconnu : ${units.format(a.unknown)}.`,
    `Non réalisé (${$('include-rewards').checked ? 'économique, gratuit inclus' : 'référence à réception'}) : ${dollars(a.price === null ? null : (a.quantity - a.unknown) * a.price)} de valeur connue − ${dollars(a.cost)} de coût restant = ${dollars(a.unrealized)}${a.unrealizedPercent === null ? '' : ` (${percent.format(a.unrealizedPercent)} %)`}.`,
    `Comparaison : ${dollars(a.economicUnrealized)} en mode économique ; ${dollars(original.unrealized)} de variation depuis la valeur à réception. Récompenses historiques reçues : ${dollars(a.rewards)}${a.rewardsIncomplete ? ' (partiel)' : ''} ; ce montant n’est pas à ajouter aux gains économiques.`,
    `Réalisé (${$('include-rewards').checked ? 'économique' : 'référence à réception'}) : ${dollars(a.realized)}${a.realizedIncomplete ? ' · partiel : coût ou produit de certaines ventes inconnu' : ''}. Les coûts sortent proportionnellement au coût moyen global de cet actif ; ce n’est pas la performance par lot ni celle calculée selon une méthode propre à l’exchange.`,
    ...(a.hybridQuantity > 1e-12 ? ['Le solde Hybrid est un capital net reconstitué, pas le solde confirmé du coffre. Rendement et pertes du coffre sont absents : ce PnL n’est pas le bénéfice total actuel de votre position DeFi.'] : []),
  ]) root.append(element('p', text, 'small'));
}
$('chart-asset').addEventListener('change', renderPnL);
function render() {
  result = analyze(parsed, analysisOptions());
  const t = gainView(result.totals), includeRewards = $('include-rewards').checked;
  const heldCount = result.assets.filter(a => a.quantity > 1e-12).length;
  $('asset-scope').textContent = `${result.assets.length} actifs dans l’historique · ${heldCount} détenus · ${result.assets.length - heldCount} à solde nul · ${displayCurrency.currency} · Spot + Earn`;
  for (const heading of document.querySelectorAll('[data-currency-label]')) {
    heading.textContent = `${heading.dataset.currencyLabel} / ${displayCurrency.currency}`;
  }
  $('dashboard').hidden = false; $('empty-state').hidden = true;
  $('file-meta').textContent = `${filename} · ${result.rows.length.toLocaleString('fr-FR')} lignes · ${date(result.start)} → ${date(result.end)} UTC`;
  $('total-value').textContent = dollars(t.value);
  if (t.unpricedAssets.length || t.hybridReconstructed) $('total-value').append(element('span', t.unpricedAssets.length ? ' · partiel' : ' · reconstitué', 'small'));
  $('cash').textContent = `+ ${dollars(t.cash)} en fiat (prix de valorisation disponibles)`;
  gain($('total-unrealized'), t.unrealized);
  $('unrealized-note').textContent = `${t.incomplete ? 'Partiel · coûts ou prix manquants' : 'Valeur moins coût des actifs restants'}${includeRewards ? ' · Distributions gratuites incluses' : ' · Variation depuis la réception des récompenses'}${t.estimated ? ' · Estimé' : ''}${t.hybridReconstructed ? ' · Capital Hybrid reconstitué, rendement non inclus' : ''}`;
  gain($('total-realized'), t.realized);
  $('realized-note').textContent = `${t.realizedIncomplete ? 'Partiel · coût ou produit de certaines ventes inconnu' : 'Produits des ventes moins coût sorti'}${includeRewards ? ' · Distributions gratuites incluses' : ''}${t.estimated ? ' · Estimé' : ''}`;
  $('gifts-held').textContent = `${dollars(t.giftValue)}${t.giftValueIncomplete ? ' · partiel' : ''}`;
  $('gifts-sold').textContent = `${dollars(t.giftRealized)}${t.giftRealizedIncomplete ? ' · partiel' : ''}`;
  $('total-rewards').textContent = dollars(t.rewards);
  if (t.rewardsIncomplete) $('total-rewards').append(element('span', ' · partiel', 'small'));
  $('remaining-cost').textContent = dollars(t.cost); $('fees').textContent = `${dollars(t.fees)}${t.feesIncomplete ? ' · partiel' : ''}`;
  $('bought').textContent = dollars(t.bought); $('sold').textContent = dollars(t.sold);
  $('coverage-label').textContent = `${percent.format(t.coverage)} % de la valeur disponible au coût ${t.estimated ? 'connu ou estimé' : 'connu'}${t.unpricedAssets.length ? ` · ${t.unpricedAssets.length} actif(s) sans prix exclus` : ''}`;
  $('coverage-bar').style.width = `${Math.max(0, Math.min(100, t.coverage))}%`;
  $('quality-badge').textContent = t.hybridReconstructed ? 'Hybrid à confirmer' : t.incomplete || t.realizedIncomplete || t.rewardsIncomplete || t.feesIncomplete ? 'À compléter' : t.estimated ? 'Estimations' : 'Coûts renseignés';
  const sources = new Set(result.assets.filter(a => a.quantity > 1e-12).map(a => a.priceSource));
  const quantityNote = sourceOptions.snapshotDate ? `Les quantités sont celles du solde API synchronisé (${date(sourceOptions.snapshotDate)} UTC).` : `La quantité reste celle de la fin du fichier (${date(result.end)} UTC).`;
  $('price-note').textContent = `${sources.has('Export') ? 'Prix historiques : au moins un actif utilise encore le dernier prix de son historique, pas un cours actuel. ' : 'Valorisation aux prix actualisés ou saisis. '}${quantityNote} ${priceMessage} Calculs internes en USD ; affichage en ${displayCurrency.currency}.`;
  $('warnings-title').textContent = `Points à vérifier (${result.warnings.length})`;
  $('warnings-list').replaceChildren(...result.warnings.map(text => element('li', text)));
  renderHoldings(); renderAllocation(); renderBasis(); renderHistory();
  portfolioChart.setData(result);
  renderPriceSource();
  renderPnL();
}
function renderPriceSource() {
  $('price-gecko-settings').hidden = $('price-provider').value !== 'coingecko';
  const root = $('price-gecko-ids');
  root.replaceChildren();
  for (const a of result.assets.filter(a => a.quantity > 1e-12).sort((a, b) => a.asset.localeCompare(b.asset))) {
    const label = element('label', `${a.asset} · Identifiant CoinGecko`, 'basis-field');
    const input = element('input');
    input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
    input.value = portfolioChart.geckoIDs.get(a.asset) ?? COINGECKO_IDS[a.asset] ?? '';
    input.placeholder = 'Identifiant exact requis';
    input.addEventListener('change', () => {
      portfolioChart.geckoIDs.set(a.asset, input.value.trim());
      portfolioChart.providerControls(true);
    });
    label.append(input); root.append(label);
  }
}
$('price-provider').addEventListener('change', () => {
  if (result) renderPriceSource();
});
$('gecko-id').addEventListener('change', () => { if (result) renderPriceSource(); });
function fxDescription() {
  return displayCurrency.currency === 'EUR' ?
    `1 USD = ${units.format(displayCurrency.eurPerUSD)} EUR · Kraken EUR/USD, dernier échange · ${date(displayCurrency.date)} UTC. Conversion de présentation au même taux pour tous les montants, pas des gains historiques calculés en EUR.` :
    'Affichage USD, devise de calcul du ledger. Choisir EUR charge uniquement le taux public Kraken EUR/USD.';
}
async function updateDisplayCurrency(force = false) {
  const selected = $('display-currency').value;
  $('display-currency').disabled = true; $('refresh-fx').disabled = true;
  try {
    if (force || (selected === 'EUR' && displayCurrency.eurPerUSD === null)) {
      $('fx-status').textContent = 'Chargement du taux public Kraken EUR/USD… L’affichage précédent reste actif.';
      const quote = await fetchEURRate();
      displayCurrency.set(selected, quote);
    } else displayCurrency.set(selected);
    $('fx-status').textContent = fxDescription();
    if (parsed) { render(); portfolioChart.draw(); }
  } catch (error) {
    $('display-currency').value = displayCurrency.currency;
    $('fx-status').textContent = `Conversion indisponible : ${error.message} Affichage ${displayCurrency.currency} conservé. ${fxDescription()}`;
  } finally {
    $('display-currency').disabled = false; $('refresh-fx').disabled = false;
  }
}
$('display-currency').addEventListener('change', () => updateDisplayCurrency());
$('refresh-fx').addEventListener('click', () => updateDisplayCurrency(true));
function load(text, name, options = {}) {
  const next = parseCSV(text);
  // Commit only after a complete analysis, preserving the previous import on invalid files.
  analyze(next, { ...options, includeHybrid: $('include-hybrid').checked });
  apiAbort?.abort();
  requestId++; parsed = next; filename = name; prices = {}; basis = {}; priceMessage = '';
  sourceOptions = options;
  $('refresh').disabled = false;
  $('search').value = ''; $('show-closed').checked = true;
  showError(''); render();
  $('status').textContent = `${next.rows.length.toLocaleString('fr-FR')} opérations chargées.`;
}
async function importFile(file) {
  if (!file) return;
  apiAbort?.abort();
  const id = ++requestId;
  $('refresh').disabled = false;
  if (file.size > 30 * 1024 * 1024) { showError('Le fichier dépasse la limite de 30 Mo.'); return; }
  $('status').textContent = 'Lecture et analyse du fichier…';
  try {
    const text = await file.text();
    if (id !== requestId) return;
    load(text, file.name);
  } catch (error) {
    if (id !== requestId) return;
    showError(error.message); $('status').textContent = 'Import refusé. Les données précédentes sont conservées.';
  }
}
$('file-input').addEventListener('change', event => {
  importFile(event.target.files[0]); event.target.value = '';
});
const dropzone = $('import-panel');
for (const event of ['dragenter', 'dragover']) dropzone.addEventListener(event, e => { e.preventDefault(); dropzone.classList.add('dragging'); });
for (const event of ['dragleave', 'drop']) dropzone.addEventListener(event, e => { e.preventDefault(); dropzone.classList.remove('dragging'); });
dropzone.addEventListener('drop', e => {
  if (e.dataTransfer.files.length !== 1) { showError('Importez un seul export complet à la fois.'); return; }
  importFile(e.dataTransfer.files[0]);
});
$('search').addEventListener('input', renderHoldings);
$('show-closed').addEventListener('change', renderHoldings);
$('include-rewards').addEventListener('change', () => { if (parsed) render(); });
$('include-hybrid').addEventListener('change', () => {
  if (!parsed) return;
  try { render(); showError(''); }
  catch (error) { $('include-hybrid').checked = !$('include-hybrid').checked; render(); showError(error.message); }
});
$('refresh').addEventListener('click', async () => {
  if (!result) return;
  const id = ++requestId;
  const provider = $('price-provider').value;
  const source = provider === 'coingecko' ? 'CoinGecko' : 'Kraken';
  $('refresh').disabled = true; showError('');
  $('status').textContent = `Connexion à l’API publique ${source} (identifiants publics uniquement)…`;
  try {
    const assets = result.assets.filter(a => a.quantity > 1e-12).map(a => a.asset);
    const update = provider === 'coingecko'
      ? await fetchGeckoQuotes(assets, { ids: Object.fromEntries(portfolioChart.geckoIDs), catalog: portfolioChart.geckoCatalog })
      : await fetchKrakenPrices(assets);
    if (id !== requestId) return;
    if (provider !== $('price-provider').value) {
      $('status').textContent = 'Source des prix modifiée : réponse précédente ignorée. Cliquez sur « Actualiser les cours » pour charger la nouvelle source.';
      return;
    }
    prices = { ...prices, ...update.prices };
    priceMessage = update.missing.length ? `${source} · Cours indisponibles ou identifiants non renseignés : ${update.missing.join(', ')} ; anciens prix conservés, à vérifier ou saisir manuellement.` : `Tous les actifs détenus ont un cours ${source} actualisé.`;
    render();
    $('status').textContent = `${Object.keys(update.prices).length} cours actualisés. ${priceMessage}`;
  } catch (error) {
    if (id !== requestId) return;
    showError(`${error.message} Les anciens prix sont conservés. Vérifiez votre connexion ou saisissez les prix manuellement.`);
    $('status').textContent = 'Échec de l’actualisation.';
  } finally { if (id === requestId) $('refresh').disabled = false; }
});
$('reset').addEventListener('click', () => {
  apiAbort?.abort();
  requestId++; parsed = null; result = null; filename = ''; prices = {}; basis = {}; priceMessage = ''; sourceOptions = {};
  $('dashboard').hidden = true; $('empty-state').hidden = false;
  portfolioChart.clear();
  for (const id of ['holdings-body', 'statistics-body', 'history-body', 'basis-inputs', 'warnings-list', 'allocation-legend', 'pnl-detail']) $(id).replaceChildren();
  $('file-meta').textContent = ''; $('refresh').disabled = false;
  showError(''); $('status').textContent = 'Données effacées de cette page.';
});
$('export').addEventListener('click', () => {
  if (!result) return;
  const header = ['actif', 'quantite', 'prix_usd', 'source_prix', 'date_prix_utc', 'valeur_usd', 'cout_restant_connu_usd', 'gain_non_realise_part_connue_usd', 'gain_realise_part_connue_usd', 'quantite_cout_inconnu', 'recompenses_usd', 'gain_partiel', 'gain_estime', 'cout_moyen_part_connue_usd', 'achats_usd', 'ventes_usd', 'frais_usd', 'recompenses_partielles', 'frais_partiels', 'mode_gain', 'unites_gratuites_recues', 'unites_gratuites_restantes', 'valeur_gratuite_restante_usd', 'produit_ventes_unites_gratuites_usd', 'cout_reference_restant_usd', 'gain_reference_non_realise_usd', 'gain_reference_realise_usd', 'gain_economique_non_realise_usd', 'gain_economique_realise_usd', 'cout_economique_inconnu', 'gain_economique_partiel', 'ventes_gratuites_partielles'];
  header.push('devise_affichage', 'taux_usd_vers_devise', 'date_taux_utc', 'source_taux',
    'valeur_affichee', 'cout_restant_affiche', 'gain_non_realise_affiche', 'gain_realise_affiche',
    'prix_affiche', 'recompenses_reception_affichees', 'frais_affiches', 'offert_detenu_affiche', 'ventes_offert_affichees');
  header.push('quantite_ledger_ou_api', 'capital_hybrid_reconstitue', 'hybrid_inclus', 'solde_hybrid_non_confirme');
  const csv = [header, ...result.assets.map(original => {
    const a = gainView(original);
    return [a.asset, a.quantity, a.price ?? '', a.priceSource, a.priceDate ? new Date(a.priceDate).toISOString() : '', a.value ?? '', a.cost, a.unrealized ?? '', a.realized, a.unknown, a.rewards, a.unknown > 1e-12 || a.realizedIncomplete || a.price === null, a.estimated, a.averageCost ?? '', a.bought, a.sold, a.fees, a.rewardsIncomplete, a.feesIncomplete, $('include-rewards').checked ? 'economique' : 'reference_reception', a.gifted, a.giftRemaining, a.giftValue ?? '', a.giftRealized, original.cost, original.unrealized ?? '', original.realized, a.economicUnrealized ?? '', a.economicRealized, a.economicUnknown, a.economicUnknown > 1e-12 || a.economicRealizedIncomplete || a.price === null, a.giftRealizedIncomplete,
      displayCurrency.currency, displayCurrency.convert(1), displayCurrency.currency === 'EUR' ? new Date(displayCurrency.date).toISOString() : '',
      displayCurrency.currency === 'EUR' ? 'Kraken EUR/USD · dernier échange' : 'USD · devise du ledger',
      ...[a.value, a.cost, a.unrealized, a.realized, a.price, a.rewards, a.fees, a.giftValue, a.giftRealized].map(value => displayCurrency.convert(value) ?? ''),
      a.ledgerQuantity, a.hybridQuantity, $('include-hybrid').checked, a.hybridQuantity > 1e-12];
  })]
    .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = element('a'); link.href = url; link.download = `kraken-statistiques-${displayCurrency.currency.toLowerCase()}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') $('connector-url').value = location.origin;
async function restoreRememberedKey() {
  const revision = memoryRevision;
  try {
    const credentials = await restoreCredentials();
    if (revision !== memoryRevision) return;
    if (!credentials) {
      $('restore-key').hidden = true;
      $('remember-status').textContent = 'Aucune clé mémorisée sur cette origine.';
      return;
    }
    if (!$('api-key').value && !$('api-secret').value) {
      $('api-key').value = credentials.key;
      $('api-secret').value = credentials.secret;
    }
    $('remember-key').checked = true;
    $('restore-key').hidden = false;
    $('remember-status').textContent = 'Clé mémorisée chargée. Le code 2FA doit être saisi à chaque import si nécessaire.';
  } catch (error) { showError(error.message); }
}
async function forgetRememberedKey() {
  memoryRevision++;
  apiAbort?.abort();
  try {
    await forgetCredentials();
    $('remember-key').checked = false;
    $('restore-key').hidden = true;
    for (const id of ['api-key', 'api-secret', 'api-otp']) $(id).value = '';
    $('remember-status').textContent = 'Clé mémorisée supprimée de ce navigateur. Révoquez-la sur Kraken si vous souhaitez désactiver son accès.';
  } catch (error) { showError(error.message); }
}
$('restore-key').addEventListener('click', restoreRememberedKey);
$('forget-key').addEventListener('click', forgetRememberedKey);
$('remember-key').addEventListener('change', () => {
  memoryRevision++;
  if (!$('remember-key').checked) forgetRememberedKey();
  else $('remember-status').textContent = 'La clé sera mémorisée après un import API réussi.';
});
restoreRememberedKey();
$('api-cancel').addEventListener('click', () => apiAbort?.abort());
$('api-form').addEventListener('submit', async event => {
  event.preventDefault();
  let connector;
  try {
    connector = connectorAddress();
  } catch (error) { showError(error.message); return; }
  apiAbort?.abort();
  const controller = new AbortController();
  apiAbort = controller;
  const id = ++requestId;
  const memoryAtStart = ++memoryRevision;
  $('refresh').disabled = true;
  $('api-connect').disabled = true; $('api-cancel').hidden = false; showError('');
  $('api-check').disabled = true;
  $('api-status').textContent = 'Vérification du connecteur local…';
  let credentials = null, authToRemember = null;
  try {
    await checkConnector(connector, controller.signal);
    credentials = { key: $('api-key').value.trim(), secret: $('api-secret').value.trim(), otp: $('api-otp').value.trim() };
    if ($('remember-key').checked) authToRemember = { key: credentials.key, secret: credentials.secret };
    for (const field of ['api-key', 'api-secret', 'api-otp']) $(field).value = '';
    $('api-status').textContent = 'Lecture des ledgers Kraken… Cela peut prendre plusieurs minutes. Les anciennes données sont conservées jusqu’à la fin.';
    const response = await fetch(`${connector.origin}/api/import`, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20 * 60 * 1000)]),
    });
    credentials = null;
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Connecteur : HTTP ${response.status}.`);
    if (id !== requestId) return;
    if (typeof data.csv !== 'string' || !data.snapshot || !Array.isArray(data.notes) || !Number.isFinite(data.importedAt)) throw new Error('Réponse du connecteur invalide.');
    analyze(parseCSV(data.csv), { snapshot: data.snapshot, notes: data.notes, includeHybrid: $('include-hybrid').checked });
    if (authToRemember && $('remember-key').checked && memoryAtStart === memoryRevision) {
      await rememberCredentials(authToRemember);
      if (memoryAtStart === memoryRevision) {
        $('restore-key').hidden = false;
        $('remember-status').textContent = 'Clé et secret mémorisés chiffrés sur cet appareil. Code 2FA non conservé.';
      }
    }
    if (id !== requestId || controller.signal.aborted) return;
    apiAbort = null;
    load(data.csv, `Kraken API · synchronisation ${date(data.importedAt)} UTC`, { snapshot: data.snapshot, snapshotDate: data.importedAt, notes: data.notes });
    $('api-status').textContent = `Import terminé. Consultez les coûts inconnus, puis actualisez les cours. ${$('remember-key').checked ? 'Mémorisation locale facultative activée.' : 'Aucun identifiant conservé.'}`;
  } catch (error) {
    if (controller.signal.aborted) $('api-status').textContent = 'Synchronisation annulée. Aucune donnée partielle importée.';
    else if (id === requestId) {
      showError(error instanceof TypeError ? 'Connexion interrompue avec le connecteur local. Vérifiez son état et l’accès au réseau local ; les données précédentes sont conservées.' : error.message);
      $('api-status').textContent = 'Échec de l’import API. Les données précédentes sont conservées.';
    }
  } finally {
    credentials = null;
    authToRemember = null;
    for (const field of ['api-key', 'api-secret', 'api-otp']) $(field).value = '';
    if (apiAbort === controller) apiAbort = null;
    $('api-connect').disabled = false; $('api-cancel').hidden = true;
    $('api-check').disabled = false;
    $('refresh').disabled = false;
  }
});
$('demo').addEventListener('click', () => {
  const headers = 'txid,refid,time,type,subtype,aclass,subclass,asset,wallet,amount,fee,balance,amountusd,feeusd,balanceusd,feecurrency';
  const data = [
    'd1,b1,2025-01-01 12:00:00,spend,,currency,fiat,USD,spot / main,-1000,5,995,-1000,5,995,USD',
    'd2,b1,2025-01-01 12:00:00,receive,,currency,crypto,BTC,spot / main,0.02,0,0.02,1000,0,1000,',
    'd3,b2,2025-02-01 12:00:00,spend,,currency,fiat,USD,spot / main,-900,5,90,-900,5,90,USD',
    'd4,b2,2025-02-01 12:00:00,receive,,currency,crypto,ETH,spot / main,0.3,0,0.3,900,0,900,',
    'd5,e1,2025-03-01 12:00:00,earn,reward,currency,crypto,ETH,spot / main,0.01,0.002,0.308,30,6,924,ETH',
    'd6,s1,2025-04-01 12:00:00,spend,,currency,crypto,BTC,spot / main,-0.005,0,0.015,-300,0,900,',
    'd7,s1,2025-04-01 12:00:00,receive,,currency,fiat,USD,spot / main,300,2,388,300,2,388,USD',
    'd8,p1,2025-05-01 12:00:00,deposit,,currency,crypto,SOL,spot / main,2,0,2,300,0,300,',
    'd9,e2,2025-06-01 12:00:00,earn,reward,currency,crypto,ETH,spot / main,0.001,0,0.309,3.5,0,1081.5,',
  ];
  try { load([headers, ...data].join('\n'), 'Exemple fictif · aucun compte réel'); }
  catch (error) { showError(error.message); }
});
