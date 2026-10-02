import { fetchKrakenPrices } from './prices.js';

export class CurrencyDisplay {
  constructor() {
    this.currency = 'USD';
    this.eurPerUSD = null;
    this.date = null;
    this.formatters = new Map();
  }

  set(currency, quote) {
    if (!['USD', 'EUR'].includes(currency)) throw new Error('Devise d’affichage non prise en charge.');
    if (quote) {
      if (!Number.isFinite(quote.eurPerUSD) || quote.eurPerUSD <= 0 || !Number.isFinite(quote.date) || !Number.isFinite(new Date(quote.date).getTime())) {
        throw new Error('Taux EUR/USD invalide.');
      }
      this.eurPerUSD = quote.eurPerUSD; this.date = quote.date;
    }
    if (currency === 'EUR' && this.eurPerUSD === null) throw new Error('Un taux EUR/USD est nécessaire pour afficher les euros.');
    this.currency = currency;
  }

  convert(value) {
    if (value === null) return null;
    if (!Number.isFinite(value)) throw new Error('Montant de conversion invalide.');
    return value * (this.currency === 'EUR' ? this.eurPerUSD : 1);
  }

  toUSD(value) {
    if (value === null) return null;
    if (!Number.isFinite(value)) throw new Error('Montant de conversion invalide.');
    return value / (this.currency === 'EUR' ? this.eurPerUSD : 1);
  }

  money(value, significant = false) {
    if (value === null) return '—';
    const key = `${this.currency}|${significant}`;
    if (!this.formatters.has(key)) this.formatters.set(key, new Intl.NumberFormat('fr-FR', {
      style: 'currency', currency: this.currency,
      ...(significant ? { maximumSignificantDigits: 6 } : { maximumFractionDigits: 2 }),
    }));
    return this.formatters.get(key).format(this.convert(value));
  }
}

export const displayCurrency = new CurrencyDisplay();

export async function fetchEURRate() {
  const result = await fetchKrakenPrices(['EUR']);
  const quote = result.prices.EUR;
  if (!quote) throw new Error('Cours EUR/USD Kraken indisponible. L’affichage précédent est conservé.');
  return { eurPerUSD: 1 / quote.value, date: quote.date };
}
