import { PERIODS, periodRange, ledgerObservations, tradeMarkers, chartWindow, fetchCandles } from './market.js';
import { displayCurrency } from './currency.js';
import { COINGECKO_IDS, fetchGeckoPrices, geckoWindow, geckoDays } from './coingecko.js';

const SVG = 'http://www.w3.org/2000/svg';
const quantity = new Intl.NumberFormat('fr-FR', { maximumSignificantDigits: 9 });
const date = time => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(time);
const money = value => value === null ? 'Inconnu' : displayCurrency.money(value, true);
const $ = id => document.getElementById(id);
function svg(tag, attrs = {}, text) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text;
  return el;
}
function html(tag, text) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}
const intervalName = interval => ({ 60: '1 heure', 240: '4 heures', 1440: '1 jour', 10080: '1 semaine', 21600: '15 jours' }[interval]);

export class PortfolioChart {
  constructor() {
    this.rows = null;
    this.period = 'ALL';
    this.marketEnabled = false;
    this.catalog = null;
    this.geckoCatalog = null;
    this.geckoIDs = new Map();
    this.market = null;
    this.cache = new Map();
    this.abort = null;
    this.generation = 0;
    this.hoverIndex = 0;
    $('chart-asset').addEventListener('change', () => { this.providerControls(true); this.refresh(); });
    $('chart-provider').addEventListener('change', () => { this.providerControls(); this.refresh(); });
    $('gecko-id').addEventListener('change', () => {
      this.geckoIDs.set($('chart-asset').value, $('gecko-id').value.trim());
      this.refresh();
    });
    $('chart-anchor').addEventListener('change', () => this.refresh());
    for (const period of PERIODS) {
      const button = html('button', period);
      button.type = 'button'; button.className = 'period-button'; button.dataset.period = period;
      button.setAttribute('aria-pressed', String(period === this.period));
      button.addEventListener('click', () => { this.period = period; this.refresh(); });
      $('chart-periods').append(button);
    }
    $('chart-load').addEventListener('click', () => { this.marketEnabled = true; this.refresh(true); });
    $('chart-offline').addEventListener('click', () => { this.marketEnabled = false; this.refresh(); });
    $('price-chart').addEventListener('pointermove', e => this.inspect(e));
    $('price-chart').addEventListener('pointerleave', () => { $('chart-tooltip').hidden = true; this.crosshair?.setAttribute('visibility', 'hidden'); });
    $('price-chart').addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || !this.plot?.points.length) return;
      e.preventDefault();
      const last = this.plot.points.length - 1;
      this.hoverIndex = e.key === 'Home' ? 0 : e.key === 'End' ? last : Math.max(0, Math.min(last, this.hoverIndex + (e.key === 'ArrowRight' ? 1 : -1)));
      this.showPoint(this.hoverIndex);
    });
    this.resize = new ResizeObserver(() => { if (this.rows) this.draw(); });
    this.resize.observe($('chart-canvas'));
  }

  setData(result) {
    const sameRows = this.rows === result.rows;
    const selected = sameRows ? $('chart-asset').value : null;
    if (!sameRows) this.clear();
    this.rows = result.rows;
    this.result = result;
    const select = $('chart-asset');
    select.replaceChildren();
    for (const held of [true, false]) {
      const group = html('optgroup'); group.label = held ? 'Actifs détenus' : 'Soldes nuls · historique conservé';
      for (const a of result.assets.filter(a => (a.quantity > 1e-12) === held).sort((a, b) => a.asset.localeCompare(b.asset))) {
        const option = html('option', a.asset); option.value = a.asset; group.append(option);
      }
      if (group.children.length) select.append(group);
    }
    select.value = selected || result.assets[0]?.asset || '';
    if (sameRows) return;
    $('chart-anchor').value = 'history';
    this.refresh();
  }

  providerControls(assetChanged = false) {
    const gecko = $('chart-provider').value === 'coingecko';
    $('gecko-field').hidden = !gecko;
    $('chart-load').textContent = gecko ? 'Charger la courbe CoinGecko' : 'Charger les bougies Kraken';
    if (assetChanged || !$('gecko-id').value) {
      $('gecko-id').value = this.geckoIDs.get($('chart-asset').value) ?? COINGECKO_IDS[$('chart-asset').value] ?? '';
    }
  }

  selectAsset(asset) {
    if (!this.result?.assets.some(a => a.asset === asset)) return;
    $('chart-asset').value = asset;
    $('chart-asset').dispatchEvent(new Event('change'));
    $('chart-title').scrollIntoView({ block: 'start' });
  }

  clear() {
    this.abort?.abort(); this.generation++;
    this.rows = null; this.result = null; this.market = null; this.marketEnabled = false;
    this.plot = null; this.cache.clear();
    this.observations = []; this.trades = []; this.currentRange = null; this.hoverIndex = 0;
    this.geckoIDs.clear(); $('gecko-id').value = '';
    $('chart-asset').replaceChildren();
    $('price-chart').replaceChildren(); $('chart-trades-body').replaceChildren();
    $('chart-tooltip').hidden = true;
    $('chart-error').hidden = true;
    $('chart-load').disabled = false;
    $('gecko-credit').hidden = true;
  }

  range() {
    const end = $('chart-anchor').value === 'today' ? Date.now() : this.result.end;
    return periodRange(this.period, end, this.result.start);
  }

  async refresh(force = false) {
    if (!this.rows) return;
    this.abort?.abort();
    const generation = ++this.generation;
    this.market = null; this.plot = null;
    $('chart-tooltip').hidden = true; $('chart-error').hidden = true;
    for (const b of $('chart-periods').children) b.setAttribute('aria-pressed', String(b.dataset.period === this.period));
    const asset = $('chart-asset').value;
    this.providerControls();
    const gecko = $('chart-provider').value === 'coingecko';
    this.observations = ledgerObservations(this.rows, asset);
    this.trades = tradeMarkers(this.rows, asset);
    this.currentRange = this.range();
    this.hoverIndex = 0;
    if (!this.marketEnabled) {
      $('chart-load').disabled = false;
      $('chart-status').textContent = 'Mode local : observations du fichier, sans requête réseau. Choisissez une source puis cliquez sur son bouton de chargement pour le marché réel.';
      this.draw(); return;
    }
    $('chart-load').disabled = true;
    $('chart-status').textContent = `Chargement ${gecko ? 'CoinGecko' : 'Kraken'} ${asset}/USD… Aucune transaction, quantité ou clé Kraken n’est transmise.`;
    $('price-chart').replaceChildren();
    $('chart-trades-body').replaceChildren();
    const controller = new AbortController();
    this.abort = controller;
    const id = $('gecko-id').value.trim();
    const now = Date.now();
    try {
      const key = gecko ? `coingecko|${id}|${asset}|${geckoDays(this.currentRange, now)}` :
        `kraken|${asset}|${this.currentRange.interval}|${Math.floor(this.currentRange.start / 1000)}`;
      const cached = this.cache.get(key);
      const data = !force && cached && Date.now() - cached.fetchedAt < 60000 ? cached :
        gecko ? await fetchGeckoPrices(asset, this.currentRange, { id, catalog: this.geckoCatalog, signal: controller.signal, now }) :
          await fetchCandles(asset, this.currentRange, { pairs: force ? null : this.catalog, signal: controller.signal });
      if (generation !== this.generation || controller.signal.aborted) return;
      if (gecko) this.geckoCatalog = data.catalog;
      else this.catalog = data.pairs;
      this.cache.set(key, data); this.market = data;
      $('chart-status').textContent = gecko ?
        `CoinGecko · ${data.name} (${data.id}) · Prix agrégés USD, pas prix d’exécution Kraken · Chargés le ${date(data.fetchedAt)} UTC.` :
        `${data.pair} · Bougies de ${intervalName(this.currentRange.interval)} · Chargées le ${date(data.fetchedAt)} UTC. La dernière bougie Kraken est en cours.`;
      this.draw();
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      $('chart-error').textContent = `${error.message} Réessayez ou revenez aux observations du fichier.`;
      $('chart-error').hidden = false;
      $('chart-status').textContent = 'Aucune série de marché chargée. Les statistiques du portefeuille sont inchangées.';
      this.draw();
    } finally { if (generation === this.generation) $('chart-load').disabled = false; }
  }

  draw() {
    if (!this.rows || !this.currentRange) return;
    $('chart-tooltip').hidden = true;
    const root = $('price-chart'), range = this.currentRange;
    root.replaceChildren(); this.crosshair = null; this.plot = null;
    const asset = $('chart-asset').value;
    const marketMode = this.marketEnabled;
    const gecko = marketMode && $('chart-provider').value === 'coingecko';
    const candleMode = marketMode && !gecko;
    const data = this.market ? gecko ? geckoWindow(this.market.points, this.trades, range, this.market.maxGap) :
      chartWindow(this.market.candles, this.trades, range) : null;
    const observations = this.observations.filter(p => p.time >= range.start && p.time <= range.end);
    const points = marketMode ? (gecko ? data?.points || [] : data?.candles || []) : observations;
    const trades = this.trades.filter(t => t.time >= range.start && t.time <= range.end);
    $('gecko-credit').hidden = !gecko;
    $('chart-legend-up').textContent = candleMode ? 'Bougie haussière / achat ▲' : 'Achat ▲';
    $('chart-legend-down').textContent = candleMode ? 'Bougie baissière / vente ▼' : 'Vente ▼';
    $('chart-chart-note').textContent = `${trades.filter(t => t.side === 'buy').length} achat(s) · ${trades.filter(t => t.side === 'sell').length} vente(s) dans cette période. ${candleMode ? 'Les flèches sont sous/sur les bougies des transactions. Plusieurs opérations de même sens dans une bougie sont regroupées.' : gecko ? 'Les flèches sont placées à la date exacte, sur le cours de marché interpolé entre deux points disponibles proches, pas au prix d’exécution. Les trous ne sont pas interpolés.' : 'Les opérations sans prix restent dans le tableau, sans position verticale inventée.'} Transferts, dépôts et récompenses ne sont pas des achats/ventes.`;
    $('chart-source').textContent = `${marketMode ? gecko ? 'MARCHÉ COINGECKO' : 'MARCHÉ KRAKEN' : 'OBSERVATIONS DU FICHIER'} · ${displayCurrency.currency}${displayCurrency.currency === 'EUR' ? ' (conversion du cours USD)' : ''}`;
    $('chart-summary').textContent = points.length ? `${money(points.at(-1).close ?? points.at(-1).price)} · ${points.filter(p => !p.interpolated).length} ${candleMode ? 'bougies' : gecko ? 'points de marché' : 'observations'}` : 'Aucune donnée sur cette période';
    $('chart-coverage').textContent = gecko ?
      `API publique CoinGecko : 365 jours d’historique maximum ; ALL peut être tronqué. ${data?.truncated ? 'Période partiellement couverte. ' : ''}${data?.excluded.length ?? trades.length} opération(s) sans cours correspondant. Aucun historique ancien ni trou n’est fabriqué ; toutes les opérations restent dans le tableau. Les limites d’accès et de requêtes peuvent bloquer le chargement.` : marketMode ?
      `Kraken fournit au maximum 720 bougies récentes, sans récupération des plus anciennes. ${data?.truncated ? 'Début de période non couvert. ' : ''}${data?.excluded.length || (points.length ? 0 : trades.length)} opération(s) de la période sans bougie correspondante ; leurs dates restent dans le tableau ci-dessous. ALL couvre la période de l’historique importé, dans cette limite. Les bougies de bord sont complètes et peuvent inclure des échanges hors de la plage exacte choisie.` :
      'Cette courbe relie uniquement les prix implicites observés dans le fichier ; ce ne sont pas des bougies de marché ni un historique continu. Les repères utilisent leur prix USD implicite quand il est connu.';
    this.renderTrades(trades, data, marketMode);
    const width = Math.max(300, $('chart-canvas').clientWidth), height = 370;
    root.setAttribute('viewBox', `0 0 ${width} ${height}`);
    root.setAttribute('aria-label', `${asset} en ${displayCurrency.currency}, ${candleMode ? 'bougies Kraken' : gecko ? 'courbe CoinGecko' : 'observations du fichier'}, période ${this.period}. Utilisez les flèches gauche et droite pour lire les valeurs.`);
    if (!points.length) {
      root.append(svg('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', fill: '#8798a3', 'font-size': 13 }, 'Aucune donnée disponible pour cette période'));
      return;
    }
    const left = 12, right = width - 88, top = 36, bottom = 300;
    const duration = range.interval * 60000;
    const minTime = Math.min(range.start, points[0].time), maxTime = Math.max(range.end, minTime + duration);
    const axisValues = candleMode ? points.flatMap(c => [c.low, c.high]) : points.map(p => p.price);
    if (!marketMode) axisValues.push(...trades.filter(t => t.price !== null).map(t => t.price));
    const low = Math.min(...axisValues), high = Math.max(...axisValues);
    const padding = Math.max((high - low) * .16, high * .02, 1e-9);
    const minPrice = Math.max(0, low - padding), maxPrice = high + padding;
    const x = time => left + (time - minTime) / (maxTime - minTime) * (right - left);
    const y = price => bottom - (price - minPrice) / (maxPrice - minPrice) * (bottom - top);
    for (let i = 0; i <= 4; i++) {
      const price = minPrice + (maxPrice - minPrice) * i / 4, yy = y(price);
      root.append(svg('line', { x1: left, x2: right, y1: yy, y2: yy, stroke: '#263b46', 'stroke-dasharray': '3 5' }),
        svg('text', { x: right + 8, y: yy + 4, fill: '#a2b4bd', 'font-size': 10 }, money(price)));
    }
    const ticks = width < 500 ? 3 : 5;
    for (let i = 0; i < ticks; i++) {
      const time = minTime + (maxTime - minTime) * i / (ticks - 1);
      root.append(svg('text', { x: x(time), y: 342, 'text-anchor': i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle', fill: '#a2b4bd', 'font-size': 10 }, new Date(time).toLocaleDateString('fr-FR', { timeZone: 'UTC' })));
    }
    if (candleMode) {
      const barWidth = Math.max(1, Math.min(12, (right - left) * duration / (maxTime - minTime) * .68));
      for (const c of points) {
        const xx = x(Math.min(range.end, Math.max(range.start, c.time + duration / 2)));
        const color = c.close >= c.open ? '#3ccea8' : '#f17883';
        const group = svg('g', { class: 'candle', 'data-time': c.time, opacity: c.provisional ? '.65' : '1' });
        group.append(svg('title', {}, `${date(c.time)} UTC · O ${money(c.open)} · H ${money(c.high)} · B ${money(c.low)} · C ${money(c.close)}${c.provisional ? ' · En cours' : ''}`),
          svg('line', { x1: xx, x2: xx, y1: y(c.high), y2: y(c.low), stroke: color }),
          svg('rect', { x: xx - barWidth / 2, y: Math.min(y(c.open), y(c.close)), width: barWidth, height: Math.max(1, Math.abs(y(c.open) - y(c.close))), fill: color }));
        root.append(group);
      }
    } else {
      const segments = gecko ? data.segments : [points];
      for (const segment of segments) root.append(svg('path', { d: segment.map((p, i) => `${i ? 'L' : 'M'}${x(p.time)},${y(p.price)}`).join(' '), stroke: '#7bb9e8', 'stroke-width': 2, fill: 'none', class: gecko ? 'gecko-line' : 'ledger-line' }));
      if (points.length < 100) for (const p of points) root.append(svg('circle', { cx: x(p.time), cy: y(p.price), r: 2, fill: '#7bb9e8' }));
    }
    const placed = candleMode ? (data?.markers || []).map(m => {
      const c = points[m.index];
      return { ...m, time: Math.min(range.end, Math.max(range.start, c.time + duration / 2)), price: m.side === 'buy' ? c.low : c.high };
    }) : gecko ? data?.markers || [] : trades.filter(t => t.price !== null).map(t => ({ side: t.side, time: t.time, price: t.price, trades: [t] }));
    for (const marker of placed) {
      const xx = x(marker.time), yy = y(marker.price) + (marker.side === 'buy' ? 13 : -13), direction = marker.side === 'buy' ? -1 : 1;
      const group = svg('g', { class: `trade-marker ${marker.side}`, 'data-count': marker.trades.length, tabindex: '0', role: 'button' });
      const label = `${marker.side === 'buy' ? 'Achat' : 'Vente'} · ${marker.trades.length} opération(s) · ${marker.trades.map(t => date(t.time)).join(', ')} UTC`;
      group.setAttribute('aria-label', label);
      group.append(svg('title', {}, label), svg('path', { d: `M${xx},${yy + direction * 6} L${xx - 6},${yy - direction * 5} L${xx + 6},${yy - direction * 5} Z`, fill: marker.side === 'buy' ? '#3ccea8' : '#f17883', stroke: '#142831', 'stroke-width': 1 }));
      if (marker.trades.length > 1) group.append(svg('text', { x: xx + 8, y: yy + 3, fill: '#dce9ee', 'font-size': 9 }, String(marker.trades.length)));
      const show = () => {
        $('chart-tooltip').textContent = `${label} · ${quantity.format(marker.trades.reduce((sum, t) => sum + t.quantity, 0))} ${asset} · Repère ${candleMode ? 'sur la bougie correspondante, pas un prix d’exécution' : gecko ? `au cours CoinGecko interpolé ${money(marker.price)}, pas un prix d’exécution` : 'au prix implicite du ledger'}.`;
        $('chart-tooltip').hidden = false;
      };
      group.addEventListener('pointerenter', show); group.addEventListener('focus', show); group.addEventListener('click', show);
      group.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); } });
      root.append(group);
    }
    this.crosshair = svg('line', { x1: 0, x2: 0, y1: top, y2: bottom, stroke: '#8ca5b4', 'stroke-dasharray': '4 3', visibility: 'hidden' });
    root.append(this.crosshair);
    this.plot = { points, x, y, duration, range, marketMode: candleMode, gecko, left, right };
  }

  inspect(event) {
    if (!this.plot?.points.length || event.target.closest?.('.trade-marker')) return;
    const rect = $('price-chart').getBoundingClientRect();
    const xx = (event.clientX - rect.left) * $('price-chart').viewBox.baseVal.width / rect.width;
    const { points, x, duration, marketMode } = this.plot;
    let index = 0, distance = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(x(marketMode ? Math.min(this.currentRange.end, Math.max(this.currentRange.start, p.time + duration / 2)) : p.time) - xx);
      if (d < distance) { distance = d; index = i; }
    });
    this.hoverIndex = index; this.showPoint(index);
  }

  showPoint(index) {
    const { points, x, duration, marketMode } = this.plot, point = points[index];
    const xx = x(marketMode ? Math.min(this.currentRange.end, Math.max(this.currentRange.start, point.time + duration / 2)) : point.time);
    this.crosshair.setAttribute('x1', xx); this.crosshair.setAttribute('x2', xx); this.crosshair.setAttribute('visibility', 'visible');
    $('chart-tooltip').textContent = marketMode ?
      `${date(point.time)} UTC · O ${money(point.open)} · H ${money(point.high)} · B ${money(point.low)} · C ${money(point.close)} · Volume ${quantity.format(point.volume)} ${$('chart-asset').value}${point.provisional ? ' · Bougie en cours' : ''}` :
      `${date(point.time)} UTC · ${this.plot.gecko ? `Cours CoinGecko${point.interpolated ? ' interpolé à la limite de période' : ''}` : 'Prix implicite du fichier'} : ${money(point.price)}`;
    $('chart-tooltip').hidden = false;
  }

  renderTrades(trades, data, marketMode) {
    const body = $('chart-trades-body');
    body.replaceChildren();
    for (const t of [...trades].reverse()) {
      const row = html('tr');
      const unavailable = marketMode && (!data || data.excluded.includes(t));
      for (const text of [date(t.time), `${t.side === 'buy' ? 'Achat' : 'Vente'}${t.dust ? ' · poussières' : ''}${t.matched ? '' : ' · non apparié'}`,
        quantity.format(t.quantity), quantity.format(t.fees), money(t.price), t.refid,
        marketMode ? unavailable ? 'Sans cours disponible' : $('chart-provider').value === 'coingecko' ? 'Sur la courbe CoinGecko' : 'Sur la bougie' : t.price === null ? 'Prix inconnu' : 'Sur la courbe']) row.append(html('td', text));
      body.append(row);
    }
    if (!trades.length) {
      const row = html('tr'), cell = html('td', 'Aucun achat ou vente de cet actif dans la période sélectionnée.');
      cell.colSpan = 7; row.append(cell); body.append(row);
    }
  }
}
