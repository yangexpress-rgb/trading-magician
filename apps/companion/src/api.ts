import { z } from 'zod';

/**
 * The client for the cloud's companion API (ADR 0116). Every call carries the
 * pairing token; the cloud answers as the person who paired. Errors come back
 * as `CompanionApiError` with the cloud's code, so the scheduler can tell
 * "unpaired" (stop) from "rate limited" or "offline" (try later).
 */

export const Instrument = z.object({
  id: z.string(),
  symbol: z.string(),
  assetClass: z.string(),
  kind: z.string(),
  displayName: z.string(),
  venue: z.string(),
  currency: z.string(),
});
export type Instrument = z.infer<typeof Instrument>;

export const MembershipPeriod = z.object({
  groupId: z.string(),
  symbol: z.string(),
  instrumentId: z.string().nullable(),
  fromDate: z.string(),
  toDate: z.string().nullable(),
});
export type MembershipPeriod = z.infer<typeof MembershipPeriod>;

const HelloReply = z.object({
  connectionId: z.string(),
  seenAt: z.string(),
  serverTime: z.string(),
});
export type HelloReply = z.infer<typeof HelloReply>;

const InstrumentsReply = z.object({
  instruments: z.array(Instrument),
  next: z.string().nullable(),
});
const MembershipReply = z.object({ periods: z.array(MembershipPeriod) });

export const MlModel = z.object({
  id: z.string(),
  modelKey: z.string(),
  name: z.string(),
  universe: z.string(),
  featureSet: z.unknown(),
  featureSetVersion: z.number(),
  label: z.unknown(),
  algorithm: z.string(),
  status: z.string(),
  snapshotsFrom: z.string(),
  availability: z.unknown(),
});
export type MlModel = z.infer<typeof MlModel>;

export const MlRun = z.object({
  id: z.string(),
  modelId: z.string(),
  runNo: z.number(),
  predictionDate: z.string(),
  trainingStart: z.string(),
  trainingEnd: z.string(),
  maxLabelEnd: z.string(),
  rowsTrained: z.number(),
  crossSections: z.number(),
  hyperparams: z.unknown(),
  coefficients: z.unknown(),
  codeVersion: z.string(),
  source: z.string(),
  createdAt: z.string(),
});
export type MlRun = z.infer<typeof MlRun>;

const MlStateReply = z.object({ models: z.array(MlModel), runs: z.array(MlRun) });
const PredictionsReply = z.object({ predictions: z.array(z.tuple([z.string(), z.number()])) });
const PushReply = z.object({ pushId: z.string(), duplicate: z.boolean() });
export const PushSummary = z.object({
  id: z.string(),
  kind: z.string(),
  clientKey: z.string(),
  receivedAt: z.string(),
  appliedAt: z.string().nullable(),
  result: z.unknown(),
  error: z.string().nullable(),
});
export type PushSummary = z.infer<typeof PushSummary>;
const PushesReply = z.object({ pushes: z.array(PushSummary) });

export type PushKind = 'ml_run' | 'ml_evaluation' | 'ml_report' | 'pattern_scan_result';

export type FetchKind =
  'members' | 'bars' | 'filings' | 'events' | 'pattern_members' | 'option_signals' | 'pattern_scan';
const FetchReply = z.object({ fetchId: z.string() });
export const FetchState = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('done'), answer: z.unknown() }),
  z.object({ status: z.literal('failed'), error: z.string() }),
]);
export type FetchState = z.infer<typeof FetchState>;
const ErrorReply = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

/** Cloud codes that mean this pairing will never work again. */
const FINAL_CODES = new Set([
  'unauthorized',
  'connection_revoked',
  'connection_expired',
  'connection_closed',
]);

export class CompanionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'CompanionApiError';
  }

  /** The pairing is gone (unpaired, expired, account closed): stop and ask to pair again. */
  get final(): boolean {
    return this.status === 401 || FINAL_CODES.has(this.code);
  }
}

export interface CompanionClientOptions {
  apiBase: string;
  token: string;
  fetch?: typeof fetch;
  /** Per call; the cloud is never waited on for long. */
  timeoutMs?: number;
}

export class CompanionClient {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: CompanionClientOptions) {
    this.base = `${options.apiBase.replace(/\/+$/, '')}/api/companion/v1`;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  hello(input: { version: string; platform: string }): Promise<HelloReply> {
    return this.call('POST', '/hello', HelloReply, input);
  }

  instruments(after?: string): Promise<z.infer<typeof InstrumentsReply>> {
    const query = after ? `?after=${encodeURIComponent(after)}` : '';
    return this.call('GET', `/instruments${query}`, InstrumentsReply);
  }

  /** Every instrument, following the pages to the end. */
  async allInstruments(): Promise<Instrument[]> {
    const out: Instrument[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.instruments(after);
      out.push(...page.instruments);
      if (!page.next) return out;
      after = page.next;
    }
  }

  async membership(): Promise<MembershipPeriod[]> {
    return (await this.call('GET', '/membership', MembershipReply)).periods;
  }

  mlState(): Promise<z.infer<typeof MlStateReply>> {
    return this.call('GET', '/ml/state', MlStateReply);
  }

  async runPredictions(runId: string): Promise<[string, number][]> {
    const reply = await this.call(
      'GET',
      `/ml/runs/${encodeURIComponent(runId)}/predictions`,
      PredictionsReply,
    );
    return reply.predictions;
  }

  /** Queues one Frozen Output in the cloud; a repeated client key is the same push. */
  push(kind: PushKind, clientKey: string, payload: unknown): Promise<z.infer<typeof PushReply>> {
    return this.call('POST', '/pushes', PushReply, { kind, clientKey, payload });
  }

  /** Asks the cloud for data (ADR 0118); the answer comes later from `fetchState`. */
  async fetch(kind: FetchKind, request: unknown): Promise<string> {
    return (await this.call('POST', '/fetches', FetchReply, { kind, request })).fetchId;
  }

  /** A data request's state; a final answer is handed over once. */
  fetchState(fetchId: string): Promise<FetchState> {
    return this.call('GET', `/fetches/${encodeURIComponent(fetchId)}`, FetchState);
  }

  /** Pushes not applied yet, or refused. */
  async openPushes(): Promise<PushSummary[]> {
    return (await this.call('GET', '/pushes?open=1', PushesReply)).pushes;
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.token}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new CompanionApiError(
        0,
        'offline',
        `Could not reach Trading Magician: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const err = ErrorReply.safeParse(parsed);
      const retry = Number(response.headers.get('retry-after'));
      throw new CompanionApiError(
        response.status,
        err.success ? err.data.error.code : `http_${response.status}`,
        err.success ? err.data.error.message : `Trading Magician answered ${response.status}`,
        Number.isFinite(retry) && retry > 0 ? retry : null,
      );
    }
    const ok = schema.safeParse(parsed);
    if (!ok.success) {
      throw new CompanionApiError(
        response.status,
        'bad_reply',
        `Unexpected reply from ${path}; the companion may need updating`,
      );
    }
    return ok.data;
  }
}
