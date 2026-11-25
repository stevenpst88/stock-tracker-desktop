import type { QuoteData, PriceHistoryPoint } from '../../shared/types';

export interface RawDividend {
  date: string;     // YYYY-MM-DD
  perShare: number; // 每股配息金額
}

export interface IPriceProvider {
  readonly name: string;
  fetchQuote(stockCode: string): Promise<QuoteData>;
  fetchQuotes(stockCodes: string[]): Promise<QuoteData[]>;
  fetchHistory(stockCode: string, from: Date, to: Date): Promise<PriceHistoryPoint[]>;
  fetchDividends(stockCode: string, from: Date, to: Date): Promise<RawDividend[]>;
}
