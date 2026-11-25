import type { IPriceProvider } from '../providers/IPriceProvider';
import type { QuoteData, PriceHistoryPoint } from '../../shared/types';
import { getCachedPrice, upsertCachedPrice } from '../database/repositories/priceCacheRepository';
import { getSetting } from '../database/index';

export class PriceService {
  constructor(private provider: IPriceProvider) {}

  private getTtl(): number {
    return Number(getSetting('cache_ttl_seconds') ?? '900');
  }

  private isStale(fetchedAt: string): boolean {
    const ageMs = Date.now() - new Date(fetchedAt).getTime();
    return ageMs > this.getTtl() * 1000;
  }

  async getPrice(stockCode: string): Promise<QuoteData> {
    const cached = getCachedPrice(stockCode, this.provider.name);
    if (cached && cached.price > 0 && !this.isStale(cached.fetchedAt)) {
      return cached;
    }
    const fresh = await this.provider.fetchQuote(stockCode);
    if (fresh.price > 0) {
      upsertCachedPrice(fresh, this.provider.name);
      return fresh;
    }
    // 休市/API 回傳 0：用舊快取（不管是否過期），避免顯示 -100%
    if (cached && cached.price > 0) {
      console.log(`[PriceService] ${stockCode}: fresh price=0, using stale cache ${cached.price}`);
      return cached;
    }
    return fresh;
  }

  async getPrices(stockCodes: string[]): Promise<Map<string, QuoteData>> {
    const result = new Map<string, QuoteData>();
    const toFetch: string[] = [];

    for (const code of stockCodes) {
      const cached = getCachedPrice(code, this.provider.name);
      if (cached && cached.price > 0 && !this.isStale(cached.fetchedAt)) {
        result.set(code, cached);
      } else {
        toFetch.push(code);
      }
    }

    if (toFetch.length > 0) {
      const fresh = await this.provider.fetchQuotes(toFetch);
      for (const q of fresh) {
        if (q.price > 0) {
          upsertCachedPrice(q, this.provider.name);
          result.set(q.stockCode, q);
        } else {
          // fresh price=0，降級用舊快取
          const stale = getCachedPrice(q.stockCode, this.provider.name);
          if (stale && stale.price > 0) {
            console.log(`[PriceService] ${q.stockCode}: fresh=0, stale cache=${stale.price}`);
            result.set(q.stockCode, stale);
          }
          // 若連舊快取都沒有，就不加進 map（portfolioService 會用成本價 fallback）
        }
      }
    }

    return result;
  }

  async getHistory(stockCode: string, from: Date, to: Date): Promise<PriceHistoryPoint[]> {
    return this.provider.fetchHistory(stockCode, from, to);
  }

  /** 抓大盤 + 美股期貨 + 匯率（雖然不快取，每次都即時打）*/
  async getMarketContext() {
    // YahooFinanceProvider 自己有 fetchMarketContext；其他 provider 沒實作就回空
    const p = this.provider as { fetchMarketContext?: () => Promise<unknown> };
    if (typeof p.fetchMarketContext === 'function') {
      return await p.fetchMarketContext();
    }
    return { fetchedAt: new Date().toISOString() };
  }

  async getDividends(stockCode: string, from: Date, to: Date) {
    return this.provider.fetchDividends(stockCode, from, to);
  }
}
