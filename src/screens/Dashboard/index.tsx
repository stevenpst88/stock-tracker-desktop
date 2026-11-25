import { usePortfolio } from '../../hooks/usePortfolio';
import CurrencyDisplay, { formatTWD } from '../../components/CurrencyDisplay';
import { Link } from 'react-router-dom';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';

const COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#ec4899'];

export default function Dashboard() {
  const { data, loading, error, forceRefresh } = usePortfolio();

  if (loading) return <PageShell><div className="text-slate-400 text-sm">載入中...</div></PageShell>;
  if (error)   return <PageShell><div className="text-red-400 text-sm">{error}</div></PageShell>;
  if (!data)   return null;

  const pnlPct = data.totalUnrealizedPnlPct;
  const updatedTime = data.pricesLastUpdated
    ? new Date(data.pricesLastUpdated).toLocaleTimeString('zh-TW')
    : '—';

  const totalValue = data.totalValue || 1;
  const pieData = data.holdings.map(h => ({
    code: h.stockCode,
    name: h.stockName,
    label: h.stockCode,          // 圖例只顯示代碼
    value: h.currentValue,
    pct: (h.currentValue / totalValue * 100).toFixed(1),
  }));

  return (
    <PageShell>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-slate-100">資產總覽</h1>
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

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <SummaryCard label="投入成本" value={data.totalCost} suffix=" TWD" />
        <SummaryCard label="總市值" value={data.totalValue} suffix=" TWD" />
        <SummaryCard
          label="未實現損益"
          value={data.totalUnrealizedPnl}
          showSign
          colorize
          suffix={` (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`}
        />
        <SummaryCard label="已實現損益" value={data.totalRealizedPnl} showSign colorize />
        <SummaryCard label="今日漲跌" value={data.dayChange} showSign colorize />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Mini Holdings */}
        <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
            <span className="text-sm font-medium text-slate-300">持倉概況</span>
            <Link to="/holdings" className="text-xs text-blue-400 hover:text-blue-300">查看全部 →</Link>
          </div>
          {data.holdings.length === 0 ? (
            <div className="px-4 py-8 text-center text-slate-500 text-sm">尚無持倉紀錄</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 border-b border-slate-800">
                  <th className="px-4 py-2 text-left">股票</th>
                  <th className="px-4 py-2 text-right">現值</th>
                  <th className="px-4 py-2 text-right">損益%</th>
                </tr>
              </thead>
              <tbody>
                {data.holdings.slice(0, 6).map(h => (
                  <tr key={h.stockCode} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-100">{h.stockCode}</div>
                      <div className="text-xs text-slate-500">{h.stockName}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right text-slate-200">{formatTWD(h.currentValue)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <CurrencyDisplay value={h.unrealizedPnlPct} showSign colorize decimals={2} />
                      <span className="text-slate-500">%</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Allocation Pie */}
        <div className="bg-slate-900 rounded-xl border border-slate-800 p-4">
          <div className="text-sm font-medium text-slate-300 mb-2">資產配置</div>
          {pieData.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-slate-500 text-sm">尚無資料</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="label"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                          <div style={{ color: '#e2e8f0', fontWeight: 600 }}>{d.code} {d.name}</div>
                          <div style={{ color: '#94a3b8', marginTop: 2 }}>
                            ${formatTWD(d.value)} <span style={{ color: '#60a5fa' }}>({d.pct}%)</span>
                          </div>
                        </div>
                      );
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              {/* 自訂圖例：代碼 + 名稱，兩欄排列 */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-1">
                {pieData.map((d, i) => (
                  <div key={d.code} className="flex items-center gap-1.5 min-w-0">
                    <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                    <span className="text-xs text-slate-400 truncate">{d.code}</span>
                    <span className="text-xs text-slate-600 truncate">{d.name}</span>
                    <span className="text-xs text-slate-500 ml-auto shrink-0">{d.pct}%</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return <div className="p-6">{children}</div>;
}

function SummaryCard({ label, value, suffix = '', showSign = false, colorize = false }: {
  label: string; value: number; suffix?: string; showSign?: boolean; colorize?: boolean;
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-4">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className="text-lg font-bold">
        <CurrencyDisplay value={value} showSign={showSign} colorize={colorize} />
        {suffix && <span className="text-xs text-slate-500 ml-1">{suffix.trim()}</span>}
      </div>
    </div>
  );
}
