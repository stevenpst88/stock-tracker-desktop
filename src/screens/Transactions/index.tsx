import { useState, useEffect, useCallback } from 'react';
import Modal from '../../components/Modal';
import CurrencyDisplay, { formatTWD } from '../../components/CurrencyDisplay';
import type { Transaction, Stock, AddTransactionInput, TxnType, DividendSyncItem } from '../../../shared/types';
import clsx from 'clsx';

const TYPE_LABELS: Record<TxnType, string> = { BUY: '買入', SELL: '賣出', DIVIDEND: '配息' };
const TYPE_COLORS: Record<TxnType, string> = {
  BUY:      'text-blue-400',
  SELL:     'text-red-400',
  DIVIDEND: 'text-amber-400',
};

export default function Transactions() {
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [showDividendForm, setShowDividendForm] = useState(false);
  const [editingTxn, setEditingTxn] = useState<Transaction | null>(null);
  const [filterCode, setFilterCode] = useState('');
  const [filterType, setFilterType] = useState<TxnType | ''>('');
  const [loading, setLoading] = useState(true);

  const stockMap = new Map(stocks.map(s => [s.code, s]));

  const loadTxns = useCallback(async () => {
    setLoading(true);
    const result = await window.electronAPI.transactions.list({
      stockCode: filterCode || undefined,
      type: (filterType as TxnType) || undefined,
    });
    setTxns(result);
    setLoading(false);
  }, [filterCode, filterType]);

  useEffect(() => {
    window.electronAPI.stocks.list().then(setStocks);
  }, []);

  useEffect(() => { loadTxns(); }, [loadTxns]);

  async function handleDelete(id: number) {
    if (!confirm('確定刪除此筆交易？此操作無法復原。')) return;
    await window.electronAPI.transactions.delete(id);
    loadTxns();
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-slate-100">交易紀錄</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowDividendForm(true)}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white text-sm rounded-lg transition-colors font-medium"
          >
            🌾 記錄配息
          </button>
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors font-medium"
          >
            + 新增交易
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <select
          value={filterCode}
          onChange={e => setFilterCode(e.target.value)}
          className="bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">全部股票</option>
          {stocks.map(s => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}
        </select>
        <select
          value={filterType}
          onChange={e => setFilterType(e.target.value as TxnType | '')}
          className="bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">全部類型</option>
          <option value="BUY">買入</option>
          <option value="SELL">賣出</option>
          <option value="DIVIDEND">配息</option>
        </select>
      </div>

      {loading ? (
        <p className="text-slate-400 text-sm">載入中...</p>
      ) : txns.length === 0 ? (
        <div className="text-center py-16 text-slate-500">
          <div className="text-4xl mb-3">≡</div>
          <p className="text-sm">尚無交易紀錄</p>
        </div>
      ) : (
        <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 border-b border-slate-800">
                {['日期', '股票', '類型', '股數', '單價', '手續費', '證交稅', '淨金額', '備註', ''].map(h => (
                  <th key={h} className="px-4 py-3 text-right first:text-left last:text-right">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {txns.map(t => (
                <tr key={t.id} className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                  <td className="px-4 py-3 text-slate-400">{t.date}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-100">{t.stockCode}</div>
                    <div className="text-xs text-slate-500">
                      {stockMap.get(t.stockCode)?.name ?? ''}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={clsx('font-medium', TYPE_COLORS[t.type])}>{TYPE_LABELS[t.type]}</span>
                  </td>
                  <td className="px-4 py-3 text-right text-slate-200">{t.shares.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-slate-200">{formatTWD(t.pricePerShare, 2)}</td>
                  <td className="px-4 py-3 text-right text-slate-400">{formatTWD(t.brokerageFee)}</td>
                  <td className="px-4 py-3 text-right text-slate-400">{formatTWD(t.transactionTax)}</td>
                  <td className="px-4 py-3 text-right">
                    <CurrencyDisplay value={t.netAmount} colorize showSign />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {t.notes ? (
                      <span className="text-xs text-slate-500 max-w-[100px] truncate inline-block" title={t.notes}>
                        {t.notes}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button
                        onClick={() => setEditingTxn(t)}
                        className="text-slate-500 hover:text-blue-400 transition-colors text-xs"
                      >
                        編輯
                      </button>
                      <button
                        onClick={() => handleDelete(t.id)}
                        className="text-slate-600 hover:text-red-400 transition-colors text-xs"
                      >
                        刪除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <TransactionForm
          stocks={stocks}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); loadTxns(); }}
        />
      )}

      {editingTxn && (
        <TransactionForm
          stocks={stocks}
          editingTxn={editingTxn}
          onClose={() => setEditingTxn(null)}
          onSaved={() => { setEditingTxn(null); loadTxns(); }}
        />
      )}

      {showDividendForm && (
        <DividendSyncModal
          onClose={() => setShowDividendForm(false)}
          onImported={() => { setShowDividendForm(false); loadTxns(); }}
        />
      )}
    </div>
  );
}

function TransactionForm({ stocks, editingTxn, onClose, onSaved }: {
  stocks: Stock[];
  editingTxn?: Transaction;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!editingTxn;
  const today = new Date().toISOString().slice(0, 10);

  const [stockCode, setStockCode] = useState(editingTxn?.stockCode ?? '');
  const [newStockName, setNewStockName] = useState('');
  const [newStockMarket, setNewStockMarket] = useState<'TWSE' | 'OTC' | 'ETF'>('TWSE');
  const [isNewStock, setIsNewStock] = useState(false);
  const [type, setType] = useState<TxnType>(editingTxn?.type ?? 'BUY');
  const [date, setDate] = useState(editingTxn?.date ?? today);
  const [shares, setShares] = useState(editingTxn ? String(editingTxn.shares) : '');
  const [price, setPrice] = useState(editingTxn ? String(editingTxn.pricePerShare) : '');
  const [brokerageFee, setBrokerageFee] = useState(editingTxn ? String(editingTxn.brokerageFee) : '');
  const [tax, setTax] = useState(editingTxn ? String(editingTxn.transactionTax) : '');
  const [notes, setNotes] = useState(editingTxn?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // 切換到配息時，清空費用欄位
  function handleTypeChange(t: TxnType) {
    setType(t);
    if (t === 'DIVIDEND') { setBrokerageFee('0'); setTax('0'); }
  }

  async function autoCalcFees() {
    const s = Number(shares);
    const p = Number(price);
    if (!s || !p) return;
    const fees = await window.electronAPI.transactions.calcFees({ type, shares: s, pricePerShare: p, stockCode: stockCode || undefined });
    setBrokerageFee(String(fees.brokerageFee));
    setTax(String(fees.transactionTax));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stockCode) { setError('請選擇或輸入股票代碼'); return; }
    if (!shares || !price) { setError('請填寫股數與單價'); return; }

    setSaving(true);
    setError('');
    try {
      if (!isEdit && isNewStock && newStockName) {
        await window.electronAPI.stocks.add({ code: stockCode, name: newStockName, market: newStockMarket });
      }
      const input: AddTransactionInput = {
        stockCode,
        type,
        date,
        shares: Number(shares),
        pricePerShare: Number(price),
        brokerageFee: Number(brokerageFee) || 0,
        transactionTax: Number(tax) || 0,
        notes: notes || undefined,
      };

      if (isEdit && editingTxn) {
        await window.electronAPI.transactions.update(editingTxn.id, input);
      } else {
        await window.electronAPI.transactions.add(input);
      }
      onSaved();
    } catch (e) {
      // 移除 Electron IPC 前綴，只顯示核心訊息
      const raw = String(e).replace(/^Error: Error invoking remote method '[^']+': /, '').replace(/^Error: /, '');
      setError(raw);
    } finally {
      setSaving(false);
    }
  }

  const inputClass = 'w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder:text-slate-600';

  return (
    <Modal title={isEdit ? '編輯交易' : '新增交易'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Stock selector */}
        <div>
          <label className="block text-xs text-slate-400 mb-1.5">股票</label>
          {isEdit ? (
            // 編輯模式：股票固定不可更改
            <div className={clsx(inputClass, 'opacity-60 cursor-not-allowed')}>
              {editingTxn?.stockCode} — {stocks.find(s => s.code === editingTxn?.stockCode)?.name}
            </div>
          ) : (
            <div className="flex gap-2">
              <select
                value={isNewStock ? '__new__' : stockCode}
                onChange={e => {
                  if (e.target.value === '__new__') { setIsNewStock(true); setStockCode(''); }
                  else { setIsNewStock(false); setStockCode(e.target.value); }
                }}
                className={inputClass}
              >
                <option value="">選擇股票...</option>
                {stocks.map(s => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
                <option value="__new__">+ 新增股票</option>
              </select>
            </div>
          )}
          {!isEdit && isNewStock && (
            <div className="mt-2 grid grid-cols-3 gap-2">
              <input
                placeholder="代碼 (如 2330)"
                value={stockCode}
                onChange={e => setStockCode(e.target.value)}
                className={inputClass}
              />
              <input
                placeholder="名稱 (如 台積電)"
                value={newStockName}
                onChange={e => setNewStockName(e.target.value)}
                className={inputClass}
              />
              <select
                value={newStockMarket}
                onChange={e => setNewStockMarket(e.target.value as typeof newStockMarket)}
                className={inputClass}
              >
                <option value="TWSE">上市</option>
                <option value="OTC">上櫃</option>
                <option value="ETF">ETF</option>
              </select>
            </div>
          )}
        </div>

        {/* Type */}
        <div>
          <label className="block text-xs text-slate-400 mb-1.5">交易類型</label>
          <div className="flex gap-2">
            {(['BUY', 'SELL', 'DIVIDEND'] as TxnType[]).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => handleTypeChange(t)}
                className={clsx(
                  'flex-1 py-2 rounded-lg text-sm font-medium transition-colors',
                  type === t
                    ? t === 'BUY' ? 'bg-blue-600 text-white'
                    : t === 'SELL' ? 'bg-red-600 text-white'
                    : 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                )}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        {/* Date & Shares & Price */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">日期</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">
              {type === 'DIVIDEND' ? '持股數' : '股數'}
            </label>
            <input
              type="number" min="1" step="1"
              value={shares} onChange={e => setShares(e.target.value)}
              onBlur={autoCalcFees}
              placeholder="1000"
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">
              {type === 'DIVIDEND' ? '每股配息 (TWD)' : '單價 (TWD)'}
            </label>
            <input
              type="number" min="0" step="0.01"
              value={price} onChange={e => setPrice(e.target.value)}
              onBlur={autoCalcFees}
              placeholder={type === 'DIVIDEND' ? '例：1.20' : '500.00'}
              className={inputClass}
            />
          </div>
        </div>

        {/* Fees — 配息不顯示手續費/證交稅 */}
        {type !== 'DIVIDEND' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">手續費 (TWD)</label>
              <input
                type="number" min="0"
                value={brokerageFee} onChange={e => setBrokerageFee(e.target.value)}
                placeholder="自動計算"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">證交稅 (TWD)</label>
              <input
                type="number" min="0"
                value={tax} onChange={e => setTax(e.target.value)}
                placeholder={type === 'SELL' ? '自動計算' : '0'}
                disabled={type !== 'SELL'}
                className={clsx(inputClass, type !== 'SELL' && 'opacity-40')}
              />
            </div>
          </div>
        )}
        {type === 'DIVIDEND' && (shares && price) && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-xs text-slate-400">
            配息收入預估：
            <span className="text-amber-400 font-semibold ml-1">
              +{((Number(shares) || 0) * (Number(price) || 0)).toLocaleString('zh-TW', { maximumFractionDigits: 0 })} TWD
            </span>
          </div>
        )}

        {/* Notes */}
        <div>
          <label className="block text-xs text-slate-400 mb-1.5">備註 (選填)</label>
          <input
            value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="例：除息前最後一日"
            className={inputClass}
          />
        </div>

        {error && <p className="text-red-400 text-xs">{error}</p>}

        <div className="flex gap-3 pt-1">
          <button type="button" onClick={onClose} className="flex-1 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-sm transition-colors">
            取消
          </button>
          <button
            type="submit"
            disabled={saving}
            className={clsx(
              'flex-1 py-2 rounded-lg text-white text-sm font-medium transition-colors disabled:opacity-50',
              isEdit ? 'bg-amber-600 hover:bg-amber-500' : 'bg-blue-600 hover:bg-blue-500'
            )}
          >
            {saving ? '儲存中...' : isEdit ? '確認修改' : '確認新增'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── 自動同步配息 Modal ───────────────────────────────────────────────────────
function DividendSyncModal({ onClose, onImported }: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [phase, setPhase] = useState<'loading' | 'preview' | 'importing' | 'done'>('loading');
  const [items, setItems] = useState<DividendSyncItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [importedCount, setImportedCount] = useState(0);

  useEffect(() => {
    window.electronAPI.dividends.sync()
      .then((result: DividendSyncItem[]) => {
        setItems(result);
        // 預設全選
        setSelected(new Set(result.map((r, i) => `${r.stockCode}-${r.date}-${i}`)));
        setPhase('preview');
      })
      .catch((e: unknown) => { setError(String(e)); setPhase('preview'); });
  }, []);

  function toggleItem(key: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  async function handleImport() {
    const toImport = items.filter((_, i) => selected.has(`${items[i].stockCode}-${items[i].date}-${i}`));
    if (toImport.length === 0) { onClose(); return; }
    setPhase('importing');
    try {
      const { imported } = await window.electronAPI.dividends.import(toImport) as { imported: number };
      setImportedCount(imported);
      setPhase('done');
    } catch (e) {
      setError(String(e));
      setPhase('preview');
    }
  }

  const totalSelected = items
    .filter((_, i) => selected.has(`${items[i].stockCode}-${items[i].date}-${i}`))
    .reduce((s, it) => s + it.total, 0);

  return (
    <Modal title="同步配息紀錄" onClose={onClose}>
      {/* Loading */}
      {phase === 'loading' && (
        <div className="py-12 text-center">
          <div className="text-slate-400 text-sm mb-2">正在從 Yahoo Finance 抓取配息資料...</div>
          <div className="text-slate-500 text-xs">這可能需要幾秒鐘</div>
        </div>
      )}

      {/* Preview */}
      {phase === 'preview' && (
        <>
          {error && <p className="text-red-400 text-xs mb-3">{error}</p>}

          {items.length === 0 ? (
            <div className="py-10 text-center">
              <div className="text-3xl mb-3">✅</div>
              <p className="text-slate-300 text-sm font-medium">配息紀錄已是最新</p>
              <p className="text-slate-500 text-xs mt-1">沒有發現新的配息事件</p>
            </div>
          ) : (
            <>
              <p className="text-slate-400 text-xs mb-3">
                發現 <span className="text-amber-400 font-semibold">{items.length}</span> 筆尚未記錄的配息，請確認後匯入：
              </p>
              <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-800 divide-y divide-slate-800">
                {items.map((item, i) => {
                  const key = `${item.stockCode}-${item.date}-${i}`;
                  const checked = selected.has(key);
                  return (
                    <label key={key} className={clsx(
                      'flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors',
                      checked ? 'bg-slate-800/30' : 'bg-transparent opacity-50'
                    )}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleItem(key)}
                        className="accent-amber-500"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-slate-100 text-sm font-medium">{item.stockCode}</span>
                          <span className="text-slate-500 text-xs">{item.stockName}</span>
                          <span className="text-slate-500 text-xs ml-auto">{item.date}</span>
                        </div>
                        <div className="flex items-center gap-1 mt-0.5 text-xs text-slate-500">
                          <span>{item.sharesHeld.toLocaleString()} 股</span>
                          <span>×</span>
                          <span>${item.perShare}/股</span>
                          <span className="ml-auto text-amber-400 font-semibold">
                            +{formatTWD(item.total)}
                          </span>
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>

              {/* Total */}
              <div className="mt-3 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-2 flex justify-between items-center">
                <span className="text-slate-400 text-sm">選取 {selected.size} / {items.length} 筆，總配息</span>
                <span className="text-amber-400 font-bold">+{formatTWD(totalSelected)}</span>
              </div>
            </>
          )}

          <div className="flex gap-3 mt-4">
            <button onClick={onClose} className="flex-1 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-sm transition-colors">
              取消
            </button>
            {items.length > 0 && (
              <button
                onClick={handleImport}
                disabled={selected.size === 0}
                className="flex-1 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-sm font-medium transition-colors"
              >
                匯入 {selected.size} 筆
              </button>
            )}
            {items.length === 0 && (
              <button onClick={onClose} className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors">
                確認
              </button>
            )}
          </div>
        </>
      )}

      {/* Importing */}
      {phase === 'importing' && (
        <div className="py-12 text-center">
          <div className="text-slate-400 text-sm">匯入中...</div>
        </div>
      )}

      {/* Done */}
      {phase === 'done' && (
        <div className="py-10 text-center">
          <div className="text-3xl mb-3">🎉</div>
          <p className="text-slate-100 text-sm font-medium">成功匯入 {importedCount} 筆配息</p>
          <button
            onClick={onImported}
            className="mt-4 px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
          >
            完成
          </button>
        </div>
      )}
    </Modal>
  );
}
