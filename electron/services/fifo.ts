import { getDb } from '../database/index';
import type { FifoLot, RealizedPnlRecord } from '../../shared/types';

interface FifoLotRow {
  id: number;
  transaction_id: number;
  stock_code: string;
  purchase_date: string;
  original_shares: number;
  remaining_shares: number;
  cost_per_share: number;
}

function rowToLot(row: FifoLotRow): FifoLot {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    stockCode: row.stock_code,
    purchaseDate: row.purchase_date,
    originalShares: row.original_shares,
    remainingShares: row.remaining_shares,
    costPerShare: row.cost_per_share,
  };
}

export function calcFees(
  type: 'BUY' | 'SELL' | 'DIVIDEND',
  shares: number,
  pricePerShare: number,
  brokerageRate = 0.001425,
  taxRate = 0.003,
): { brokerageFee: number; transactionTax: number; netAmount: number } {
  const gross = shares * pricePerShare;
  // 配息不需要手續費與證交稅
  const brokerageFee = type === 'DIVIDEND' ? 0 : Math.floor(gross * brokerageRate);
  const transactionTax = type === 'SELL' ? Math.floor(gross * taxRate) : 0;
  // BUY：實際付出 = 股票金額 + 手續費
  // SELL：實際收入 = 金額 - 手續費 - 證交稅
  // DIVIDEND：實際收入 = perShare × shares（全額）
  const netAmount = type === 'BUY'
    ? -(gross + brokerageFee)
    : gross - brokerageFee - transactionTax;
  return { brokerageFee, transactionTax, netAmount };
}

export function processBuy(txnId: number, stockCode: string, date: string, shares: number, pricePerShare: number, brokerageFee: number): void {
  const costPerShare = (shares * pricePerShare + brokerageFee) / shares;
  getDb().prepare(`
    INSERT INTO fifo_lots (transaction_id, stock_code, purchase_date, original_shares, remaining_shares, cost_per_share)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(txnId, stockCode, date, shares, shares, costPerShare);
}

export function processSell(txnId: number, stockCode: string, date: string, shares: number, sellPrice: number, brokerageFee: number, transactionTax: number): void {
  const db = getDb();
  const lots = db.prepare(`
    SELECT * FROM fifo_lots
    WHERE stock_code = ? AND remaining_shares > 0
    ORDER BY purchase_date ASC, id ASC
  `).all(stockCode) as unknown as FifoLotRow[];

  let remaining = shares;
  const totalFees = brokerageFee + transactionTax;

  for (const lot of lots) {
    if (remaining <= 0) break;
    const taken = Math.min(lot.remaining_shares, remaining);
    const feeProportion = taken / shares;
    const attributedFee = totalFees * feeProportion;
    const grossProfit = (sellPrice - lot.cost_per_share) * taken;
    const attributedBrokerage = brokerageFee * feeProportion;
    const attributedTax = transactionTax * feeProportion;
    const netProfit = grossProfit - attributedFee;

    db.prepare(`
      INSERT INTO realized_pnl
        (sell_txn_id, lot_id, stock_code, sell_date, shares_sold, cost_per_share,
         sell_price, gross_profit, brokerage_fee, transaction_tax, net_profit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(txnId, lot.id, stockCode, date, taken, lot.cost_per_share,
           sellPrice, grossProfit, attributedBrokerage, attributedTax, netProfit);

    db.prepare('UPDATE fifo_lots SET remaining_shares = remaining_shares - ? WHERE id = ?')
      .run(taken, lot.id);

    remaining -= taken;
  }

  if (remaining > 0.0001) {
    throw new Error(`庫存不足：${stockCode} 尚缺 ${remaining.toFixed(2)} 股`);
  }
}

export function undoSell(txnId: number): void {
  const db = getDb();
  const records = db.prepare('SELECT lot_id, shares_sold FROM realized_pnl WHERE sell_txn_id = ?').all(txnId) as unknown as Array<{
    lot_id: number; shares_sold: number;
  }>;

  for (const r of records) {
    db.prepare('UPDATE fifo_lots SET remaining_shares = remaining_shares + ? WHERE id = ?')
      .run(r.shares_sold, r.lot_id);
  }
  db.prepare('DELETE FROM realized_pnl WHERE sell_txn_id = ?').run(txnId);
}

export function getLotsForStock(stockCode: string): FifoLot[] {
  const rows = getDb().prepare(`
    SELECT * FROM fifo_lots WHERE stock_code = ? ORDER BY purchase_date ASC, id ASC
  `).all(stockCode) as unknown as FifoLotRow[];
  return rows.map(rowToLot);
}

export function getRealizedPnl(stockCode?: string, dateFrom?: string, dateTo?: string): RealizedPnlRecord[] {
  let sql = 'SELECT * FROM realized_pnl WHERE 1=1';
  const params: (string | number)[] = [];
  if (stockCode) { sql += ' AND stock_code = ?'; params.push(stockCode); }
  if (dateFrom)  { sql += ' AND sell_date >= ?'; params.push(dateFrom); }
  if (dateTo)    { sql += ' AND sell_date <= ?'; params.push(dateTo); }
  sql += ' ORDER BY sell_date DESC';

  interface PnlRow {
    id: number; sell_txn_id: number; lot_id: number; stock_code: string;
    sell_date: string; shares_sold: number; cost_per_share: number;
    sell_price: number; gross_profit: number; brokerage_fee: number;
    transaction_tax: number; net_profit: number;
  }
  const rows = getDb().prepare(sql).all(...params) as unknown as PnlRow[];
  return rows.map(r => ({
    id: r.id, sellTxnId: r.sell_txn_id, lotId: r.lot_id, stockCode: r.stock_code,
    sellDate: r.sell_date, sharesSold: r.shares_sold, costPerShare: r.cost_per_share,
    sellPrice: r.sell_price, grossProfit: r.gross_profit, brokerageFee: r.brokerage_fee,
    transactionTax: r.transaction_tax, netProfit: r.net_profit,
  }));
}

export function getYearlyPnl(): Array<{ year: number; realizedPnl: number; dividendIncome: number; totalTxns: number }> {
  const db = getDb();
  const pnlRows = db.prepare(`
    SELECT strftime('%Y', sell_date) as year, SUM(net_profit) as total
    FROM realized_pnl GROUP BY year ORDER BY year DESC
  `).all() as unknown as Array<{ year: string; total: number }>;

  const divRows = db.prepare(`
    SELECT strftime('%Y', date) as year, SUM(net_amount) as total
    FROM transactions WHERE type = 'DIVIDEND' GROUP BY year
  `).all() as unknown as Array<{ year: string; total: number }>;

  const txnRows = db.prepare(`
    SELECT strftime('%Y', date) as year, COUNT(*) as cnt
    FROM transactions WHERE type != 'DIVIDEND' GROUP BY year
  `).all() as unknown as Array<{ year: string; cnt: number }>;

  const years = new Set([
    ...pnlRows.map(r => r.year),
    ...divRows.map(r => r.year),
    ...txnRows.map(r => r.year),
  ]);

  return [...years].sort((a, b) => b.localeCompare(a)).map(year => ({
    year: Number(year),
    realizedPnl: pnlRows.find(r => r.year === year)?.total ?? 0,
    dividendIncome: divRows.find(r => r.year === year)?.total ?? 0,
    totalTxns: txnRows.find(r => r.year === year)?.cnt ?? 0,
  }));
}
