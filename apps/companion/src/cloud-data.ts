import type { InstrumentRef } from '@tm/backtest';
import {
  COMPANION_FETCH_MAX_ITEMS,
  decodeBars,
  decodeEvents,
  type BarsAnswer,
  type EventsAnswer,
  type FilingsAnswer,
  type MembersAnswer,
  type OptionSignalsAnswer,
  type PatternMembersAnswer,
  type SnapshotFilings,
} from '@tm/db';
import type {
  BarRequest,
  BarSeries,
  EventData,
  HistoricalDataProvider,
  OptionSignal,
} from '@tm/domain';
import type { CompanionClient, FetchKind } from './api';

/**
 * The data the feature writer reads, asked of the cloud (ADR 0118): the
 * worker answers each request through the same feeds and functions the
 * cloud's own snapshot job uses. Requests are split to the cloud's limit and
 * polled until answered.
 */

export interface CloudDataOptions {
  /** Between polls for an answer. */
  pollMs?: number;
  /** Longest wait for one answer (bars wait on the feed's background budget). */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export class CloudDataError extends Error {
  override name = 'CloudDataError';
}

export class CloudData {
  private readonly refs = new Map<string, InstrumentRef>();
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: CompanionClient,
    private readonly options: CloudDataOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Asks once and waits for the answer. */
  async ask<T>(kind: FetchKind, request: unknown): Promise<T> {
    const id = await this.client.fetch(kind, request);
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (this.options.signal?.aborted) throw new CloudDataError('Stopped');
      const state = await this.client.fetchState(id);
      if (state.status === 'done') return state.answer as T;
      if (state.status === 'failed') throw new CloudDataError(state.error);
      if (Date.now() > deadline) {
        throw new CloudDataError(`Trading Magician did not answer the ${kind} request in time`);
      }
      await this.sleep(this.pollMs);
    }
  }

  /** A model universe's members today; their instruments are kept for `instrumentRefs`. */
  async members(universe: string): Promise<string[]> {
    const answer = await this.ask<MembersAnswer>('members', { universe });
    for (const [id, ref] of answer.refs) this.refs.set(id, ref);
    return answer.ids;
  }

  /** The factor store's members (ADR 0119); their instruments are kept for `instrumentRefs`. */
  async patternMembers(): Promise<Omit<PatternMembersAnswer, 'refs'>> {
    const answer = await this.ask<PatternMembersAnswer>('pattern_members', {});
    for (const [id, ref] of answer.refs) this.refs.set(id, ref);
    return { members: answer.members, sessionMembers: answer.sessionMembers, from: answer.from };
  }

  /** Daily options signals from a date on. */
  async optionSignals(ids: readonly string[], from: string): Promise<Map<string, OptionSignal[]>> {
    const out = new Map<string, OptionSignal[]>();
    for (let i = 0; i < ids.length; i += COMPANION_FETCH_MAX_ITEMS) {
      const answer = await this.ask<OptionSignalsAnswer>('option_signals', {
        ids: ids.slice(i, i + COMPANION_FETCH_MAX_ITEMS),
        from,
      });
      for (const [id, list] of answer.byId) out.set(id, list);
    }
    return out;
  }

  /** The instruments of members already asked for (the members answer carries them). */
  async instrumentRefs(ids: readonly string[]): Promise<ReadonlyMap<string, InstrumentRef>> {
    const out = new Map<string, InstrumentRef>();
    for (const id of ids) {
      const ref = this.refs.get(id);
      if (ref) out.set(id, ref);
    }
    return out;
  }

  async bars(requests: readonly BarRequest[]): Promise<(BarSeries | Error)[]> {
    const out: (BarSeries | Error)[] = [];
    for (let i = 0; i < requests.length; i += COMPANION_FETCH_MAX_ITEMS) {
      const answer = await this.ask<BarsAnswer>('bars', {
        requests: requests.slice(i, i + COMPANION_FETCH_MAX_ITEMS),
      });
      out.push(...decodeBars(answer));
    }
    return out;
  }

  /** Bars as a provider the back test's loader reads. */
  history(): HistoricalDataProvider {
    return {
      id: 'cloud',
      intervals: ['5m', '1d'],
      getBars: async (request) => {
        const [answer] = await this.bars([request]);
        if (!answer || answer instanceof Error) throw answer ?? new CloudDataError('No answer');
        return answer;
      },
      getBarsMany: (requests) => this.bars(requests),
    };
  }

  /** Point-in-time filings, through the cloud's company data feed. */
  readonly filings: SnapshotFilings = async (_userId, instruments) => {
    const byId = new Map<string, FilingsAnswer['byId'][number][1]>();
    for (let i = 0; i < instruments.length; i += COMPANION_FETCH_MAX_ITEMS) {
      const answer = await this.ask<FilingsAnswer>('filings', {
        instruments: instruments.slice(i, i + COMPANION_FETCH_MAX_ITEMS),
      });
      for (const [id, obs] of answer.byId) byId.set(id, obs);
    }
    return { byId };
  };

  /** The events store's data for the metrics each instrument reads (the same for all, as both jobs ask). */
  async events(reads: ReadonlyMap<string, ReadonlySet<string>>): Promise<EventData> {
    const ids = [...reads.keys()];
    const metrics = [...new Set([...reads.values()].flatMap((m) => [...m]))].sort();
    let merged: EventsAnswer | undefined;
    for (let i = 0; i < ids.length; i += COMPANION_FETCH_MAX_ITEMS) {
      const answer = await this.ask<EventsAnswer>('events', {
        ids: ids.slice(i, i + COMPANION_FETCH_MAX_ITEMS),
        ...(metrics.length > 0 ? { metrics } : {}),
      });
      if (!merged) {
        merged = answer;
        continue;
      }
      // Per-instrument parts add up; the market-wide ones are the same in every answer.
      merged.earnings.push(...answer.earnings);
      merged.calendar.push(...answer.calendar);
      merged.deals = [...(merged.deals ?? []), ...(answer.deals ?? [])];
      if (answer.shortInterest)
        merged.shortInterest = [...(merged.shortInterest ?? []), ...answer.shortInterest];
    }
    return decodeEvents(merged ?? { earnings: [], calendar: [] });
  }
}
