import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  ResponsiveContainer, ComposedChart, XAxis, YAxis, Tooltip,
  CartesianGrid, Bar, Line,
} from 'recharts';
import Modal from '../../components/Modal';
import type { RadarStock, PriceHistoryPoint } from '../../../shared/types';
import { fmt, fmtPct } from './logic';

interface Props {
  stock: RadarStock;
  currentPrice?: { price: number; pct: number; changeAbs: number };
  avgCost?: number;
  buyAt?: number | null;
  stopLoss?: number | null;
  onClose: () => void;
}

type Range = 30 | 60 | 90 | 180;

// 把每日 OHLC 點補上候選的 ma5 / ma20 / ma60 / 漲跌方向
interface ChartPoint {
  date: string;       // YYYY-MM-DD
  shortDate: string;  // MM-DD（X 軸顯示用）
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isUp: boolean;
  bodyLow: number;    // min(open, close)，畫蠟燭實體用
  bodyHigh: number;   // max(open, close)
  bodyRange: [number, number];   // 給 ErrorBar 用
  wickRange: [number, number];   // 給 ErrorBar 用
  ma5?: number;
  ma20?: number;
  ma60?: number;
}

function computeMA(closes: number[], n: number): (number | undefined)[] {
  return closes.map((_, i) => {
    if (i < n - 1) return undefined;
    const slice = closes.slice(i - n + 1, i + 1);
    return slice.reduce((s, v) => s + v, 0) / n;
  });
}

export default function StockDetailModal({
  stock, currentPrice, avgCost, buyAt, stopLoss, onClose,
}: Props) {
  const [range, setRange] = useState<Range>(60);
  const [history, setHistory] = useState<PriceHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const to = new Date();
        const from = new Date(to.getTime() - range * 86400_000);
        const data = await window.electronAPI.prices.history({
          stockCode: stock.stockCode,
          from: from.toISOString().slice(0, 10),
          to:   to.toISOString().slice(0, 10),
        }) as PriceHistoryPoint[];
        if (!cancelled) setHistory(data);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [stock.stockCode, range]);

  // 把 raw history 加工成 chart-friendly 資料
  const chartData = useMemo<ChartPoint[]>(() => {
    if (history.length === 0) return [];
    const closes = history.map(p => p.close);
    const ma5  = computeMA(closes, 5);
    const ma20 = computeMA(closes, 20);
    const ma60 = computeMA(closes, 60);
    return history.map((p, i) => {
      const open  = p.open  ?? p.close;
      const high  = p.high  ?? p.close;
      const low   = p.low   ?? p.close;
      const close = p.close;
      const isUp  = close >= open;
      return {
        date: p.date,
        shortDate: p.date.slice(5),
        open, high, low, close, volume: p.volume,
        isUp,
        bodyLow: Math.min(open, close),
        bodyHigh: Math.max(open, close),
        bodyRange: [Math.min(open, close), Math.max(open, close)],
        wickRange: [low, high],
        ma5: ma5[i], ma20: ma20[i], ma60: ma60[i],
      };
    });
  }, [history]);

  // Y 軸範圍：取 90 日內最高最低 + 5% 緩衝
  const priceDomain = useMemo<[number, number]>(() => {
    if (chartData.length === 0) return [0, 1];
    const allHigh = Math.max(...chartData.map(d => d.high));
    const allLow  = Math.min(...chartData.map(d => d.low));
    const pad = (allHigh - allLow) * 0.05;
    return [Math.max(0, allLow - pad), allHigh + pad];
  }, [chartData]);

  const pctColor = currentPrice && currentPrice.pct > 0 ? 'text-emerald-400'
    : currentPrice && currentPrice.pct < 0 ? 'text-red-400'
    : 'text-slate-400';

  return (
    <Modal title={`${stock.stockCode} ${stock.stockName} — 個股 K 線`} width="max-w-5xl" onClose={onClose}>
      <div className="space-y-3">
        {/* Header: current price + targets */}
        <div className="flex items-baseline gap-4 flex-wrap px-1">
          <div>
            <span className="text-2xl font-bold text-slate-100">
              {currentPrice ? `$${fmt(currentPrice.price, 2)}` : '—'}
            </span>
            {currentPrice && (
              <span className={clsx('ml-2 text-base font-medium', pctColor)}>
                {currentPrice.pct >= 0 ? '+' : ''}{currentPrice.pct.toFixed(2)}%
                ({currentPrice.changeAbs >= 0 ? '+' : ''}{fmt(currentPrice.changeAbs, 2)})
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 flex gap-3 flex-wrap">
            {avgCost != null && <span>平均成本 <span className="text-slate-300">${fmt(avgCost, 2)}</span></span>}
            {buyAt != null    && <span>目標買入 <span className="text-emerald-400">${fmt(buyAt, 1)}</span></span>}
            {stopLoss != null && <span>停損 <span className="text-red-400">${fmt(stopLoss, 1)}</span></span>}
          </div>
          <div className="ml-auto flex items-center gap-1">
            {([30, 60, 90, 180] as Range[]).map(r => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={clsx(
                  'text-xs px-2.5 py-1 rounded transition-colors',
                  range === r
                    ? 'bg-blue-600 text-white font-medium'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                )}
              >
                {r}D
              </button>
            ))}
          </div>
        </div>

        {/* Loading / error */}
        {loading && <div className="py-12 text-center text-slate-500 text-sm">載入歷史資料中...</div>}
        {error && <div className="py-3 px-3 bg-red-900/30 border border-red-800 rounded text-red-300 text-sm">{error}</div>}

        {!loading && !error && chartData.length > 0 && (
          <>
            {/* K-line chart */}
            <div className="bg-slate-900/40 rounded-lg border border-slate-800 p-2">
              <div className="text-xs text-slate-500 px-2 pb-1 flex items-center gap-3">
                <span>日 K + 移動平均線</span>
                <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-amber-400"></span>MA5</span>
                <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-blue-400"></span>MA20</span>
                <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-purple-400"></span>MA60</span>
              </div>
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#1e293b" vertical={false} />
                  <XAxis
                    dataKey="shortDate"
                    tick={{ fontSize: 10, fill: '#64748b' }}
                    interval={Math.max(0, Math.floor(chartData.length / 12) - 1)}
                  />
                  <YAxis
                    domain={priceDomain}
                    tick={{ fontSize: 10, fill: '#64748b' }}
                    tickFormatter={v => v.toFixed(0)}
                    width={50}
                  />
                  <Tooltip content={<KlineTooltip />} />
                  {/* High-Low wick:用 Bar 模擬細長線（dataKey 為 [low, high] range）*/}
                  <Bar dataKey="wickRange" shape={<WickShape />} isAnimationActive={false} />
                  {/* Open-Close body */}
                  <Bar dataKey="bodyRange" shape={<BodyShape />} isAnimationActive={false} />
                  {/* MA lines */}
                  <Line type="monotone" dataKey="ma5"  stroke="#fbbf24" strokeWidth={1} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="ma20" stroke="#60a5fa" strokeWidth={1} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="ma60" stroke="#a78bfa" strokeWidth={1} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Volume bar chart */}
            <div className="bg-slate-900/40 rounded-lg border border-slate-800 p-2">
              <div className="text-xs text-slate-500 px-2 pb-1">成交量（股）</div>
              <ResponsiveContainer width="100%" height={120}>
                <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#1e293b" vertical={false} />
                  <XAxis
                    dataKey="shortDate"
                    tick={{ fontSize: 10, fill: '#64748b' }}
                    interval={Math.max(0, Math.floor(chartData.length / 12) - 1)}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: '#64748b' }}
                    tickFormatter={v => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(0)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toString()}
                    width={50}
                  />
                  <Tooltip
                    cursor={{ fill: '#33415555' }}
                    contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }}
                    formatter={(value) => [fmt(Number(value) || 0), '成交量']}
                  />
                  <Bar dataKey="volume" shape={<VolumeShape />} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Footer summary stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              {(() => {
                const last = chartData[chartData.length - 1];
                const first = chartData[0];
                const change = last.close - first.close;
                const changePct = (change / first.close) * 100;
                const high = Math.max(...chartData.map(d => d.high));
                const low  = Math.min(...chartData.map(d => d.low));
                const avgVol = chartData.reduce((s, d) => s + d.volume, 0) / chartData.length;
                return (
                  <>
                    <SummaryStat label={`${range}日漲跌`} value={fmtPct(changePct)} color={change >= 0 ? 'emerald' : 'red'} />
                    <SummaryStat label={`${range}日最高`} value={`$${fmt(high, 2)}`} />
                    <SummaryStat label={`${range}日最低`} value={`$${fmt(low, 2)}`} />
                    <SummaryStat label="平均成交量" value={fmt(Math.round(avgVol))} />
                  </>
                );
              })()}
            </div>
          </>
        )}

        {!loading && !error && chartData.length === 0 && (
          <div className="py-12 text-center text-slate-500 text-sm">無歷史資料</div>
        )}
      </div>
    </Modal>
  );
}

// ── 蠟燭實體（open-close）─────────────────────────────────
function BodyShape(props: { x?: number; y?: number; width?: number; height?: number; payload?: ChartPoint }) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props;
  if (!payload) return null;
  const color = payload.isUp ? '#10b981' : '#ef4444';
  // 確保即使 open == close 也至少 1px 高度
  const h = Math.max(height, 1);
  return <rect x={x} y={y} width={width} height={h} fill={color} />;
}

// ── 蠟燭蕊（high-low），畫成細直線 ───────────────────────
function WickShape(props: { x?: number; y?: number; width?: number; height?: number; payload?: ChartPoint }) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props;
  if (!payload) return null;
  const color = payload.isUp ? '#10b981' : '#ef4444';
  const cx = x + width / 2;
  return <line x1={cx} y1={y} x2={cx} y2={y + height} stroke={color} strokeWidth={1} />;
}

// ── 成交量 bar，依當日漲跌染色 ───────────────────────────
function VolumeShape(props: { x?: number; y?: number; width?: number; height?: number; payload?: ChartPoint }) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props;
  if (!payload) return null;
  const color = payload.isUp ? '#10b98180' : '#ef444480';
  return <rect x={x} y={y} width={width} height={height} fill={color} />;
}

// ── Tooltip：顯示完整 OHLC + 量 ──────────────────────────
function KlineTooltip({ active, payload }: { active?: boolean; payload?: { payload: ChartPoint }[] }) {
  if (!active || !payload || !payload[0]) return null;
  const d = payload[0].payload;
  const color = d.isUp ? 'text-emerald-400' : 'text-red-400';
  return (
    <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 6, padding: '8px 10px', fontSize: 12 }}>
      <div className="text-slate-200 font-medium mb-1">{d.date}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
        <span className="text-slate-500">開</span>
        <span className="text-slate-200 text-right tabular-nums">${fmt(d.open, 2)}</span>
        <span className="text-slate-500">高</span>
        <span className="text-emerald-400 text-right tabular-nums">${fmt(d.high, 2)}</span>
        <span className="text-slate-500">低</span>
        <span className="text-red-400 text-right tabular-nums">${fmt(d.low, 2)}</span>
        <span className="text-slate-500">收</span>
        <span className={clsx('text-right tabular-nums font-medium', color)}>${fmt(d.close, 2)}</span>
        <span className="text-slate-500 mt-1">量</span>
        <span className="text-slate-300 text-right tabular-nums mt-1">{fmt(d.volume)}</span>
      </div>
    </div>
  );
}

function SummaryStat({ label, value, color }: { label: string; value: string; color?: 'emerald' | 'red' }) {
  const colorClass = color === 'emerald' ? 'text-emerald-400'
    : color === 'red' ? 'text-red-400'
    : 'text-slate-200';
  return (
    <div className="bg-slate-800/40 border border-slate-800 rounded-lg px-3 py-2">
      <div className="text-slate-500 text-[10px]">{label}</div>
      <div className={clsx('text-sm font-bold tabular-nums', colorClass)}>{value}</div>
    </div>
  );
}
