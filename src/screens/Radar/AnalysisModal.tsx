import { useMemo, useState, useEffect } from 'react';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Modal from '../../components/Modal';
import type { RadarStock, InstData, InstTrend, TechData, MarginData, FundamentalData, BacktestResult, MarketContext } from '../../../shared/types';
import type { PriceInfo, HoldingInfo } from './index';
import {
  type Signal,
  getSignal, fmt, fmtShares, fmtPct,
  SIGNAL_LABEL, SIGNAL_STYLE, MARKET_BADGE,
  BUY_THRESHOLD, SELL_THRESHOLD, STRONG_BUY_THRESHOLD,
} from './logic';

// 戰備現金 — 由 user 自行輸入，存 localStorage
const STORAGE_RESERVE_CASH = 'reserve-cash';

// ── AI Provider 抽象層 ───────────────────────────────────────
// 支援 Claude 與 Gemini；user 在設定區下拉切換、各自存獨立 API Key
type Provider = 'claude' | 'gemini';

interface ProviderConfig {
  id: Provider;
  label: string;
  storageKey: string;         // localStorage 存 API Key 的 key
  keyPlaceholder: string;
  consoleUrl: string;
  /** 呼叫 API、回傳純文字；失敗 throw Error */
  call: (apiKey: string, prompt: string) => Promise<string>;
}

const STORAGE_PROVIDER  = 'ai-provider';      // 記住上次選的 provider
const STORAGE_LAST_RESULT   = 'ai-last-result';   // 上次 AI 回應全文
const STORAGE_LAST_MODE     = 'ai-last-mode';     // 上次跑的模式
const STORAGE_LAST_TIME     = 'ai-last-time';     // 上次跑的 ISO 時間
const STORAGE_LAST_PROVIDER = 'ai-last-provider'; // 上次跑用哪個 provider

// ── Claude（Anthropic）─────────────────────────────────────
async function callClaudeApi(apiKey: string, prompt: string): Promise<string> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      // Prompt 加了大盤/融資/技術/基本面/回測/AI 過往後變大，
      // 8000 才能完整包住 markdown 分析 + 結構化 JSON
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Claude API ${resp.status}：${(await resp.text()).slice(0, 300)}`);
  }
  interface ClaudeResponse {
    content: { type: string; text?: string }[];
    stop_reason?: string;
  }
  const json = await resp.json() as ClaudeResponse;
  const text = json.content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('\n');
  if (!text) throw new Error('Claude 回應為空');
  // 偵測截斷（Claude 用 stop_reason="max_tokens"）
  if (json.stop_reason === 'max_tokens') {
    return text + '\n\n⚠ 內容因達 token 上限被截斷（結構化建議可能缺失）。建議減少雷達股數。';
  }
  return text;
}

// ── Gemini（Google）─────────────────────────────────────────
async function callGeminiApi(apiKey: string, prompt: string): Promise<string> {
  // Gemini CORS 對 browser 友善，不需特殊 header（不像 Anthropic 要 dangerous-direct-browser-access）
  // 注意：gemini-2.5-flash 預設啟用 thinking 模式，會吃掉 output token 額度。
  // 設 thinkingBudget=0 關閉內部推理，讓全部 token 給實際文字輸出。
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        // Prompt 變大（R1-R6 加了大量 context），16000 才能完整包到結構化 JSON
        maxOutputTokens: 16000,
        thinkingConfig: { thinkingBudget: 0 },  // 關閉 thinking，避免內部推理吃 token
      },
    }),
  });
  if (!resp.ok) {
    throw new Error(`Gemini API ${resp.status}：${(await resp.text()).slice(0, 300)}`);
  }
  interface GeminiResponse {
    candidates?: {
      content?: { parts?: { text?: string }[] };
      finishReason?: string;
    }[];
  }
  const json = await resp.json() as GeminiResponse;
  const cand = json.candidates?.[0];
  const text = cand?.content?.parts?.map(p => p.text ?? '').join('\n') ?? '';
  if (!text) {
    // 若是 MAX_TOKENS 被截斷，明確提示而不是說「回應為空」
    if (cand?.finishReason === 'MAX_TOKENS') {
      throw new Error('Gemini 回應超出 token 上限（thinking 吃掉所有額度）');
    }
    throw new Error(`Gemini 回應為空（finishReason: ${cand?.finishReason ?? 'unknown'}）`);
  }
  // 即使有 text，若 finishReason 是 MAX_TOKENS 還是要警示使用者
  if (cand?.finishReason === 'MAX_TOKENS') {
    return text + '\n\n⚠ 內容因達 token 上限被截斷，建議減少雷達股數或縮短 prompt';
  }
  return text;
}

const PROVIDERS: Record<Provider, ProviderConfig> = {
  claude: {
    id: 'claude',
    label: 'Claude (Anthropic)',
    storageKey: 'anthropic-key',
    keyPlaceholder: 'sk-ant-api03-...',
    consoleUrl: 'console.anthropic.com',
    call: callClaudeApi,
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini (Google)',
    storageKey: 'gemini-key',
    keyPlaceholder: 'AIzaSy...',
    consoleUrl: 'aistudio.google.com/apikey',
    call: callGeminiApi,
  },
};

// ── 3 種分析模式 ─────────────────────────────────────────────
// 每個模式有獨立的時段窗口、prompt、與 last-run 記錄
type AiMode = 'premarket' | 'intraday' | 'postclose';

interface ModeConfig {
  id: AiMode;
  label: string;
  icon: string;
  // 開放時段（分鐘 from 00:00 local）
  startMin: number;
  endMin: number;
  storageKey: string;
  gradient: string;        // 按鈕色
  windowLabel: string;     // 顯示用：「06:00-09:00」
}

const MODE_CONFIGS: Record<AiMode, ModeConfig> = {
  premarket: {
    id: 'premarket',
    label: '盤前分析',
    icon: '🌅',
    startMin: 6 * 60,         // 06:00
    endMin: 9 * 60,           // 09:00
    storageKey: 'anthropic-last-premarket',
    gradient: 'from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500',
    windowLabel: '06:00–09:00',
  },
  intraday: {
    id: 'intraday',
    label: '盤中分析',
    icon: '📊',
    startMin: 9 * 60,         // 09:00
    endMin: 13 * 60 + 30,     // 13:30
    storageKey: 'anthropic-last-intraday',
    gradient: 'from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500',
    windowLabel: '09:00–13:30',
  },
  postclose: {
    id: 'postclose',
    label: '盤後結算',
    icon: '🌙',
    startMin: 13 * 60 + 40,   // 13:40
    endMin: 24 * 60,          // 隔日 00:00（technically 直到隔日 06:00 才結束、但簡化以 13:40+ 不限）
    storageKey: 'anthropic-last-postclose',
    gradient: 'from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500',
    windowLabel: '13:40 之後',
  },
};

// 給每個模式單獨計算「現在能不能用」
function getModeState(cfg: ModeConfig): { allowed: boolean; reason?: string; nextAt?: string } {
  const now = new Date();
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  const nowStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  if (day === 0 || day === 6) {
    return { allowed: false, reason: '週末非交易日' };
  }
  if (mins < cfg.startMin) {
    return { allowed: false, reason: `${cfg.windowLabel} 開放（現在 ${nowStr}）` };
  }
  if (mins >= cfg.endMin) {
    return { allowed: false, reason: `已過 ${cfg.windowLabel}` };
  }

  const lastStr = localStorage.getItem(cfg.storageKey);
  if (lastStr) {
    const last = new Date(lastStr);
    const windowStart = new Date(now);
    windowStart.setHours(Math.floor(cfg.startMin / 60), cfg.startMin % 60, 0, 0);
    if (last.getTime() >= windowStart.getTime()) {
      const next = new Date(now);
      next.setDate(next.getDate() + 1);
      next.setHours(Math.floor(cfg.startMin / 60), cfg.startMin % 60, 0, 0);
      while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
      return {
        allowed: false,
        reason: `本日已執行過`,
        nextAt: next.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }),
      };
    }
  }
  return { allowed: true };
}

interface Props {
  stocks: RadarStock[];
  instMap: Record<string, InstData>;
  trendMap: Record<string, InstTrend>;
  techMap?: Record<string, TechData>;
  marginMap?: Record<string, MarginData>;
  fundMap?: Record<string, FundamentalData>;
  backtestMap?: Record<string, BacktestResult>;
  priceMap: Record<string, PriceInfo>;
  holdingsMap: Record<string, HoldingInfo>;
  instDate: string | null;
  onClose: () => void;
  /** AI 套用更新後通知 parent 重新載入 stocks */
  onStocksChanged?: () => void;
}

// ── Recommendation tier ──────────────────────────────────────────
type Tier = 'urgent' | 'sell-warn' | 'entry' | 'add' | 'watch';

interface Recommendation {
  tier: Tier;
  stock: RadarStock;
  reason: string;
}

const TIER_META: Record<Tier, { label: string; icon: string; color: string }> = {
  urgent:     { label: '緊急停損檢視', icon: '🚨', color: 'border-red-500/60 bg-red-900/20' },
  'sell-warn':{ label: '賣出警示',     icon: '⚠️', color: 'border-orange-500/60 bg-orange-900/20' },
  entry:      { label: '進場機會',     icon: '🎯', color: 'border-emerald-500/60 bg-emerald-900/20' },
  add:        { label: '加碼候選',     icon: '💎', color: 'border-emerald-400/40 bg-emerald-900/10' },
  watch:      { label: '觀察中',       icon: '👁️', color: 'border-slate-700 bg-slate-800/40' },
};

export default function AnalysisModal({
  stocks, instMap, trendMap, techMap = {}, marginMap = {}, fundMap = {}, backtestMap = {},
  priceMap, holdingsMap, instDate, onClose, onStocksChanged,
}: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const updateTime = new Date().toLocaleTimeString('zh-TW');

  // ── Section 1: 今日綜覽 ────────────────────────────────────────
  const summary = useMemo(() => {
    let totalDayPnl = 0;        // 持倉今日盈虧（元）
    let up = 0, down = 0, flat = 0;
    let topGainer: { code: string; name: string; pct: number } | null = null;
    let topLoser: { code: string; name: string; pct: number } | null = null;

    for (const s of stocks) {
      const price = priceMap[s.stockCode];
      if (!price) { flat++; continue; }

      const holding = holdingsMap[s.stockCode];
      if (holding) totalDayPnl += holding.totalShares * price.changeAbs;

      if (price.pct > 0) up++;
      else if (price.pct < 0) down++;
      else flat++;

      if (!topGainer || price.pct > topGainer.pct) {
        topGainer = { code: s.stockCode, name: s.stockName, pct: price.pct };
      }
      if (!topLoser || price.pct < topLoser.pct) {
        topLoser = { code: s.stockCode, name: s.stockName, pct: price.pct };
      }
    }
    return { totalDayPnl, up, down, flat, topGainer, topLoser };
  }, [stocks, priceMap, holdingsMap]);

  // ── 風險集中度（單支股票占持倉 %）─────────────────────────
  const concentration = useMemo(() => {
    const totalVal = Object.entries(holdingsMap).reduce((sum, [code, h]) => {
      const p = priceMap[code];
      if (!p) return sum;
      return sum + h.totalShares * p.price;
    }, 0);
    if (totalVal === 0) return { items: [] as Array<{ code: string; name: string; pct: number; value: number }>, totalVal: 0 };
    const items = Object.entries(holdingsMap).map(([code, h]) => {
      const p = priceMap[code];
      const stock = stocks.find(s => s.stockCode === code);
      const value = p ? h.totalShares * p.price : 0;
      return { code, name: stock?.stockName ?? code, pct: (value / totalVal) * 100, value };
    }).filter(x => x.value > 0).sort((a, b) => b.pct - a.pct);
    return { items, totalVal };
  }, [holdingsMap, priceMap, stocks]);

  // ── Section 2: 持倉今日表現（依 |dayPnl| 排序）────────────────
  const holdingsPerf = useMemo(() => {
    const rows = stocks
      .filter(s => holdingsMap[s.stockCode] && priceMap[s.stockCode])
      .map(s => {
        const h = holdingsMap[s.stockCode];
        const p = priceMap[s.stockCode];
        return {
          stock: s,
          price: p.price,
          pct: p.pct,
          dayPnl: h.totalShares * p.changeAbs,
          totalShares: h.totalShares,
        };
      });
    rows.sort((a, b) => Math.abs(b.dayPnl) - Math.abs(a.dayPnl));
    const upCount = rows.filter(r => r.pct > 0).length;
    const downCount = rows.filter(r => r.pct < 0).length;
    return { rows, upCount, downCount };
  }, [stocks, holdingsMap, priceMap]);

  // ── Section 3: 燈號分布 + 重點訊號 ────────────────────────────
  const signals = useMemo(() => {
    const counts: Record<Signal, number> = { green: 0, orange: 0, yellow: 0, red: 0, grey: 0 };
    const sellWarns: RadarStock[] = [];
    const strongBuys: RadarStock[] = [];
    for (const s of stocks) {
      const inst = instMap[s.stockCode];
      const trend = trendMap[s.stockCode];
      const sig = getSignal(s, inst, trend, techMap[s.stockCode]);
      counts[sig]++;
      if (sig === 'orange') sellWarns.push(s);
      if (sig === 'green' && inst && inst.totalNet > STRONG_BUY_THRESHOLD) strongBuys.push(s);
    }
    return { counts, sellWarns, strongBuys };
  }, [stocks, instMap]);

  // ── Section 4: 明日操作預案（優先級互斥分組）──────────────────
  const recommendations = useMemo<Record<Tier, Recommendation[]>>(() => {
    const groups: Record<Tier, Recommendation[]> = {
      urgent: [], 'sell-warn': [], entry: [], add: [], watch: [],
    };

    for (const s of stocks) {
      const inst = instMap[s.stockCode];
      const trend = trendMap[s.stockCode];
      const price = priceMap[s.stockCode];
      const sig = getSignal(s, inst, trend, techMap[s.stockCode]);

      const distStop = (s.stopLoss && price) ? ((price.price - s.stopLoss) / s.stopLoss) * 100 : null;
      const distBuy  = (s.buyAt    && price) ? ((price.price - s.buyAt)    / s.buyAt)    * 100 : null;

      // 等級 1：緊急停損
      if (s.isHolding && distStop != null && distStop < 3 && distStop >= 0) {
        groups.urgent.push({
          tier: 'urgent', stock: s,
          reason: `距停損僅 ${fmtPct(distStop)}，重新檢視出場條件`,
        });
        continue;
      }

      // 等級 2：賣出警示（orange signal）
      if (sig === 'orange' && inst) {
        groups['sell-warn'].push({
          tier: 'sell-warn', stock: s,
          reason: `法人持續出貨 合計 ${fmtShares(inst.totalNet)}，考慮減碼`,
        });
        continue;
      }

      // 等級 3：進場機會（距買點 ±3% 內，外資未連賣）
      if (distBuy != null && distBuy >= -3 && distBuy <= 2 && sig !== 'red' && (!trend || trend.foreignStreak >= 0)) {
        const trendNote = trend && trend.foreignStreak >= 2 ? `、外資連買 ${trend.foreignStreak} 日` : '';
        groups.entry.push({
          tier: 'entry', stock: s,
          reason: `距買點 ${fmtPct(distBuy)}${trendNote}，可分批佈局`,
        });
        continue;
      }

      // 等級 4：加碼候選（持有 + 法人連買 3+ 日 + 合計 > 50 萬）
      if (s.isHolding && trend && trend.foreignStreak >= 3 && inst && inst.totalNet > BUY_THRESHOLD) {
        groups.add.push({
          tier: 'add', stock: s,
          reason: `外資連買 ${trend.foreignStreak} 日、合計 ${fmtShares(inst.totalNet)}，可考慮加碼`,
        });
        continue;
      }

      // 等級 5：觀察中（持有或有 buyAt，但無強訊號）
      if (s.isHolding || s.buyAt != null) {
        const detail = s.buyAt && distBuy != null ? `距買點 ${fmtPct(distBuy)}`
          : distStop != null ? `距停損 ${fmtPct(distStop)}`
          : '持續追蹤法人動向';
        groups.watch.push({
          tier: 'watch', stock: s,
          reason: detail,
        });
      }
    }
    return groups;
  }, [stocks, instMap, trendMap, priceMap]);

  // ── AI 分析（Claude 或 Gemini，可切換）─────────────────────
  const [provider, setProvider] = useState<Provider>(() => {
    const saved = localStorage.getItem(STORAGE_PROVIDER);
    return (saved === 'claude' || saved === 'gemini') ? saved : 'claude';
  });
  const [apiKey, setApiKey] = useState('');   // 當前 provider 的 key
  const [reserveCash, setReserveCash] = useState<number>(() => {
    const saved = localStorage.getItem(STORAGE_RESERVE_CASH);
    const n = saved != null ? Number(saved) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<string | null>(() => localStorage.getItem(STORAGE_LAST_RESULT));
  const [aiResultTime, setAiResultTime] = useState<string | null>(() => localStorage.getItem(STORAGE_LAST_TIME));
  const [aiResultProvider, setAiResultProvider] = useState<string | null>(() => localStorage.getItem(STORAGE_LAST_PROVIDER));
  const [aiError, setAiError] = useState<string | null>(null);
  const [copyOk, setCopyOk] = useState(false);
  const [tick, setTick] = useState(0);   // 每 30 秒 bump 一次讓時段限制自動重新評估
  const [marketCtx, setMarketCtx] = useState<MarketContext | null>(null);

  // 當 provider 變動或啟動時，從對應 storage 載入 key
  useEffect(() => {
    const saved = localStorage.getItem(PROVIDERS[provider].storageKey) ?? '';
    setApiKey(saved);
    setShowKeyInput(!saved);   // 無 key 自動展開設定區
  }, [provider]);

  // 每 30 秒讓所有模式狀態重新計算（讓窗口過渡時按鈕自動解鎖/鎖定）
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // 每個模式各自的時段狀態
  // Gemini 免費，跳過所有時段/頻率限制；Claude 維持原本嚴格規則
  const modeStates = useMemo(() => {
    if (provider === 'gemini') {
      const open = { allowed: true } as ReturnType<typeof getModeState>;
      return { premarket: open, intraday: open, postclose: open };
    }
    return {
      premarket: getModeState(MODE_CONFIGS.premarket),
      intraday:  getModeState(MODE_CONFIGS.intraday),
      postclose: getModeState(MODE_CONFIGS.postclose),
    };
  }, [tick, aiResult, provider]);

  // 紀錄上次點哪個模式（用於 result 顯示時的標題）— 也從 localStorage 還原
  const [lastMode, setLastMode] = useState<AiMode | null>(() => {
    const saved = localStorage.getItem(STORAGE_LAST_MODE);
    return (saved === 'premarket' || saved === 'intraday' || saved === 'postclose') ? saved : null;
  });

  function saveApiKey(k: string) {
    setApiKey(k);
    const sk = PROVIDERS[provider].storageKey;
    if (k) localStorage.setItem(sk, k);
    else   localStorage.removeItem(sk);
  }

  function changeProvider(next: Provider) {
    setProvider(next);
    localStorage.setItem(STORAGE_PROVIDER, next);
  }

  function saveReserveCash(n: number) {
    const safe = Math.max(0, Math.floor(n));
    setReserveCash(safe);
    if (safe > 0) localStorage.setItem(STORAGE_RESERVE_CASH, String(safe));
    else          localStorage.removeItem(STORAGE_RESERVE_CASH);
  }

  // 把持倉資料轉成 markdown table 給 Claude 看
  function buildStocksTable(): string {
    const rows = stocks
      .filter(s => holdingsMap[s.stockCode] && priceMap[s.stockCode])
      .map(s => {
        const h = holdingsMap[s.stockCode];
        const p = priceMap[s.stockCode];
        const dayPnl = h.totalShares * p.changeAbs;
        return {
          code: s.stockCode, name: s.stockName,
          price: p.price, pct: p.pct,
          dayPnl, totalShares: h.totalShares,
          avgCost: h.avgCost,
        };
      })
      .sort((a, b) => Math.abs(b.dayPnl) - Math.abs(a.dayPnl));

    if (rows.length === 0) return '（無持倉資料）';

    let table = '| 代號 | 名稱 | 現價 | 漲跌% | 今日盈虧 | 持有股數 | 平均成本 |\n';
    table    += '|------|------|------|------|---------|---------|---------|\n';
    for (const r of rows) {
      table += `| ${r.code} | ${r.name} | $${fmt(r.price, 2)} | ${fmtPct(r.pct)} | ${r.dayPnl >= 0 ? '+' : ''}$${fmt(r.dayPnl)} | ${fmt(r.totalShares)} | $${fmt(r.avgCost, 2)} |\n`;
    }
    return table;
  }

  // 把雷達清單法人資料轉成 markdown table
  function buildRadarTable(): string {
    const rows = stocks.map(s => {
      const inst = instMap[s.stockCode];
      const trend = trendMap[s.stockCode];
      const tech = techMap[s.stockCode];
      const margin = marginMap[s.stockCode];
      const price = priceMap[s.stockCode];
      const sig = getSignal(s, inst, trend, techMap[s.stockCode]);
      return { s, inst, trend, tech, margin, price, sig };
    });

    if (rows.length === 0) return '（雷達清單為空）';

    // 主表：保持精簡（市況數據用）
    let table = '| 代號 | 名稱 | 市場 | 持有 | 現價 | 漲跌% | 燈號 | 外資 | 投信 | 自營 | 合計 | 連續性 |\n';
    table    += '|------|------|------|------|------|------|------|------|------|------|------|--------|\n';
    for (const { s, inst, trend, price, sig } of rows) {
      const sigText = SIGNAL_LABEL[sig];
      const priceText = price ? `$${fmt(price.price, 2)}` : '—';
      const pctText = price ? fmtPct(price.pct) : '—';
      const foreign = inst ? fmtShares(inst.foreignNet) : '—';
      const trust   = inst ? fmtShares(inst.trustNet)   : '—';
      const dealer  = inst ? fmtShares(inst.dealerNet)  : '—';
      const total   = inst ? fmtShares(inst.totalNet)   : '—';
      const streak  = trend && Math.abs(trend.foreignStreak) >= 2
        ? `外資${trend.foreignStreak > 0 ? '連買' : '連賣'}${Math.abs(trend.foreignStreak)}日`
        : '—';
      table += `| ${s.stockCode} | ${s.stockName} | ${s.market} | ${s.isHolding ? '是' : '否'} | ${priceText} | ${pctText} | ${sigText} | ${foreign} | ${trust} | ${dealer} | ${total} | ${streak} |\n`;
    }

    // 融資融券表（散戶情緒）— 只列有資料的
    const withMargin = rows.filter(r => r.margin);
    if (withMargin.length > 0) {
      table += '\n【融資融券（散戶情緒）— 單位：張】\n';
      table += '| 代號 | 融資餘額 | 融資增減 | 融券餘額 | 融券增減 | 訊號解讀 |\n';
      table += '|------|---------|---------|---------|---------|---------|\n';
      for (const { s, margin, inst } of withMargin) {
        if (!margin) continue;
        // 訊號解讀（與法人對照）
        let signal = '—';
        if (inst) {
          const foreignBuy = inst.foreignNet > 0;
          const marginUp = margin.marginChange > 0;
          if (foreignBuy && !marginUp) signal = '👍 法人吃貨、散戶不追（真強）';
          else if (foreignBuy && marginUp) signal = '⚠ 法人買+散戶追（要小心）';
          else if (!foreignBuy && marginUp) signal = '⚠ 法人賣+散戶接（高危）';
          else if (!foreignBuy && !marginUp) signal = '同向出貨';
        }
        const sign = (n: number) => n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString();
        table += `| ${s.stockCode} | ${margin.marginBalance.toLocaleString()} | ${sign(margin.marginChange)} | ${margin.shortBalance.toLocaleString()} | ${sign(margin.shortChange)} | ${signal} |\n`;
      }
    }

    // 歷史回測：每支股票「外資連買 3 日」訊號的實證勝率
    const withBacktest = rows.filter(r => {
      const b = backtestMap[r.s.stockCode];
      return b && b.greenSignalCount >= 3 && b.greenWinRate5d != null;
    });
    if (withBacktest.length > 0) {
      table += '\n【歷史回測（過去 90 天「外資連買 3 日」後表現）】\n';
      table += '| 代號 | 觸發次數 | 5日勝率 | 5日平均報酬 | 10日勝率 | 10日平均報酬 |\n';
      table += '|------|---------|--------|------------|---------|--------------|\n';
      for (const { s } of withBacktest) {
        const b = backtestMap[s.stockCode];
        if (!b) continue;
        const wr5  = b.greenWinRate5d   != null ? `${b.greenWinRate5d.toFixed(0)}%`   : '—';
        const ar5  = b.greenAvgReturn5d != null ? `${b.greenAvgReturn5d >= 0 ? '+' : ''}${b.greenAvgReturn5d.toFixed(2)}%` : '—';
        const wr10 = b.greenWinRate10d  != null ? `${b.greenWinRate10d.toFixed(0)}%`  : '—';
        const ar10 = b.greenAvgReturn10d!= null ? `${b.greenAvgReturn10d >= 0 ? '+' : ''}${b.greenAvgReturn10d.toFixed(2)}%` : '—';
        table += `| ${s.stockCode} | ${b.greenSignalCount} | ${wr5} | ${ar5} | ${wr10} | ${ar10} |\n`;
      }
      table += '↑ 勝率 < 50% 或平均報酬負 = 此股的「連買訊號」歷史上不可靠，AI 給建議時應大幅降低信心\n';
    }

    // 基本面表（P/E, EPS, 殖利率）— 只列有資料的
    const withFund = rows.filter(r => fundMap[r.s.stockCode]);
    if (withFund.length > 0) {
      table += '\n【基本面】\n';
      table += '| 代號 | P/E | EPS | 殖利率 |\n';
      table += '|------|-----|-----|--------|\n';
      for (const { s } of withFund) {
        const f = fundMap[s.stockCode];
        if (!f) continue;
        const peText  = f.pe  != null ? f.pe.toFixed(1)  : '—';
        const epsText = f.eps != null ? f.eps.toFixed(2) : '—';
        const dyText  = f.dividendYield != null && f.dividendYield > 0
          ? `${f.dividendYield.toFixed(1)}%` : '—';
        table += `| ${s.stockCode} | ${peText} | ${epsText} | ${dyText} |\n`;
      }
    }

    // 技術指標表（RSI/KD/MACD/ATR/動能）— 只列有資料的
    const withTech = rows.filter(r => r.tech);
    if (withTech.length > 0) {
      table += '\n【技術指標】\n';
      table += '| 代號 | RSI(14) | K | D | MACD | ATR(14) | 20日漲跌 | 距60日高 | 訊號 |\n';
      table += '|------|---------|---|---|------|---------|----------|----------|------|\n';
      for (const { s, tech } of withTech) {
        if (!tech) continue;
        const rsiText = tech.rsi14 != null ? tech.rsi14.toFixed(0) + (tech.rsi14 > 70 ? '（超買）' : tech.rsi14 < 30 ? '（超賣）' : '') : '—';
        const kText   = tech.kdK   != null ? tech.kdK.toFixed(0)  : '—';
        const dText   = tech.kdD   != null ? tech.kdD.toFixed(0)  : '—';
        // MACD 柱狀正負方向
        const macdText = tech.macdHist != null
          ? (tech.macdHist > 0 ? `紅柱 +${tech.macdHist.toFixed(2)}` : `綠柱 ${tech.macdHist.toFixed(2)}`)
          : '—';
        // ATR：絕對值 + 占收盤百分比（給 AI 估停損用）
        const atrText = tech.atr14 != null && tech.lastClose > 0
          ? `±${tech.atr14.toFixed(2)} 元 (${(tech.atr14 / tech.lastClose * 100).toFixed(1)}%)`
          : '—';
        // 20 日漲跌 + 強弱標籤
        const r20Text = tech.return20d != null
          ? `${tech.return20d >= 0 ? '+' : ''}${tech.return20d.toFixed(1)}%${
              tech.return20d >= 15 ? '（強勢）'
              : tech.return20d <= -10 ? '（弱勢）'
              : ''}`
          : '—';
        // 距 60 日高 + 位階標籤
        const distHText = tech.distFromHigh60d != null
          ? `${tech.distFromHigh60d.toFixed(1)}%${
              tech.distFromHigh60d >= -2 ? '（近高點）'
              : tech.distFromHigh60d <= -15 ? '（深回檔）'
              : ''}`
          : '—';
        // 簡易訊號
        let sig = '—';
        if (tech.kdK != null && tech.kdD != null) {
          if (tech.kdK > tech.kdD && tech.kdK < 30) sig = 'KD 低檔黃金交叉';
          else if (tech.kdK < tech.kdD && tech.kdK > 70) sig = 'KD 高檔死亡交叉';
          else if (tech.kdK > 80) sig = 'KD 過熱';
          else if (tech.kdK < 20) sig = 'KD 過冷';
        }
        table += `| ${s.stockCode} | ${rsiText} | ${kText} | ${dText} | ${macdText} | ${atrText} | ${r20Text} | ${distHText} | ${sig} |\n`;
      }
      table += '\n（停損建議：進場價 - 2×ATR 為合理初始停損；過熱時可改用 1.5×ATR；ATR 占收盤 > 5% 為高波動股，需縮小部位）\n';
      table += '（位階判讀：距 60 日高 -2% 內 = 追高風險高、需等回檔；-15% 以下 + 法人轉買 = 回檔買點；20 日漲跌 > +15% 視為動能強，但需配合大盤確認）\n';
    }

    // 附加區塊：使用者自己填的目標價、策略、觀察重點（只列出有填的）
    const withNotes = rows.filter(({ s }) =>
      s.buyAt != null || s.stopLoss != null || s.targetShares != null
      || (s.note && s.note !== '自持倉同步') || s.remark
    );
    if (withNotes.length > 0) {
      table += '\n\n【使用者觀察筆記】（請務必整合進你的建議）\n';
      for (const { s } of withNotes) {
        const parts: string[] = [];
        if (s.buyAt != null)        parts.push(`目標買入 $${fmt(s.buyAt, 1)}`);
        if (s.stopLoss != null)     parts.push(`停損 $${fmt(s.stopLoss, 1)}`);
        if (s.targetShares != null) parts.push(`目標 ${s.targetShares.toLocaleString()} 股`);
        if (s.note && s.note !== '自持倉同步') parts.push(`策略「${s.note}」`);
        if (s.remark)                parts.push(`觀察「${s.remark}」`);
        table += `- ${s.stockCode} ${s.stockName}：${parts.join('、')}\n`;
      }
    }

    return table;
  }

  // 每個模式有不同 prompt（焦點不同）
  // 把 MarketContext 格式化成 prompt 用的字串
  function fmtMarketCtx(ctx: MarketContext | null): string {
    if (!ctx) return '（無大盤資料）';
    const parts: string[] = [];
    const fmt2 = (v: number) => v.toFixed(2);
    const pct  = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
    if (ctx.taiex)     parts.push(`加權 ${fmt2(ctx.taiex.value)} (${pct(ctx.taiex.changePct)})`);
    if (ctx.otc)       parts.push(`櫃買 ${fmt2(ctx.otc.value)} (${pct(ctx.otc.changePct)})`);
    if (ctx.esFutures) parts.push(`S&P 期 ${fmt2(ctx.esFutures.value)} (${pct(ctx.esFutures.changePct)})`);
    if (ctx.usdTwd)    parts.push(`USD/TWD ${fmt2(ctx.usdTwd.value)} (${pct(ctx.usdTwd.changePct)})`);
    return parts.length > 0 ? parts.join('｜') : '（大盤資料抓取失敗）';
  }

  // 把 recent recommendations 格式化成「自我對帳」段落
  function fmtRecentRecs(recs: Array<{
    stockCode: string; mode: string; buyAt?: number; stopLoss?: number;
    confidence?: number; priceAtRec?: number; recommendedAt: string;
  }>): string {
    if (recs.length === 0) return '（無過往建議紀錄）';
    const modeLabel: Record<string, string> = { premarket: '盤前', intraday: '盤中', postclose: '盤後' };
    return recs.map(r => {
      const date = r.recommendedAt.slice(5, 16).replace('T', ' ');
      const ml = modeLabel[r.mode] ?? r.mode;
      const stock = stocks.find(s => s.stockCode === r.stockCode);
      const name = stock?.stockName ?? r.stockCode;
      const now = priceMap[r.stockCode]?.price;
      const diff = r.priceAtRec && now ? ((now - r.priceAtRec) / r.priceAtRec * 100) : null;
      const parts: string[] = [];
      if (r.buyAt) parts.push(`buyAt=$${r.buyAt}`);
      if (r.stopLoss) parts.push(`stopLoss=$${r.stopLoss}`);
      if (r.confidence != null) parts.push(`信心${r.confidence}`);
      const action = parts.length > 0 ? parts.join('、') : '無具體數字';
      const priceLine = (r.priceAtRec && now)
        ? `當時 $${r.priceAtRec.toFixed(2)} → 現在 $${now.toFixed(2)} (${diff && diff >= 0 ? '+' : ''}${diff?.toFixed(2)}%)`
        : '價格資料不完整';
      return `- ${date} ${ml} ${r.stockCode} ${name}：${action} | ${priceLine}`;
    }).join('\n');
  }

  function buildPrompt(
    mode: AiMode,
    ctx: MarketContext | null = null,
    recentRecs: Array<{
      stockCode: string; mode: string; buyAt?: number; stopLoss?: number;
      confidence?: number; priceAtRec?: number; recommendedAt: string;
    }> = [],
  ): string {
    const dateTime = `${today} ${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`;
    const common = `【市場環境（即時）】
${fmtMarketCtx(ctx)}
↑ 請務必把大盤方向、美股期貨方向、新台幣強弱納入判斷
（例：大盤跌 + 美期跌 + 新台幣貶 → 外資撤出，個股訊號要保守）

【目前持倉】
${buildStocksTable()}

【雷達清單法人數據】
${buildRadarTable()}

【戰備現金】${reserveCash > 0 ? `NT$${reserveCash.toLocaleString()}` : '（未設定，請使用者依自身狀況評估部位）'}

【你過去 7 天的 AI 建議回顧（自我對帳）】
${fmtRecentRecs(recentRecs)}
↑ 對照「當時建議價」與「現在實際價」：
  - 若上次預測過於樂觀（買點太高、停損太鬆），這次給更保守的建議
  - 若預測準確（價格走進你的買點區），可維持類似邏輯
  - 若預測完全相反（建議買但價格大跌），明確承認並調整方法
  - 在你的分析段落要主動提及 1-2 個明顯對錯的回顧，建立信任`;

    // 結構化建議區塊（讓系統能解析後自動填入雷達股的目標價/策略/觀察）
    const updatesSuffix = `

---
**【結構化建議】（必填、固定格式）**

請在回答最後額外輸出一個 JSON 區塊，系統會解析後讓使用者選擇套用更新到雷達股紀錄。格式如下（用 \`\`\`json 代碼塊包起來）：

\`\`\`json
{
  "updates": [
    { "stockCode": "3231", "buyAt": 145, "stopLoss": 135, "targetShares": 5000, "confidence": 75, "note": "等回測 $143-146 進場、預計 5 張", "remark": "外資連 2 日大買 + 法人合計 +3372 萬" },
    { "stockCode": "6669", "buyAt": 5300, "stopLoss": 5200, "targetShares": 1000, "confidence": 55, "note": "等均線死叉修復後再進場、預計 1 張" }
  ],
  "noAction": [
    { "stockCode": "2330", "reason": "已持有 + 法人小買 + 接近壓力區，今日無操作必要" },
    { "stockCode": "8028", "reason": "剛漲停追高風險、隔日易回測，先觀望" }
  ]
}
\`\`\`

**【targetShares 單位重要】**：必須是「**股**」不是「張」。台股 1 張 = 1000 股。
- 你想建議買 5 張 → targetShares: 5000
- 想建議買 2 張 → targetShares: 2000
- 高價股（如台積電 $2300+）建議買 1000 股以下時，targetShares 可以是 100, 500, 1000 等小單位（零股）

**強制規則（不可省略）：**
1. **每一支「持有=是」的股票**：必須在 update 中提供 stopLoss（這是保護資金的底線，絕對不可省）
   - **停損計算優先用 ATR**：stopLoss = buyAt - 2×ATR（一般股）或 buyAt - 1.5×ATR（過熱/橘燈）
   - 同時參考技術支撐（如 MA20/MA60、近期低點），取兩者較合理的較大值
   - 高波動股（ATR/收盤 > 5%）需注意停損幅度，可考慮縮減部位而非放大停損
2. **凡是你給出任何「進場 / 加碼 / 佈局 / 觀察進場 / 可分批 / 區間買進」等正向動作建議的股票（只要燈號不是紅燈都包含 — 綠/橘/黃/灰 都算）**：必須同時提供 **buyAt + stopLoss + targetShares**（三者缺一不可）
   - **targetShares 計算原則**：${reserveCash > 0 ? `依【戰備現金】NT$${reserveCash.toLocaleString()}、現有持倉、單支不超過 30% 戰備現金、買入金額 = buyAt × targetShares 來推估合理張數，再 ×1000 換算成股` : '使用者未提供戰備現金，請給保守起手量（如 1000 股、單張零股或 1-2 張），讓使用者依自身狀況調整'}
   - 包含但不限於：綠燈直接買、黃燈持有加碼、灰燈待法人確認時的觀察價、橘燈反向看好等
   - 即使該股當日漲停或位於相對高點，也要給：在 note 中說明「等回測至 X 元再進」，並把 buyAt 設為合理回測價位（例如現價 -5% ~ -8%），stopLoss 設為更深支撐
   - 不可因為「追高風險」而完全不給 — 這會讓使用者沒有可操作的數字
3. **僅有「紅燈」可以不給 buyAt/stopLoss/targetShares**（因為你預設不建議進場）；但若你罕見地建議逆勢進場紅燈股，仍需給三個數字
4. **持倉股的 note**：若 note 仍是「自持倉同步」，請改寫為實質策略（例如「持有觀察、跌破 X 停損」）

**【信心度 confidence 必填】**：
- 每一筆 update **必須**附 \`confidence\` 整數（0-100），代表你對這筆建議的把握度
- 80+ = 高信心（多訊號齊發、勝率高）
- 50-79 = 中信心（部份訊號支持，需配合大盤）
- 30-49 = 低信心（可選擇性參考，使用者自己再判斷）
- < 30 的建議請不要給，省略整支股票

**【noAction 列表（建議但非必填）】**：
- 對於你判斷「今日不需操作」的雷達股，加進 \`noAction\` 陣列，附簡短 reason
- 例：已持有但訊號中性、進場價遠、剛大漲追高風險高、需等更明確訊號
- 目的：避免使用者過度操作 + 讓使用者看到你「主動排除」哪些不需動

**一般規則：**
- 不建議更動的欄位請省略該 key（不要寫 null）
- 數字欄位用 number 型別，文字欄位用 string
- 必須是合法 JSON
- 這個區塊放在所有分析文字的**最後**，使用者主要看你前面的分析、後面交給系統處理`;

    switch (mode) {
      case 'premarket':
        return `你是一位專業台股私人財富經理人。
今日日期：${dateTime}（盤前分析）

${common}

請執行盤前分析（精簡實用，控制在 500-800 字）：
1. 根據前日法人動向預判今日盤面方向（多/空/震盪）
2. 列出今日重點觀察股（持倉風險 + 雷達進場機會）
3. 給出盤前操作策略（限價單建議價位）
4. 提醒可能影響盤面的事件（除權息、財報、外資匯出入）
請用繁體中文回答，分段清晰。${updatesSuffix}`;

      case 'intraday':
        return `你是一位專業台股私人財富經理人。
今日日期：${dateTime}（盤中即時分析）

${common}

請執行盤中分析（**簡潔扼要、盤中時間寶貴，控制在 300-500 字**）：
1. 評估持倉當前表現，列出需要即時調整的個股
2. 雷達股是否觸及進場/停損價，立即動作建議
3. 盤中量價是否出現異常訊號
4. 給出短線操作優先級
請用繁體中文回答。${updatesSuffix}`;

      case 'postclose':
        return `你是一位專業台股私人財富經理人。
今日日期：${dateTime}（盤後結算）

${common}

請執行盤後結算（**控制在 1500 字內，務必預留空間給最後的結構化 JSON**）：
1. 計算今日總損益變化
2. 分析各持倉今日表現
3. 根據法人數據更新各雷達股燈號評估
4. 給出明日操作預案
請用繁體中文回答，格式清晰。${updatesSuffix}`;
    }
  }

  // ── 解析 AI 回應中的 JSON 區塊 ──────────────────────────────
  interface AiUpdate {
    stockCode: string;
    buyAt?: number;
    stopLoss?: number;
    targetShares?: number;
    note?: string;
    remark?: string;
    confidence?: number;   // 0-100；AI 自評信心度
  }
  interface AiNoAction {
    stockCode: string;
    reason?: string;
  }
  interface AiResponseBlock {
    updates?: AiUpdate[];
    noAction?: AiNoAction[];
  }
  interface DiffRow {
    stock: RadarStock;
    update: AiUpdate;
    changes: Array<{ field: Exclude<keyof AiUpdate, 'confidence' | 'stockCode'>; oldVal: string; newVal: string }>;
  }

  /** 從 AI 回應提取完整 JSON block（updates + noAction）*/
  function extractAiBlock(text: string): AiResponseBlock | null {
    const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
    if (matches.length === 0) return null;
    const lastBlock = matches[matches.length - 1][1].trim();
    try {
      return JSON.parse(lastBlock) as AiResponseBlock;
    } catch {
      return null;
    }
  }

  /** 只取 updates 陣列 */
  function extractUpdates(text: string): AiUpdate[] | null {
    const block = extractAiBlock(text);
    if (!block?.updates || !Array.isArray(block.updates)) return null;
    return block.updates.filter(u => typeof u.stockCode === 'string' && u.stockCode);
  }

  /** 取 noAction 列表（AI 主動排除的股票）*/
  function extractNoAction(text: string): AiNoAction[] {
    const block = extractAiBlock(text);
    if (!block?.noAction || !Array.isArray(block.noAction)) return [];
    return block.noAction.filter(n => typeof n.stockCode === 'string' && n.stockCode);
  }

  /** 與目前 DB 對比，回傳「真的有變動」的清單 */
  function computeDiffs(updates: AiUpdate[]): DiffRow[] {
    const out: DiffRow[] = [];
    for (const u of updates) {
      const stock = stocks.find(s => s.stockCode === u.stockCode);
      if (!stock) continue;
      const changes: DiffRow['changes'] = [];
      const priceStr  = (n: number | null | undefined) => n == null ? '—' : `$${n}`;
      const sharesStr = (n: number | null | undefined) => n == null ? '—' : `${n.toLocaleString()} 股`;
      if (u.buyAt        !== undefined && u.buyAt !== stock.buyAt)
        changes.push({ field: 'buyAt', oldVal: priceStr(stock.buyAt), newVal: priceStr(u.buyAt) });
      if (u.stopLoss     !== undefined && u.stopLoss !== stock.stopLoss)
        changes.push({ field: 'stopLoss', oldVal: priceStr(stock.stopLoss), newVal: priceStr(u.stopLoss) });
      if (u.targetShares !== undefined && u.targetShares !== stock.targetShares)
        changes.push({ field: 'targetShares', oldVal: sharesStr(stock.targetShares), newVal: sharesStr(u.targetShares) });
      if (u.note         !== undefined && (u.note ?? '') !== (stock.note ?? ''))
        changes.push({ field: 'note', oldVal: stock.note ?? '—', newVal: u.note });
      if (u.remark       !== undefined && (u.remark ?? '') !== (stock.remark ?? ''))
        changes.push({ field: 'remark', oldVal: stock.remark ?? '—', newVal: u.remark });
      if (changes.length > 0) out.push({ stock, update: u, changes });
    }
    return out;
  }

  async function handleAnalyze(mode: AiMode) {
    if (!apiKey.trim()) {
      setAiError(`請先輸入 ${PROVIDERS[provider].label} API Key`);
      setShowKeyInput(true);
      return;
    }
    const state = modeStates[mode];
    if (!state.allowed) {
      setAiError(state.reason ?? '目前無法執行此模式');
      return;
    }
    setLastMode(mode);
    setAiLoading(true);
    setAiError(null);
    setAiResult(null);
    try {
      // 先抓大盤 context（即時，跟 Yahoo 拿 ^TWII / ^TWOII / ES=F / TWD=X）
      let ctx: MarketContext | null = null;
      try {
        ctx = await window.electronAPI.prices.marketContext() as MarketContext;
        setMarketCtx(ctx);
      } catch { /* 抓不到不阻塞分析 */ }

      // 抓最近 7 天 AI 過往建議（給 AI 自我對帳用）
      type RecentRec = {
        stockCode: string; mode: string; provider: string;
        buyAt?: number; stopLoss?: number; confidence?: number;
        note?: string; priceAtRec?: number; recommendedAt: string;
      };
      let recentRecs: RecentRec[] = [];
      try {
        recentRecs = await window.electronAPI.radar.aiRecRecent(7) as RecentRec[];
      } catch { /* ignore */ }

      // Dispatch 到對應 provider 的實作
      const text = await PROVIDERS[provider].call(apiKey, buildPrompt(mode, ctx, recentRecs));
      const nowIso = new Date().toISOString();
      setAiResult(text);
      setAiResultTime(nowIso);
      setAiResultProvider(provider);
      // 持久化：modal 關掉重開也能看到上次結果，避免重新跑浪費 token
      localStorage.setItem(STORAGE_LAST_RESULT, text);
      localStorage.setItem(STORAGE_LAST_TIME, nowIso);
      localStorage.setItem(STORAGE_LAST_PROVIDER, provider);
      localStorage.setItem(STORAGE_LAST_MODE, mode);
      // 成功後記錄該模式時間戳；Gemini 免費所以不限次數、不寫紀錄
      if (provider !== 'gemini') {
        localStorage.setItem(MODE_CONFIGS[mode].storageKey, new Date().toISOString());
      }

      // 儲存本次 AI 給的所有 update 建議進 DB（下次跑 AI 時自我對帳）
      try {
        const block = extractAiBlock(text);
        const updates = block?.updates ?? [];
        if (updates.length > 0) {
          const recs = updates.map(u => ({
            stockCode:    u.stockCode,
            mode,
            provider,
            buyAt:        u.buyAt,
            stopLoss:     u.stopLoss,
            targetShares: u.targetShares,
            confidence:   u.confidence,
            note:         u.note,
            priceAtRec:   priceMap[u.stockCode]?.price,
          }));
          await window.electronAPI.radar.aiRecSave(recs);
        }
      } catch (e) {
        console.warn('[AI] 儲存建議到 DB 失敗:', e);
      }
    } catch (e) {
      setAiError(`分析失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAiLoading(false);
    }
  }

  async function handleCopy() {
    if (!aiResult) return;
    try {
      // 複製時用乾淨版本（不含 JSON 區塊）
      await navigator.clipboard.writeText(displayedResult ?? aiResult);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 2000);
    } catch { /* ignore */ }
  }

  // 顯示給使用者的 markdown — 移除內部用的 ```json``` 建議區塊
  const displayedResult = useMemo(() => {
    if (!aiResult) return null;
    return aiResult.replace(/```json\s*[\s\S]*?```/g, '').trim();
  }, [aiResult]);

  // 解析 AI 建議並計算 diff（與當前 stocks 比較才知道真的有變動）
  const aiDiffs = useMemo<DiffRow[]>(() => {
    if (!aiResult) return [];
    const updates = extractUpdates(aiResult);
    if (!updates) return [];
    return computeDiffs(updates);
  }, [aiResult, stocks]);

  // AI 主動列出的「今日不操作」股票（NoAction list）
  const aiNoActions = useMemo<AiNoAction[]>(() => {
    if (!aiResult) return [];
    return extractNoAction(aiResult);
  }, [aiResult]);

  // 套用 UI 狀態
  const [showApplyPanel, setShowApplyPanel] = useState(false);
  const [selectedDiffs, setSelectedDiffs] = useState<Set<string>>(new Set());  // stockCode set
  const [applying, setApplying] = useState(false);
  const [applyDone, setApplyDone] = useState<number | null>(null);

  // 展開 panel 時預設全選
  useEffect(() => {
    if (showApplyPanel) {
      setSelectedDiffs(new Set(aiDiffs.map(d => d.stock.stockCode)));
    }
  }, [showApplyPanel, aiDiffs]);

  function toggleDiff(code: string) {
    setSelectedDiffs(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  async function applySelectedUpdates() {
    setApplying(true);
    let count = 0;
    try {
      for (const diff of aiDiffs) {
        if (!selectedDiffs.has(diff.stock.stockCode)) continue;
        const s = diff.stock;
        const u = diff.update;
        // 合併：保留沒被建議的舊欄位、用 AI 新值蓋掉建議的欄位
        await window.electronAPI.radar.update(s.id, {
          stockCode: s.stockCode,
          stockName: s.stockName,
          market:    s.market,
          buyAt:        u.buyAt        ?? s.buyAt,
          stopLoss:     u.stopLoss     ?? s.stopLoss,
          targetShares: u.targetShares ?? s.targetShares,
          note:         u.note         ?? s.note ?? undefined,
          remark:       u.remark       ?? s.remark ?? undefined,
          isHolding:    s.isHolding,
        });
        count++;
      }
      setApplyDone(count);
      setShowApplyPanel(false);
      onStocksChanged?.();   // 通知 parent 重抓 → diffs 會自動重算（消失）
      setTimeout(() => setApplyDone(null), 4000);
    } catch (e) {
      setAiError(`套用失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setApplying(false);
    }
  }

  // 欄位中文 label（給 diff UI 用）— confidence 不參與 diff 所以不放
  const FIELD_LABEL: Record<keyof Omit<AiUpdate, 'confidence'>, string> = {
    stockCode:    '代號',
    buyAt:        '目標買入',
    stopLoss:     '停損',
    targetShares: '目標股數',
    note:         '進場策略',
    remark:       '觀察重點',
  };

  return (
    <Modal title="📊 雷達分析報告" width="max-w-4xl" onClose={onClose}>
      <div className="max-h-[80vh] overflow-y-auto pr-1">

        {/* Sub-header: data freshness — sticky banner so date stays visible while scrolling */}
        <div className="sticky top-0 z-10 -mt-1 mb-4 bg-slate-800/80 backdrop-blur border border-slate-700 rounded-lg px-3 py-2 text-xs">
          <div className="text-slate-300">
            法人資料：<span className="font-medium">{instDate ?? '尚未抓取'}</span>
            {instDate && instDate !== today && <span className="ml-1 text-amber-500">（最近交易日）</span>}
            <span className="mx-2 text-slate-700">│</span>
            股價更新：<span className="font-medium">{updateTime}</span>
          </div>
          <div className="text-slate-500 mt-0.5">
            分析以現有資料為準；如需新資料請先關閉此視窗，按上方「更新法人資料」或「重整股價」後再開啟
          </div>
        </div>

        <div className="space-y-5">

        {stocks.length === 0 ? (
          <div className="text-center py-8 text-slate-500 text-sm">雷達清單為空，請先新增股票</div>
        ) : (
          <>
            {/* ── Section 1: 今日綜覽 ── */}
            <Section title="今日綜覽">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard
                  label="持倉今日盈虧"
                  value={summary.totalDayPnl}
                  format={v => (typeof v === 'number') ? `${v >= 0 ? '+' : ''}$${fmt(v)}` : '—'}
                  color={summary.totalDayPnl > 0 ? 'emerald' : summary.totalDayPnl < 0 ? 'red' : 'slate'}
                />
                <StatCard
                  label="雷達漲跌家數"
                  customValue={
                    <div className="text-lg font-bold tabular-nums">
                      <span className="text-emerald-400">↑{summary.up}</span>
                      <span className="text-slate-500 mx-1">/</span>
                      <span className="text-red-400">↓{summary.down}</span>
                      <span className="text-slate-500 mx-1">/</span>
                      <span className="text-slate-400">={summary.flat}</span>
                    </div>
                  }
                />
                <StatCard
                  label="今日最大漲幅"
                  customValue={
                    summary.topGainer ? (
                      <div>
                        <div className="text-sm font-bold text-slate-100 truncate">{summary.topGainer.code} {summary.topGainer.name}</div>
                        <div className="text-emerald-400 font-bold tabular-nums">{fmtPct(summary.topGainer.pct)}</div>
                      </div>
                    ) : <div className="text-slate-500 text-sm">—</div>
                  }
                />
                <StatCard
                  label="今日最大跌幅"
                  customValue={
                    summary.topLoser ? (
                      <div>
                        <div className="text-sm font-bold text-slate-100 truncate">{summary.topLoser.code} {summary.topLoser.name}</div>
                        <div className="text-red-400 font-bold tabular-nums">{fmtPct(summary.topLoser.pct)}</div>
                      </div>
                    ) : <div className="text-slate-500 text-sm">—</div>
                  }
                />
              </div>
            </Section>

            {/* ── 風險集中度警示（只在有持倉時顯示）── */}
            {concentration.items.length > 0 && (
              <Section title="風險集中度">
                <div className="space-y-1.5 text-xs">
                  {concentration.items.map(item => {
                    const tooHigh = item.pct > 30;
                    return (
                      <div key={item.code} className={clsx(
                        'flex items-center gap-2 px-3 py-1.5 rounded',
                        tooHigh ? 'bg-red-900/30 border border-red-900/60' : 'bg-slate-800/30',
                      )}>
                        <span className="font-medium text-slate-100 w-16">{item.code}</span>
                        <span className="text-slate-400 flex-1 truncate">{item.name}</span>
                        <span className="text-slate-500 tabular-nums">${fmt(Math.round(item.value))}</span>
                        <span className={clsx('tabular-nums font-bold w-14 text-right',
                          tooHigh ? 'text-red-400' : 'text-slate-300')}>
                          {item.pct.toFixed(1)}%
                        </span>
                        {tooHigh && (
                          <span className="text-[10px] text-red-300 font-medium">⚠ 集中</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {concentration.items.some(i => i.pct > 30) && (
                  <p className="mt-2 text-[11px] text-amber-400">
                    ⚠ 標示「集中」的個股佔投資組合超過 30%，建議分散風險。
                  </p>
                )}
              </Section>
            )}

            {/* ── Section 2: 持倉今日表現 ── */}
            <Section title="持倉今日表現" subtitle={`持倉 ${holdingsPerf.rows.length} 支｜${holdingsPerf.upCount} 漲 ${holdingsPerf.downCount} 跌`}>
              {holdingsPerf.rows.length === 0 ? (
                <p className="text-slate-600 text-sm italic">無持倉資料（自持倉同步尚未完成或股價未抓取）</p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-slate-800">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-slate-500 bg-slate-950">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">股票</th>
                        <th className="px-3 py-2 text-right font-medium">現價</th>
                        <th className="px-3 py-2 text-right font-medium">漲跌%</th>
                        <th className="px-3 py-2 text-right font-medium">今日盈虧</th>
                        <th className="px-3 py-2 text-right font-medium">持有</th>
                      </tr>
                    </thead>
                    <tbody>
                      {holdingsPerf.rows.map(r => {
                        const pos = r.dayPnl > 0;
                        const neg = r.dayPnl < 0;
                        return (
                          <tr key={r.stock.id} className="border-t border-slate-800/60 hover:bg-slate-800/30">
                            <td className="px-3 py-2">
                              <div className="font-medium text-slate-100">{r.stock.stockCode}</div>
                              <div className="text-xs text-slate-500">{r.stock.stockName}</div>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-slate-200">${fmt(r.price, 2)}</td>
                            <td className={clsx('px-3 py-2 text-right tabular-nums font-medium',
                              pos ? 'text-emerald-400' : neg ? 'text-red-400' : 'text-slate-400')}>
                              {fmtPct(r.pct)}
                            </td>
                            <td className={clsx('px-3 py-2 text-right tabular-nums font-bold',
                              pos ? 'text-emerald-400' : neg ? 'text-red-400' : 'text-slate-400')}>
                              {pos ? '+' : ''}${fmt(r.dayPnl)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-slate-400">{fmt(r.totalShares)} 股</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            {/* ── Section 3: 法人燈號分布 ── */}
            <Section title="法人燈號分布">
              <div className="flex items-center gap-2 flex-wrap mb-3">
                {(['green', 'orange', 'yellow', 'red', 'grey'] as Signal[]).map(sig => (
                  <div key={sig} className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-slate-800/60">
                    <span className={clsx('w-2 h-2 rounded-full shrink-0', SIGNAL_STYLE[sig].replace('animate-pulse', ''))} />
                    <span className="text-slate-400">{SIGNAL_LABEL[sig]}</span>
                    <span className="text-slate-200 font-bold tabular-nums ml-0.5">{signals.counts[sig]}</span>
                  </div>
                ))}
              </div>

              {(signals.sellWarns.length === 0 && signals.strongBuys.length === 0) ? (
                <p className="text-slate-600 text-sm italic">今日無強烈訊號</p>
              ) : (
                <div className="space-y-1.5">
                  {signals.sellWarns.map(s => {
                    const inst = instMap[s.stockCode];
                    return (
                      <div key={s.id} className="flex items-center gap-2 text-xs px-3 py-2 rounded bg-orange-900/20 border border-orange-900/40">
                        <span>🟠</span>
                        <span className="font-medium text-orange-300">{s.stockCode} {s.stockName}</span>
                        {inst && (
                          <span className="text-slate-400 ml-auto tabular-nums">
                            外資 {fmtShares(inst.foreignNet)}　合計 <span className="text-orange-300 font-medium">{fmtShares(inst.totalNet)}</span>
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {signals.strongBuys.map(s => {
                    const inst = instMap[s.stockCode];
                    return (
                      <div key={s.id} className="flex items-center gap-2 text-xs px-3 py-2 rounded bg-emerald-900/20 border border-emerald-900/40">
                        <span>🟢</span>
                        <span className="font-medium text-emerald-300">{s.stockCode} {s.stockName}</span>
                        {inst && (
                          <span className="text-slate-400 ml-auto tabular-nums">
                            外資 {fmtShares(inst.foreignNet)}　合計 <span className="text-emerald-300 font-medium">{fmtShares(inst.totalNet)}</span>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>

            {/* ── Section 4: 明日操作預案 ── */}
            <Section title="明日操作預案">
              {(['urgent', 'sell-warn', 'entry', 'add', 'watch'] as Tier[]).map(tier => {
                const items = recommendations[tier];
                if (items.length === 0) return null;
                const meta = TIER_META[tier];
                return (
                  <div key={tier} className="mb-3 last:mb-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-base">{meta.icon}</span>
                      <h4 className="text-sm font-semibold text-slate-200">{meta.label}</h4>
                      <span className="text-xs text-slate-500 tabular-nums">{items.length} 支</span>
                    </div>
                    <div className="space-y-1.5">
                      {items.map(r => {
                        const price = priceMap[r.stock.stockCode];
                        return (
                          <div key={r.stock.id}
                            className={clsx('px-3 py-2 rounded-lg border text-sm flex items-center gap-3 flex-wrap', meta.color)}>
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="font-bold text-slate-100">{r.stock.stockCode}</span>
                              <span className="text-slate-300 truncate">{r.stock.stockName}</span>
                              <span className={clsx('text-[10px] px-1.5 py-0.5 rounded font-medium', MARKET_BADGE[r.stock.market] ?? 'bg-slate-700 text-slate-300')}>
                                {r.stock.market}
                              </span>
                              {r.stock.isHolding && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/50 text-amber-300 font-medium">持有</span>
                              )}
                            </div>
                            <div className="text-xs text-slate-400 flex-1 min-w-[180px]">{r.reason}</div>
                            {price && (
                              <div className="text-xs tabular-nums text-slate-500">
                                ${fmt(price.price, 2)} <span className={price.pct >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtPct(price.pct)}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {(['urgent', 'sell-warn', 'entry', 'add', 'watch'] as Tier[]).every(t => recommendations[t].length === 0) && (
                <p className="text-slate-600 text-sm italic">無建議動作 — 雷達內所有股票均無觸發條件</p>
              )}
            </Section>

            {/* ── AI 分析（Claude API）三種模式 ── */}
            <Section title={`🤖 AI 分析（${PROVIDERS[provider].label}）`}>
              {/* Provider + API Key collapsible settings */}
              <div className="mb-3">
                <button
                  type="button"
                  onClick={() => setShowKeyInput(v => !v)}
                  className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
                >
                  {showKeyInput ? '▼' : '▶'} AI 設定
                  {apiKey && !showKeyInput && (
                    <span className="ml-2 text-emerald-500">✓ {PROVIDERS[provider].label} 已設定</span>
                  )}
                </button>
                {showKeyInput && (
                  <div className="mt-2 p-3 rounded-lg bg-slate-800/40 border border-slate-700 space-y-2">
                    {/* Provider 下拉選單 */}
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">AI Provider</label>
                      <select
                        value={provider}
                        onChange={e => changeProvider(e.target.value as Provider)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                      >
                        {Object.values(PROVIDERS).map(p => (
                          <option key={p.id} value={p.id}>{p.label}</option>
                        ))}
                      </select>
                    </div>

                    {/* API Key input — placeholder 跟著 provider 變 */}
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">API Key</label>
                      <input
                        type="password"
                        value={apiKey}
                        onChange={e => saveApiKey(e.target.value)}
                        placeholder={PROVIDERS[provider].keyPlaceholder}
                        className="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500 font-mono"
                      />
                    </div>

                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      API Key 請至 <span className="text-blue-400">{PROVIDERS[provider].consoleUrl}</span> 申請。
                      Key 僅保存在本機 localStorage、不會上傳任何伺服器。
                      切換 provider 後會自動載入該 provider 的 Key（兩組獨立）。
                    </p>

                    {/* 戰備現金（自行輸入；AI 用來推估 targetShares）*/}
                    <div className="pt-2 border-t border-slate-700/60">
                      <label className="block text-[11px] text-slate-500 mb-1">
                        戰備現金（可動用買股的 TWD 金額；空白 = 不告知 AI）
                      </label>
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500 text-sm">NT$</span>
                        <input
                          type="number"
                          step="1000"
                          min="0"
                          value={reserveCash || ''}
                          onChange={e => saveReserveCash(Number(e.target.value) || 0)}
                          placeholder="例：100000"
                          className="flex-1 bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500 font-mono tabular-nums"
                        />
                        {reserveCash > 0 && (
                          <span className="text-xs text-emerald-400 font-medium tabular-nums">
                            {reserveCash.toLocaleString()}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[10px] text-slate-600">
                        AI 會用這個金額算「每支股票最多投入多少（預設單支不超過 30%）」並建議 targetShares。
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* 3 mode buttons */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                {(['premarket', 'intraday', 'postclose'] as AiMode[]).map(mode => {
                  const cfg = MODE_CONFIGS[mode];
                  const state = modeStates[mode];
                  const isCurrentLoading = aiLoading && lastMode === mode;
                  const disabled = aiLoading || !state.allowed;
                  return (
                    <div key={mode} className="flex flex-col">
                      <button
                        type="button"
                        onClick={() => handleAnalyze(mode)}
                        disabled={disabled}
                        className={clsx(
                          'text-sm px-3 py-3 rounded-lg font-medium transition-colors text-white text-left',
                          isCurrentLoading
                            ? 'bg-slate-700 text-slate-400 cursor-wait'
                            : !state.allowed
                            ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                            : `bg-gradient-to-r ${cfg.gradient}`,
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{state.allowed && !isCurrentLoading ? cfg.icon : '🔒'}</span>
                          <span className="font-bold">{cfg.label}</span>
                        </div>
                        <div className={clsx('text-[11px] mt-0.5',
                          state.allowed ? 'text-white/80' : 'text-slate-600')}>
                          {isCurrentLoading
                            ? '分析中...'
                            : state.allowed
                            ? `${cfg.windowLabel}　就緒`
                            : state.reason}
                        </div>
                        {!state.allowed && state.nextAt && (
                          <div className="text-[10px] text-slate-600 mt-0.5">
                            下次：{state.nextAt}
                          </div>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>

              <p className="mt-2 text-[11px] text-slate-600">
                {provider === 'gemini' ? (
                  <>ⓘ Gemini 免費，<span className="text-emerald-400">無時段/次數限制</span>，可隨時執行任一模式</>
                ) : (
                  <>ⓘ Claude：每模式每日僅可執行一次（週一至週五）；每次約 10-20 秒、消耗少量 API token</>
                )}
              </p>

              {/* Error */}
              {aiError && (
                <div className="mt-3 px-3 py-2 rounded-lg bg-red-900/30 border border-red-800 text-red-300 text-sm">
                  {aiError}
                </div>
              )}

              {/* Result */}
              {aiResult && (
                <div className="mt-3 bg-slate-800/40 border border-slate-700 rounded-lg">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 flex-wrap gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-slate-400 font-medium">
                        {lastMode ? `${MODE_CONFIGS[lastMode].icon} ${MODE_CONFIGS[lastMode].label}結果` : '分析結果'}
                      </span>
                      {aiResultTime && (
                        <span className="text-[10px] text-slate-600">
                          {new Date(aiResultTime).toLocaleString('zh-TW', {
                            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
                          })}
                          {aiResultProvider && ` · ${PROVIDERS[aiResultProvider as Provider]?.label ?? aiResultProvider}`}
                        </span>
                      )}
                      {/* 大盤 context — AI 分析所用的市場環境快照 */}
                      {marketCtx && (
                        <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
                          {marketCtx.taiex && (
                            <span className={clsx('px-1.5 py-0.5 rounded',
                              marketCtx.taiex.changePct >= 0 ? 'bg-emerald-900/40 text-emerald-300' : 'bg-red-900/40 text-red-300')}>
                              加權 {marketCtx.taiex.changePct >= 0 ? '+' : ''}{marketCtx.taiex.changePct.toFixed(2)}%
                            </span>
                          )}
                          {marketCtx.esFutures && (
                            <span className={clsx('px-1.5 py-0.5 rounded',
                              marketCtx.esFutures.changePct >= 0 ? 'bg-emerald-900/40 text-emerald-300' : 'bg-red-900/40 text-red-300')}>
                              美期 {marketCtx.esFutures.changePct >= 0 ? '+' : ''}{marketCtx.esFutures.changePct.toFixed(2)}%
                            </span>
                          )}
                          {marketCtx.usdTwd && (
                            <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">
                              USD/TWD {marketCtx.usdTwd.value.toFixed(2)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          if (!confirm('確定清空上次 AI 結果？')) return;
                          setAiResult(null);
                          setAiResultTime(null);
                          setAiResultProvider(null);
                          localStorage.removeItem(STORAGE_LAST_RESULT);
                          localStorage.removeItem(STORAGE_LAST_TIME);
                          localStorage.removeItem(STORAGE_LAST_PROVIDER);
                          localStorage.removeItem(STORAGE_LAST_MODE);
                        }}
                        className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-red-900/60 text-slate-400 hover:text-red-300 transition-colors"
                        title="清空上次結果"
                      >
                        🗑
                      </button>
                      <button
                        type="button"
                        onClick={handleCopy}
                        className={clsx(
                          'text-xs px-2 py-1 rounded transition-colors',
                          copyOk
                            ? 'bg-emerald-700 text-white'
                            : 'bg-slate-700 hover:bg-slate-600 text-slate-200'
                        )}
                      >
                        {copyOk ? '✓ 已複製' : '📋 複製結果'}
                      </button>
                    </div>
                  </div>
                  {/* AI 建議自動套用區（如有偵測到 ```json``` 區塊）*/}
                  {aiDiffs.length > 0 && (
                    <div className="px-3 py-2 border-b border-slate-700 bg-emerald-900/10">
                      {!showApplyPanel ? (
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="text-xs text-emerald-300">
                            💡 AI 建議更新 <span className="font-bold">{aiDiffs.length}</span> 支股票（{aiDiffs.reduce((s, d) => s + d.changes.length, 0)} 個欄位）
                          </span>
                          <button
                            type="button"
                            onClick={() => setShowApplyPanel(true)}
                            className="text-xs px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors"
                          >
                            預覽 / 套用
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-slate-300">
                              選取要套用的更新（{selectedDiffs.size}/{aiDiffs.length}）
                            </span>
                            <button
                              type="button"
                              onClick={() => setShowApplyPanel(false)}
                              className="text-xs text-slate-500 hover:text-slate-300"
                            >
                              收起
                            </button>
                          </div>
                          <div className="space-y-1.5 max-h-[260px] overflow-y-auto pr-1">
                            {aiDiffs.map(diff => {
                              const isSelected = selectedDiffs.has(diff.stock.stockCode);
                              return (
                                <label
                                  key={diff.stock.stockCode}
                                  className={clsx(
                                    'flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer text-xs border',
                                    isSelected
                                      ? 'bg-emerald-900/20 border-emerald-700/60'
                                      : 'bg-slate-800/30 border-slate-700/60 hover:bg-slate-800/60'
                                  )}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleDiff(diff.stock.stockCode)}
                                    className="mt-0.5 accent-emerald-500"
                                  />
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="font-bold text-slate-100">
                                        {diff.stock.stockCode} {diff.stock.stockName}
                                      </span>
                                      {/* AI 信心度 badge */}
                                      {typeof diff.update.confidence === 'number' && (
                                        <span
                                          title="AI 自評信心度"
                                          className={clsx(
                                            'text-[10px] px-1.5 py-0.5 rounded font-bold tabular-nums',
                                            diff.update.confidence >= 80 ? 'bg-emerald-900/60 text-emerald-300'
                                            : diff.update.confidence >= 50 ? 'bg-blue-900/60 text-blue-300'
                                            : diff.update.confidence >= 30 ? 'bg-amber-900/60 text-amber-300'
                                            : 'bg-slate-700 text-slate-400'
                                          )}
                                        >
                                          信心 {diff.update.confidence}
                                        </span>
                                      )}
                                    </div>
                                    <div className="mt-0.5 space-y-0.5">
                                      {diff.changes.map((c, i) => (
                                        <div key={i} className="text-slate-400">
                                          <span className="text-slate-500">{FIELD_LABEL[c.field]}：</span>
                                          <span className="text-slate-600 line-through mr-1">{c.oldVal}</span>
                                          <span className="text-emerald-300">→ {c.newVal}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                          <div className="flex items-center justify-end gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => setShowApplyPanel(false)}
                              className="text-xs px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200"
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              onClick={applySelectedUpdates}
                              disabled={applying || selectedDiffs.size === 0}
                              className="text-xs px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium"
                            >
                              {applying ? '套用中...' : `套用選取 (${selectedDiffs.size})`}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {applyDone != null && (
                    <div className="px-3 py-2 border-b border-slate-700 bg-emerald-900/30 text-xs text-emerald-300">
                      ✓ 已套用 {applyDone} 項到雷達清單
                    </div>
                  )}

                  {/* AI 主動排除「今日不操作」清單 */}
                  {aiNoActions.length > 0 && (
                    <div className="px-3 py-2 border-b border-slate-700 bg-slate-800/40">
                      <div className="text-xs text-slate-400 font-medium mb-1.5">
                        🛑 AI 建議「今日不操作」<span className="text-slate-600 ml-1">{aiNoActions.length} 支</span>
                      </div>
                      <div className="space-y-1">
                        {aiNoActions.map(n => {
                          const stock = stocks.find(s => s.stockCode === n.stockCode);
                          return (
                            <div key={n.stockCode} className="text-xs text-slate-400 px-2 py-1 rounded bg-slate-900/40">
                              <span className="font-medium text-slate-300">{n.stockCode}</span>
                              {stock && <span className="text-slate-500 ml-1">{stock.stockName}</span>}
                              {n.reason && <span className="text-slate-500"> — {n.reason}</span>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="px-4 py-3 text-sm text-slate-200 leading-relaxed max-h-[500px] overflow-y-auto">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        // 表格：套深色 theme + 邊框
                        table: ({ children }) => (
                          <div className="overflow-x-auto my-2">
                            <table className="w-full text-xs border-collapse">{children}</table>
                          </div>
                        ),
                        thead: ({ children }) => (
                          <thead className="bg-slate-800 text-slate-300">{children}</thead>
                        ),
                        th: ({ children }) => (
                          <th className="px-2 py-1.5 border border-slate-700 text-left font-semibold whitespace-nowrap">{children}</th>
                        ),
                        td: ({ children }) => (
                          <td className="px-2 py-1 border border-slate-800 align-top">{children}</td>
                        ),
                        tr: ({ children }) => (
                          <tr className="hover:bg-slate-800/40">{children}</tr>
                        ),
                        // 標題層級
                        h1: ({ children }) => <h1 className="text-base font-bold mt-4 mb-2 text-slate-100">{children}</h1>,
                        h2: ({ children }) => <h2 className="text-sm font-bold mt-3 mb-1.5 text-slate-100 border-b border-slate-700 pb-1">{children}</h2>,
                        h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1 text-slate-200">{children}</h3>,
                        h4: ({ children }) => <h4 className="text-sm font-medium mt-2 mb-1 text-slate-200">{children}</h4>,
                        // Bold / italic
                        strong: ({ children }) => <strong className="font-bold text-emerald-300">{children}</strong>,
                        em: ({ children }) => <em className="italic text-amber-300">{children}</em>,
                        // 段落 + 列表
                        p: ({ children }) => <p className="my-1.5">{children}</p>,
                        ul: ({ children }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5">{children}</ul>,
                        ol: ({ children }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5">{children}</ol>,
                        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                        // 引用 + 程式碼 + 分隔線
                        blockquote: ({ children }) => (
                          <blockquote className="border-l-2 border-blue-500 pl-3 my-2 text-slate-400 italic">{children}</blockquote>
                        ),
                        code: ({ children }) => (
                          <code className="bg-slate-800 px-1.5 py-0.5 rounded text-amber-300 text-xs font-mono">{children}</code>
                        ),
                        hr: () => <hr className="my-3 border-slate-700" />,
                      }}
                    >
                      {displayedResult ?? aiResult}
                    </ReactMarkdown>
                  </div>
                </div>
              )}
            </Section>
          </>
        )}
        </div>
      </div>
    </Modal>
  );
}

// ── Helpers ──────────────────────────────────────────────────────
function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-bold text-slate-100">{title}</h3>
        {subtitle && <span className="text-xs text-slate-500">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function StatCard({ label, value, format, color, customValue }: {
  label: string;
  value?: number;
  format?: (v: number) => string;
  color?: 'emerald' | 'red' | 'slate' | 'amber';
  customValue?: React.ReactNode;
}) {
  const colorClass = color === 'emerald' ? 'text-emerald-400'
    : color === 'red' ? 'text-red-400'
    : color === 'amber' ? 'text-amber-400'
    : 'text-slate-100';
  return (
    <div className="bg-slate-800/40 border border-slate-800 rounded-xl px-3 py-3">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      {customValue ?? (
        <div className={clsx('text-lg font-bold tabular-nums', colorClass)}>
          {value != null && format ? format(value) : (value != null ? fmt(value) : '—')}
        </div>
      )}
    </div>
  );
}
