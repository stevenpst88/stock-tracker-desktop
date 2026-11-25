import { getDb, getSetting } from '../database/index';
import { getLotsForStock, getRealizedPnl } from './fifo';
import { getTotalDividend } from '../database/repositories/transactionRepository';
import type { PriceService } from './priceService';
import type { HoldingSummary, PortfolioSummary } from '../../shared/types';

interface StockRow { code: string; name: string; market: string; }
interface LotAgg { stock_code: string; total_shares: number; }

/** 扣除預估賣出費用後的淨現值（與券商 App 的「預估損益」計算方式一致） */
function calcNetValue(grossValue: number, brokerageRate: number, taxRate = 0.003): number {
  const fee = Math.floor(grossValue * brokerageRate);
  const tax = Math.floor(grossValue * taxRate);
  return grossValue - fee - tax;
}

export async function buildPortfolioSummary(priceService: PriceService): Promise<PortfolioSummary> {
  const db = getDb();
  const brokerageRate = Number(getSetting('brokerage_fee_rate') ?? '0.001425');

  const activeLots = db.prepare(`
    SELECT stock_code, SUM(remaining_shares) as total_shares
    FROM fifo_lots WHERE remaining_shares > 0
    GROUP BY stock_code
  `).all() as unknown as LotAgg[];

  if (activeLots.length === 0) {
    const totalRealizedPnl = getRealizedPnl().reduce((s, r) => s + r.netProfit, 0);
    return {
      totalCost: 0, totalValue: 0, totalUnrealizedPnl: 0, totalUnrealizedPnlPct: 0,
      totalRealizedPnl, totalDividendIncome: getTotalDividend(),
      dayChange: 0, holdings: [], pricesLastUpdated: new Date().toISOString(),
    };
  }

  const codes = activeLots.map(l => l.stock_code);
  const priceMap = await priceService.getPrices(codes);

  const stockRows = db.prepare(
    `SELECT code, name, market FROM stocks WHERE code IN (${codes.map(() => '?').join(',')})`
  ).all(...codes) as unknown as StockRow[];
  const stockMap = new Map(stockRows.map(s => [s.code, s]));

  const holdings: HoldingSummary[] = [];
  let totalCost = 0;
  let totalValue = 0;
  let totalDayChange = 0;

  for (const agg of activeLots) {
    const lots = getLotsForStock(agg.stock_code);
    const activeLot = lots.filter(l => l.remainingShares > 0);
    const totalShares = activeLot.reduce((s, l) => s + l.remainingShares, 0);
    const weightedCost = activeLot.reduce((s, l) => s + l.remainingShares * l.costPerShare, 0);
    const avgCostPerShare = totalShares > 0 ? weightedCost / totalShares : 0;

    const stock = stockMap.get(agg.stock_code);
    const quote = priceMap.get(agg.stock_code);
    // price=0 代表抓取失敗（非交易時段或 API 問題），改用成本價避免顯示 -100%
    const currentPrice = (quote && quote.price > 0) ? quote.price : avgCostPerShare;
    const currentValueGross = totalShares * currentPrice;
    // 淨現值 = 扣除預估賣出手續費＋證交稅（與券商 App「預估損益」一致）
    // ETF 證交稅 0.1%；一般股票 0.3%
    const taxRate = stock?.market === 'ETF' ? 0.001 : 0.003;
    const currentValue = calcNetValue(currentValueGross, brokerageRate, taxRate);
    const unrealizedPnl = currentValue - weightedCost;
    const unrealizedPnlPct = weightedCost > 0 ? (unrealizedPnl / weightedCost) * 100 : 0;
    const dayChange = totalShares * (quote?.changeAbs ?? 0);

    totalCost += weightedCost;
    totalValue += currentValue;
    totalDayChange += dayChange;
    holdings.push({
      stockCode: agg.stock_code,
      stockName: stock?.name ?? agg.stock_code,
      market: (stock?.market ?? 'TWSE') as HoldingSummary['market'],
      totalShares,
      avgCostPerShare,
      totalCost: weightedCost,
      currentPrice,
      currentValue,
      unrealizedPnl,
      unrealizedPnlPct,
      dayChange,
      dayChangePct: quote?.changePct ?? 0,
      lots: activeLot,
    });
  }

  holdings.sort((a, b) => b.currentValue - a.currentValue);

  const totalUnrealizedPnl = totalValue - totalCost;
  const totalUnrealizedPnlPct = totalCost > 0 ? (totalUnrealizedPnl / totalCost) * 100 : 0;
  const totalRealizedPnl = getRealizedPnl().reduce((s, r) => s + r.netProfit, 0);

  const lastUpdatedArr = [...priceMap.values()].map(q => q.fetchedAt).sort().reverse();

  return {
    totalCost,
    totalValue,
    totalUnrealizedPnl,
    totalUnrealizedPnlPct,
    totalRealizedPnl,
    totalDividendIncome: getTotalDividend(),
    dayChange: totalDayChange,
    holdings,
    pricesLastUpdated: lastUpdatedArr[0] ?? new Date().toISOString(),
  };
}
