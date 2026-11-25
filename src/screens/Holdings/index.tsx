import { useState } from 'react';
import { usePortfolio } from '../../hooks/usePortfolio';
import CurrencyDisplay, { formatTWD } from '../../components/CurrencyDisplay';
import type { HoldingSummary } from '../../../shared/types';
import clsx from 'clsx';

type SortField = 'stockCode' | 'totalShares' | 'avgCostPerShare' | 'currentPrice' | 'totalCost' | 'currentValue' | 'unrealizedPnl' | 'unrealizedPnlPct' | 'dayChangePct';

export default function Holdings() {
  const { data, loading, error, forceRefresh } = usePortfolio();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>('currentValue');
  const [sortAsc, setSortAsc] = useState(false);

  if (loading) return <Shell><p className="text-slate-400 text-sm">載入中...</p></Shell>;
  if (error)   return <Shell><p className="text-red-400 text-sm">{error}</p></Shell>;

  const rawHoldings = data?.holdings ?? [];

  function toggleSort(field: SortField) {
    if (sortField === field) setSortAsc(v => !v);
    else { setSortField(field); setSortAsc(false); }
  }

  const holdings = [...rawHoldings].sort((a, b) => {
    const av = a[sortField], bv = b[sortField];
    const cmp = typeof av === 'string'
      ? (av as string).localeCompare(bv as string)
      : (av as number) - (bv as number);
    return sortAsc ? cmp : -cmp;
  });
  const updatedTime = data?.pricesLastUpdated
    ? new Date(data.pricesLastUpdated).toLocaleTimeString('zh-TW')
    : '—';

  return (
    <Shell>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-slate-100">持倉明細</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">股價更新：{updatedTime}</span>
          <button
            onClick={forceRefresh}
            className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
          >
            重新整理
          </button>
        </div>
      </div>

      {holdings.length === 0 ? (
        <div className="text-center py-16 text-slate-500">
          <div className="text-4xl mb-3">◈</div>
          <p className="text-sm">目前無持倉，請先新增交易紀錄</p>
        </div>
      ) : (
        <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 border-b border-slate-800 bg-slate-900/80">
                {([
                  ['股票',     'stockCode',       'left'],
                  ['持股數',   'totalShares',     'right'],
                  ['均成本',   'avgCostPerShare',  'right'],
                  ['現價',     'currentPrice',    'right'],
                  ['總成本',   'totalCost',       'right'],
                  ['現值',     'currentValue',    'right'],
                  ['未實現損益','unrealizedPnl',  'right'],
                  ['損益%',    'unrealizedPnlPct','right'],
                  ['今日漲跌', 'dayChangePct',    'right'],
                ] as [string, SortField, string][]).map(([label, field, align]) => (
                  <th
                    key={field}
                    className={clsx('px-4 py-3 cursor-pointer select-none hover:text-slate-300 transition-colors',
                      align === 'left' ? 'text-left' : 'text-right',
                      sortField === field && 'text-slate-200'
                    )}
                    onClick={() => toggleSort(field)}
                  >
                    {label}
                    {sortField === field && (
                      <span className="ml-0.5">{sortAsc ? '↑' : '↓'}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {holdings.map(h => (
                <HoldingRow
                  key={h.stockCode}
                  h={h}
                  expanded={expanded === h.stockCode}
                  onToggle={() => setExpanded(expanded === h.stockCode ? null : h.stockCode)}
                />
              ))}
            </tbody>
          </table>

          {/* Footer totals */}
          <div className="grid grid-cols-4 gap-4 px-4 py-3 border-t border-slate-800 bg-slate-800/30 text-sm">
            <div>
              <span className="text-slate-500 text-xs">總成本</span>
              <div className="font-medium">{formatTWD(data?.totalCost ?? 0)}</div>
            </div>
            <div>
              <span className="text-slate-500 text-xs">總市值</span>
              <div className="font-medium">{formatTWD(data?.totalValue ?? 0)}</div>
            </div>
            <div>
              <span className="text-slate-500 text-xs">未實現損益</span>
              <div className="font-medium">
                <CurrencyDisplay value={data?.totalUnrealizedPnl ?? 0} showSign colorize />
              </div>
            </div>
            <div>
              <span className="text-slate-500 text-xs">損益%</span>
              <div className="font-medium">
                <CurrencyDisplay value={data?.totalUnrealizedPnlPct ?? 0} showSign colorize decimals={2} />
                <span className="text-slate-500 text-xs ml-0.5">%</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}

function HoldingRow({ h, expanded, onToggle }: { h: HoldingSummary; expanded: boolean; onToggle: () => void }) {
  const marketBadge: Record<string, string> = {
    TWSE: 'bg-blue-900/50 text-blue-300',
    OTC:  'bg-green-900/50 text-green-300',
    ETF:  'bg-amber-900/50 text-amber-300',
  };

  return (
    <>
      <tr
        className="border-b border-slate-800/50 hover:bg-slate-800/30 cursor-pointer transition-colors"
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xs">{expanded ? '▼' : '▶'}</span>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-slate-100">{h.stockCode}</span>
                <span className={clsx('text-xs px-1.5 py-0.5 rounded font-medium', marketBadge[h.market] ?? 'bg-slate-700 text-slate-300')}>
                  {h.market}
                </span>
              </div>
              <div className="text-xs text-slate-500">{h.stockName}</div>
            </div>
          </div>
        </td>
        <td className="px-4 py-3 text-right text-slate-200">{h.totalShares.toLocaleString()}</td>
        <td className="px-4 py-3 text-right text-slate-300">{formatTWD(h.avgCostPerShare, 2)}</td>
        <td className="px-4 py-3 text-right text-slate-100 font-medium">{formatTWD(h.currentPrice, 2)}</td>
        <td className="px-4 py-3 text-right text-slate-300">{formatTWD(h.totalCost)}</td>
        <td className="px-4 py-3 text-right text-slate-100">{formatTWD(h.currentValue)}</td>
        <td className="px-4 py-3 text-right">
          <CurrencyDisplay value={h.unrealizedPnl} showSign colorize />
        </td>
        <td className="px-4 py-3 text-right">
          <CurrencyDisplay value={h.unrealizedPnlPct} showSign colorize decimals={2} />
          <span className="text-slate-500 text-xs">%</span>
        </td>
        <td className="px-4 py-3 text-right">
          <CurrencyDisplay value={h.dayChangePct} showSign colorize decimals={2} />
          <span className="text-slate-500 text-xs">%</span>
        </td>
      </tr>

      {expanded && (
        <tr className="bg-slate-800/20 border-b border-slate-800">
          <td colSpan={9} className="px-8 py-3">
            <div className="text-xs text-slate-500 mb-2 font-medium uppercase tracking-wider">FIFO 批次明細</div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 border-b border-slate-700">
                  {['買入日期', '原始股數', '剩餘股數', '成本/股', '總成本', '未實現損益'].map(h => (
                    <th key={h} className="py-1.5 pr-4 text-right first:text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {h.lots.map(lot => {
                  const lotValue = lot.remainingShares * h.currentPrice;
                  const lotCost = lot.remainingShares * lot.costPerShare;
                  const pnl = lotValue - lotCost;
                  return (
                    <tr key={lot.id} className="border-b border-slate-700/30">
                      <td className="py-1.5 pr-4 text-slate-300">{lot.purchaseDate}</td>
                      <td className="py-1.5 pr-4 text-right text-slate-400">{lot.originalShares.toLocaleString()}</td>
                      <td className="py-1.5 pr-4 text-right text-slate-200">{lot.remainingShares.toLocaleString()}</td>
                      <td className="py-1.5 pr-4 text-right text-slate-300">{formatTWD(lot.costPerShare, 4)}</td>
                      <td className="py-1.5 pr-4 text-right text-slate-300">{formatTWD(lotCost)}</td>
                      <td className="py-1.5 pr-4 text-right">
                        <CurrencyDisplay value={pnl} showSign colorize />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="p-6">{children}</div>;
}
