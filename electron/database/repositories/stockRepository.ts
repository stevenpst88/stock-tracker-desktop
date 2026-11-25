import { getDb } from '../index';
import type { Stock, AddStockInput } from '../../../shared/types';

interface StockRow {
  code: string;
  name: string;
  market: string;
  currency: string;
}

function rowToStock(row: StockRow): Stock {
  return {
    code: row.code,
    name: row.name,
    market: row.market as Stock['market'],
    currency: 'TWD',
  };
}

export function listStocks(): Stock[] {
  const rows = getDb().prepare('SELECT * FROM stocks ORDER BY code').all() as unknown as StockRow[];
  return rows.map(rowToStock);
}

export function getStock(code: string): Stock | null {
  const row = getDb().prepare('SELECT * FROM stocks WHERE code = ?').get(code) as unknown as StockRow | undefined;
  return row ? rowToStock(row) : null;
}

export function addStock(input: AddStockInput): Stock {
  getDb()
    .prepare('INSERT OR IGNORE INTO stocks(code, name, market) VALUES (?, ?, ?)')
    .run(input.code, input.name, input.market);
  return { code: input.code, name: input.name, market: input.market, currency: 'TWD' };
}

export function deleteStock(code: string): void {
  getDb().prepare('DELETE FROM stocks WHERE code = ?').run(code);
}
