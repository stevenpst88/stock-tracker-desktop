// yahoo-finance2 v3: default export is the YahooFinance class constructor
// Must use `new` to create an instance, otherwise methods throw "Call new YahooFinance() first"
import YahooFinanceClass from 'yahoo-finance2';
import type { IPriceProvider, RawDividend } from './IPriceProvider';
import type { QuoteData, PriceHistoryPoint, MarketContext, FundamentalData } from '../../shared/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yf = new (YahooFinanceClass as any)({ suppressNotices: ['yahooSurvey'] });

interface YFQuote {
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketVolume?: number;
  regularMarketPreviousClose?: number;
}

interface YFHistoricalItem {
  date: Date;
  close: number;
  volume: number;
}

/** 台股代碼轉 Yahoo Finance ticker */
const toTicker = (code: string) => `${code}.TW`;
const toTickerOTC = (code: string) => `${code}.TWO`;

export class YahooFinanceProvider implements IPriceProvider {
  readonly name = 'yahoo';

  async fetchQuote(stockCode: string): Promise<QuoteData> {
    // 先試 .TW（上市/ETF），price=0 再試 .TWO（上櫃）
    for (const ticker of [toTicker(stockCode), toTickerOTC(stockCode)]) {
      try {
        const result = (await yf.quote(
          ticker,
          {},
          { validateResult: false }
        )) as YFQuote;

        // regularMarketPrice = 最後成交價（含收盤後）；若仍為 0 用前日收盤
        const price = (result.regularMarketPrice && result.regularMarketPrice > 0)
          ? result.regularMarketPrice
          : (result.regularMarketPreviousClose ?? 0);

        if (price > 0) {
          console.log(`[Yahoo] ${stockCode} (${ticker}) price=${price}`);
          return {
            stockCode,
            price,
            changeAbs: result.regularMarketChange ?? 0,
            changePct: result.regularMarketChangePercent ?? 0,
            volume: result.regularMarketVolume ?? 0,
            fetchedAt: new Date().toISOString(),
            isDelayed: true,
          };
        }
        console.warn(`[Yahoo] ${ticker} returned price=0, trying next suffix...`);
      } catch (err) {
        console.warn(`[Yahoo] fetch failed for ${ticker}:`, (err as Error).message);
      }
    }

    console.error(`[Yahoo] Could not fetch price for ${stockCode}`);
    return { stockCode, price: 0, changeAbs: 0, changePct: 0, volume: 0, fetchedAt: new Date().toISOString(), isDelayed: true };
  }

  async fetchQuotes(stockCodes: string[]): Promise<QuoteData[]> {
    const results = await Promise.allSettled(stockCodes.map(c => this.fetchQuote(c)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.error(`[Yahoo] rejected ${stockCodes[i]}:`, r.reason);
    });
    return results
      .filter((r): r is PromiseFulfilledResult<QuoteData> => r.status === 'fulfilled')
      .map(r => r.value);
  }

  async fetchHistory(stockCode: string, from: Date, to: Date): Promise<PriceHistoryPoint[]> {
    // 使用 chart() 取代已棄用的 historical()（v3 中 historical 會被重導向到 chart）
    interface ChartQuote {
      date: Date | string;
      open: number | null;
      high: number | null;
      low: number | null;
      close: number | null;
      volume: number | null;
    }
    interface ChartResult { quotes: ChartQuote[] }

    for (const ticker of [toTicker(stockCode), toTickerOTC(stockCode)]) {
      try {
        const result = (await yf.chart(
          ticker,
          { period1: from, period2: to, interval: '1d' },
          { validateResult: false }
        )) as ChartResult;

        const quotes = (result.quotes ?? []).filter(q => q.close != null && q.close > 0);
        if (quotes.length > 0) {
          return quotes.map(d => {
            const dt = d.date instanceof Date ? d.date : new Date(d.date as string);
            return {
              date: dt.toISOString().slice(0, 10),
              close: d.close!,
              volume: d.volume ?? 0,
              open:  d.open  ?? undefined,
              high:  d.high  ?? undefined,
              low:   d.low   ?? undefined,
            };
          });
        }
      } catch (err) {
        console.warn(`[Yahoo] history failed for ${ticker}:`, (err as Error).message);
      }
    }
    return [];
  }

  /** 抓大盤 + 美股期貨 + 匯率 — 給 AI 看市場 context */
  async fetchMarketContext(): Promise<MarketContext> {
    interface IndexResult { value: number; changePct: number }
    const tickers: { key: keyof Omit<MarketContext, 'fetchedAt'>; ticker: string }[] = [
      { key: 'taiex',     ticker: '^TWII' },        // 加權指數
      { key: 'otc',       ticker: '^TWOII' },       // 櫃買指數
      { key: 'esFutures', ticker: 'ES=F' },         // S&P 500 期貨
      { key: 'usdTwd',    ticker: 'TWD=X' },        // USD/TWD（Yahoo 慣用 TWD=X）
    ];

    const out: MarketContext = { fetchedAt: new Date().toISOString() };
    await Promise.allSettled(
      tickers.map(async ({ key, ticker }) => {
        try {
          const q = (await yf.quote(ticker)) as YFQuote;
          if (q?.regularMarketPrice != null) {
            const data: IndexResult = {
              value: q.regularMarketPrice,
              changePct: q.regularMarketChangePercent ?? 0,
            };
            out[key] = data;
          }
        } catch (err) {
          console.warn(`[Yahoo] market index ${ticker} failed:`, (err as Error).message);
        }
      })
    );
    return out;
  }

  /** 抓基本面（本益比、EPS、殖利率、市值）— 用 quoteSummary 端點 */
  async fetchFundamental(stockCode: string): Promise<FundamentalData | null> {
    interface SummaryDetail { trailingPE?: number; dividendYield?: number; marketCap?: number }
    interface KeyStats { trailingEps?: number }
    interface QuoteSummaryResult {
      summaryDetail?: SummaryDetail;
      defaultKeyStatistics?: KeyStats;
    }

    for (const ticker of [toTicker(stockCode), toTickerOTC(stockCode)]) {
      try {
        const result = (await yf.quoteSummary(
          ticker,
          { modules: ['summaryDetail', 'defaultKeyStatistics'] },
          { validateResult: false }
        )) as QuoteSummaryResult;
        const sd = result.summaryDetail;
        const ks = result.defaultKeyStatistics;
        if (!sd && !ks) continue;
        return {
          stockCode,
          pe:            sd?.trailingPE,
          eps:           ks?.trailingEps,
          // dividendYield 從 yahoo 是小數（0.0523 = 5.23%）→ 轉百分比
          dividendYield: sd?.dividendYield != null ? sd.dividendYield * 100 : undefined,
          marketCap:     sd?.marketCap,
          fetchedAt:     new Date().toISOString(),
        };
      } catch (err) {
        console.warn(`[Yahoo] fundamental ${ticker} failed:`, (err as Error).message);
      }
    }
    return null;
  }

  async fetchDividends(stockCode: string, from: Date, to: Date): Promise<RawDividend[]> {
    // Yahoo Finance chart() 的 events 欄位包含除息紀錄
    interface DivEntry { date: Date | number; amount: number; }
    interface ChartEvents { dividends?: DivEntry[] | Record<string, DivEntry>; }
    interface ChartWithEvents { quotes: unknown[]; events?: ChartEvents; }

    for (const ticker of [toTicker(stockCode), toTickerOTC(stockCode)]) {
      try {
        const result = (await yf.chart(
          ticker,
          { period1: from, period2: to, interval: '1d', events: 'div' },
          { validateResult: false }
        )) as ChartWithEvents;

        const rawDivs = result.events?.dividends;
        if (!rawDivs) continue;

        // dividends 可能是 array 或 object（key = timestamp）
        const arr: DivEntry[] = Array.isArray(rawDivs)
          ? rawDivs
          : Object.values(rawDivs);

        if (arr.length === 0) continue;

        console.log(`[Yahoo] ${ticker} found ${arr.length} dividend event(s)`);
        return arr
          .filter(d => d.amount > 0)
          .map(d => {
            const dt = d.date instanceof Date
              ? d.date
              : new Date(typeof d.date === 'number' ? d.date * 1000 : d.date);
            return { date: dt.toISOString().slice(0, 10), perShare: d.amount };
          })
          .sort((a, b) => a.date.localeCompare(b.date));
      } catch (err) {
        console.warn(`[Yahoo] dividends failed for ${ticker}:`, (err as Error).message);
      }
    }
    return [];
  }
}
