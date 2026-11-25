import { useState, useEffect, useCallback, useMemo } from 'react';
import clsx from 'clsx';
import type { RadarStock, InstData, AddRadarInput, InstTrend, TechData, MarginData, FundamentalData, BacktestResult } from '../../../shared/types';
import {
  type Signal, type ScorePresetKey,
  getSignal, computeScore, scoreColor,
  fmt, fmtShares, fmtPct,
  SIGNAL_STYLE, SIGNAL_LABEL, CARD_BORDER, MARKET_BADGE,
  SCORE_PRESETS,
} from './logic';
import AnalysisModal from './AnalysisModal';
import StockDetailModal from './StockDetailModal';

type MarketType = 'TWSE' | 'OTC' | 'ETF';

export type PriceInfo = { price: number; pct: number; changeAbs: number };
export type HoldingInfo = { avgCost: number; totalShares: number };

type SortMode = 'default' | 'score-desc' | 'score-asc';

// ── Main screen ───────────────────────────────────────────
export default function Radar() {
  const [stocks, setStocks] = useState<RadarStock[]>([]);
  const [instMap, setInstMap] = useState<Record<string, InstData>>({});
  const [trendMap, setTrendMap] = useState<Record<string, InstTrend>>({});
  const [techMap, setTechMap] = useState<Record<string, TechData>>({});
  const [marginMap, setMarginMap] = useState<Record<string, MarginData>>({});
  const [fundMap, setFundMap] = useState<Record<string, FundamentalData>>({});
  const [backtestMap, setBacktestMap] = useState<Record<string, BacktestResult>>({});
  const [priceMap, setPriceMap] = useState<Record<string, PriceInfo>>({});
  const [holdingsMap, setHoldingsMap] = useState<Record<string, HoldingInfo>>({});  // 持倉成本 + 股數（FIFO）
  const [loading, setLoading] = useState(true);
  const [fetchingInst, setFetchingInst] = useState(false);
  const [fetchingTech, setFetchingTech] = useState(false);
  const [instDate, setInstDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<RadarStock | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [detailTarget, setDetailTarget] = useState<RadarStock | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('default');
  const [scorePreset, setScorePreset] = useState<ScorePresetKey>(() => {
    const saved = localStorage.getItem('radar-score-preset');
    return (saved && saved in SCORE_PRESETS) ? saved as ScorePresetKey : 'balanced';
  });
  const scoreWeights = SCORE_PRESETS[scorePreset].weights;

  // Load list from DB
  const loadStocks = useCallback(async () => {
    try {
      const list = await window.electronAPI.radar.list() as RadarStock[];
      setStocks(list);
      return list;
    } catch (e) {
      setError(String(e));
      return [];
    }
  }, []);

  // Fetch current prices for all radar stocks
  const fetchPrices = useCallback(async (list: RadarStock[]) => {
    if (list.length === 0) return;
    try {
      const codes = list.map(s => s.stockCode);
      const raw = await window.electronAPI.prices.getBatch(codes) as Record<string, {
        price: number; changePct: number; changeAbs: number;
      }>;
      const map: Record<string, PriceInfo> = {};
      for (const [code, q] of Object.entries(raw)) {
        map[code] = { price: q.price, pct: q.changePct, changeAbs: q.changeAbs ?? 0 };
      }
      setPriceMap(map);
    } catch { /* price fetch fail — keep old values */ }
  }, []);

  // 載入多日法人趨勢（從 DB 歷史表計算，無網路）
  // 從快取讀融資融券（不打網路）
  const loadMargin = useCallback(async () => {
    try {
      const m = await window.electronAPI.radar.marginCache() as Record<string, MarginData>;
      setMarginMap(m);
    } catch { /* ignore */ }
  }, []);

  // 讀基本面（讀快取 + 7 天舊的會自動背景刷新）
  const loadFundamental = useCallback(async () => {
    try {
      const f = await window.electronAPI.radar.fundamental() as Record<string, FundamentalData>;
      setFundMap(f);
    } catch { /* ignore */ }
  }, []);

  // 讀歷史回測（讀快取 + 24h 舊的會自動重算）
  const loadBacktest = useCallback(async () => {
    try {
      const b = await window.electronAPI.radar.backtest() as Record<string, BacktestResult>;
      setBacktestMap(b);
    } catch { /* ignore */ }
  }, []);

  const loadTrends = useCallback(async () => {
    try {
      const t = await window.electronAPI.radar.instTrends() as Record<string, InstTrend>;
      setTrendMap(t);
    } catch { /* ignore */ }
  }, []);

  // 載入持倉資訊（平均成本 + 總股數）；用於距成本 / 今日盈虧$計算
  const loadHoldings = useCallback(async () => {
    try {
      const summary = await window.electronAPI.portfolio.summary() as
        { holdings: { stockCode: string; avgCostPerShare: number; totalShares: number }[] };
      const m: Record<string, HoldingInfo> = {};
      for (const h of summary.holdings) {
        m[h.stockCode] = { avgCost: h.avgCostPerShare, totalShares: h.totalShares };
      }
      setHoldingsMap(m);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      // 自動將持倉個股（非 ETF）同步進雷達
      try { await window.electronAPI.radar.syncHoldings(); } catch { /* ignore */ }
      const list = await loadStocks();
      // 載入上次快取的法人資料（讓使用者不用每次重新抓取）
      try {
        const cached = await window.electronAPI.radar.instCache() as Record<string, InstData>;
        if (Object.keys(cached).length > 0) {
          setInstMap(cached);
          const firstEntry = Object.values(cached)[0];
          setInstDate(firstEntry?.date ?? null);
        }
      } catch { /* ignore */ }
      await loadTrends();      // 從歷史表計算趨勢（不打網路，很快）
      await loadMargin();      // 融資融券 cache
      await loadHoldings();    // 從 portfolio summary 拉持倉成本 + 股數
      // 基本面 + 歷史回測：非阻塞背景載入（會花幾秒抓 yahoo）
      loadFundamental();
      loadBacktest();
      await fetchPrices(list);
      setLoading(false);
    })();
  }, [loadStocks, fetchPrices, loadTrends, loadMargin, loadHoldings, loadFundamental, loadBacktest]);

  // ── 更新法人資料（自動往前找最近交易日；同時刷新趨勢）──
  const handleFetchInst = async () => {
    setFetchingInst(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const raw = await window.electronAPI.radar.fetchInst(today) as Record<string, InstData>;
      setInstMap(raw);
      const firstEntry = Object.values(raw)[0];
      setInstDate(firstEntry?.date ?? null);
      await loadTrends();   // 新資料寫進歷史表後重算趨勢
      await loadMargin();   // 融資融券 cache 也一起重抓
      loadBacktest();       // 背景重算回測（不阻塞）
    } catch (e) {
      setError(`法人資料更新失敗：${e}`);
    } finally {
      setFetchingInst(false);
    }
  };

  // ── 更新技術線型（批次抓 yahoo finance 90 天歷史，較慢）──
  const handleFetchTech = async () => {
    setFetchingTech(true);
    try {
      const t = await window.electronAPI.radar.tech() as Record<string, TechData>;
      setTechMap(t);
    } catch (e) {
      setError(`技術線型更新失敗：${e}`);
    } finally {
      setFetchingTech(false);
    }
  };

  // ── 刷新股價 ──
  const handleRefreshPrices = async () => {
    await fetchPrices(stocks);
  };

  // ── Toggle holding ──
  const handleToggleHolding = async (id: number) => {
    await window.electronAPI.radar.toggleHolding(id);
    setStocks(prev => prev.map(s => s.id === id ? { ...s, isHolding: !s.isHolding } : s));
  };

  // ── Delete ──
  const handleDelete = async (id: number) => {
    if (!confirm('確定要從雷達清單移除？')) return;
    await window.electronAPI.radar.delete(id);
    setStocks(prev => prev.filter(s => s.id !== id));
  };

  // ── Add / Save ──
  const handleSave = async (input: AddRadarInput, id?: number) => {
    if (id !== undefined) {
      await window.electronAPI.radar.update(id, input);
    } else {
      await window.electronAPI.radar.add(input);
    }
    const list = await loadStocks();
    await fetchPrices(list);
    setEditTarget(null);
    setShowAdd(false);
  };

  // 預先計算每支股票的評分；給排序與卡片顯示用
  const scoredStocks = useMemo(() => {
    const scored = stocks.map(s => ({
      stock: s,
      score: computeScore(s, instMap[s.stockCode], trendMap[s.stockCode], techMap[s.stockCode], priceMap[s.stockCode], scoreWeights),
    }));
    if (sortMode === 'score-desc') scored.sort((a, b) => b.score - a.score);
    else if (sortMode === 'score-asc') scored.sort((a, b) => a.score - b.score);
    return scored;
  }, [stocks, instMap, trendMap, techMap, priceMap, sortMode, scoreWeights]);

  if (loading) return <Shell><p className="text-slate-400 text-sm">載入中...</p></Shell>;

  return (
    <Shell>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-100">股票雷達</h1>
          {instDate && (
            <p className="text-xs text-slate-500 mt-0.5">
              法人資料：{instDate}
              {instDate !== new Date().toISOString().slice(0, 10) && (
                <span className="ml-1 text-amber-500">（最近交易日）</span>
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={scorePreset}
            onChange={e => {
              const v = e.target.value as ScorePresetKey;
              setScorePreset(v);
              localStorage.setItem('radar-score-preset', v);
            }}
            title="評分策略偏好 — 改變各因子權重"
            className="text-xs px-2 py-1.5 rounded-lg bg-slate-800 text-slate-300 border border-slate-700 focus:outline-none focus:border-blue-500"
          >
            {Object.entries(SCORE_PRESETS).map(([k, v]) => (
              <option key={k} value={k}>策略：{v.label}</option>
            ))}
          </select>
          <select
            value={sortMode}
            onChange={e => setSortMode(e.target.value as SortMode)}
            className="text-xs px-2 py-1.5 rounded-lg bg-slate-800 text-slate-300 border border-slate-700 focus:outline-none focus:border-blue-500"
          >
            <option value="default">原順序</option>
            <option value="score-desc">評分高→低</option>
            <option value="score-asc">評分低→高</option>
          </select>
          <button
            onClick={handleRefreshPrices}
            className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
          >
            重整股價
          </button>
          <button
            onClick={handleFetchInst}
            disabled={fetchingInst}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors"
          >
            {fetchingInst ? '更新中...' : '更新法人資料'}
          </button>
          <button
            onClick={handleFetchTech}
            disabled={fetchingTech}
            className="text-xs px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white transition-colors"
          >
            {fetchingTech ? '抓取中...' : '更新技術線'}
          </button>
          <button
            onClick={() => setShowAnalysis(true)}
            className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium transition-colors"
          >
            📊 分析
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
          >
            + 新增股票
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-900/30 border border-red-800 text-red-300 text-sm">
          {error}
          <button className="ml-3 underline text-xs" onClick={() => setError(null)}>關閉</button>
        </div>
      )}

      {/* Signal legend */}
      <div className="flex items-center gap-4 mb-5 text-xs text-slate-500 flex-wrap">
        {(['green','orange','yellow','red','grey'] as Signal[]).map(s => (
          <div key={s} className="flex items-center gap-1.5">
            <span className={clsx('w-2.5 h-2.5 rounded-full shrink-0', SIGNAL_STYLE[s].replace('animate-pulse',''))} />
            <span className={s === 'orange' ? 'text-orange-400 font-medium' : ''}>{SIGNAL_LABEL[s]}</span>
          </div>
        ))}
        <span className="text-slate-700">│ 賣出：外資淨賣 且 合計 &lt; −10萬股</span>
      </div>

      {stocks.length === 0 ? (
        <div className="text-center py-16 text-slate-500">
          <div className="text-4xl mb-3">⊕</div>
          <p className="text-sm">雷達清單為空，點「新增股票」加入追蹤</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {scoredStocks.map(({ stock: s, score }) => {
            const inst = instMap[s.stockCode];
            const trend = trendMap[s.stockCode];
            const tech = techMap[s.stockCode];
            const margin = marginMap[s.stockCode];
            const fund = fundMap[s.stockCode];
            const backtest = backtestMap[s.stockCode];
            const price = priceMap[s.stockCode];
            const avgCost = holdingsMap[s.stockCode]?.avgCost;
            const signal = getSignal(s, inst, trend, tech);
            return (
              <RadarCard
                key={s.id}
                stock={s}
                inst={inst}
                trend={trend}
                tech={tech}
                margin={margin}
                fund={fund}
                backtest={backtest}
                price={price}
                avgCost={avgCost}
                signal={signal}
                score={score}
                onShowDetail={() => setDetailTarget(s)}
                onToggleHolding={() => handleToggleHolding(s.id)}
                onEdit={() => setEditTarget(s)}
                onDelete={() => handleDelete(s.id)}
              />
            );
          })}
        </div>
      )}

      {/* Add / Edit modal */}
      {(showAdd || editTarget) && (
        <RadarModal
          initial={editTarget ?? undefined}
          onSave={(input) => handleSave(input, editTarget?.id)}
          onClose={() => { setShowAdd(false); setEditTarget(null); }}
        />
      )}

      {/* Analysis modal */}
      {showAnalysis && (
        <AnalysisModal
          stocks={stocks}
          instMap={instMap}
          trendMap={trendMap}
          techMap={techMap}
          marginMap={marginMap}
          fundMap={fundMap}
          backtestMap={backtestMap}
          priceMap={priceMap}
          holdingsMap={holdingsMap}
          instDate={instDate}
          onClose={() => setShowAnalysis(false)}
          onStocksChanged={loadStocks}
        />
      )}

      {/* Stock detail (K-line) modal */}
      {detailTarget && (
        <StockDetailModal
          stock={detailTarget}
          currentPrice={priceMap[detailTarget.stockCode]}
          avgCost={holdingsMap[detailTarget.stockCode]?.avgCost}
          buyAt={detailTarget.buyAt}
          stopLoss={detailTarget.stopLoss}
          onClose={() => setDetailTarget(null)}
        />
      )}
    </Shell>
  );
}

// ── Card ──────────────────────────────────────────────────
function RadarCard({
  stock, inst, trend, tech, margin, fund, backtest, price, avgCost, signal, score,
  onShowDetail, onToggleHolding, onEdit, onDelete,
}: {
  stock: RadarStock;
  inst: InstData | undefined;
  trend: InstTrend | undefined;
  tech: TechData | undefined;
  margin: MarginData | undefined;
  fund: FundamentalData | undefined;
  backtest: BacktestResult | undefined;
  price: PriceInfo | undefined;
  avgCost: number | undefined;       // FIFO 平均成本（持倉股才有）
  signal: Signal;
  score: number;
  onShowDetail: () => void;
  onToggleHolding: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const pct = price?.pct ?? 0;
  const pctColor = pct > 0 ? 'text-emerald-400' : pct < 0 ? 'text-red-400' : 'text-slate-400';

  // 計算距目標買入價、停損價、平均成本的百分比
  const distBuy  = (stock.buyAt    && price) ? ((price.price - stock.buyAt)    / stock.buyAt)    * 100 : null;
  const distStop = (stock.stopLoss && price) ? ((price.price - stock.stopLoss) / stock.stopLoss) * 100 : null;
  const distCost = (avgCost        && price) ? ((price.price - avgCost)        / avgCost)        * 100 : null;

  return (
    <div className={clsx(
      'bg-slate-900 border border-slate-800 rounded-xl overflow-hidden hover:border-slate-700 transition-colors',
      CARD_BORDER[signal],
      signal === 'orange' && 'bg-orange-950/10',
    )}>
      {/* Top bar: signal + stock info + score */}
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        {/* Signal dot */}
        <div className="mt-0.5 shrink-0">
          <span
            title={SIGNAL_LABEL[signal]}
            className={clsx('block w-3 h-3 rounded-full', SIGNAL_STYLE[signal])}
          />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-slate-100 text-base">{stock.stockCode}</span>
            <span className="font-medium text-slate-300 text-sm">{stock.stockName}</span>
            <span className={clsx('text-xs px-1.5 py-0.5 rounded font-medium', MARKET_BADGE[stock.market] ?? 'bg-slate-700 text-slate-300')}>
              {stock.market}
            </span>
            {stock.isHolding && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900/50 text-amber-300 font-medium">持有</span>
            )}
          </div>

          {/* Price + sell warning banner */}
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-lg font-bold text-slate-100">
              {price ? `$${fmt(price.price, 2)}` : '—'}
            </span>
            <span className={clsx('text-sm font-medium', pctColor)}>
              {price ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : ''}
            </span>
            {signal === 'orange' && (
              <span className="ml-1 text-xs font-bold text-orange-400 animate-pulse">⚠ 考慮賣出</span>
            )}
          </div>
        </div>

        {/* Score badge */}
        <div
          title="綜合評分（法人+趨勢+距離+技術）"
          className={clsx('shrink-0 text-center px-2 py-1 rounded-lg', scoreColor(score))}
        >
          <div className="text-base font-bold leading-none tabular-nums">{score}</div>
          <div className="text-[9px] mt-0.5 opacity-70 leading-none">SCORE</div>
        </div>
      </div>

      {/* 歷史回測勝率（外資連買 3 日後表現）*/}
      {backtest && backtest.greenSignalCount >= 3 && backtest.greenWinRate5d != null && (
        <div
          title="過去 90 天「外資連買 3 日」訊號後 5 日股價表現"
          className="px-4 -mt-1 pb-1 text-[10px] text-slate-500 flex items-center gap-2 flex-wrap"
        >
          <span>📈 連買3日訊號 {backtest.greenSignalCount} 次</span>
          <span>·</span>
          <span>5日勝率 <span className={clsx('font-medium',
            backtest.greenWinRate5d >= 60 ? 'text-emerald-400' :
            backtest.greenWinRate5d >= 40 ? 'text-slate-300' : 'text-red-400')}>
            {backtest.greenWinRate5d.toFixed(0)}%
          </span></span>
          {backtest.greenAvgReturn5d != null && (
            <>
              <span>·</span>
              <span>平均 <span className={clsx('font-medium tabular-nums',
                backtest.greenAvgReturn5d >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                {backtest.greenAvgReturn5d >= 0 ? '+' : ''}{backtest.greenAvgReturn5d.toFixed(2)}%
              </span></span>
            </>
          )}
        </div>
      )}

      {/* Institutional data */}
      <div className="px-4 pb-3 border-t border-slate-800/60 pt-3">
        <div className="text-xs text-slate-500 mb-1.5 font-medium">法人買賣超（股）</div>
        {inst ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-500">外資</span>
              <span className={clsx('font-medium tabular-nums', inst.foreignNet > 0 ? 'text-emerald-400' : inst.foreignNet < 0 ? 'text-red-400' : 'text-slate-400')}>
                {fmtShares(inst.foreignNet)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">投信</span>
              <span className={clsx('font-medium tabular-nums', inst.trustNet > 0 ? 'text-emerald-400' : inst.trustNet < 0 ? 'text-red-400' : 'text-slate-400')}>
                {fmtShares(inst.trustNet)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">自營</span>
              <span className={clsx('font-medium tabular-nums', inst.dealerNet > 0 ? 'text-emerald-400' : inst.dealerNet < 0 ? 'text-red-400' : 'text-slate-400')}>
                {fmtShares(inst.dealerNet)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">合計</span>
              <span className={clsx('font-bold tabular-nums', inst.totalNet > 0 ? 'text-emerald-400' : inst.totalNet < 0 ? 'text-red-400' : 'text-slate-400')}>
                {fmtShares(inst.totalNet)}
              </span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-600 italic">點「更新法人資料」載入數據</p>
        )}

        {/* Multi-day trend badges */}
        {trend && trend.daysAvailable >= 2 && (
          <div className="flex items-center gap-1.5 mt-2 flex-wrap text-[11px]">
            {trend.foreignStreak >= 2 && (
              <span className="px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 font-medium">
                外資連買 {trend.foreignStreak} 日
              </span>
            )}
            {trend.foreignStreak <= -2 && (
              <span className="px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 font-medium">
                外資連賣 {Math.abs(trend.foreignStreak)} 日
              </span>
            )}
            {trend.trustStreak >= 2 && (
              <span className="px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 font-medium">
                投信連買 {trend.trustStreak} 日
              </span>
            )}
            {trend.trustStreak <= -2 && (
              <span className="px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 font-medium">
                投信連賣 {Math.abs(trend.trustStreak)} 日
              </span>
            )}
            {trend.daysAvailable >= 5 && (
              <span
                title={`最近 5 日合計累積：${fmtShares(trend.total5d)}`}
                className={clsx(
                  'px-1.5 py-0.5 rounded font-medium tabular-nums',
                  trend.total5d > 0 ? 'bg-emerald-900/30 text-emerald-400'
                  : trend.total5d < 0 ? 'bg-red-900/30 text-red-400'
                  : 'bg-slate-800 text-slate-400'
                )}
              >
                5日 {fmtShares(trend.total5d)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* 融資融券（散戶情緒） */}
      {margin && (
        <div className="px-4 pb-3 border-t border-slate-800/60 pt-2">
          <div className="text-xs text-slate-500 mb-1 font-medium">融資融券（張）</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-500">融資</span>
              <span className="tabular-nums">
                <span className="text-slate-300">{margin.marginBalance.toLocaleString()}</span>
                <span className={clsx('ml-1.5 text-[10px]',
                  margin.marginChange > 0 ? 'text-amber-400' : margin.marginChange < 0 ? 'text-emerald-400' : 'text-slate-500')}>
                  {margin.marginChange > 0 ? '+' : ''}{margin.marginChange.toLocaleString()}
                </span>
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">融券</span>
              <span className="tabular-nums">
                <span className="text-slate-300">{margin.shortBalance.toLocaleString()}</span>
                <span className={clsx('ml-1.5 text-[10px]',
                  margin.shortChange > 0 ? 'text-amber-400' : margin.shortChange < 0 ? 'text-emerald-400' : 'text-slate-500')}>
                  {margin.shortChange > 0 ? '+' : ''}{margin.shortChange.toLocaleString()}
                </span>
              </span>
            </div>
          </div>
          {/* 智能對照解讀 */}
          {inst && (() => {
            const fBuy = inst.foreignNet > 0;
            const mUp = margin.marginChange > 0;
            if (fBuy && !mUp) return (
              <p className="mt-1 text-[10px] text-emerald-400">👍 法人吃貨、散戶不追（真強訊號）</p>
            );
            if (!fBuy && mUp) return (
              <p className="mt-1 text-[10px] text-red-400">⚠ 法人賣、散戶接刀（高危）</p>
            );
            return null;
          })()}
        </div>
      )}

      {/* Tech indicators (MA + RSI/KD/MACD) */}
      {tech && tech.lastClose > 0 && (
        <div className="px-4 pb-3 border-t border-slate-800/60 pt-2">
          <div className="text-xs text-slate-500 mb-1 font-medium">技術線型</div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            {(['ma5', 'ma20', 'ma60'] as const).map(k => {
              const label = k.toUpperCase();
              const v = tech[k];
              if (v === 0) return (
                <div key={k}>
                  <span className="text-slate-500">{label}</span>
                  <div className="text-slate-600 text-xs">—</div>
                </div>
              );
              const above = tech.lastClose > v;
              const distPct = ((tech.lastClose - v) / v) * 100;
              return (
                <div key={k}>
                  <span className="text-slate-500">{label}</span>
                  <div className={clsx('font-medium tabular-nums', above ? 'text-emerald-400' : 'text-red-400')}>
                    {above ? '▲' : '▼'} {fmtPct(distPct)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* RSI / KD / MACD / ATR */}
          {(tech.rsi14 != null || tech.kdK != null || tech.macdHist != null || tech.atr14 != null) && (
            <div className="grid grid-cols-4 gap-2 text-xs mt-2 pt-2 border-t border-slate-800/40">
              {/* RSI */}
              <div>
                <span className="text-slate-500">RSI</span>
                {tech.rsi14 != null ? (
                  <div className={clsx('font-medium tabular-nums',
                    tech.rsi14 > 70 ? 'text-red-400'
                    : tech.rsi14 < 30 ? 'text-emerald-400'
                    : 'text-slate-300')}>
                    {tech.rsi14.toFixed(0)}
                    {tech.rsi14 > 70 && <span className="text-[9px] ml-1">過熱</span>}
                    {tech.rsi14 < 30 && <span className="text-[9px] ml-1">超賣</span>}
                  </div>
                ) : <div className="text-slate-600">—</div>}
              </div>
              {/* KD */}
              <div>
                <span className="text-slate-500">KD</span>
                {tech.kdK != null && tech.kdD != null ? (
                  <div className={clsx('font-medium tabular-nums text-[11px]',
                    tech.kdK > tech.kdD ? 'text-emerald-400' : 'text-red-400')}>
                    {tech.kdK.toFixed(0)}/{tech.kdD.toFixed(0)}
                    {tech.kdK > tech.kdD && tech.kdK < 30 && <span className="text-[9px] ml-1">低檔金叉</span>}
                    {tech.kdK < tech.kdD && tech.kdK > 70 && <span className="text-[9px] ml-1">高檔死叉</span>}
                  </div>
                ) : <div className="text-slate-600">—</div>}
              </div>
              {/* MACD 柱狀 */}
              <div>
                <span className="text-slate-500">MACD</span>
                {tech.macdHist != null ? (
                  <div className={clsx('font-medium tabular-nums text-[11px]',
                    tech.macdHist > 0 ? 'text-red-400' : 'text-emerald-400')}>
                    {tech.macdHist > 0 ? '🔴' : '🟢'} {Math.abs(tech.macdHist).toFixed(2)}
                  </div>
                ) : <div className="text-slate-600">—</div>}
              </div>
              {/* ATR(14) - 波動度（單位：元 + 占比） */}
              <div title="ATR(14)：過去 14 日平均真實波動。建議停損 = 進場價 - 2×ATR">
                <span className="text-slate-500">波動</span>
                {tech.atr14 != null && tech.lastClose > 0 ? (
                  <div className="font-medium tabular-nums text-[11px] text-amber-300">
                    ±{tech.atr14.toFixed(2)}
                    <span className="text-[9px] ml-1 text-slate-500">
                      ({(tech.atr14 / tech.lastClose * 100).toFixed(1)}%)
                    </span>
                  </div>
                ) : <div className="text-slate-600">—</div>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Target info */}
      <div className="px-4 pb-3 border-t border-slate-800/60 pt-3">
        <div className="grid grid-cols-3 gap-2 text-xs mb-2">
          <div>
            <div className="text-slate-500 mb-0.5">
              {stock.buyAt != null ? '目標買入' : avgCost != null ? '平均成本' : '目標買入'}
            </div>
            <div className="text-slate-200 font-medium">
              {stock.buyAt != null
                ? `$${fmt(stock.buyAt, 1)}`
                : avgCost != null
                ? `$${fmt(avgCost, 1)}`
                : '—'}
            </div>
            {distBuy != null ? (
              <div
                title="現價與目標買入價的距離（負值=低於目標，可進場）"
                className={clsx(
                  'text-[10px] tabular-nums mt-0.5',
                  Math.abs(distBuy) <= 2 ? 'text-emerald-400 font-medium'
                  : distBuy < 0 ? 'text-emerald-500'
                  : 'text-slate-500'
                )}
              >
                距 {fmtPct(distBuy)}
              </div>
            ) : distCost != null ? (
              <div
                title="現價與 FIFO 平均成本的距離（正值=賺、負值=虧）"
                className={clsx(
                  'text-[10px] tabular-nums mt-0.5 font-medium',
                  distCost > 0 ? 'text-emerald-400'
                  : distCost < 0 ? 'text-red-400'
                  : 'text-slate-500'
                )}
              >
                損益 {fmtPct(distCost)}
              </div>
            ) : null}
          </div>
          <div>
            <div className="text-slate-500 mb-0.5">停損</div>
            <div className="text-red-400 font-medium">{stock.stopLoss != null ? `$${fmt(stock.stopLoss, 1)}` : '—'}</div>
            {distStop != null && stock.isHolding && (
              <div
                title="現價距停損的距離（接近 0% 為危險區）"
                className={clsx(
                  'text-[10px] tabular-nums mt-0.5',
                  distStop < 3 ? 'text-red-400 font-bold animate-pulse'
                  : distStop < 8 ? 'text-amber-400 font-medium'
                  : 'text-slate-500'
                )}
              >
                距 {fmtPct(distStop)}
              </div>
            )}
          </div>
          <div>
            <div className="text-slate-500 mb-0.5">目標股數</div>
            <div className="text-slate-200 font-medium">
              {stock.targetShares != null
                ? `${stock.targetShares.toLocaleString()} 股`
                : '—'}
            </div>
          </div>
        </div>

        {/* Note + remark */}
        {stock.note && (
          <p className="text-xs text-blue-300 bg-blue-900/20 rounded px-2 py-1 mb-1.5">{stock.note}</p>
        )}
        {stock.remark && (
          <p className="text-xs text-slate-400">{stock.remark}</p>
        )}
      </div>

      {/* 基本面（小條 inline） */}
      {fund && (fund.pe != null || fund.eps != null || fund.dividendYield != null) && (
        <div className="px-4 pb-2 -mt-1 flex items-center gap-3 text-[11px] text-slate-500 flex-wrap">
          {fund.pe != null && (
            <span title="本益比">
              P/E <span className="text-slate-300 tabular-nums">{fund.pe.toFixed(1)}</span>
            </span>
          )}
          {fund.eps != null && (
            <span title="每股盈餘 (TTM)">
              EPS <span className="text-slate-300 tabular-nums">{fund.eps.toFixed(2)}</span>
            </span>
          )}
          {fund.dividendYield != null && fund.dividendYield > 0 && (
            <span title="殖利率">
              殖利率 <span className="text-emerald-400 tabular-nums">{fund.dividendYield.toFixed(1)}%</span>
            </span>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1 px-3 pb-3 border-t border-slate-800/60 pt-2">
        <button
          onClick={onToggleHolding}
          className={clsx(
            'text-xs px-2.5 py-1 rounded-md transition-colors',
            stock.isHolding
              ? 'bg-amber-900/40 text-amber-300 hover:bg-amber-900/60'
              : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
          )}
        >
          {stock.isHolding ? '✓ 持有中' : '標記持有'}
        </button>
        <div className="flex-1" />
        <button
          onClick={onShowDetail}
          className="text-xs px-2.5 py-1 rounded-md bg-blue-900/40 text-blue-300 hover:bg-blue-900/60 transition-colors"
          title="顯示 K 線 + 成交量"
        >
          📈 K 線
        </button>
        <button
          onClick={onEdit}
          className="text-xs px-2.5 py-1 rounded-md bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors"
        >
          編輯
        </button>
        <button
          onClick={onDelete}
          className="text-xs px-2.5 py-1 rounded-md bg-slate-800 text-red-400 hover:bg-red-900/40 transition-colors"
        >
          刪除
        </button>
      </div>
    </div>
  );
}

// ── Add / Edit Modal ──────────────────────────────────────
const EMPTY_FORM = {
  stockCode: '', stockName: '', market: 'TWSE' as MarketType,
  buyAt: '', stopLoss: '', targetShares: '',
  note: '', remark: '', isHolding: false,
};

function RadarModal({
  initial,
  onSave,
  onClose,
}: {
  initial?: RadarStock;
  onSave: (input: AddRadarInput) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    stockCode:    initial?.stockCode    ?? '',
    stockName:    initial?.stockName    ?? '',
    market:       (initial?.market      ?? 'TWSE') as MarketType,
    buyAt:        initial?.buyAt        != null ? String(initial.buyAt)        : '',
    stopLoss:     initial?.stopLoss     != null ? String(initial.stopLoss)     : '',
    targetShares: initial?.targetShares != null ? String(initial.targetShares) : '',
    note:         initial?.note         ?? '',
    remark:       initial?.remark       ?? '',
    isHolding:    initial?.isHolding    ?? false,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  function set<K extends keyof typeof form>(k: K, v: typeof form[K]) {
    setForm(prev => ({ ...prev, [k]: v }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.stockCode.trim()) { setErr('請輸入股票代號'); return; }
    if (!form.stockName.trim()) { setErr('請輸入股票名稱'); return; }
    setSaving(true);
    try {
      await onSave({
        stockCode:    form.stockCode.trim().toUpperCase(),
        stockName:    form.stockName.trim(),
        market:       form.market,
        buyAt:        form.buyAt    ? Number(form.buyAt)        : null,
        stopLoss:     form.stopLoss ? Number(form.stopLoss)     : null,
        targetShares: form.targetShares ? Number(form.targetShares) : null,
        note:         form.note.trim()   || undefined,
        remark:       form.remark.trim() || undefined,
        isHolding:    form.isHolding,
      });
    } catch (e) {
      setErr(String(e));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <form
        onSubmit={handleSubmit}
        className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <h2 className="text-base font-bold text-slate-100">
            {initial ? '編輯雷達股票' : '新增雷達股票'}
          </h2>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-300 text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {err && <p className="text-red-400 text-sm">{err}</p>}

          {/* Code + Name + Market */}
          <div className="grid grid-cols-5 gap-3">
            <div className="col-span-2">
              <label className="block text-xs text-slate-400 mb-1">股票代號 *</label>
              <input
                value={form.stockCode}
                onChange={e => set('stockCode', e.target.value)}
                placeholder="2356"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-400 mb-1">股票名稱 *</label>
              <input
                value={form.stockName}
                onChange={e => set('stockName', e.target.value)}
                placeholder="英業達"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="col-span-1">
              <label className="block text-xs text-slate-400 mb-1">市場</label>
              <select
                value={form.market}
                onChange={e => set('market', e.target.value as MarketType)}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option value="TWSE">上市</option>
                <option value="OTC">上櫃</option>
                <option value="ETF">ETF</option>
              </select>
            </div>
          </div>

          {/* Prices */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">目標買入價</label>
              <input
                type="number" step="0.1"
                value={form.buyAt}
                onChange={e => set('buyAt', e.target.value)}
                placeholder="56"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">停損價</label>
              <input
                type="number" step="0.1"
                value={form.stopLoss}
                onChange={e => set('stopLoss', e.target.value)}
                placeholder="53"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">目標股數</label>
              <input
                type="number" step="1000"
                value={form.targetShares}
                onChange={e => set('targetShares', e.target.value)}
                placeholder="2000"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* Note */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">進場條件／策略</label>
            <input
              value={form.note}
              onChange={e => set('note', e.target.value)}
              placeholder="等回測 $55–57"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Remark */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">催化劑／觀察重點</label>
            <input
              value={form.remark}
              onChange={e => set('remark', e.target.value)}
              placeholder="AI伺服器，外資連買"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Is holding */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.isHolding}
              onChange={e => set('isHolding', e.target.checked)}
              className="w-4 h-4 rounded accent-amber-500"
            />
            <span className="text-sm text-slate-300">標記為已持有</span>
          </label>
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-800">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors"
          >
            {saving ? '儲存中...' : '儲存'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="p-6">{children}</div>;
}
