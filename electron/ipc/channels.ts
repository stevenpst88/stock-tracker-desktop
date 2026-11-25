export const IPC = {
  STOCKS_LIST:       'stocks:list',
  STOCKS_ADD:        'stocks:add',
  STOCKS_DELETE:     'stocks:delete',

  TXN_LIST:          'txn:list',
  TXN_ADD:           'txn:add',
  TXN_UPDATE:        'txn:update',
  TXN_DELETE:        'txn:delete',
  TXN_CALC_FEES:     'txn:calc-fees',

  PORTFOLIO_SUMMARY: 'portfolio:summary',
  PORTFOLIO_HISTORY: 'portfolio:history',
  REALIZED_PNL:      'pnl:realized',
  YEARLY_PNL:        'pnl:yearly',

  PRICE_GET:         'price:get',
  PRICE_GET_BATCH:   'price:get-batch',
  PRICE_HISTORY:     'price:history',
  PRICE_INVALIDATE:  'price:invalidate',
  PRICE_MARKET_CTX:  'price:market-context',

  SETTINGS_GET:      'settings:get',
  SETTINGS_SET:      'settings:set',

  DIVIDEND_SYNC:     'dividend:sync',
  DIVIDEND_IMPORT:   'dividend:import',

  RADAR_LIST:           'radar:list',
  RADAR_ADD:            'radar:add',
  RADAR_UPDATE:         'radar:update',
  RADAR_DELETE:         'radar:delete',
  RADAR_TOGGLE_HOLDING: 'radar:toggle-holding',
  RADAR_FETCH_INST:     'radar:fetch-inst',
  RADAR_SYNC_HOLDINGS:  'radar:sync-holdings',
  RADAR_INST_CACHE:     'radar:inst-cache',
  RADAR_INST_TRENDS:    'radar:inst-trends',
  RADAR_TECH:           'radar:tech',
  RADAR_MARGIN_CACHE:   'radar:margin-cache',
  RADAR_FUNDAMENTAL:    'radar:fundamental',
  RADAR_BACKTEST:       'radar:backtest',
  AI_REC_SAVE:          'ai:rec-save',
  AI_REC_RECENT:        'ai:rec-recent',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
