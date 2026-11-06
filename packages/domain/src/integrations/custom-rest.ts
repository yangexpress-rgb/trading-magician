import Decimal from 'decimal.js';
import { z } from 'zod';

/**
 * Custom REST (JSON) market-data feeds (v1.2 N17; ADR 0041): a person
 * describes any JSON price API (where it lives, how it signs in, two URL
 * templates and where the numbers sit in each answer) and the app uses it
 * like a built-in provider, with no code per vendor. Everything here is pure:
 * checking a description, filling a URL template and reading an answer. The
 * worker does the fetching (ADR 0041), never the browser.
 */

export const CUSTOM_REST_PROVIDER_ID = 'custom_rest';

export const CUSTOM_REST_LIMITS = {
  /** Requests a minute when the person does not lower it. */
  defaultRequestsPerMinute: 30,
  /** No custom feed may go faster than this, whatever its provider allows. */
  maxRequestsPerMinute: 300,
  timeoutMs: { min: 1_000, max: 10_000, default: 5_000 },
  /** Answers bigger than this are refused unread. */
  maxResponseBytes: 5 * 1024 * 1024,
  /** Bars kept from one answer. */
  maxBars: 20_000,
  pathLength: 200,
  urlLength: 500,
} as const;

export const CUSTOM_REST_PLACEHOLDERS = ['symbol', 'from', 'to', 'apikey'] as const;
export type CustomRestPlaceholder = (typeof CUSTOM_REST_PLACEHOLDERS)[number];

export const CUSTOM_REST_AUTH_TYPES = ['none', 'header', 'query', 'bearer'] as const;
export type CustomRestAuthType = (typeof CUSTOM_REST_AUTH_TYPES)[number];

export const TIMESTAMP_FORMATS = ['iso', 'unix_seconds'] as const;
export type TimestampFormat = (typeof TIMESTAMP_FORMATS)[number];

export const CUSTOM_REST_ASSET_CLASSES = ['stock', 'etf'] as const;

export interface CustomRestConfig {
  /** `https://host[/prefix]`, no trailing slash; both URL templates must start with it. */
  baseUrl: string;
  auth: {
    type: CustomRestAuthType;
    /** The header (`header`) or query parameter (`query`) that carries the key. */
    name: string | null;
  };
  /** Daily bars; {symbol} is required, {from} and {to} are New York dates (YYYY-MM-DD). */
  barsUrl: string;
  /** The latest price; {symbol} is required. */
  quoteUrl: string;
  bars: {
    timestamp: string;
    timestampFormat: TimestampFormat;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  };
  quote: {
    last: string;
    bid: string | null;
    ask: string | null;
    /** When the provider gives the price's time; otherwise the time it was fetched. */
    timestamp: string | null;
    timestampFormat: TimestampFormat;
  };
  limits: {
    timeoutMs: number;
    /** What this app may use, never more than the provider's documented limit. */
    requestsPerMinute: number;
    /** The provider's documented limit, as the person read it. */
    providerRequestsPerMinute: number;
    /** An optional daily budget, for free tiers that count by the day. */
    requestsPerDay: number | null;
  };
  /** The symbol tested before saving and used by the minute-by-minute health check. */
  testSymbol: string;
}

// ---------------------------------------------------------------------------
// Checking a description
// ---------------------------------------------------------------------------

const path = z.string().trim().min(1).max(CUSTOM_REST_LIMITS.pathLength);
const optionalPath = z
  .string()
  .trim()
  .max(CUSTOM_REST_LIMITS.pathLength)
  .nullish()
  .transform((v) => (v ? v : null));
const url = z.string().trim().min(1).max(CUSTOM_REST_LIMITS.urlLength);

/** What the form sends; `checkCustomRestConfig` does the checks a schema cannot. */
export const customRestConfigInput = z.object({
  baseUrl: url,
  auth: z.object({
    type: z.enum(CUSTOM_REST_AUTH_TYPES),
    name: z.string().trim().max(60).nullish(),
  }),
  barsUrl: url,
  quoteUrl: url,
  bars: z.object({
    timestamp: path,
    timestampFormat: z.enum(TIMESTAMP_FORMATS),
    open: path,
    high: path,
    low: path,
    close: path,
    volume: path,
  }),
  quote: z.object({
    last: path,
    bid: optionalPath,
    ask: optionalPath,
    timestamp: optionalPath,
    timestampFormat: z.enum(TIMESTAMP_FORMATS),
  }),
  limits: z.object({
    timeoutMs: z.number().int(),
    requestsPerMinute: z.number().int(),
    providerRequestsPerMinute: z.number().int(),
    requestsPerDay: z.number().int().nullish(),
  }),
  testSymbol: z.string().trim().min(1).max(12),
});
export type CustomRestConfigInput = z.input<typeof customRestConfigInput>;

export interface ConfigProblem {
  /** The form field, e.g. `barsUrl` or `bars.close`. */
  field: string;
  message: string;
}

export type ConfigCheck =
  { ok: true; config: CustomRestConfig } | { ok: false; problems: ConfigProblem[] };

const HEADER_NAME = /^[A-Za-z0-9-]{1,60}$/;
const QUERY_NAME = /^[A-Za-z0-9_.-]{1,60}$/;
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,11}$/;
/** Headers a key may not be put in: they belong to the connection, not to the provider. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'cookie',
  'user-agent',
  'accept',
  'accept-encoding',
]);

/** Host names that only mean something inside a network, never a public provider. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet'];

/**
 * Why a base URL's host may not be used, or null. Only public host names:
 * no IP literals at all (private or public), no single-label or local names.
 * The worker checks again after resolving the name, so a public name that
 * points inside a network is refused too (ADR 0041).
 */
export function hostProblem(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || /^[0-9.]+$/.test(host) || host.includes(':')) {
    return 'Use the provider’s host name, not an IP address';
  }
  if (host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return 'Local and private-network addresses are not allowed';
  }
  if (!host.includes('.')) return 'Use the provider’s full host name, such as api.example.com';
  if (!/^[a-z0-9.-]+$/.test(host)) return 'The host name has characters a host name cannot have';
  return null;
}

function checkBaseUrl(raw: string, problems: ConfigProblem[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    problems.push({
      field: 'baseUrl',
      message: 'Enter a full URL, such as https://api.example.com',
    });
    return null;
  }
  if (parsed.protocol !== 'https:') {
    problems.push({ field: 'baseUrl', message: 'The base URL must start with https://' });
    return null;
  }
  if (parsed.username || parsed.password) {
    problems.push({ field: 'baseUrl', message: 'Put the key in the auth settings, not the URL' });
    return null;
  }
  if (parsed.port && parsed.port !== '443') {
    problems.push({ field: 'baseUrl', message: 'Only the standard HTTPS port (443) is allowed' });
    return null;
  }
  if (parsed.search || parsed.hash) {
    problems.push({
      field: 'baseUrl',
      message: 'The base URL is the host and an optional path, without ? or #',
    });
    return null;
  }
  const host = hostProblem(parsed.hostname);
  if (host) {
    problems.push({ field: 'baseUrl', message: host });
    return null;
  }
  return `https://${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
}

const PLACEHOLDER = /\{([^{}]*)\}/g;

function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '');
}

function checkTemplate(
  field: 'barsUrl' | 'quoteUrl',
  raw: string,
  base: string,
  authType: CustomRestAuthType,
  problems: ConfigProblem[],
): string | null {
  // A path is taken as relative to the base URL.
  const template = raw.startsWith('/') ? `${base}${raw}` : raw;
  const before = problems.length;
  const names = placeholdersOf(template);
  const unknown = names.filter((n) => !(CUSTOM_REST_PLACEHOLDERS as readonly string[]).includes(n));
  if (unknown.length > 0) {
    problems.push({
      field,
      message: `Unknown placeholder {${unknown[0]}}; use {symbol}, {from}, {to} or {apikey}`,
    });
  }
  if (/[{}]/.test(template.replace(PLACEHOLDER, ''))) {
    problems.push({ field, message: 'A { or } is not part of a placeholder' });
  }
  if (!names.includes('symbol')) problems.push({ field, message: 'Put {symbol} in the URL' });
  if (names.includes('apikey') && authType !== 'query') {
    problems.push({
      field,
      message:
        authType === 'none'
          ? 'This feed signs in with no key, so {apikey} cannot be used'
          : 'With the key in a header, leave {apikey} out of the URL',
    });
  }
  // The key only ever goes to the base URL's host: each template starts with it.
  if (template !== base && !template.startsWith(`${base}/`) && !template.startsWith(`${base}?`)) {
    problems.push({ field, message: `The URL must start with the base URL, ${base}` });
  }
  try {
    const filled = new URL(fillTemplate(template, SAMPLE_VALUES));
    if (filled.hash) problems.push({ field, message: 'Leave # out of the URL' });
  } catch {
    problems.push({ field, message: 'This is not a valid URL' });
  }
  return problems.length === before ? template : null;
}

const SAMPLE_VALUES: Record<CustomRestPlaceholder, string> = {
  symbol: 'SPY',
  from: '2026-01-02',
  to: '2026-01-30',
  apikey: 'key',
};

/**
 * Checks a feed description and returns it in its stored form: base URL
 * normalized, templates made absolute, empty optional paths null, limits
 * within bounds. Problems name the form field they belong to.
 */
export function checkCustomRestConfig(input: CustomRestConfigInput): ConfigCheck {
  const parsed = customRestConfigInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    };
  }
  const v = parsed.data;
  const problems: ConfigProblem[] = [];
  const base = checkBaseUrl(v.baseUrl, problems);

  const authName = v.auth.name?.trim() || null;
  if (v.auth.type === 'header') {
    if (!authName || !HEADER_NAME.test(authName)) {
      problems.push({
        field: 'auth.name',
        message: 'Name the header that carries the key, such as X-API-Key',
      });
    } else if (RESERVED_HEADERS.has(authName.toLowerCase()) || /^authorization$/i.test(authName)) {
      problems.push({
        field: 'auth.name',
        message: /^authorization$/i.test(authName)
          ? 'For an Authorization: Bearer header, choose "Bearer token"'
          : `${authName} cannot carry a key`,
      });
    }
  }
  if (v.auth.type === 'query' && (!authName || !QUERY_NAME.test(authName))) {
    problems.push({
      field: 'auth.name',
      message: 'Name the query parameter that carries the key, such as apikey',
    });
  }

  const barsUrl = base ? checkTemplate('barsUrl', v.barsUrl, base, v.auth.type, problems) : null;
  const quoteUrl = base ? checkTemplate('quoteUrl', v.quoteUrl, base, v.auth.type, problems) : null;

  // Bar paths: each names one list of bars, the same one, with `[]`.
  const barFields = ['timestamp', 'open', 'high', 'low', 'close', 'volume'] as const;
  let listPrefix: string | undefined;
  for (const f of barFields) {
    const p = parseJsonPath(v.bars[f]);
    if (!p.ok) {
      problems.push({ field: `bars.${f}`, message: p.message });
      continue;
    }
    const each = p.segments.filter((s) => s.kind === 'each').length;
    if (each !== 1) {
      problems.push({
        field: `bars.${f}`,
        message: 'Mark the list of bars with [] once, such as data.bars[].close',
      });
      continue;
    }
    const prefix = formatPath(
      p.segments.slice(
        0,
        p.segments.findIndex((s) => s.kind === 'each'),
      ),
    );
    if (listPrefix === undefined) listPrefix = prefix;
    else if (prefix !== listPrefix) {
      problems.push({
        field: `bars.${f}`,
        message: `Every bar field must be in the same list (${listPrefix || 'the top level'}[])`,
      });
    }
  }
  for (const f of ['last', 'bid', 'ask', 'timestamp'] as const) {
    const raw = v.quote[f];
    if (raw === null) continue;
    const p = parseJsonPath(raw);
    if (!p.ok) problems.push({ field: `quote.${f}`, message: p.message });
    else if (p.segments.some((s) => s.kind === 'each')) {
      problems.push({
        field: `quote.${f}`,
        message: 'A quote is one value: use [0] for the first item of a list, not []',
      });
    }
  }

  const { timeoutMs, requestsPerMinute, providerRequestsPerMinute } = v.limits;
  const requestsPerDay = v.limits.requestsPerDay ?? null;
  const t = CUSTOM_REST_LIMITS.timeoutMs;
  if (timeoutMs < t.min || timeoutMs > t.max) {
    problems.push({
      field: 'limits.timeoutMs',
      message: `The timeout is ${t.min / 1000} to ${t.max / 1000} seconds`,
    });
  }
  if (providerRequestsPerMinute < 1 || providerRequestsPerMinute > 100_000) {
    problems.push({
      field: 'limits.providerRequestsPerMinute',
      message: 'Enter the provider’s documented limit, in requests a minute',
    });
  }
  const ceiling = Math.min(providerRequestsPerMinute, CUSTOM_REST_LIMITS.maxRequestsPerMinute);
  if (requestsPerMinute < 1 || requestsPerMinute > ceiling) {
    problems.push({
      field: 'limits.requestsPerMinute',
      message:
        requestsPerMinute > providerRequestsPerMinute
          ? `It cannot be more than the provider’s documented limit (${providerRequestsPerMinute} a minute)`
          : `Use 1 to ${ceiling} requests a minute`,
    });
  }
  if (requestsPerDay !== null && (requestsPerDay < 1 || requestsPerDay > 10_000_000)) {
    problems.push({ field: 'limits.requestsPerDay', message: 'Enter a daily limit of 1 or more' });
  }
  const testSymbol = v.testSymbol.toUpperCase();
  if (!SYMBOL.test(testSymbol)) {
    problems.push({ field: 'testSymbol', message: 'Enter a ticker symbol, such as SPY' });
  }

  if (problems.length > 0 || !base || !barsUrl || !quoteUrl) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    config: {
      baseUrl: base,
      auth: {
        type: v.auth.type,
        name: v.auth.type === 'header' || v.auth.type === 'query' ? authName : null,
      },
      barsUrl,
      quoteUrl,
      bars: {
        timestamp: v.bars.timestamp,
        timestampFormat: v.bars.timestampFormat,
        open: v.bars.open,
        high: v.bars.high,
        low: v.bars.low,
        close: v.bars.close,
        volume: v.bars.volume,
      },
      quote: {
        last: v.quote.last,
        bid: v.quote.bid,
        ask: v.quote.ask,
        timestamp: v.quote.timestamp,
        timestampFormat: v.quote.timestampFormat,
      },
      limits: { timeoutMs, requestsPerMinute, providerRequestsPerMinute, requestsPerDay },
      testSymbol,
    },
  };
}

/**
 * The stored form as one string with a fixed key order, so a test result can
 * be matched to exactly the description that was saved.
 */
export function canonicalCustomRestConfig(config: CustomRestConfig): string {
  const c = config;
  return JSON.stringify([
    c.baseUrl,
    c.auth.type,
    c.auth.name,
    c.barsUrl,
    c.quoteUrl,
    c.bars.timestamp,
    c.bars.timestampFormat,
    c.bars.open,
    c.bars.high,
    c.bars.low,
    c.bars.close,
    c.bars.volume,
    c.quote.last,
    c.quote.bid,
    c.quote.ask,
    c.quote.timestamp,
    c.quote.timestampFormat,
    c.limits.timeoutMs,
    c.limits.requestsPerMinute,
    c.limits.providerRequestsPerMinute,
    c.limits.requestsPerDay,
    c.testSymbol,
  ]);
}

// ---------------------------------------------------------------------------
// URL templates
// ---------------------------------------------------------------------------

export function fillTemplate(
  template: string,
  values: Partial<Record<CustomRestPlaceholder, string | undefined>>,
): string {
  return template.replace(PLACEHOLDER, (_, name: string) =>
    encodeURIComponent(values[name as CustomRestPlaceholder] ?? ''),
  );
}

export interface CustomRestRequest {
  url: string;
  headers: Record<string, string>;
  /** The URL with the key masked, safe to show and log. */
  shownUrl: string;
}

/**
 * The request for one call: the template filled in, and the key placed where
 * the feed says (a header, a query parameter, a bearer token or {apikey}).
 */
export function buildRequest(
  config: CustomRestConfig,
  which: 'bars' | 'quote',
  values: { symbol: string; from?: string; to?: string },
  apiKey: string | undefined,
): CustomRestRequest {
  const template = which === 'bars' ? config.barsUrl : config.quoteUrl;
  const needsKey = config.auth.type !== 'none';
  if (needsKey && !apiKey) throw new Error('No API key is stored for this feed');
  const key = needsKey ? (apiKey ?? '') : '';
  const fill = (k: string) =>
    fillTemplate(template, { symbol: values.symbol, from: values.from, to: values.to, apikey: k });
  const url = new URL(fill(key));
  const shown = new URL(fill('KEY'));
  const headers: Record<string, string> = { accept: 'application/json' };
  if (config.auth.type === 'query' && config.auth.name && !template.includes('{apikey}')) {
    url.searchParams.set(config.auth.name, key);
    shown.searchParams.set(config.auth.name, 'KEY');
  }
  if (config.auth.type === 'header' && config.auth.name) headers[config.auth.name] = key;
  if (config.auth.type === 'bearer') headers.authorization = `Bearer ${key}`;
  return {
    url: url.toString(),
    headers,
    shownUrl: shown.toString().replaceAll('KEY', '••••'),
  };
}

// ---------------------------------------------------------------------------
// JSON paths
// ---------------------------------------------------------------------------

export type PathSegment =
  { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'each' };

const KEY = /^[A-Za-z0-9_$@-]+$/;

/**
 * Reads a path such as `data.bars[].close`, `results[0].price` or `[].c`:
 * keys separated by dots, `[n]` for one item of a list and `[]` for every item.
 */
export function parseJsonPath(
  text: string,
): { ok: true; segments: PathSegment[] } | { ok: false; message: string } {
  const segments: PathSegment[] = [];
  const parts = text.trim().split('.');
  for (const part of parts) {
    const m = /^([^[\]]*)((?:\[\d*\])*)$/.exec(part);
    if (!m || (m[1] === '' && m[2] === '')) {
      return { ok: false, message: `“${text}” is not a path; write it like data.bars[].close` };
    }
    const key = m[1] ?? '';
    if (key && !KEY.test(key)) {
      return { ok: false, message: `“${key}” has characters a path key cannot have` };
    }
    if (key) segments.push({ kind: 'key', key });
    for (const b of (m[2] ?? '').matchAll(/\[(\d*)\]/g)) {
      segments.push(b[1] === '' ? { kind: 'each' } : { kind: 'index', index: Number(b[1]) });
    }
  }
  return { ok: true, segments };
}

export function formatPath(segments: readonly PathSegment[]): string {
  let out = '';
  for (const s of segments) {
    if (s.kind === 'key') out += out ? `.${s.key}` : s.key;
    else out += s.kind === 'each' ? '[]' : `[${s.index}]`;
  }
  return out;
}

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MappingError';
  }
}

const describe = (v: unknown) =>
  v === null
    ? 'null'
    : Array.isArray(v)
      ? 'a list'
      : typeof v === 'object'
        ? 'an object'
        : typeof v;

function keysOf(v: unknown): string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '';
  const keys = Object.keys(v).slice(0, 8);
  return keys.length > 0 ? ` (it has ${keys.join(', ')})` : ' (it is empty)';
}

/** Follows path segments that contain no `[]`; `where` names the place for errors. */
function follow(root: unknown, segments: readonly PathSegment[], where: string): unknown {
  let cur = root;
  const seen: PathSegment[] = [];
  for (const s of segments) {
    const at = formatPath(seen) || 'the answer';
    if (s.kind === 'key') {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) {
        throw new MappingError(`${where}: ${at} is ${describe(cur)}, so it has no “${s.key}”`);
      }
      if (!Object.hasOwn(cur, s.key)) {
        throw new MappingError(`${where}: ${at} has no “${s.key}”${keysOf(cur)}`);
      }
      cur = (cur as Record<string, unknown>)[s.key];
    } else if (s.kind === 'index') {
      if (!Array.isArray(cur)) {
        throw new MappingError(`${where}: ${at} is ${describe(cur)}, not a list`);
      }
      if (s.index >= cur.length) {
        throw new MappingError(`${where}: ${at} has ${cur.length} items, so no [${s.index}]`);
      }
      cur = cur[s.index];
    } else {
      throw new MappingError(`${where}: [] is not allowed here`);
    }
    seen.push(s);
  }
  return cur;
}

const NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

function toDecimal(v: unknown, where: string): Decimal {
  if (typeof v === 'number' && Number.isFinite(v)) return new Decimal(v);
  if (typeof v === 'string' && NUMBER.test(v.trim())) return new Decimal(v.trim());
  throw new MappingError(
    `${where} is ${typeof v === 'string' ? `“${v.slice(0, 40)}”` : describe(v)}, not a number`,
  );
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/;
/** Unix seconds from 1970 to 2100; anything bigger is probably milliseconds. */
const MAX_UNIX_SECONDS = 4_102_444_800;

/** A timestamp as an instant (ISO) and its calendar date as the provider labels it. */
function toTime(v: unknown, format: TimestampFormat, where: string): { iso: string; date: string } {
  if (format === 'iso') {
    if (typeof v !== 'string') {
      throw new MappingError(
        `${where} is ${describe(v)}; an ISO date looks like “2026-11-05”. Is it Unix seconds?`,
      );
    }
    const m = ISO_DATE.exec(v.trim());
    const t = Date.parse(v.trim().length === 10 ? `${v.trim()}T00:00:00Z` : v.trim());
    if (!m || Number.isNaN(t)) {
      throw new MappingError(`${where} is “${v.slice(0, 40)}”, not an ISO date or date-time`);
    }
    return { iso: new Date(t).toISOString(), date: `${m[1]}-${m[2]}-${m[3]}` };
  }
  const n =
    typeof v === 'number' ? v : typeof v === 'string' && NUMBER.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) {
    throw new MappingError(
      `${where} is ${typeof v === 'string' ? `“${v.slice(0, 40)}”` : describe(v)}, not Unix seconds`,
    );
  }
  if (n > MAX_UNIX_SECONDS) {
    throw new MappingError(`${where} is ${n}, which looks like milliseconds, not Unix seconds`);
  }
  const iso = new Date(n * 1000).toISOString();
  return { iso, date: iso.slice(0, 10) };
}

/** One parsed daily bar: the provider's date label and its prices. */
export interface CustomDailyBar {
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

function splitEach(text: string): { list: PathSegment[]; item: PathSegment[] } {
  const p = parseJsonPath(text);
  if (!p.ok) throw new MappingError(p.message);
  const i = p.segments.findIndex((s) => s.kind === 'each');
  return { list: p.segments.slice(0, i), item: p.segments.slice(i + 1) };
}

/**
 * Reads the daily bars from an answer with the feed's bar paths. Bars come
 * back sorted by date, one per date (the last one wins), and each is checked:
 * prices above zero, high not below low. The first bad value fails the whole
 * answer with where it is, so a wrong mapping is never half used.
 */
export function mapBars(body: unknown, mapping: CustomRestConfig['bars']): CustomDailyBar[] {
  const fields = ['timestamp', 'open', 'high', 'low', 'close', 'volume'] as const;
  const paths = Object.fromEntries(fields.map((f) => [f, splitEach(mapping[f])])) as Record<
    (typeof fields)[number],
    { list: PathSegment[]; item: PathSegment[] }
  >;
  const listPath = formatPath(paths.close.list);
  const list = follow(body, paths.close.list, 'Bars');
  if (!Array.isArray(list)) {
    throw new MappingError(
      `Bars: ${listPath || 'the answer'} is ${describe(list)}, not a list of bars${keysOf(list)}`,
    );
  }
  if (list.length > CUSTOM_REST_LIMITS.maxBars) {
    throw new MappingError(`Bars: the answer has more than ${CUSTOM_REST_LIMITS.maxBars} bars`);
  }
  const byDate = new Map<string, CustomDailyBar>();
  list.forEach((item, n) => {
    const where = (f: string) => `Bar ${n + 1} ${f}`;
    const value = (f: (typeof fields)[number]) => follow(item, paths[f].item, `Bar ${n + 1}`);
    const time = toTime(value('timestamp'), mapping.timestampFormat, where('timestamp'));
    const open = toDecimal(value('open'), where('open'));
    const high = toDecimal(value('high'), where('high'));
    const low = toDecimal(value('low'), where('low'));
    const close = toDecimal(value('close'), where('close'));
    const volume = toDecimal(value('volume'), where('volume'));
    if (open.lte(0) || high.lte(0) || low.lte(0) || close.lte(0)) {
      throw new MappingError(`Bar ${n + 1} (${time.date}) has a price of zero or less`);
    }
    if (high.lt(low)) {
      throw new MappingError(`Bar ${n + 1} (${time.date}) has a high below its low`);
    }
    if (volume.lt(0)) throw new MappingError(`Bar ${n + 1} (${time.date}) has a negative volume`);
    byDate.set(time.date, {
      date: time.date,
      open: open.toString(),
      high: high.toString(),
      low: low.toString(),
      close: close.toString(),
      volume: volume.toString(),
    });
  });
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface CustomQuote {
  last: string;
  bid: string | null;
  ask: string | null;
  /** The provider's time for the price, when the feed maps one. */
  at: string | null;
}

/** Reads the latest price from an answer with the feed's quote paths. */
export function mapQuote(body: unknown, mapping: CustomRestConfig['quote']): CustomQuote {
  const read = (text: string, what: string) => {
    const p = parseJsonPath(text);
    if (!p.ok) throw new MappingError(p.message);
    return follow(body, p.segments, `Quote ${what}`);
  };
  const price = (text: string | null, what: string) => {
    if (text === null) return null;
    const v = toDecimal(read(text, what), `Quote ${what}`);
    if (v.lte(0)) throw new MappingError(`Quote ${what} is ${v.toString()}, not above zero`);
    return v.toString();
  };
  const last = price(mapping.last, 'last price');
  if (last === null) throw new MappingError('Quote last price is missing');
  const bid = price(mapping.bid, 'bid');
  const ask = price(mapping.ask, 'ask');
  const at =
    mapping.timestamp === null
      ? null
      : toTime(read(mapping.timestamp, 'time'), mapping.timestampFormat, 'Quote time').iso;
  return { last, bid, ask, at };
}
