import { getDb } from '../index';
import type { QuoteData } from '../../../shared/types';

interface CacheRow {
  stock_code: string;
  provider: string;
  price: number;
  change_abs: number | null;
  change_pct: number | null;
  volume: number | null;
  fetched_at: string;
}

export function getCachedPrice(stockCode: string, provider = 'yahoo'): QuoteData | null {
  const row = getDb()
    .prepare('SELECT * FROM price_cache WHERE stock_code = ? AND provider = ?')
    .get(stockCode, provider) as unknown as CacheRow | undefined;
  if (!row) return null;
  return {
    stockCode: row.stock_code,
    price: row.price,
    changeAbs: row.change_abs ?? 0,
    changePct: row.change_pct ?? 0,
    volume: row.volume ?? 0,
    fetchedAt: row.fetched_at,
    isDelayed: true,
  };
}

export function upsertCachedPrice(data: QuoteData, provider = 'yahoo'): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO price_cache
      (stock_code, provider, price, change_abs, change_pct, volume, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.stockCode, provider, data.price,
    data.changeAbs, data.changePct, data.volume,
    new Date().toISOString()
  );
}

export function getAllCachedPrices(): QuoteData[] {
  const rows = getDb().prepare('SELECT * FROM price_cache').all() as unknown as CacheRow[];
  return rows.map(r => ({
    stockCode: r.stock_code,
    price: r.price,
    changeAbs: r.change_abs ?? 0,
    changePct: r.change_pct ?? 0,
    volume: r.volume ?? 0,
    fetchedAt: r.fetched_at,
    isDelayed: true,
  }));
}
