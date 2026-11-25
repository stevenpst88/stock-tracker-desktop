import { ipcMain } from 'electron';
import { IPC } from './channels';
import { listStocks, addStock, deleteStock } from '../database/repositories/stockRepository';
import { listTransactions, insertTransaction, deleteTransaction } from '../database/repositories/transactionRepository';
import { processBuy, processSell, undoSell, getRealizedPnl, getYearlyPnl, calcFees } from '../services/fifo';
import { buildPortfolioSummary } from '../services/portfolioService';
import { getSetting, setSetting, getDb } from '../database/index';
import type { PriceService } from '../services/priceService';
import type { AddStockInput, AddTransactionInput, TxnFilter, CalcFeesInput, DividendSyncItem, AddRadarInput, InstData, InstTrend, TechData, MarginData, FundamentalData, BacktestResult } from '../../shared/types';

export function registerHandlers(priceService: PriceService): void {

  // --- Stocks ---
  ipcMain.handle(IPC.STOCKS_LIST, () => listStocks());

  ipcMain.handle(IPC.STOCKS_ADD, (_e, input: AddStockInput) => addStock(input));

  ipcMain.handle(IPC.STOCKS_DELETE, (_e, code: string) => deleteStock(code));

  // --- Transactions ---
  ipcMain.handle(IPC.TXN_LIST, (_e, filter: TxnFilter = {}) => listTransactions(filter));

  ipcMain.handle(IPC.TXN_ADD, (_e, input: AddTransactionInput) => {
    const db = getDb();
    const gross = input.shares * input.pricePerShare;
    const netAmount = input.type === 'BUY'
      ? -(gross + input.brokerageFee)
      : gross - input.brokerageFee - input.transactionTax;

    db.exec('BEGIN');
    try {
      const txnId = insertTransaction({
        stockCode: input.stockCode,
        type: input.type,
        date: input.date,
        shares: input.shares,
        pricePerShare: input.pricePerShare,
        brokerageFee: input.brokerageFee,
        transactionTax: input.transactionTax,
        netAmount,
        notes: input.notes,
      });

      if (input.type === 'BUY') {
        processBuy(txnId, input.stockCode, input.date, input.shares, input.pricePerShare, input.brokerageFee);
      } else if (input.type === 'SELL') {
        processSell(txnId, input.stockCode, input.date, input.shares, input.pricePerShare, input.brokerageFee, input.transactionTax);
      }
      db.exec('COMMIT');
      return txnId;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  ipcMain.handle(IPC.TXN_UPDATE, (_e, id: number, input: AddTransactionInput) => {
    const db = getDb();
    const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as unknown as {
      type: string; stock_code: string; shares: number;
    } | undefined;
    if (!txn) throw new Error('找不到交易紀錄');

    const gross = input.shares * input.pricePerShare;
    const netAmount = input.type === 'BUY'
      ? -(gross + input.brokerageFee)
      : gross - input.brokerageFee - input.transactionTax;

    db.exec('BEGIN');
    try {
      // Step 1: Undo old FIFO effects
      if (txn.type === 'BUY') {
        const lot = db.prepare('SELECT original_shares, remaining_shares FROM fifo_lots WHERE transaction_id = ?')
          .get(id) as unknown as { original_shares: number; remaining_shares: number } | undefined;
        if (lot && lot.remaining_shares < lot.original_shares - 0.0001) {
          throw new Error('此筆買入已部分賣出，請先刪除對應的賣出交易才能修改');
        }
        db.prepare('DELETE FROM fifo_lots WHERE transaction_id = ?').run(id);
      } else if (txn.type === 'SELL') {
        const records = db.prepare('SELECT lot_id, shares_sold FROM realized_pnl WHERE sell_txn_id = ?')
          .all(id) as unknown as Array<{ lot_id: number; shares_sold: number }>;
        for (const r of records) {
          db.prepare('UPDATE fifo_lots SET remaining_shares = remaining_shares + ? WHERE id = ?')
            .run(r.shares_sold, r.lot_id);
        }
        db.prepare('DELETE FROM realized_pnl WHERE sell_txn_id = ?').run(id);
      }

      // Step 2: Update the transaction record
      db.prepare(`
        UPDATE transactions SET
          stock_code = ?, type = ?, date = ?, shares = ?, price_per_share = ?,
          brokerage_fee = ?, transaction_tax = ?, net_amount = ?, notes = ?
        WHERE id = ?
      `).run(input.stockCode, input.type, input.date, input.shares, input.pricePerShare,
             input.brokerageFee, input.transactionTax, netAmount, input.notes ?? null, id);

      // Step 3: Re-apply FIFO effects with new data (inline, no nested BEGIN)
      if (input.type === 'BUY') {
        const costPerShare = (input.shares * input.pricePerShare + input.brokerageFee) / input.shares;
        db.prepare(`
          INSERT INTO fifo_lots (transaction_id, stock_code, purchase_date, original_shares, remaining_shares, cost_per_share)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, input.stockCode, input.date, input.shares, input.shares, costPerShare);
      } else if (input.type === 'SELL') {
        const lots = db.prepare(`
          SELECT * FROM fifo_lots WHERE stock_code = ? AND remaining_shares > 0
          ORDER BY purchase_date ASC, id ASC
        `).all(input.stockCode) as unknown as Array<{
          id: number; remaining_shares: number; cost_per_share: number;
        }>;
        let remaining = input.shares;
        const totalFees = input.brokerageFee + input.transactionTax;
        for (const lot of lots) {
          if (remaining <= 0) break;
          const taken = Math.min(lot.remaining_shares, remaining);
          const feeProp = taken / input.shares;
          const grossProfit = (input.pricePerShare - lot.cost_per_share) * taken;
          db.prepare(`
            INSERT INTO realized_pnl
              (sell_txn_id, lot_id, stock_code, sell_date, shares_sold, cost_per_share,
               sell_price, gross_profit, brokerage_fee, transaction_tax, net_profit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(id, lot.id, input.stockCode, input.date, taken, lot.cost_per_share,
                 input.pricePerShare, grossProfit, input.brokerageFee * feeProp,
                 input.transactionTax * feeProp, grossProfit - totalFees * feeProp);
          db.prepare('UPDATE fifo_lots SET remaining_shares = remaining_shares - ? WHERE id = ?')
            .run(taken, lot.id);
          remaining -= taken;
        }
        if (remaining > 0.0001) throw new Error(`庫存不足：${input.stockCode} 尚缺 ${remaining.toFixed(2)} 股`);
      }

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  ipcMain.handle(IPC.TXN_DELETE, (_e, id: number) => {
    const db = getDb();
    const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as unknown as {
      type: string; stock_code: string; shares: number;
    } | undefined;
    if (!txn) return;

    db.exec('BEGIN');
    try {
      if (txn.type === 'SELL') undoSell(id);
      if (txn.type === 'BUY') {
        db.prepare('DELETE FROM fifo_lots WHERE transaction_id = ?').run(id);
      }
      deleteTransaction(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  ipcMain.handle(IPC.TXN_CALC_FEES, (_e, input: CalcFeesInput) => {
    const brokerageRate = Number(getSetting('brokerage_fee_rate') ?? '0.001425');
    let taxRate = Number(getSetting('transaction_tax_rate') ?? '0.003');

    // ETF 證交稅為 0.1%，一般股票為 0.3%
    if (input.stockCode) {
      const db = getDb();
      const stock = db.prepare('SELECT market FROM stocks WHERE code = ?').get(input.stockCode) as
        { market: string } | undefined;
      if (stock?.market === 'ETF') taxRate = 0.001;
    }

    return calcFees(input.type, input.shares, input.pricePerShare, brokerageRate, taxRate);
  });

  // --- Portfolio ---
  ipcMain.handle(IPC.PORTFOLIO_SUMMARY, async () => {
    return buildPortfolioSummary(priceService);
  });

  ipcMain.handle(IPC.PORTFOLIO_HISTORY, async (_e, days: number = 90) => {
    const db = getDb();

    // 取得所有買賣交易（用來還原歷史持股數）
    interface TxnRow { stock_code: string; date: string; type: string; shares: number; }
    const allTxns = db.prepare(`
      SELECT stock_code, date, type, shares
      FROM transactions
      WHERE type IN ('BUY', 'SELL')
      ORDER BY date ASC, id ASC
    `).all() as unknown as TxnRow[];

    if (allTxns.length === 0) return [];

    // 依股票分組，建立 (date, delta) 序列
    const txnsByStock = new Map<string, Array<{ date: string; delta: number }>>();
    for (const t of allTxns) {
      const delta = t.type === 'BUY' ? t.shares : -t.shares;
      if (!txnsByStock.has(t.stock_code)) txnsByStock.set(t.stock_code, []);
      txnsByStock.get(t.stock_code)!.push({ date: t.date, delta });
    }

    const from = new Date();
    from.setDate(from.getDate() - days);
    const to = new Date();
    const fromStr = from.toISOString().slice(0, 10);

    // 取各股歷史收盤價
    const stockPrices = new Map<string, Map<string, number>>(); // code → date → close
    await Promise.allSettled(
      [...txnsByStock.keys()].map(async code => {
        const history = await priceService.getHistory(code, from, to);
        if (history.length === 0) return;
        const m = new Map<string, number>();
        for (const pt of history) m.set(pt.date, pt.close);
        stockPrices.set(code, m);
      })
    );

    // 彙整所有日期（取聯集）
    const allDates = new Set<string>();
    for (const m of stockPrices.values()) for (const d of m.keys()) allDates.add(d);
    const sortedDates = [...allDates].sort();

    if (sortedDates.length === 0) return [];

    // 逐日計算總市值：
    //   1. 歷史持股數按交易日期累加（非使用目前庫存）
    //   2. 缺價格的日期沿用前一天（forward fill）
    const dateMap = new Map<string, number>();

    for (const [code, txns] of txnsByStock.entries()) {
      const priceMap = stockPrices.get(code);
      if (!priceMap) continue;

      // 計算查詢期間開始前已累積的持股數
      let sharesHeld = 0;
      let txnIdx = 0;
      for (; txnIdx < txns.length && txns[txnIdx].date < fromStr; txnIdx++) {
        sharesHeld += txns[txnIdx].delta;
      }

      let lastPrice: number | null = null;

      for (const date of sortedDates) {
        // 套用這一天及之前的交易
        while (txnIdx < txns.length && txns[txnIdx].date <= date) {
          sharesHeld += txns[txnIdx].delta;
          txnIdx++;
        }

        // forward fill：有價格就更新，沒有就沿用上次
        const p = priceMap.get(date);
        if (p !== undefined) lastPrice = p;

        if (sharesHeld > 0 && lastPrice !== null) {
          dateMap.set(date, (dateMap.get(date) ?? 0) + sharesHeld * lastPrice);
        }
      }
    }

    const sorted = [...dateMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, value: Math.round(value) }));

    // ── 計算每日成本基準（cost basis）──
    // 買入時成本增加，賣出時扣除已賣部分的成本
    interface LotCostRow { purchase_date: string; total_cost: number; }
    interface SellCostRow { sell_date: string; total_removed: number; }

    const lotCostRows = db.prepare(`
      SELECT purchase_date, SUM(original_shares * cost_per_share) as total_cost
      FROM fifo_lots GROUP BY purchase_date ORDER BY purchase_date
    `).all() as unknown as LotCostRow[];

    const sellCostRows = db.prepare(`
      SELECT sell_date, SUM(shares_sold * cost_per_share) as total_removed
      FROM realized_pnl GROUP BY sell_date ORDER BY sell_date
    `).all() as unknown as SellCostRow[];

    // 建立 date → 累計成本 快速查詢陣列（已排序）
    let runningLotCost = 0;
    const lotCumulative: Array<{ date: string; cost: number }> = [];
    for (const r of lotCostRows) {
      runningLotCost += r.total_cost;
      lotCumulative.push({ date: r.purchase_date, cost: runningLotCost });
    }
    let runningSellCost = 0;
    const sellCumulative: Array<{ date: string; cost: number }> = [];
    for (const r of sellCostRows) {
      runningSellCost += r.total_removed;
      sellCumulative.push({ date: r.sell_date, cost: runningSellCost });
    }

    // 二分搜尋取「≤ date 的最後一個累計值」
    function cumAt(arr: Array<{ date: string; cost: number }>, date: string): number {
      let lo = 0, hi = arr.length - 1, result = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].date <= date) { result = arr[mid].cost; lo = mid + 1; }
        else hi = mid - 1;
      }
      return result;
    }

    // ── 當日交易現金流（用來把買賣行為從 dailyChange 剝離出來）──
    // 原本 dailyChange = value_today − value_yesterday，但這會把買賣行為污染進去：
    //   買 100 股 @ $100 → value 升 $10k，但這不是「賺到」
    //   賣 50 股 @ $200 → value 降 $10k，但這不是「虧到」
    // 真正想看的「純市場 P&L」= (value_today − value_yesterday) − (買進金額 − 賣出金額)
    interface TxCashRow { date: string; type: 'BUY' | 'SELL'; gross: number; }
    const txCashRows = db.prepare(`
      SELECT date, type, SUM(shares * price_per_share) as gross
      FROM transactions
      WHERE type IN ('BUY', 'SELL')
      GROUP BY date, type
    `).all() as unknown as TxCashRow[];

    // date → net inflow（買 - 賣，正值=當日新增資金到組合）
    const netInflowByDate = new Map<string, number>();
    for (const r of txCashRows) {
      const delta = r.type === 'BUY' ? r.gross : -r.gross;
      netInflowByDate.set(r.date, (netInflowByDate.get(r.date) ?? 0) + delta);
    }

    return sorted.map((d, i) => {
      const rawDelta = i > 0 ? d.value - sorted[i - 1].value : 0;
      const netInflow = netInflowByDate.get(d.date) ?? 0;
      return {
        date: d.date,
        value: d.value,
        cost: Math.round(cumAt(lotCumulative, d.date) - cumAt(sellCumulative, d.date)),
        // 純市場 P&L：扣除當日買賣金額影響
        dailyChange: Math.round(rawDelta - netInflow),
      };
    });
  });

  ipcMain.handle(IPC.REALIZED_PNL, (_e, { stockCode, dateFrom, dateTo }: {
    stockCode?: string; dateFrom?: string; dateTo?: string;
  } = {}) => {
    return getRealizedPnl(stockCode, dateFrom, dateTo);
  });

  ipcMain.handle(IPC.YEARLY_PNL, () => getYearlyPnl());

  // --- Prices ---
  ipcMain.handle(IPC.PRICE_INVALIDATE, () => {
    // 清空價格快取，下次查詢時強制重新抓取
    getDb().exec('DELETE FROM price_cache');
    return { ok: true };
  });

  ipcMain.handle(IPC.PRICE_GET, async (_e, code: string) => {
    return priceService.getPrice(code);
  });

  ipcMain.handle(IPC.PRICE_GET_BATCH, async (_e, codes: string[]) => {
    const map = await priceService.getPrices(codes);
    return Object.fromEntries(map);
  });

  ipcMain.handle(IPC.PRICE_HISTORY, async (_e, { stockCode, from, to }: {
    stockCode: string; from: string; to: string;
  }) => {
    return priceService.getHistory(stockCode, new Date(from), new Date(to));
  });

  ipcMain.handle(IPC.PRICE_MARKET_CTX, async () => {
    return priceService.getMarketContext();
  });

  // --- Settings ---
  ipcMain.handle(IPC.SETTINGS_GET, (_e, key: string) => getSetting(key));
  ipcMain.handle(IPC.SETTINGS_SET, (_e, key: string, value: string) => setSetting(key, value));

  // --- Dividend auto-sync ---
  ipcMain.handle(IPC.DIVIDEND_SYNC, async () => {
    const db = getDb();

    // 取得所有有買賣紀錄的股票及其名稱
    interface StockCodeRow { stock_code: string; }
    interface StockNameRow { code: string; name: string; }
    const traded = db.prepare(`
      SELECT DISTINCT stock_code FROM transactions WHERE type IN ('BUY','SELL')
    `).all() as unknown as StockCodeRow[];

    if (traded.length === 0) return [];

    // 最早交易日（作為查詢起始）
    interface EarliestRow { earliest: string; }
    const earliest = (db.prepare(`
      SELECT MIN(date) as earliest FROM transactions WHERE type IN ('BUY','SELL')
    `).get() as unknown as EarliestRow).earliest;

    const from = new Date(earliest);
    const to = new Date();

    const stockNames = db.prepare(
      `SELECT code, name FROM stocks WHERE code IN (${traded.map(() => '?').join(',')})`
    ).all(...traded.map(r => r.stock_code)) as unknown as StockNameRow[];
    const nameMap = new Map(stockNames.map(s => [s.code, s.name]));

    const pending: DividendSyncItem[] = [];

    for (const { stock_code } of traded) {
      const rawDivs = await priceService.getDividends(stock_code, from, to);
      if (rawDivs.length === 0) continue;

      for (const div of rawDivs) {
        // 跳過已記錄的（同股票 + 同日期的 DIVIDEND 交易）
        const existing = db.prepare(
          `SELECT id FROM transactions WHERE stock_code = ? AND type = 'DIVIDEND' AND date = ?`
        ).get(stock_code, div.date);
        if (existing) continue;

        // 計算該日期的累積持股數
        interface SharesRow { total: number; }
        const { total: sharesHeld } = db.prepare(`
          SELECT COALESCE(SUM(CASE WHEN type='BUY' THEN shares ELSE -shares END), 0) as total
          FROM transactions
          WHERE stock_code = ? AND type IN ('BUY','SELL') AND date <= ?
        `).get(stock_code, div.date) as unknown as SharesRow;

        if (sharesHeld <= 0) continue;

        pending.push({
          stockCode: stock_code,
          stockName: nameMap.get(stock_code) ?? stock_code,
          date: div.date,
          perShare: div.perShare,
          sharesHeld,
          total: Math.round(div.perShare * sharesHeld * 100) / 100,
        });
      }
    }

    // 依日期排序
    return pending.sort((a, b) => a.date.localeCompare(b.date));
  });

  // --- Radar ---
  ipcMain.handle(IPC.RADAR_LIST, () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, stock_code, stock_name, market, buy_at, stop_loss, target_shares,
             note, remark, is_holding, sort_order
      FROM radar_stocks ORDER BY sort_order ASC, id ASC
    `).all() as unknown as Array<{
      id: number; stock_code: string; stock_name: string; market: string;
      buy_at: number | null; stop_loss: number | null; target_shares: number | null;
      note: string | null; remark: string | null; is_holding: number; sort_order: number;
    }>;
    return rows.map(r => ({
      id: r.id,
      stockCode: r.stock_code,
      stockName: r.stock_name,
      market: r.market,
      buyAt: r.buy_at,
      stopLoss: r.stop_loss,
      targetShares: r.target_shares,
      note: r.note,
      remark: r.remark,
      isHolding: r.is_holding === 1,
      sortOrder: r.sort_order,
    }));
  });

  ipcMain.handle(IPC.RADAR_ADD, (_e, input: AddRadarInput) => {
    const db = getDb();
    const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM radar_stocks').get() as { m: number }).m;
    const result = db.prepare(`
      INSERT INTO radar_stocks (stock_code, stock_name, market, buy_at, stop_loss, target_shares, note, remark, is_holding, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.stockCode, input.stockName, input.market,
      input.buyAt ?? null, input.stopLoss ?? null, input.targetShares ?? null,
      input.note ?? null, input.remark ?? null,
      input.isHolding ? 1 : 0,
      maxOrder + 1,
    );
    return result.lastInsertRowid;
  });

  ipcMain.handle(IPC.RADAR_UPDATE, (_e, id: number, input: AddRadarInput) => {
    getDb().prepare(`
      UPDATE radar_stocks SET
        stock_code = ?, stock_name = ?, market = ?,
        buy_at = ?, stop_loss = ?, target_shares = ?,
        note = ?, remark = ?, is_holding = ?
      WHERE id = ?
    `).run(
      input.stockCode, input.stockName, input.market,
      input.buyAt ?? null, input.stopLoss ?? null, input.targetShares ?? null,
      input.note ?? null, input.remark ?? null,
      input.isHolding ? 1 : 0,
      id,
    );
  });

  ipcMain.handle(IPC.RADAR_DELETE, (_e, id: number) => {
    getDb().prepare('DELETE FROM radar_stocks WHERE id = ?').run(id);
  });

  ipcMain.handle(IPC.RADAR_TOGGLE_HOLDING, (_e, id: number) => {
    getDb().prepare('UPDATE radar_stocks SET is_holding = 1 - is_holding WHERE id = ?').run(id);
  });

  ipcMain.handle(IPC.RADAR_SYNC_HOLDINGS, () => {
    const db = getDb();
    // 取得目前有剩餘股數的非 ETF 持倉
    interface HoldingRow { stock_code: string; stock_name: string; market: string; }
    const holdings = db.prepare(`
      SELECT s.code AS stock_code, s.name AS stock_name, s.market
      FROM stocks s
      WHERE s.market != 'ETF'
        AND EXISTS (
          SELECT 1 FROM fifo_lots fl
          WHERE fl.stock_code = s.code AND fl.remaining_shares > 0.0001
        )
    `).all() as unknown as HoldingRow[];

    let added = 0;
    let updated = 0;

    for (const h of holdings) {
      const existing = db.prepare('SELECT id, is_holding FROM radar_stocks WHERE stock_code = ?')
        .get(h.stock_code) as { id: number; is_holding: number } | undefined;

      if (!existing) {
        // 新增：自持倉自動納入
        const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM radar_stocks').get() as { m: number }).m;
        db.prepare(`
          INSERT INTO radar_stocks (stock_code, stock_name, market, is_holding, note, sort_order)
          VALUES (?, ?, ?, 1, '自持倉同步', ?)
        `).run(h.stock_code, h.stock_name, h.market, maxOrder + 1);
        added++;
      } else if (existing.is_holding === 0) {
        // 已在雷達但未標記持有 → 更新
        db.prepare('UPDATE radar_stocks SET is_holding = 1 WHERE id = ?').run(existing.id);
        updated++;
      }
    }

    return { added, updated };
  });

  ipcMain.handle(IPC.RADAR_FETCH_INST, async (_e, dateYMD: string) => {
    // dateYMD: YYYY-MM-DD — auto-retries up to 5 previous days (weekends / holidays)
    const result: Record<string, InstData> = {};

    function parseNum(s: string): number {
      const n = parseFloat((s ?? '0').toString().replace(/,/g, ''));
      return isNaN(n) ? 0 : n;
    }

    function prevDay(ymd: string, n: number): string {
      const d = new Date(ymd);
      d.setDate(d.getDate() - n);
      return d.toISOString().slice(0, 10);
    }

    // ── TWSE T86: try up to 5 days back until data found ──
    let twseDate = dateYMD;
    for (let attempt = 0; attempt <= 5; attempt++) {
      const tryDate = prevDay(dateYMD, attempt);
      try {
        const url = `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${tryDate.replace(/-/g, '')}&selectType=ALL`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockTracker/1.0)' },
          signal: AbortSignal.timeout(15000),
        });
        const json = await resp.json() as { stat: string; data?: string[][] };
        if (json.stat === 'OK' && Array.isArray(json.data) && json.data.length > 0) {
          twseDate = tryDate;
          for (const row of json.data) {
            const code = (row[0] ?? '').trim();
            if (!code) continue;
            // TWSE T86 欄位（0-indexed，單位：股）。TWSE 在 2026 改版後從 21 欄縮為 19 欄
            if (row.length >= 21) {
              // 舊版 21 欄結構（含「外資及陸資合計」分組欄位）
              // [8-10]  外資合計 ; [11-13] 投信 ; [16] 自營自行淨 ; [19] 自營避險淨 ; [20] 三大法人合計
              result[code] = {
                date: tryDate,
                foreignNet: Math.round(parseNum(row[10])),
                trustNet:   Math.round(parseNum(row[13])),
                dealerNet:  Math.round(parseNum(row[16]) + parseNum(row[19])),
                totalNet:   Math.round(parseNum(row[20])),
              };
            } else if (row.length >= 19) {
              // 新版 19 欄結構（移除了「外資及陸資合計」分組欄位）
              // [2-4]   外陸資(不含外資自營商) 買/賣/淨   → 外資淨 = row[4]
              // [5-7]   外資自營商 買/賣/淨               → 外資自營商淨 = row[7]
              // [8-10]  投信 買/賣/淨                     → trustNet = row[10]
              // [11]    自營商買賣超合計                   → dealerNet = row[11]
              // [12-14] 自營商(自行) 買/賣/淨
              // [15-17] 自營商(避險) 買/賣/淨
              // [18]    三大法人買賣超合計                 → totalNet = row[18]
              result[code] = {
                date: tryDate,
                foreignNet: Math.round(parseNum(row[4]) + parseNum(row[7])),
                trustNet:   Math.round(parseNum(row[10])),
                dealerNet:  Math.round(parseNum(row[11])),
                totalNet:   Math.round(parseNum(row[18])),
              };
            }
          }
          console.log(`[Radar] TWSE data fetched for ${tryDate} (${Object.keys(result).length} stocks)`);
          break;
        }
      } catch (e) {
        console.warn(`[Radar] TWSE attempt ${attempt} (${tryDate}) failed:`, e);
      }
    }

    // ── TPEX (上櫃): 2026 改用新 endpoint /insti/dailyTrade ──
    // 舊 endpoint /insti/dailySummary 已 404；新版回傳 24 欄、單位「股」（不再 ×1000）
    try {
      const [y, m, d] = twseDate.split('-');
      const rocDate = `${Number(y) - 1911}/${m}/${d}`;
      const url = `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&id=&response=json&date=${rocDate}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockTracker/1.0)' },
        signal: AbortSignal.timeout(15000),
      });
      interface TpexTable { data?: string[][]; fields?: string[]; }
      const json = await resp.json() as { tables?: TpexTable[]; aaData?: string[][] };

      // 新版結構（24 欄，0-indexed，單位：股）:
      // [2-4]   外資(不含外資自營商) 買/賣/淨
      // [5-7]   外資自營商 買/賣/淨
      // [8-10]  外資合計(含自營商) 買/賣/淨    ← foreignNet=row[10]
      // [11-13] 投信 買/賣/淨                  ← trustNet=row[13]
      // [14-16] 自營商(自行) 買/賣/淨
      // [17-19] 自營商(避險) 買/賣/淨
      // [20-22] 自營商合計 買/賣/淨            ← dealerNet=row[22]
      // [23]    三大法人買賣超合計             ← totalNet=row[23]
      const rows = json.tables?.[0]?.data ?? json.aaData ?? [];
      if (rows.length > 0) {
        let tpexCount = 0;
        for (const row of rows) {
          const code = (row[0] ?? '').trim();
          if (!code) continue;
          if (row.length >= 24) {
            // 新版 24 欄結構（dailyTrade endpoint）
            result[code] = {
              date: twseDate,
              foreignNet: Math.round(parseNum(row[10])),
              trustNet:   Math.round(parseNum(row[13])),
              dealerNet:  Math.round(parseNum(row[22])),
              totalNet:   Math.round(parseNum(row[23])),
            };
            tpexCount++;
          } else if (row.length >= 18) {
            // 舊版 18+ 欄結構（dailySummary endpoint，單位：張）
            result[code] = {
              date: twseDate,
              foreignNet: Math.round(parseNum(row[10]) * 1000),
              trustNet:   Math.round(parseNum(row[13]) * 1000),
              dealerNet:  Math.round(parseNum(row[16]) * 1000),
              totalNet:   Math.round(parseNum(row[17]) * 1000),
            };
            tpexCount++;
          }
        }
        console.log(`[Radar] TPEX data fetched for ${twseDate} (${tpexCount} stocks)`);
      } else {
        console.warn(`[Radar] TPEX returned empty for ${twseDate}`);
      }
    } catch (e) {
      console.warn('[Radar] TPEX fetch failed:', e);
    }

    // ── 儲存到快取表，方便下次開 app 直接顯示 ──
    const db = getDb();
    const upsert = db.prepare(`
      INSERT INTO radar_inst_cache (stock_code, date, foreign_net, trust_net, dealer_net, total_net, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(stock_code) DO UPDATE SET
        date        = excluded.date,
        foreign_net = excluded.foreign_net,
        trust_net   = excluded.trust_net,
        dealer_net  = excluded.dealer_net,
        total_net   = excluded.total_net,
        fetched_at  = excluded.fetched_at
    `);
    // 歷史表：保留每日 snapshot 供趨勢分析
    const historyUpsert = db.prepare(`
      INSERT INTO radar_inst_history (stock_code, date, foreign_net, trust_net, dealer_net, total_net)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(stock_code, date) DO UPDATE SET
        foreign_net = excluded.foreign_net,
        trust_net   = excluded.trust_net,
        dealer_net  = excluded.dealer_net,
        total_net   = excluded.total_net
    `);
    for (const [code, d] of Object.entries(result)) {
      upsert.run(code, d.date, d.foreignNet, d.trustNet, d.dealerNet, d.totalNet);
      historyUpsert.run(code, d.date, d.foreignNet, d.trustNet, d.dealerNet, d.totalNet);
    }

    // ── 順便抓融資融券（同一個 trading day）──
    try {
      const marginMap: Record<string, { mB: number; mC: number; sB: number; sC: number }> = {};

      // TWSE 信用交易彙總 — 16 欄
      const twseUrl = `https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&date=${twseDate.replace(/-/g, '')}&selectType=ALL`;
      try {
        const r = await fetch(twseUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockTracker/1.0)' },
          signal: AbortSignal.timeout(15000),
        });
        interface MarginTable { data?: string[][] }
        const j = await r.json() as { tables?: MarginTable[] };
        // 第二個 table 才是 per-stock 明細
        const rows = j.tables?.[1]?.data ?? [];
        for (const row of rows) {
          if (row.length < 13) continue;
          const code = (row[0] ?? '').trim();
          if (!code) continue;
          // [5] 融資前日餘額 [6] 融資今日餘額 [11] 融券前日餘額 [12] 融券今日餘額
          const mPrev = parseNum(row[5]);
          const mCur  = parseNum(row[6]);
          const sPrev = parseNum(row[11]);
          const sCur  = parseNum(row[12]);
          marginMap[code] = { mB: mCur, mC: mCur - mPrev, sB: sCur, sC: sCur - sPrev };
        }
      } catch (e) {
        console.warn('[Radar] TWSE margin fetch failed:', e);
      }

      // TPEX 上櫃融資融券 — 20 欄
      try {
        const [y, m, d] = twseDate.split('-');
        const rocDate = `${Number(y) - 1911}/${m}/${d}`;
        const tpexUrl = `https://www.tpex.org.tw/www/zh-tw/margin/balance?response=json&date=${rocDate}`;
        const r = await fetch(tpexUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockTracker/1.0)' },
          signal: AbortSignal.timeout(15000),
        });
        interface TpexMarginTable { data?: string[][] }
        const j = await r.json() as { tables?: TpexMarginTable[] };
        const rows = j.tables?.[0]?.data ?? [];
        for (const row of rows) {
          if (row.length < 15) continue;
          const code = (row[0] ?? '').trim();
          if (!code) continue;
          // [2] 融資前餘 [6] 融資今餘 [10] 融券前餘 [14] 融券今餘
          const mPrev = parseNum(row[2]);
          const mCur  = parseNum(row[6]);
          const sPrev = parseNum(row[10]);
          const sCur  = parseNum(row[14]);
          marginMap[code] = { mB: mCur, mC: mCur - mPrev, sB: sCur, sC: sCur - sPrev };
        }
      } catch (e) {
        console.warn('[Radar] TPEX margin fetch failed:', e);
      }

      // 寫進 cache
      const marginUpsert = db.prepare(`
        INSERT INTO radar_margin_cache (stock_code, date, margin_balance, margin_change, short_balance, short_change, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(stock_code) DO UPDATE SET
          date = excluded.date,
          margin_balance = excluded.margin_balance,
          margin_change = excluded.margin_change,
          short_balance = excluded.short_balance,
          short_change = excluded.short_change,
          fetched_at = excluded.fetched_at
      `);
      let mCount = 0;
      for (const code of Object.keys(marginMap)) {
        const m = marginMap[code];
        marginUpsert.run(code, twseDate, Math.round(m.mB), Math.round(m.mC), Math.round(m.sB), Math.round(m.sC));
        mCount++;
      }
      console.log(`[Radar] Margin data cached: ${mCount} stocks`);
    } catch (e) {
      console.warn('[Radar] margin overall fetch failed:', e);
    }

    return result; // Record<stockCode, InstData> — each entry has .date = actual trading day
  });

  // ── 讀取上次快取的法人資料（app 啟動時自動載入）──
  ipcMain.handle(IPC.RADAR_INST_CACHE, () => {
    const db = getDb();
    interface CacheRow {
      stock_code: string; date: string;
      foreign_net: number; trust_net: number; dealer_net: number; total_net: number;
    }
    const rows = db.prepare('SELECT * FROM radar_inst_cache').all() as unknown as CacheRow[];
    const out: Record<string, InstData> = {};
    for (const r of rows) {
      out[r.stock_code] = {
        date:       r.date,
        foreignNet: r.foreign_net,
        trustNet:   r.trust_net,
        dealerNet:  r.dealer_net,
        totalNet:   r.total_net,
      };
    }
    return out;
  });

  // ── 讀取融資融券快取 ──
  ipcMain.handle(IPC.RADAR_MARGIN_CACHE, () => {
    const db = getDb();
    interface MarginRow {
      stock_code: string; date: string;
      margin_balance: number; margin_change: number;
      short_balance: number; short_change: number;
    }
    const rows = db.prepare('SELECT * FROM radar_margin_cache').all() as unknown as MarginRow[];
    const out: Record<string, MarginData> = {};
    for (const r of rows) {
      out[r.stock_code] = {
        date:           r.date,
        marginBalance:  r.margin_balance,
        marginChange:   r.margin_change,
        shortBalance:   r.short_balance,
        shortChange:    r.short_change,
      };
    }
    return out;
  });

  // ── 基本面（P/E, EPS, 殖利率, 市值）─────────────────────
  // 策略：cache 7 天，超過就背景刷新；返回時不阻塞，已有 cache 先回，舊資料下次才更新
  ipcMain.handle(IPC.RADAR_FUNDAMENTAL, async () => {
    const db = getDb();
    const codes = (db.prepare('SELECT stock_code FROM radar_stocks').all() as { stock_code: string }[])
      .map(r => r.stock_code);
    if (codes.length === 0) return {};

    interface FundRow {
      stock_code: string; pe?: number; eps?: number;
      dividend_yield?: number; market_cap?: number; fetched_at: string;
    }
    const cachedRows = db.prepare('SELECT * FROM radar_fundamental_cache').all() as unknown as FundRow[];
    const cacheMap = new Map(cachedRows.map(r => [r.stock_code, r]));

    // 判斷哪些需要刷新（無快取 OR 7 天前抓的）
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const needRefresh = codes.filter(code => {
      const row = cacheMap.get(code);
      if (!row) return true;
      const age = now - new Date(row.fetched_at).getTime();
      return age > SEVEN_DAYS_MS;
    });

    // 同步刷新（並行；不阻塞太久，外面總共最多 yahoo rate-limit 可以接受）
    if (needRefresh.length > 0) {
      const yahooProvider = priceService as unknown as { provider: { fetchFundamental?: (c: string) => Promise<FundamentalData | null> } };
      const fp = yahooProvider.provider?.fetchFundamental;
      if (typeof fp === 'function') {
        const upsert = db.prepare(`
          INSERT INTO radar_fundamental_cache (stock_code, pe, eps, dividend_yield, market_cap, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(stock_code) DO UPDATE SET
            pe = excluded.pe, eps = excluded.eps,
            dividend_yield = excluded.dividend_yield,
            market_cap = excluded.market_cap,
            fetched_at = excluded.fetched_at
        `);
        await Promise.allSettled(needRefresh.map(async code => {
          const fund = await fp(code);
          if (fund) {
            upsert.run(code, fund.pe ?? null, fund.eps ?? null,
                       fund.dividendYield ?? null, fund.marketCap ?? null, fund.fetchedAt);
          }
        }));
      }
    }

    // 重新讀（含剛才刷新的）
    const freshRows = db.prepare('SELECT * FROM radar_fundamental_cache').all() as unknown as FundRow[];
    const out: Record<string, FundamentalData> = {};
    for (const r of freshRows) {
      out[r.stock_code] = {
        stockCode:     r.stock_code,
        pe:            r.pe ?? undefined,
        eps:           r.eps ?? undefined,
        dividendYield: r.dividend_yield ?? undefined,
        marketCap:     r.market_cap ?? undefined,
        fetchedAt:     r.fetched_at,
      };
    }
    return out;
  });

  // ── AI 過往建議：寫入 + 查詢最近 N 天 ──
  ipcMain.handle(IPC.AI_REC_SAVE, (_e, recs: Array<{
    stockCode: string; mode: string; provider: string;
    buyAt?: number; stopLoss?: number; targetShares?: number;
    confidence?: number; note?: string; priceAtRec?: number;
  }>) => {
    if (!Array.isArray(recs) || recs.length === 0) return { saved: 0 };
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO ai_recommendations
        (stock_code, mode, provider, buy_at, stop_loss, target_shares, confidence, note, price_at_rec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN');
    try {
      for (const r of recs) {
        insert.run(
          r.stockCode, r.mode, r.provider,
          r.buyAt ?? null, r.stopLoss ?? null, r.targetShares ?? null,
          r.confidence ?? null, r.note ?? null, r.priceAtRec ?? null,
        );
      }
      db.exec('COMMIT');
      return { saved: recs.length };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  ipcMain.handle(IPC.AI_REC_RECENT, (_e, days: number = 7) => {
    const db = getDb();
    interface Row {
      stock_code: string; mode: string; provider: string;
      buy_at: number | null; stop_loss: number | null; target_shares: number | null;
      confidence: number | null; note: string | null;
      price_at_rec: number | null; recommended_at: string;
    }
    // SQLite datetime 比較字串 ISO 即可
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT * FROM ai_recommendations
      WHERE recommended_at >= ?
      ORDER BY recommended_at DESC
      LIMIT 30
    `).all(since) as unknown as Row[];
    return rows.map(r => ({
      stockCode:     r.stock_code,
      mode:          r.mode,
      provider:      r.provider,
      buyAt:         r.buy_at ?? undefined,
      stopLoss:      r.stop_loss ?? undefined,
      targetShares:  r.target_shares ?? undefined,
      confidence:    r.confidence ?? undefined,
      note:          r.note ?? undefined,
      priceAtRec:    r.price_at_rec ?? undefined,
      recommendedAt: r.recommended_at,
    }));
  });

  // ── 歷史回測：法人訊號的真實勝率 ──
  // 規則：「外資連買 3 日」為綠燈觸發 → 找出過去 90 天每次觸發後 5/10 日股價漲跌
  // Cache 24 小時，避免每次都重抓 yahoo 歷史
  ipcMain.handle(IPC.RADAR_BACKTEST, async () => {
    const db = getDb();
    const codes = (db.prepare('SELECT stock_code FROM radar_stocks').all() as { stock_code: string }[])
      .map(r => r.stock_code);
    if (codes.length === 0) return {};

    interface BTRow {
      stock_code: string;
      green_signal_count: number;
      green_win_rate_5d?: number;  green_avg_return_5d?: number;
      green_win_rate_10d?: number; green_avg_return_10d?: number;
      fetched_at: string;
    }
    const cachedRows = db.prepare('SELECT * FROM radar_backtest_cache').all() as unknown as BTRow[];
    const cacheMap = new Map(cachedRows.map(r => [r.stock_code, r]));

    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const needRefresh = codes.filter(code => {
      const row = cacheMap.get(code);
      if (!row) return true;
      return now - new Date(row.fetched_at).getTime() > ONE_DAY_MS;
    });

    if (needRefresh.length > 0) {
      // 預讀全部相關歷史的價格（一支股一次 yahoo 呼叫）
      const to = new Date();
      const from = new Date(to.getTime() - 120 * ONE_DAY_MS);   // 多 30 天 buffer
      const upsert = db.prepare(`
        INSERT INTO radar_backtest_cache (
          stock_code, green_signal_count,
          green_win_rate_5d, green_avg_return_5d,
          green_win_rate_10d, green_avg_return_10d, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stock_code) DO UPDATE SET
          green_signal_count = excluded.green_signal_count,
          green_win_rate_5d = excluded.green_win_rate_5d,
          green_avg_return_5d = excluded.green_avg_return_5d,
          green_win_rate_10d = excluded.green_win_rate_10d,
          green_avg_return_10d = excluded.green_avg_return_10d,
          fetched_at = excluded.fetched_at
      `);

      const instHistoryStmt = db.prepare(`
        SELECT date, foreign_net FROM radar_inst_history
        WHERE stock_code = ? ORDER BY date ASC
      `);

      await Promise.allSettled(needRefresh.map(async code => {
        try {
          interface InstRow { date: string; foreign_net: number }
          const instRows = instHistoryStmt.all(code) as unknown as InstRow[];
          if (instRows.length < 3) {
            // 沒有夠多的歷史資料；寫個空快取避免反覆嘗試
            upsert.run(code, 0, null, null, null, null, new Date().toISOString());
            return;
          }

          // 找觸發點：外資連續 3 日都 > 0
          const triggers: string[] = [];
          for (let i = 2; i < instRows.length; i++) {
            if (instRows[i].foreign_net > 0
              && instRows[i-1].foreign_net > 0
              && instRows[i-2].foreign_net > 0) {
              triggers.push(instRows[i].date);
            }
          }

          if (triggers.length === 0) {
            upsert.run(code, 0, null, null, null, null, new Date().toISOString());
            return;
          }

          // 抓股價歷史
          const priceHist = await priceService.getHistory(code, from, to);
          if (priceHist.length === 0) {
            upsert.run(code, triggers.length, null, null, null, null, new Date().toISOString());
            return;
          }
          const dates = priceHist.map(p => p.date);
          const idxMap = new Map(dates.map((d, i) => [d, i]));

          const returns5d: number[] = [];
          const returns10d: number[] = [];
          for (const trigDate of triggers) {
            const idx = idxMap.get(trigDate);
            if (idx === undefined) continue;
            const priceAt = priceHist[idx].close;
            if (priceAt <= 0) continue;

            const i5 = idx + 5;
            if (i5 < priceHist.length) {
              returns5d.push((priceHist[i5].close - priceAt) / priceAt * 100);
            }
            const i10 = idx + 10;
            if (i10 < priceHist.length) {
              returns10d.push((priceHist[i10].close - priceAt) / priceAt * 100);
            }
          }

          const calc = (arr: number[]) => {
            if (arr.length === 0) return { wr: null, avg: null };
            const wins = arr.filter(r => r > 0).length;
            const avg  = arr.reduce((s, v) => s + v, 0) / arr.length;
            return { wr: (wins / arr.length) * 100, avg };
          };
          const r5  = calc(returns5d);
          const r10 = calc(returns10d);

          upsert.run(code, triggers.length, r5.wr, r5.avg, r10.wr, r10.avg, new Date().toISOString());
        } catch (e) {
          console.warn(`[Radar] backtest ${code} failed:`, e);
        }
      }));
    }

    // 重新讀（含剛刷新的）
    const freshRows = db.prepare('SELECT * FROM radar_backtest_cache').all() as unknown as BTRow[];
    const out: Record<string, BacktestResult> = {};
    for (const r of freshRows) {
      out[r.stock_code] = {
        stockCode:        r.stock_code,
        greenSignalCount: r.green_signal_count,
        greenWinRate5d:   r.green_win_rate_5d ?? undefined,
        greenAvgReturn5d: r.green_avg_return_5d ?? undefined,
        greenWinRate10d:  r.green_win_rate_10d ?? undefined,
        greenAvgReturn10d:r.green_avg_return_10d ?? undefined,
        fetchedAt:        r.fetched_at,
      };
    }
    return out;
  });

  // ── 多日法人趨勢：連續買賣 streak + 5/10 日累積 ──
  ipcMain.handle(IPC.RADAR_INST_TRENDS, () => {
    const db = getDb();
    const codes = (db.prepare('SELECT stock_code FROM radar_stocks').all() as { stock_code: string }[])
      .map(r => r.stock_code);
    if (codes.length === 0) return {};

    const historyStmt = db.prepare(`
      SELECT date, foreign_net, trust_net, total_net
      FROM radar_inst_history
      WHERE stock_code = ?
      ORDER BY date DESC
      LIMIT 20
    `);

    // streak: 從最近日期往回算連續同方向的天數；+ 表連續買、- 表連續賣
    function streak(values: number[]): number {
      if (values.length === 0 || values[0] === 0) return 0;
      const dir = values[0] > 0 ? 1 : -1;
      let n = 0;
      for (const v of values) {
        if ((dir > 0 && v > 0) || (dir < 0 && v < 0)) n++;
        else break;
      }
      return dir * n;
    }

    const out: Record<string, InstTrend> = {};
    for (const code of codes) {
      interface H { date: string; foreign_net: number; trust_net: number; total_net: number; }
      const rows = historyStmt.all(code) as unknown as H[];
      if (rows.length === 0) continue;
      const last5  = rows.slice(0, 5);
      const last10 = rows.slice(0, 10);
      out[code] = {
        stockCode: code,
        foreignStreak: streak(rows.map(r => r.foreign_net)),
        trustStreak:   streak(rows.map(r => r.trust_net)),
        totalStreak:   streak(rows.map(r => r.total_net)),
        foreign5d: last5.reduce((s, r) => s + r.foreign_net, 0),
        total5d:   last5.reduce((s, r) => s + r.total_net,   0),
        total10d:  last10.reduce((s, r) => s + r.total_net,  0),
        daysAvailable: rows.length,
      };
    }
    return out;
  });

  // ── 技術線型：批次抓 90 天歷史價，算 MA5/MA20/MA60 ──
  ipcMain.handle(IPC.RADAR_TECH, async () => {
    const db = getDb();
    const codes = (db.prepare('SELECT stock_code FROM radar_stocks').all() as { stock_code: string }[])
      .map(r => r.stock_code);
    if (codes.length === 0) return {};

    const to   = new Date();
    const from = new Date(to.getTime() - 90 * 86400_000);

    // ── 純函式：技術指標 ──
    const ma = (arr: number[], n: number): number => {
      if (arr.length < n) return 0;
      const slice = arr.slice(-n);
      return slice.reduce((s, v) => s + v, 0) / n;
    };

    // EMA(period)
    const ema = (arr: number[], n: number): number[] => {
      if (arr.length < n) return [];
      const k = 2 / (n + 1);
      const out: number[] = [];
      // 初始用 SMA
      const initSma = arr.slice(0, n).reduce((s, v) => s + v, 0) / n;
      out.push(initSma);
      for (let i = n; i < arr.length; i++) {
        out.push(arr[i] * k + out[out.length - 1] * (1 - k));
      }
      return out;
    };

    // RSI(14) - Wilder's smoothing
    const rsi = (closes: number[], period = 14): number => {
      if (closes.length < period + 1) return 0;
      const gains: number[] = [];
      const losses: number[] = [];
      for (let i = 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        gains.push(diff > 0 ? diff : 0);
        losses.push(diff < 0 ? -diff : 0);
      }
      let avgGain = gains.slice(0, period).reduce((s, v) => s + v, 0) / period;
      let avgLoss = losses.slice(0, period).reduce((s, v) => s + v, 0) / period;
      for (let i = period; i < gains.length; i++) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
      }
      if (avgLoss === 0) return 100;
      const rs = avgGain / avgLoss;
      return 100 - (100 / (1 + rs));
    };

    // KD (Stochastic, 9-day, smooth 3)
    const kd = (highs: number[], lows: number[], closes: number[]): { k: number; d: number } => {
      const period = 9;
      if (closes.length < period) return { k: 50, d: 50 };
      const rsv: number[] = [];
      for (let i = period - 1; i < closes.length; i++) {
        const h = Math.max(...highs.slice(i - period + 1, i + 1));
        const l = Math.min(...lows.slice(i - period + 1, i + 1));
        rsv.push(h === l ? 50 : ((closes[i] - l) / (h - l)) * 100);
      }
      // K = 1/3 RSV + 2/3 上一K，D = 1/3 K + 2/3 上一D（初始 50）
      let k = 50, d = 50;
      for (const v of rsv) {
        k = (v + 2 * k) / 3;
        d = (k + 2 * d) / 3;
      }
      return { k, d };
    };

    // ATR(14) - Wilder's smoothing
    // TR = max(H-L, |H-prevC|, |L-prevC|)，ATR = Wilder 平均 TR
    const atr = (highs: number[], lows: number[], closes: number[], period = 14): number => {
      if (closes.length < period + 1) return 0;
      const trs: number[] = [];
      for (let i = 1; i < closes.length; i++) {
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i - 1]);
        const lc = Math.abs(lows[i] - closes[i - 1]);
        trs.push(Math.max(hl, hc, lc));
      }
      // 初始 ATR 用 SMA
      let atrVal = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
      // 之後用 Wilder 平滑
      for (let i = period; i < trs.length; i++) {
        atrVal = (atrVal * (period - 1) + trs[i]) / period;
      }
      return atrVal;
    };

    // MACD (12, 26, 9)
    const macd = (closes: number[]): { line: number; signal: number; hist: number } => {
      if (closes.length < 35) return { line: 0, signal: 0, hist: 0 };
      const ema12 = ema(closes, 12);
      const ema26 = ema(closes, 26);
      // 對齊長度（ema12 比 ema26 多 14 個）
      const offset = ema12.length - ema26.length;
      const macdLine: number[] = [];
      for (let i = 0; i < ema26.length; i++) {
        macdLine.push(ema12[i + offset] - ema26[i]);
      }
      const sigArr = ema(macdLine, 9);
      const lastSig = sigArr[sigArr.length - 1] ?? 0;
      const lastLine = macdLine[macdLine.length - 1] ?? 0;
      return { line: lastLine, signal: lastSig, hist: lastLine - lastSig };
    };

    const out: Record<string, TechData> = {};
    await Promise.all(codes.map(async code => {
      try {
        const history = await priceService.getHistory(code, from, to);
        if (history.length === 0) return;
        const validPoints = history.filter(p => p.close > 0);
        if (validPoints.length === 0) return;
        const closes = validPoints.map(p => p.close);
        const highs  = validPoints.map(p => p.high ?? p.close);
        const lows   = validPoints.map(p => p.low  ?? p.close);
        const volumes = validPoints.map(p => p.volume).filter(v => v > 0);

        const kdResult = kd(highs, lows, closes);
        const macdResult = macd(closes);
        const atr14 = atr(highs, lows, closes, 14);
        // 20 日平均成交量（給動態閾值用）
        const recentVols = volumes.slice(-20);
        const avgVolume = recentVols.length > 0
          ? recentVols.reduce((s, v) => s + v, 0) / recentVols.length
          : undefined;
        // 動能：20 日漲跌幅、距 60 日高點
        const lastClose = closes[closes.length - 1];
        const close20dAgo = closes.length >= 21 ? closes[closes.length - 21] : undefined;
        const return20d = (close20dAgo && close20dAgo > 0)
          ? ((lastClose - close20dAgo) / close20dAgo) * 100
          : undefined;
        const last60Highs = highs.slice(-60);
        const high60d = last60Highs.length > 0 ? Math.max(...last60Highs) : undefined;
        const distFromHigh60d = (high60d && high60d > 0)
          ? ((lastClose - high60d) / high60d) * 100  // 負值表示在高點下方
          : undefined;

        out[code] = {
          stockCode: code,
          lastClose,
          ma5:  ma(closes, 5),
          ma20: ma(closes, 20),
          ma60: ma(closes, 60),
          rsi14:      rsi(closes, 14),
          kdK:        kdResult.k,
          kdD:        kdResult.d,
          macd:       macdResult.line,
          macdSignal: macdResult.signal,
          macdHist:   macdResult.hist,
          avgVolume,
          atr14:      atr14 > 0 ? atr14 : undefined,
          return20d,
          distFromHigh60d,
        };
      } catch { /* skip silently — yahoo may rate-limit */ }
    }));
    return out;
  });

  ipcMain.handle(IPC.DIVIDEND_IMPORT, (_e, items: DividendSyncItem[]) => {
    const db = getDb();
    db.exec('BEGIN');
    try {
      for (const item of items) {
        insertTransaction({
          stockCode: item.stockCode,
          type: 'DIVIDEND',
          date: item.date,
          shares: item.sharesHeld,
          pricePerShare: item.perShare,
          brokerageFee: 0,
          transactionTax: 0,
          netAmount: item.total,
          notes: `自動同步`,
        });
      }
      db.exec('COMMIT');
      return { imported: items.length };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });
}
