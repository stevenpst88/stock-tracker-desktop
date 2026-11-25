import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './ipc/channels';
import type {
  AddStockInput, AddTransactionInput, TxnFilter, CalcFeesInput, DividendSyncItem, AddRadarInput,
} from '../shared/types';

const api = {
  stocks: {
    list:   ()                   => ipcRenderer.invoke(IPC.STOCKS_LIST),
    add:    (s: AddStockInput)   => ipcRenderer.invoke(IPC.STOCKS_ADD, s),
    delete: (code: string)       => ipcRenderer.invoke(IPC.STOCKS_DELETE, code),
  },
  transactions: {
    list:     (f?: TxnFilter)                          => ipcRenderer.invoke(IPC.TXN_LIST, f),
    add:      (t: AddTransactionInput)                 => ipcRenderer.invoke(IPC.TXN_ADD, t),
    update:   (id: number, t: AddTransactionInput)     => ipcRenderer.invoke(IPC.TXN_UPDATE, id, t),
    delete:   (id: number)                             => ipcRenderer.invoke(IPC.TXN_DELETE, id),
    calcFees: (p: CalcFeesInput)                       => ipcRenderer.invoke(IPC.TXN_CALC_FEES, p),
  },
  portfolio: {
    summary: ()                                    => ipcRenderer.invoke(IPC.PORTFOLIO_SUMMARY),
    history: (days?: number)                       => ipcRenderer.invoke(IPC.PORTFOLIO_HISTORY, days ?? 90),
    realizedPnl: (p?: { stockCode?: string; dateFrom?: string; dateTo?: string }) =>
      ipcRenderer.invoke(IPC.REALIZED_PNL, p),
    yearlyPnl: ()                                  => ipcRenderer.invoke(IPC.YEARLY_PNL),
  },
  prices: {
    get:        (code: string)             => ipcRenderer.invoke(IPC.PRICE_GET, code),
    getBatch:   (codes: string[])          => ipcRenderer.invoke(IPC.PRICE_GET_BATCH, codes),
    history:    (p: { stockCode: string; from: string; to: string }) =>
      ipcRenderer.invoke(IPC.PRICE_HISTORY, p),
    invalidate: ()                         => ipcRenderer.invoke(IPC.PRICE_INVALIDATE),
    marketContext: ()                      => ipcRenderer.invoke(IPC.PRICE_MARKET_CTX),
  },
  settings: {
    get: (key: string)               => ipcRenderer.invoke(IPC.SETTINGS_GET, key),
    set: (key: string, val: string)  => ipcRenderer.invoke(IPC.SETTINGS_SET, key, val),
  },
  dividends: {
    sync:   ()                          => ipcRenderer.invoke(IPC.DIVIDEND_SYNC),
    import: (items: DividendSyncItem[]) => ipcRenderer.invoke(IPC.DIVIDEND_IMPORT, items),
  },
  radar: {
    list:          ()                              => ipcRenderer.invoke(IPC.RADAR_LIST),
    add:           (input: AddRadarInput)          => ipcRenderer.invoke(IPC.RADAR_ADD, input),
    update:        (id: number, input: AddRadarInput) => ipcRenderer.invoke(IPC.RADAR_UPDATE, id, input),
    delete:        (id: number)                    => ipcRenderer.invoke(IPC.RADAR_DELETE, id),
    toggleHolding: (id: number)                    => ipcRenderer.invoke(IPC.RADAR_TOGGLE_HOLDING, id),
    fetchInst:     (dateYMD: string)               => ipcRenderer.invoke(IPC.RADAR_FETCH_INST, dateYMD),
    syncHoldings:  ()                              => ipcRenderer.invoke(IPC.RADAR_SYNC_HOLDINGS),
    instCache:     ()                              => ipcRenderer.invoke(IPC.RADAR_INST_CACHE),
    instTrends:    ()                              => ipcRenderer.invoke(IPC.RADAR_INST_TRENDS),
    tech:          ()                              => ipcRenderer.invoke(IPC.RADAR_TECH),
    marginCache:   ()                              => ipcRenderer.invoke(IPC.RADAR_MARGIN_CACHE),
    fundamental:   ()                              => ipcRenderer.invoke(IPC.RADAR_FUNDAMENTAL),
    backtest:      ()                              => ipcRenderer.invoke(IPC.RADAR_BACKTEST),
    aiRecSave:     (recs: unknown[])               => ipcRenderer.invoke(IPC.AI_REC_SAVE, recs),
    aiRecRecent:   (days?: number)                 => ipcRenderer.invoke(IPC.AI_REC_RECENT, days ?? 7),
  },
};

export type ElectronAPI = typeof api;

contextBridge.exposeInMainWorld('electronAPI', api);
