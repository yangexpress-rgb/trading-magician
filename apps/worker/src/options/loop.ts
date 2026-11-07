import {
  addSeedUnderlyings,
  listOptionUniverse,
  registerInstrument,
  underlyingsBySymbol,
  type ConfirmedInstrument,
  type Database,
} from '@tm/db';
import { nyDate, OPTION_SEED_SYMBOLS } from '@tm/domain';
import type { Logger } from 'pino';
import { rebuildUnderlying, type RebuildSource } from './rebuild';
import { runOptionsRecording, type OptionsJobOptions, type PassState } from './recording';

/**
 * The options worker loop (options data brief v2 §2, §5, ADR 0047): keeps the
 * seed list in the universe, records each session's chains, derives waiting
 * days, prunes old history and rebuilds one underlying's history at a time.
 */

export interface OptionsLoopOptions extends OptionsJobOptions {
  /** Alpaca option bars through the app's own key, for the history rebuild. */
  rebuild: RebuildSource | undefined;
  /** Finds a seed symbol the app doesn't know yet (through the app's Alpaca key). */
  lookup?:
    ((symbol: string) => Promise<Omit<ConfirmedInstrument, 'provider'> | undefined>) | undefined;
  pollMs?: number;
}

/** A waiting or failed rebuild is tried again after this long. */
const REBUILD_RETRY_MS = 24 * 3600_000;

/** Puts the seed list's instruments in the universe, registering any the app doesn't know. */
export async function seedOptionUniverse(
  db: Database,
  lookup: OptionsLoopOptions['lookup'],
  logger: Pick<Logger, 'warn'>,
) {
  const known = await underlyingsBySymbol(db, OPTION_SEED_SYMBOLS);
  for (const symbol of OPTION_SEED_SYMBOLS) {
    if (known.has(symbol) || !lookup) continue;
    try {
      const listing = await lookup(symbol);
      if (!listing) continue;
      const id = await db.transaction((tx) =>
        registerInstrument(tx, { ...listing, provider: 'alpaca' }),
      );
      known.set(symbol, id);
    } catch (e) {
      logger.warn({ symbol, err: { name: (e as Error).name } }, 'seed underlying lookup failed');
    }
  }
  await addSeedUnderlyings(db, [...known.values()]);
  return known.size;
}

export interface OptionsLoop {
  stop: () => Promise<void>;
}

export function startOptionsLoop(options: OptionsLoopOptions): OptionsLoop {
  const pollMs = options.pollMs ?? 60_000;
  const now = options.now ?? (() => new Date());
  const state: PassState = { derivedAt: new Map() };
  const rebuildTried = new Map<string, number>();
  let seededOn: string | undefined;
  let running = true;
  let wake: (() => void) | undefined;

  async function pass() {
    const today = nyDate(now());
    if (seededOn !== today) {
      await seedOptionUniverse(options.db, options.lookup, options.logger);
      seededOn = today;
    }
    await runOptionsRecording(options, state);
    // One rebuild per pass, oldest waiting first; never two for the same underlying in a day.
    const universe = await listOptionUniverse(options.db);
    const due = universe.find((u) => {
      // 'running' left by a worker that stopped mid-rebuild is picked up again.
      if (u.rebuildStatus === 'done') return false;
      const last = rebuildTried.get(u.underlyingId);
      return last === undefined || now().getTime() - last >= REBUILD_RETRY_MS;
    });
    if (due) {
      rebuildTried.set(due.underlyingId, now().getTime());
      await rebuildUnderlying({ ...options, source: options.rebuild }, due);
    }
  }

  const done = (async () => {
    while (running) {
      try {
        await pass();
      } catch (error) {
        const e = error as { name?: string; message?: string };
        options.logger.warn({ err: { name: e.name, message: e.message } }, 'options loop failed');
      }
      if (!running) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  })();

  return {
    stop: async () => {
      running = false;
      wake?.();
      await done;
    },
  };
}
