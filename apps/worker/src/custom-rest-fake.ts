import { addDays, nyDate, regularSession } from '@tm/domain';
import type { Transport } from './custom-rest-transport';

/**
 * A made-up JSON price API for tests and local checks (ADR 0041), standing in
 * for whatever provider a person describes: `prices.example.test`, signed in
 * with the token `fake-key` in a query parameter. Prices are invented and
 * repeatable. The worker uses it only with CUSTOM_REST_FAKE=true, which
 * production refuses outside E2E.
 */
export const FAKE_CUSTOM_HOST = 'prices.example.test';
export const FAKE_CUSTOM_KEY = 'fake-key';

/** The description a person would enter for the fake API. */
export const FAKE_CUSTOM_CONFIG = {
  baseUrl: `https://${FAKE_CUSTOM_HOST}/v1`,
  auth: { type: 'query' as const, name: 'token' },
  barsUrl: `https://${FAKE_CUSTOM_HOST}/v1/daily?symbol={symbol}&start={from}&end={to}`,
  quoteUrl: `https://${FAKE_CUSTOM_HOST}/v1/last?symbol={symbol}`,
  bars: {
    timestamp: 'data.bars[].date',
    timestampFormat: 'iso' as const,
    open: 'data.bars[].open',
    high: 'data.bars[].high',
    low: 'data.bars[].low',
    close: 'data.bars[].close',
    volume: 'data.bars[].volume',
  },
  quote: {
    last: 'quote.price',
    bid: 'quote.bid',
    ask: 'quote.ask',
    timestamp: 'quote.time',
    timestampFormat: 'unix_seconds' as const,
  },
  limits: {
    timeoutMs: 5000,
    requestsPerMinute: 30,
    providerRequestsPerMinute: 60,
    requestsPerDay: null,
  },
  testSymbol: 'SPY',
};

function seeded(text: string): number {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A repeatable close for a symbol on a date: a gentle walk around a symbol-made level. */
function closeOn(symbol: string, date: string): number {
  const base = 50 + seeded(symbol) * 450;
  const days = (Date.parse(`${date}T00:00:00Z`) - Date.parse('2015-01-02T00:00:00Z')) / 86_400_000;
  return round(base * (1 + 0.00025 * days) * (1 + 0.04 * Math.sin(days / 9 + seeded(symbol) * 6)));
}

export interface FakeCustomOptions {
  now?: () => Date;
  /** Symbols it has; anything else answers 404. */
  symbols?: readonly string[];
  /** Counts requests, for tests. */
  onRequest?: (url: URL) => void;
}

export function fakeCustomTransport(options: FakeCustomOptions = {}): Transport {
  const now = options.now ?? (() => new Date());
  const symbols = new Set(options.symbols ?? ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'DEMO-A']);
  const json = (status: number, body: unknown) => ({
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return async (req) => {
    const url = new URL(req.url);
    options.onRequest?.(url);
    if (url.hostname !== FAKE_CUSTOM_HOST)
      throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
    if (url.searchParams.get('token') !== FAKE_CUSTOM_KEY)
      return json(401, { error: 'invalid token' });
    const symbol = url.searchParams.get('symbol') ?? '';
    if (!symbols.has(symbol)) return json(404, { error: `unknown symbol ${symbol}` });
    const today = nyDate(now());
    if (url.pathname === '/v1/daily') {
      const start = url.searchParams.get('start') ?? addDays(today, -30);
      const end = [url.searchParams.get('end') ?? today, today].sort()[0] ?? today;
      const bars = [];
      for (let d = start; d <= end && bars.length < 5000; d = addDays(d, 1)) {
        const session = regularSession(d);
        if (!session || Date.parse(session.close) > now().getTime()) continue;
        const close = closeOn(symbol, d);
        const open = round(
          closeOn(symbol, addDays(d, -1)) * (1 + (seeded(`${symbol}${d}o`) - 0.5) * 0.004),
        );
        bars.push({
          date: d,
          open: String(open),
          high: String(round(Math.max(open, close) * 1.004)),
          low: String(round(Math.min(open, close) * 0.996)),
          close: String(close),
          volume: Math.round(1_000_000 + seeded(`${symbol}${d}v`) * 9_000_000),
        });
      }
      return json(200, { status: 'ok', data: { symbol, bars } });
    }
    if (url.pathname === '/v1/last') {
      const price = closeOn(symbol, today);
      return json(200, {
        quote: {
          price,
          bid: round(price - 0.01),
          ask: round(price + 0.01),
          time: Math.floor(now().getTime() / 1000),
        },
      });
    }
    return json(404, { error: 'no such endpoint' });
  };
}
