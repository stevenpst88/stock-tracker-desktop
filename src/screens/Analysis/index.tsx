import { useState, useEffect } from 'react';
import clsx from 'clsx';
import { usePortfolio } from '../../hooks/usePortfolio';
import CurrencyDisplay, { formatTWD } from '../../components/CurrencyDisplay';
import {
  PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer,
  XAxis, YAxis, CartesianGrid, Area, Line,
  ComposedChart, Bar, BarChart,
} from 'recharts';
import type { YearlyPnl } from '../../../shared/types';

const COLORS_ALL = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#ec4899'];
const COLORS_ETF  = ['#10b981','#06b6d4','#34d399','#0d9488','#22d3ee','#6ee7b7','#67e8f9','#a7f3d0'];
const COLORS_STOCK= ['#3b82f6','#8b5cf6','#f59e0b','#ef4444','#f97316','#ec4899','#60a5fa','#c084fc'];

interface HistoryPoint { date: string; value: number; cost: number; dailyChange: number; }

export default function Analysis() {
  const { data, loading } = usePortfolio();
  const [yearlyPnl, setYearlyPnl] = useState<YearlyPnl[]>([]);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [historyDays, setHistoryDays] = useState(90);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [pieTab, setPieTab] = useState<'all' | 'etf' | 'stock'>('all');

  useEffect(() => {
    window.electronAPI.portfolio.yearlyPnl().then(setYearlyPnl);
  }, []);

  useEffect(() => {
    setHistoryLoading(true);
    window.electronAPI.portfolio.history(historyDays)
      .then((h: HistoryPoint[]) => setHistory(h))
      .finally(() => setHistoryLoading(false));
  }, [historyDays]);

  if (loading) return <Shell><p className="text-slate-400 text-sm">載入中...</p></Shell>;

  const allHoldings = data?.holdings ?? [];
  const etfHoldings   = allHoldings.filter(h => h.market === 'ETF');
  const stockHoldings = allHoldings.filter(h => h.market !== 'ETF');

  const totalValue = allHoldings.reduce((s, h) => s + h.currentValue, 0);
  const etfValue   = etfHoldings.reduce((s, h) => s + h.currentValue, 0);
  const stockValue = stockHoldings.reduce((s, h) => s + h.currentValue, 0);
  const etfPct     = totalValue > 0 ? (etfValue / totalValue * 100).toFixed(1) : '0';
  const stockPct   = totalValue > 0 ? (stockValue / totalValue * 100).toFixed(1) : '0';

  const makePieData = (hs: typeof allHoldings) => hs.map(h => ({
    name: h.stockCode,           // nameKey（短）
    fullName: h.stockName,
    value: h.currentValue,
    pct: totalValue > 0 ? (h.currentValue / totalValue * 100).toFixed(1) : '0',
  }));
  const pieDataAll   = makePieData(allHoldings);
  const pieDataEtf   = makePieData(etfHoldings);
  const pieDataStock = makePieData(stockHoldings);

  const activePieData = pieTab === 'etf' ? pieDataEtf : pieTab === 'stock' ? pieDataStock : pieDataAll;
  const activeColors  = pieTab === 'etf' ? COLORS_ETF : pieTab === 'stock' ? COLORS_STOCK : COLORS_ALL;

  const chartData = yearlyPnl.map(y => ({
    year: String(y.year),
    '已實現損益': Math.round(y.realizedPnl),
    '配息收入': Math.round(y.dividendIncome),
  })).reverse();

  // 日損益趨勢資料（加上單日漲跌幅%；用前一日 value 為分母）
  // 注：dailyChange 已在後端剝離當日買賣金額，純市場 P&L
  const historyChartData = history.map((h, i) => {
    const prevValue = i > 0 ? history[i - 1].value : h.value;
    const dailyChangePct = prevValue > 0 ? (h.dailyChange / prevValue) * 100 : 0;
    return {
      date: h.date.slice(5),          // 顯示 MM-DD
      fullDate: h.date,
      value: h.value,
      cost: h.cost,
      dailyChange: h.dailyChange,
      dailyChangePct,
    };
  });

  // 只標示有資料的 X 軸刻度（每 2 週一個）
  const xTicks = historyChartData
    .filter((_, i) => i % 14 === 0 || i === historyChartData.length - 1)
    .map(d => d.date);

  const totalChange = history.length > 1
    ? history[history.length - 1].value - history[0].value
    : 0;
  const isPositive = totalChange >= 0;

  // 最近一日漲跌（用來放在標題旁強調今日表現）
  const latestPoint = historyChartData.length > 0
    ? historyChartData[historyChartData.length - 1]
    : null;

  return (
    <Shell>
      <h1 className="text-xl font-bold text-slate-100 mb-6">投資組合分析</h1>

      {/* Summary row */}
      {(() => {
        const realized  = data?.totalRealizedPnl ?? 0;
        const dividends = data?.totalDividendIncome ?? 0;
        const unrealized = data?.totalUnrealizedPnl ?? 0;
        const total = realized + dividends + unrealized;
        return (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <StatCard label="已實現損益" value={realized} colorize />
            <StatCard label="配息收入" value={dividends} colorize />
            <StatCard label="未實現損益" value={unrealized} colorize />
            <StatCard label="總損益（含未實現）" value={total} colorize highlight />
          </div>
        );
      })()}

      {/* ── 日損益趨勢圖 ── */}
      <div className="bg-slate-900 rounded-xl border border-slate-800 p-4 mb-6">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="text-sm font-medium text-slate-300">資產走勢</span>
            {/* 期間總漲跌 */}
            {history.length > 1 && (
              <span className={`text-sm font-semibold ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                期間：{isPositive ? '+' : ''}{formatTWD(totalChange)}
                <span className="text-xs text-slate-500 ml-1">
                  ({((totalChange / history[0].value) * 100).toFixed(2)}%)
                </span>
              </span>
            )}
            {/* 最近一日漲跌（強調，與期間總和分開顯示） */}
            {latestPoint && latestPoint.dailyChange !== 0 && (
              <span className={clsx(
                'text-sm font-semibold px-2 py-0.5 rounded',
                latestPoint.dailyChange >= 0
                  ? 'bg-emerald-900/30 text-emerald-300'
                  : 'bg-red-900/30 text-red-300',
              )}>
                今日：{latestPoint.dailyChange >= 0 ? '+' : ''}{formatTWD(latestPoint.dailyChange)}
                <span className="text-xs ml-1 opacity-80">
                  ({latestPoint.dailyChangePct >= 0 ? '+' : ''}{latestPoint.dailyChangePct.toFixed(2)}%)
                </span>
              </span>
            )}
          </div>
          {/* 期間選擇 */}
          <div className="flex gap-1">
            {[
              { label: '1M', days: 30 },
              { label: '3M', days: 90 },
              { label: '6M', days: 180 },
              { label: '1Y', days: 365 },
            ].map(({ label, days }) => (
              <button
                key={label}
                onClick={() => setHistoryDays(days)}
                className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                  historyDays === days
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {historyLoading ? (
          <div className="h-64 flex items-center justify-center text-slate-500 text-sm">載入中...</div>
        ) : historyChartData.length === 0 ? (
          <EmptyState />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={historyChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="valueGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={isPositive ? '#10b981' : '#ef4444'} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={isPositive ? '#10b981' : '#ef4444'} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis
                dataKey="date"
                ticks={xTicks}
                tick={{ fill: '#64748b', fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis
                yAxisId="value"
                tick={{ fill: '#64748b', fontSize: 10 }}
                tickFormatter={v => `${(v / 10000).toFixed(0)}萬`}
                width={52}
              />
              <YAxis
                yAxisId="daily"
                orientation="right"
                tick={{ fill: '#64748b', fontSize: 10 }}
                tickFormatter={v => `${(v / 1000).toFixed(0)}K`}
                width={44}
              />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
                formatter={(value, name, props) => {
                  if (name === '市值' || name === '成本') return [`$${formatTWD(Number(value))}`, name];
                  // 日漲跌：同時顯示金額與百分比
                  const v = Number(value);
                  const pct = props?.payload?.dailyChangePct ?? 0;
                  return [
                    `${v >= 0 ? '+' : ''}$${formatTWD(v)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`,
                    name,
                  ];
                }}
                labelFormatter={label => {
                  const pt = historyChartData.find(d => d.date === label);
                  if (!pt) return `日期：${label}`;
                  const pnl = pt.value - pt.cost;
                  return `${pt.fullDate}　累積損益 ${pnl >= 0 ? '+' : ''}${formatTWD(pnl)}`;
                }}
              />
              <Legend formatter={v => <span style={{ color: '#94a3b8', fontSize: 11 }}>{v}</span>} />
              {/* 成本基準虛線 */}
              <Line
                yAxisId="value"
                type="monotone"
                dataKey="cost"
                name="成本"
                stroke="#64748b"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                dot={false}
                activeDot={false}
              />
              {/* 總市值面積圖 */}
              <Area
                yAxisId="value"
                type="monotone"
                dataKey="value"
                name="市值"
                stroke={isPositive ? '#10b981' : '#ef4444'}
                strokeWidth={2}
                fill="url(#valueGrad)"
                dot={false}
                activeDot={{ r: 4 }}
              />
              {/* 每日漲跌柱狀（漲綠跌紅） */}
              <Bar
                yAxisId="daily"
                dataKey="dailyChange"
                name="日漲跌"
                radius={[2, 2, 0, 0]}
                maxBarSize={6}
                label={false}
              >
                {historyChartData.map((entry, index) => (
                  <Cell
                    key={index}
                    fill={entry.dailyChange >= 0 ? '#10b981' : '#ef4444'}
                  />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Allocation Pie */}
        <div className="bg-slate-900 rounded-xl border border-slate-800 p-4">
          {/* Header row */}
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-medium text-slate-300">持倉配置</div>
            <div className="flex gap-1">
              {(['all', 'etf', 'stock'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setPieTab(t)}
                  className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
                    pieTab === t
                      ? t === 'etf'   ? 'bg-emerald-600 text-white'
                      : t === 'stock' ? 'bg-blue-600 text-white'
                      : 'bg-slate-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                >
                  {t === 'all' ? '全部' : t === 'etf' ? 'ETF' : '個股'}
                </button>
              ))}
            </div>
          </div>

          {/* ETF vs 個股 比例摘要列 */}
          {totalValue > 0 && (
            <div className="mb-3">
              <div className="flex justify-between text-xs text-slate-400 mb-1">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
                  ETF <span className="text-emerald-400 font-semibold">{etfPct}%</span>
                  <span className="text-slate-600">({formatTWD(etfValue)})</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-slate-600">({formatTWD(stockValue)})</span>
                  <span className="text-blue-400 font-semibold">{stockPct}%</span>
                  個股
                  <span className="inline-block w-2 h-2 rounded-full bg-blue-400" />
                </span>
              </div>
              {/* 比例條 */}
              <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full"
                  style={{ width: `${etfPct}%` }}
                />
              </div>
            </div>
          )}

          {activePieData.length === 0 ? (
            <EmptyState />
          ) : (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={activePieData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={52}
                    outerRadius={85}
                    paddingAngle={2}
                  >
                    {activePieData.map((_, i) => (
                      <Cell key={i} fill={activeColors[i % activeColors.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                          <div style={{ color: '#e2e8f0', fontWeight: 600 }}>{d.name} {d.fullName}</div>
                          <div style={{ color: '#94a3b8', marginTop: 2 }}>
                            ${formatTWD(d.value)} <span style={{ color: '#60a5fa' }}>({d.pct}%)</span>
                          </div>
                        </div>
                      );
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              {/* 自訂圖例：兩欄 */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-2">
                {activePieData.map((d, i) => (
                  <div key={d.name} className="flex items-center gap-1.5 min-w-0">
                    <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: activeColors[i % activeColors.length] }} />
                    <span className="text-xs text-slate-400 shrink-0">{d.name}</span>
                    <span className="text-xs text-slate-600 truncate">{d.fullName}</span>
                    <span className="text-xs text-slate-500 ml-auto shrink-0">{d.pct}%</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Yearly P&L */}
        <div className="bg-slate-900 rounded-xl border border-slate-800 p-4">
          <div className="text-sm font-medium text-slate-300 mb-3">年度損益</div>
          {chartData.length === 0 ? (
            <EmptyState />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="year" tick={{ fill: '#64748b', fontSize: 11 }} />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} tickFormatter={v => `${(v/1000).toFixed(0)}K`} />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                  formatter={(v) => [formatTWD(Number(v)), '']}
                />
                <Legend formatter={v => <span style={{ color: '#94a3b8', fontSize: 12 }}>{v}</span>} />
                <Bar dataKey="已實現損益" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={48} />
                <Bar dataKey="配息收入" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={48} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Yearly table */}
      {yearlyPnl.length > 0 && (
        <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 text-sm font-medium text-slate-300">年度損益表</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 border-b border-slate-800">
                {['年度', '已實現損益', '配息收入', '合計', '交易筆數'].map(h => (
                  <th key={h} className="px-4 py-2 text-right first:text-left">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {yearlyPnl.map(y => (
                <tr key={y.year} className="border-b border-slate-800/50 hover:bg-slate-800/20">
                  <td className="px-4 py-3 font-medium text-slate-100">{y.year}</td>
                  <td className="px-4 py-3 text-right">
                    <CurrencyDisplay value={y.realizedPnl} showSign colorize />
                  </td>
                  <td className="px-4 py-3 text-right text-emerald-400">{formatTWD(y.dividendIncome)}</td>
                  <td className="px-4 py-3 text-right font-medium">
                    <CurrencyDisplay value={y.realizedPnl + y.dividendIncome} showSign colorize />
                  </td>
                  <td className="px-4 py-3 text-right text-slate-400">{y.totalTxns}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}

function StatCard({ label, value, colorize = false, highlight = false }: {
  label: string; value: number; colorize?: boolean; highlight?: boolean;
}) {
  return (
    <div className={clsx(
      'border rounded-xl px-4 py-4',
      highlight
        ? 'bg-slate-800 border-slate-600'
        : 'bg-slate-900 border-slate-800'
    )}>
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className="text-lg font-bold">
        <CurrencyDisplay value={value} showSign colorize={colorize} />
        <span className="text-xs text-slate-500 ml-1">TWD</span>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="p-6">{children}</div>;
}

function EmptyState() {
  return <div className="h-48 flex items-center justify-center text-slate-500 text-sm">尚無資料</div>;
}
