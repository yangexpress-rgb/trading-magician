'use client';

import { ApiError, type CustomFeedTestDto, type FeedDto } from '@tm/contracts';
import {
  CUSTOM_REST_LIMITS,
  type CustomRestAuthType,
  type CustomRestConfigInput,
  type TimestampFormat,
} from '@tm/domain';
import { Alert, Button, SelectField, Table, Td, TextField, Th } from '@tm/ui';
import { useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { CredentialFields } from './credential-fields';

/**
 * The settings of a Custom REST (JSON) feed (v1.2 N17; ADR 0041): where the
 * API lives, how it signs in, two URL templates, where each number sits in
 * the answers, and its limits. "Test" asks the server to fetch one symbol
 * and shows what it read, or exactly why it could not; the feed can only be
 * saved once a test of these exact settings has succeeded. The browser never
 * calls the provider, and a typed key is sealed on the server as soon as it
 * is sent, then cleared here.
 */

export interface CustomFormState {
  baseUrl: string;
  authType: CustomRestAuthType;
  authName: string;
  barsUrl: string;
  quoteUrl: string;
  barTimestamp: string;
  barTimestampFormat: TimestampFormat;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  last: string;
  bid: string;
  ask: string;
  quoteTimestamp: string;
  quoteTimestampFormat: TimestampFormat;
  timeoutSec: string;
  requestsPerMinute: string;
  providerRequestsPerMinute: string;
  requestsPerDay: string;
  testSymbol: string;
}

export const EMPTY_CUSTOM_FORM: CustomFormState = {
  baseUrl: '',
  authType: 'query',
  authName: 'apikey',
  barsUrl: '',
  quoteUrl: '',
  barTimestamp: '',
  barTimestampFormat: 'iso',
  open: '',
  high: '',
  low: '',
  close: '',
  volume: '',
  last: '',
  bid: '',
  ask: '',
  quoteTimestamp: '',
  quoteTimestampFormat: 'unix_seconds',
  timeoutSec: String(CUSTOM_REST_LIMITS.timeoutMs.default / 1000),
  requestsPerMinute: String(CUSTOM_REST_LIMITS.defaultRequestsPerMinute),
  providerRequestsPerMinute: '',
  requestsPerDay: '',
  testSymbol: 'SPY',
};

export function formFromConfig(config: NonNullable<FeedDto['config']>): CustomFormState {
  return {
    baseUrl: config.baseUrl,
    authType: config.auth.type,
    authName: config.auth.name ?? '',
    barsUrl: config.barsUrl,
    quoteUrl: config.quoteUrl,
    barTimestamp: config.bars.timestamp,
    barTimestampFormat: config.bars.timestampFormat,
    open: config.bars.open,
    high: config.bars.high,
    low: config.bars.low,
    close: config.bars.close,
    volume: config.bars.volume,
    last: config.quote.last,
    bid: config.quote.bid ?? '',
    ask: config.quote.ask ?? '',
    quoteTimestamp: config.quote.timestamp ?? '',
    quoteTimestampFormat: config.quote.timestampFormat,
    timeoutSec: String(config.limits.timeoutMs / 1000),
    requestsPerMinute: String(config.limits.requestsPerMinute),
    providerRequestsPerMinute: String(config.limits.providerRequestsPerMinute),
    requestsPerDay:
      config.limits.requestsPerDay === null ? '' : String(config.limits.requestsPerDay),
    testSymbol: config.testSymbol,
  };
}

const int = (v: string) => (v.trim() === '' ? NaN : Math.round(Number(v)));

export function configFromForm(f: CustomFormState): CustomRestConfigInput {
  return {
    baseUrl: f.baseUrl,
    auth: {
      type: f.authType,
      name: f.authType === 'header' || f.authType === 'query' ? f.authName : null,
    },
    barsUrl: f.barsUrl,
    quoteUrl: f.quoteUrl,
    bars: {
      timestamp: f.barTimestamp,
      timestampFormat: f.barTimestampFormat,
      open: f.open,
      high: f.high,
      low: f.low,
      close: f.close,
      volume: f.volume,
    },
    quote: {
      last: f.last,
      bid: f.bid || null,
      ask: f.ask || null,
      timestamp: f.quoteTimestamp || null,
      timestampFormat: f.quoteTimestampFormat,
    },
    limits: {
      timeoutMs: Math.round(Number(f.timeoutSec) * 1000),
      requestsPerMinute: int(f.requestsPerMinute),
      providerRequestsPerMinute: int(f.providerRequestsPerMinute),
      requestsPerDay: f.requestsPerDay.trim() === '' ? null : int(f.requestsPerDay),
    },
    testSymbol: f.testSymbol,
  };
}

/** Maps a server problem's field (e.g. `bars.close`) to the form's input. */
const FIELD_OF: Record<string, keyof CustomFormState> = {
  baseUrl: 'baseUrl',
  'auth.name': 'authName',
  barsUrl: 'barsUrl',
  quoteUrl: 'quoteUrl',
  'bars.timestamp': 'barTimestamp',
  'bars.open': 'open',
  'bars.high': 'high',
  'bars.low': 'low',
  'bars.close': 'close',
  'bars.volume': 'volume',
  'quote.last': 'last',
  'quote.bid': 'bid',
  'quote.ask': 'ask',
  'quote.timestamp': 'quoteTimestamp',
  'limits.timeoutMs': 'timeoutSec',
  'limits.requestsPerMinute': 'requestsPerMinute',
  'limits.providerRequestsPerMinute': 'providerRequestsPerMinute',
  'limits.requestsPerDay': 'requestsPerDay',
  testSymbol: 'testSymbol',
};

export function problemsOf(e: unknown): Partial<Record<keyof CustomFormState, string>> {
  if (!(e instanceof ApiError)) return {};
  const problems = (
    e.body.details as { problems?: { field: string; message: string }[] } | undefined
  )?.problems;
  const out: Partial<Record<keyof CustomFormState, string>> = {};
  for (const p of problems ?? []) {
    const k = FIELD_OF[p.field];
    if (k && !out[k]) out[k] = p.message;
  }
  return out;
}

export interface CustomKeyState {
  /** A stored custom REST key, 'new' to type one, or '' for none. */
  credentialId: string;
  newKey: Record<string, string>;
}

/** What a test was run on; saving needs a succeeded test of the same. */
export const testKey = (form: CustomFormState, credentialId: string | null) =>
  JSON.stringify([configFromForm(form), credentialId]);

export function CustomFeedFields({
  form,
  onChange,
  keys,
  keyState,
  onKeyState,
  errors,
  test,
  testing,
  testError,
  onTest,
  testSymbol,
  onTestSymbol,
}: {
  form: CustomFormState;
  onChange: (next: CustomFormState) => void;
  keys: { id: string; label: string }[];
  keyState: CustomKeyState;
  onKeyState: (next: CustomKeyState) => void;
  errors: Partial<Record<keyof CustomFormState, string>>;
  test: CustomFeedTestDto | null;
  testing: boolean;
  testError: string | null;
  onTest: () => void;
  testSymbol: string;
  onTestSymbol: (s: string) => void;
}) {
  const set = <K extends keyof CustomFormState>(k: K, v: CustomFormState[K]) =>
    onChange({ ...form, [k]: v });
  const text = (
    k: keyof CustomFormState,
    label: string,
    extra: { hint?: string | undefined; placeholder?: string; required?: boolean } = {},
  ) => (
    <TextField
      name={`custom-${k}`}
      label={label}
      value={form[k]}
      required={extra.required ?? false}
      placeholder={extra.placeholder}
      hint={extra.hint}
      error={errors[k]}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => set(k, e.target.value as never)}
    />
  );
  const needsKey = form.authType !== 'none';
  const typingKey = needsKey && (keyState.credentialId === 'new' || keys.length === 0);

  return (
    <div className="space-y-4">
      <Alert tone="warn">
        You are responsible for your provider’s terms — most free tiers do not allow showing their
        data to other users.
      </Alert>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Connection</legend>
        {text('baseUrl', 'Base URL', {
          required: true,
          placeholder: 'https://api.example.com/v1',
          hint: 'https only, on a public host name. Both URLs below must start with it.',
        })}
        <SelectField
          name="custom-authType"
          label="Sign-in"
          value={form.authType}
          onChange={(e) => {
            const t = e.target.value as CustomRestAuthType;
            onChange({
              ...form,
              authType: t,
              authName: t === 'header' ? 'X-API-Key' : t === 'query' ? 'apikey' : '',
            });
          }}
        >
          <option value="none">None</option>
          <option value="header">API key in a header</option>
          <option value="query">API key in a query parameter</option>
          <option value="bearer">Bearer token</option>
        </SelectField>
        {(form.authType === 'header' || form.authType === 'query') &&
          text('authName', form.authType === 'header' ? 'Header name' : 'Query parameter name', {
            required: true,
            hint:
              form.authType === 'query'
                ? 'Added to each URL, unless the URL has {apikey} where the key goes.'
                : undefined,
          })}
        {needsKey && keys.length > 0 && (
          <SelectField
            name="custom-key"
            label="API key"
            value={keyState.credentialId}
            required
            onChange={(e) => onKeyState({ ...keyState, credentialId: e.target.value })}
          >
            <option value="">Choose a stored key</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
            <option value="new">Add a new key…</option>
          </SelectField>
        )}
        {typingKey && (
          <CredentialFields
            provider="custom_rest"
            idPrefix="custom-key"
            values={keyState.newKey}
            onChange={(newKey) => onKeyState({ ...keyState, newKey })}
          />
        )}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Endpoints</legend>
        <p className="text-xs text-ink-muted">
          Placeholders: {'{symbol}'}, {'{from}'} and {'{to}'} (New York dates, YYYY-MM-DD) and{' '}
          {'{apikey}'}. A URL can also be a path that follows the base URL, such as /bars?symbol=
          {'{symbol}'}.
        </p>
        {text('barsUrl', 'Daily bars URL', {
          required: true,
          placeholder: 'https://api.example.com/v1/bars?symbol={symbol}&from={from}&to={to}',
        })}
        {text('quoteUrl', 'Latest quote URL', {
          required: true,
          placeholder: 'https://api.example.com/v1/quote?symbol={symbol}',
        })}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Where the numbers are</legend>
        <p className="text-xs text-ink-muted">
          JSON paths: keys joined by dots, [] for every item of the list of bars, [0] for one item.
          For example data.bars[].close or results[0].price.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {text('barTimestamp', 'Bar date', { required: true, placeholder: 'data.bars[].date' })}
          <SelectField
            name="custom-barTimestampFormat"
            label="Bar date format"
            value={form.barTimestampFormat}
            onChange={(e) => set('barTimestampFormat', e.target.value as TimestampFormat)}
          >
            <option value="iso">ISO date, e.g. 2026-11-05</option>
            <option value="unix_seconds">Unix seconds</option>
          </SelectField>
          {text('open', 'Open', { required: true, placeholder: 'data.bars[].open' })}
          {text('high', 'High', { required: true, placeholder: 'data.bars[].high' })}
          {text('low', 'Low', { required: true, placeholder: 'data.bars[].low' })}
          {text('close', 'Close', { required: true, placeholder: 'data.bars[].close' })}
          {text('volume', 'Volume', { required: true, placeholder: 'data.bars[].volume' })}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {text('last', 'Quote last price', { required: true, placeholder: 'quote.last' })}
          {text('bid', 'Quote bid (optional)', { hint: 'Without one, bid reads the last price.' })}
          {text('ask', 'Quote ask (optional)', { hint: 'Without one, ask reads the last price.' })}
          {text('quoteTimestamp', 'Quote time (optional)', {
            hint: 'Without one, a price is as old as its fetch, so a delayed feed looks current.',
          })}
          <SelectField
            name="custom-quoteTimestampFormat"
            label="Quote time format"
            value={form.quoteTimestampFormat}
            onChange={(e) => set('quoteTimestampFormat', e.target.value as TimestampFormat)}
          >
            <option value="unix_seconds">Unix seconds</option>
            <option value="iso">ISO date-time</option>
          </SelectField>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Limits</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {text('providerRequestsPerMinute', 'Provider’s documented limit (requests a minute)', {
            required: true,
            hint: 'From the provider’s pricing or API page.',
          })}
          {text('requestsPerMinute', 'This app may use (requests a minute)', {
            required: true,
            hint: `Starts at ${CUSTOM_REST_LIMITS.defaultRequestsPerMinute}; lower it freely, never above the provider’s limit or ${CUSTOM_REST_LIMITS.maxRequestsPerMinute}.`,
          })}
          {text('requestsPerDay', 'Daily limit (optional)', {
            hint: `For free tiers counted by the day. Health checks run every minute (about 1,440 a day), or every ${CUSTOM_REST_LIMITS.slowCheckSeconds / 60} minutes (96 a day) when this is under ${CUSTOM_REST_LIMITS.smallDailyLimit.toLocaleString('en-US')}.`,
          })}
          {text('timeoutSec', 'Timeout (seconds)', {
            required: true,
            hint: `${CUSTOM_REST_LIMITS.timeoutMs.min / 1000} to ${CUSTOM_REST_LIMITS.timeoutMs.max / 1000} seconds a request.`,
          })}
          {text('testSymbol', 'Health check symbol', {
            required: true,
            hint: 'Its latest quote is fetched at each health check while the feed is on.',
          })}
        </div>
      </fieldset>

      <section
        aria-labelledby="custom-test-heading"
        className="space-y-2 rounded-md border border-line p-3"
      >
        <h3 id="custom-test-heading" className="text-sm font-semibold">
          Test before saving
        </h3>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-32">
            <TextField
              name="custom-test-symbol"
              label="Symbol"
              value={testSymbol}
              onChange={(e) => onTestSymbol(e.target.value.toUpperCase())}
            />
          </div>
          <Button type="button" onClick={onTest} disabled={testing}>
            {testing ? 'Testing…' : 'Test'}
          </Button>
        </div>
        {testError && <Alert>{testError}</Alert>}
        <TestOutcome test={test} />
      </section>
    </div>
  );
}

function TestOutcome({ test }: { test: CustomFeedTestDto | null }) {
  if (!test || test.status === 'pending') return null;
  if (test.status === 'failed') {
    return (
      <div role="status" className="text-sm">
        <p className="font-medium text-danger">The test failed</p>
        <p className="mt-1 break-words">{test.message}</p>
      </div>
    );
  }
  const r = test.result;
  if (!r) return null;
  return (
    <div role="status" className="space-y-2 text-sm">
      <p className="font-medium text-ok">
        Test passed: {r.bars.count} daily bars for {r.symbol} ({r.bars.first} to {r.bars.last}),
        latest price {r.quote.last}
        {r.quote.bid ? `, bid ${r.quote.bid}` : ''}
        {r.quote.ask ? `, ask ${r.quote.ask}` : ''}
        {r.quote.at
          ? ` at ${new Date(r.quote.at).toISOString().replace('T', ' ').slice(0, 19)} UTC`
          : ''}
      </p>
      <Table label={`Latest bars read for ${r.symbol}`}>
        <thead>
          <tr>
            <Th>Date</Th>
            <Th numeric>Open</Th>
            <Th numeric>High</Th>
            <Th numeric>Low</Th>
            <Th numeric>Close</Th>
            <Th numeric>Volume</Th>
          </tr>
        </thead>
        <tbody>
          {r.bars.sample.map((b) => (
            <tr key={b.date}>
              <Td className="text-content">{b.date}</Td>
              <Td numeric>{b.open}</Td>
              <Td numeric>{b.high}</Td>
              <Td numeric>{b.low}</Td>
              <Td numeric>{b.close}</Td>
              <Td numeric>{b.volume}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="break-all text-xs text-ink-muted">
        Fetched {r.bars.url} and {r.quote.url}
      </p>
    </div>
  );
}

/** Polls a test until the worker has finished it. */
export function useCustomTest() {
  const [test, setTest] = useState<CustomFeedTestDto | null>(null);
  const [testing, setTesting] = useState(false);
  const [testedKey, setTestedKey] = useState<string | null>(null);
  const cancelled = useRef(false);
  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  async function run(start: () => Promise<CustomFeedTestDto>, key: string) {
    setTesting(true);
    setTest(null);
    cancelled.current = false;
    try {
      let current = await start();
      const deadline = Date.now() + 45_000;
      while (current.status === 'pending' && Date.now() < deadline && !cancelled.current) {
        await new Promise((r) => setTimeout(r, 1000));
        current = await apiClient.feeds.customTest(current.id);
      }
      if (current.status === 'pending') {
        current = { ...current, status: 'failed', message: 'The test took too long. Try again.' };
      }
      setTest(current);
      setTestedKey(key);
    } finally {
      setTesting(false);
    }
  }
  const reset = () => {
    setTest(null);
    setTestedKey(null);
  };
  return { test, testing, testedKey, run, reset };
}
