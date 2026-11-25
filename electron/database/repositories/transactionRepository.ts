import { getDb } from '../index';
import type { Transaction, TxnFilter } from '../../../shared/types';

interface TxnRow {
  id: number;
  stock_code: string;
  type: string;
  date: string;
  shares: number;
  price_per_share: number;
  brokerage_fee: number;
  transaction_tax: number;
  net_amount: number;
  notes: string | null;
  created_at: string;
}

function rowToTxn(row: TxnRow): Transaction {
  return {
    id: row.id,
    stockCode: row.stock_code,
    type: row.type as Transaction['type'],
    date: row.date,
    shares: row.shares,
    pricePerShare: row.price_per_share,
    brokerageFee: row.brokerage_fee,
    transactionTax: row.transaction_tax,
    netAmount: row.net_amount,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
  };
}

export function listTransactions(filter: TxnFilter = {}): Transaction[] {
  let sql = 'SELECT * FROM transactions WHERE 1=1';
  const params: (string | number)[] = [];

  if (filter.stockCode) { sql += ' AND stock_code = ?'; params.push(filter.stockCode); }
  if (filter.type)      { sql += ' AND type = ?'; params.push(filter.type); }
  if (filter.dateFrom)  { sql += ' AND date >= ?'; params.push(filter.dateFrom); }
  if (filter.dateTo)    { sql += ' AND date <= ?'; params.push(filter.dateTo); }

  sql += ' ORDER BY date DESC, id DESC';
  const rows = getDb().prepare(sql).all(...params) as unknown as TxnRow[];
  return rows.map(rowToTxn);
}

export function insertTransaction(data: {
  stockCode: string;
  type: string;
  date: string;
  shares: number;
  pricePerShare: number;
  brokerageFee: number;
  transactionTax: number;
  netAmount: number;
  notes?: string;
}): number {
  const result = getDb().prepare(`
    INSERT INTO transactions
      (stock_code, type, date, shares, price_per_share, brokerage_fee, transaction_tax, net_amount, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.stockCode, data.type, data.date, data.shares,
    data.pricePerShare, data.brokerageFee, data.transactionTax,
    data.netAmount, data.notes ?? null
  );
  return result.lastInsertRowid as number;
}

export function deleteTransaction(id: number): void {
  getDb().prepare('DELETE FROM transactions WHERE id = ?').run(id);
}

export function getTotalDividend(stockCode?: string): number {
  let sql = 'SELECT COALESCE(SUM(net_amount), 0) as total FROM transactions WHERE type = \'DIVIDEND\'';
  const params: string[] = [];
  if (stockCode) { sql += ' AND stock_code = ?'; params.push(stockCode); }
  const row = getDb().prepare(sql).get(...params) as unknown as { total: number };
  return row.total;
}
