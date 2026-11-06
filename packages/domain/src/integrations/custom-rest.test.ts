import { describe, expect, it } from 'vitest';
import {
  buildRequest,
  canonicalCustomRestConfig,
  checkCustomRestConfig,
  hostProblem,
  mapBars,
  mapQuote,
  parseJsonPath,
  type CustomRestConfig,
  type CustomRestConfigInput,
} from './custom-rest';

const input = (over: Partial<CustomRestConfigInput> = {}): CustomRestConfigInput => ({
  baseUrl: 'https://api.example.com/v1/',
  auth: { type: 'query', name: 'apikey' },
  barsUrl: 'https://api.example.com/v1/bars?symbol={symbol}&from={from}&to={to}&apikey={apikey}',
  quoteUrl: '/quote?symbol={symbol}',
  bars: {
    timestamp: 'data.bars[].t',
    timestampFormat: 'iso',
    open: 'data.bars[].o',
    high: 'data.bars[].h',
    low: 'data.bars[].l',
    close: 'data.bars[].c',
    volume: 'data.bars[].v',
  },
  quote: {
    last: 'quote.last',
    bid: 'quote.bid',
    ask: '',
    timestamp: null,
    timestampFormat: 'unix_seconds',
  },
  limits: {
    timeoutMs: 5000,
    requestsPerMinute: 30,
    providerRequestsPerMinute: 60,
    requestsPerDay: null,
  },
  testSymbol: 'spy',
  ...over,
});

const good = (over: Partial<CustomRestConfigInput> = {}): CustomRestConfig => {
  const r = checkCustomRestConfig(input(over));
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.config;
};

const problems = (over: Partial<CustomRestConfigInput>) => {
  const r = checkCustomRestConfig(input(over));
  return r.ok ? [] : r.problems.map((p) => `${p.field}: ${p.message}`);
};

describe('checking a custom feed description', () => {
  it('normalizes a good description', () => {
    const c = good();
    expect(c.baseUrl).toBe('https://api.example.com/v1');
    expect(c.quoteUrl).toBe('https://api.example.com/v1/quote?symbol={symbol}');
    expect(c.quote.ask).toBeNull();
    expect(c.testSymbol).toBe('SPY');
    expect(canonicalCustomRestConfig(c)).toBe(canonicalCustomRestConfig(good()));
  });

  it.each([
    ['http://api.example.com', 'must start with https://'],
    ['https://localhost', 'Local and private'],
    ['https://prices.internal', 'Local and private'],
    ['https://10.0.0.5', 'not an IP address'],
    ['https://8.8.8.8', 'not an IP address'],
    ['https://[::1]', 'not an IP address'],
    ['https://intranet', 'full host name'],
    ['https://user:pw@api.example.com', 'not the URL'],
    ['https://api.example.com:8443', 'port'],
  ])('refuses the base URL %s', (baseUrl, why) => {
    expect(problems({ baseUrl }).join('\n')).toContain(why);
  });

  it('keeps every template on the base URL’s host', () => {
    expect(
      problems({ quoteUrl: 'https://api.example.com.evil.test/q?symbol={symbol}' }).join(),
    ).toContain('must start with the base URL');
    expect(problems({ quoteUrl: 'https://api.example.com/v2/q?symbol={symbol}' }).join()).toContain(
      'must start with the base URL',
    );
  });

  it('checks placeholders against the sign-in', () => {
    expect(problems({ quoteUrl: '/q?s={ticker}' }).join()).toContain(
      'Unknown placeholder {ticker}',
    );
    expect(problems({ quoteUrl: '/q' }).join()).toContain('Put {symbol}');
    expect(problems({ auth: { type: 'header', name: 'X-API-Key' } }).join()).toContain(
      'leave {apikey} out',
    );
    expect(problems({ auth: { type: 'header', name: 'Authorization' } }).join()).toContain(
      'Bearer',
    );
  });

  it('needs every bar field in the same list', () => {
    const bars = { ...input().bars, close: 'data.other[].c' };
    expect(problems({ bars }).join()).toContain('same list');
    expect(problems({ bars: { ...input().bars, open: 'data.bars.o' } }).join()).toContain(
      '[] once',
    );
    expect(problems({ quote: { ...input().quote, last: 'items[].p' } }).join()).toContain('[0]');
  });

  it('holds the rate limit under the provider’s documented limit', () => {
    const limits = { timeoutMs: 5000, requestsPerMinute: 61, providerRequestsPerMinute: 60 };
    expect(problems({ limits }).join()).toContain('documented limit (60 a minute)');
    expect(
      problems({
        limits: { ...limits, requestsPerMinute: 400, providerRequestsPerMinute: 1000 },
      }).join(),
    ).toContain('1 to 300');
    expect(
      problems({ limits: { ...limits, requestsPerMinute: 10, timeoutMs: 60_000 } }).join(),
    ).toContain('timeout');
  });
});

describe('host names', () => {
  it('allows public names only', () => {
    expect(hostProblem('api.tiingo.example')).toBeNull();
    expect(hostProblem('printer.local')).not.toBeNull();
    expect(hostProblem('127.0.0.1')).not.toBeNull();
  });
});

describe('requests', () => {
  it('puts the key where the feed says and masks it', () => {
    const c = good();
    const r = buildRequest(
      c,
      'bars',
      { symbol: 'BRK.B', from: '2026-01-02', to: '2026-02-02' },
      's3cr3t',
    );
    expect(r.url).toBe(
      'https://api.example.com/v1/bars?symbol=BRK.B&from=2026-01-02&to=2026-02-02&apikey=s3cr3t',
    );
    expect(r.shownUrl).not.toContain('s3cr3t');
    const q = buildRequest(c, 'quote', { symbol: 'SPY' }, 's3cr3t');
    expect(q.url).toBe('https://api.example.com/v1/quote?symbol=SPY&apikey=s3cr3t');
    expect(q.shownUrl).toBe('https://api.example.com/v1/quote?symbol=SPY&apikey=••••');
  });

  it('sends header and bearer keys as headers only', () => {
    const header = good({
      auth: { type: 'header', name: 'X-API-Key' },
      barsUrl: '/bars/{symbol}?from={from}&to={to}',
    });
    const r = buildRequest(header, 'bars', { symbol: 'SPY', from: 'a', to: 'b' }, 'k1');
    expect(r.headers['X-API-Key']).toBe('k1');
    expect(r.url).not.toContain('k1');
    const bearer = good({ auth: { type: 'bearer', name: null }, barsUrl: '/bars/{symbol}' });
    expect(buildRequest(bearer, 'quote', { symbol: 'SPY' }, 'k2').headers.authorization).toBe(
      'Bearer k2',
    );
  });
});

describe('reading answers', () => {
  const mapping = good().bars;

  it('reads nested bars with ISO dates and numeric strings', () => {
    const body = {
      data: {
        bars: [
          { t: '2026-11-04T00:00:00.000Z', o: '10', h: 11, l: 9.5, c: '10.5', v: 1000 },
          { t: '2026-11-03', o: 9, h: 10, l: 8, c: 9.5, v: 900 },
        ],
      },
    };
    expect(mapBars(body, mapping).map((b) => [b.date, b.close])).toEqual([
      ['2026-11-03', '9.5'],
      ['2026-11-04', '10.5'],
    ]);
  });

  it('reads Unix seconds and a top-level list', () => {
    const bars = mapBars([{ t: 1_762_300_800, o: 1, h: 2, l: 1, c: 2, v: 0 }], {
      ...mapping,
      timestamp: '[].t',
      timestampFormat: 'unix_seconds',
      open: '[].o',
      high: '[].h',
      low: '[].l',
      close: '[].c',
      volume: '[].v',
    });
    expect(bars[0]?.date).toBe('2025-11-05');
  });

  it('says exactly what is wrong', () => {
    expect(() => mapBars({ data: { rows: [] } }, mapping)).toThrow(
      'Bars: data has no “bars” (it has rows)',
    );
    expect(() =>
      mapBars({ data: { bars: [{ t: '2026-11-03', o: 'n/a', h: 1, l: 1, c: 1, v: 1 }] } }, mapping),
    ).toThrow('Bar 1 open is “n/a”, not a number');
    expect(() =>
      mapBars(
        { data: { bars: [{ t: 1762300800000, o: 1, h: 1, l: 1, c: 1, v: 1 }] } },
        {
          ...mapping,
          timestampFormat: 'unix_seconds',
        },
      ),
    ).toThrow('milliseconds');
    expect(() =>
      mapBars({ data: { bars: [{ t: 1762300800, o: 1, h: 1, l: 1, c: 1, v: 1 }] } }, mapping),
    ).toThrow('Is it Unix seconds?');
  });

  it('reads a quote with [0] and optional fields', () => {
    const q = mapQuote([{ p: '512.3', b: 512.2, ts: 1_762_300_800 }], {
      last: '[0].p',
      bid: '[0].b',
      ask: null,
      timestamp: '[0].ts',
      timestampFormat: 'unix_seconds',
    });
    expect(q).toEqual({ last: '512.3', bid: '512.2', ask: null, at: '2025-11-05T00:00:00.000Z' });
  });

  it('parses paths', () => {
    expect(parseJsonPath('a.b[2][].c')).toEqual({
      ok: true,
      segments: [
        { kind: 'key', key: 'a' },
        { kind: 'key', key: 'b' },
        { kind: 'index', index: 2 },
        { kind: 'each' },
        { kind: 'key', key: 'c' },
      ],
    });
    expect(parseJsonPath('a..b').ok).toBe(false);
  });
});
