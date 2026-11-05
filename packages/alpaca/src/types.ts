/**
 * Alpaca's wire shapes (Trading API v2, Market Data API v2), as far as the
 * adapters read them. Numbers arrive as strings; timestamps are RFC 3339.
 * The recorded fixtures in `testing/recorded` hold full examples.
 */

export interface AlpacaAccount {
  id: string;
  account_number: string;
  status: string;
  currency: string;
  buying_power: string;
  cash: string;
  equity: string;
  pattern_day_trader: boolean;
  trading_blocked: boolean;
  account_blocked: boolean;
  shorting_enabled: boolean;
  multiplier: string;
  created_at: string;
}

export interface AlpacaAsset {
  id: string;
  class: string;
  exchange: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
  marginable: boolean;
  shortable: boolean;
  easy_to_borrow: boolean;
  fractionable: boolean;
  attributes?: string[];
}

export type AlpacaOrderStatus =
  | 'new'
  | 'partially_filled'
  | 'filled'
  | 'done_for_day'
  | 'canceled'
  | 'expired'
  | 'replaced'
  | 'pending_cancel'
  | 'pending_replace'
  | 'accepted'
  | 'pending_new'
  | 'accepted_for_bidding'
  | 'stopped'
  | 'rejected'
  | 'suspended'
  | 'calculated';

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  created_at: string;
  updated_at: string;
  submitted_at: string;
  filled_at: string | null;
  expired_at: string | null;
  canceled_at: string | null;
  failed_at: string | null;
  replaced_at: string | null;
  asset_id: string;
  symbol: string;
  asset_class: string;
  qty: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
  order_class: string;
  order_type: string;
  type: string;
  side: 'buy' | 'sell';
  time_in_force: string;
  limit_price: string | null;
  stop_price: string | null;
  status: AlpacaOrderStatus;
  extended_hours: boolean;
}

export interface AlpacaFillActivity {
  id: string;
  activity_type: 'FILL';
  transaction_time: string;
  type: 'fill' | 'partial_fill';
  price: string;
  qty: string;
  side: string;
  symbol: string;
  leaves_qty: string;
  order_id: string;
  cum_qty: string;
  order_status: string;
}

export interface AlpacaPosition {
  asset_id: string;
  symbol: string;
  exchange: string;
  asset_class: string;
  qty: string;
  avg_entry_price: string;
  side: 'long' | 'short';
  market_value: string;
  cost_basis: string;
}

export interface AlpacaTrade {
  t: string;
  x: string;
  p: number;
  s: number;
  c: string[];
  i: number;
  z: string;
}

export interface AlpacaQuote {
  t: string;
  ax: string;
  ap: number;
  as: number;
  bx: string;
  bp: number;
  bs: number;
  c: string[];
  z: string;
}

export interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n: number;
  vw: number;
}

export interface AlpacaSnapshot {
  latestTrade: AlpacaTrade | null;
  latestQuote: AlpacaQuote | null;
  minuteBar: AlpacaBar | null;
  dailyBar: AlpacaBar | null;
  prevDailyBar: AlpacaBar | null;
}

export interface AlpacaBarsPage {
  bars: Record<string, AlpacaBar[] | undefined>;
  next_page_token: string | null;
}

export interface AlpacaClock {
  timestamp: string;
  is_open: boolean;
  next_open: string;
  next_close: string;
}
