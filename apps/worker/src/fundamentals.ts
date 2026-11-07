import {
  activeFundamentalsFeed,
  fundamentalSyncTimes,
  loadFundamentals,
  openCredential,
  saveFundamentals,
  withTenant,
  type CredentialKey,
  type Database,
} from '@tm/db';
import { UnsupportedBarRequestError, type FundamentalObservation } from '@tm/domain';
import type { Logger } from 'pino';
import type { FundamentalsRegistry, ProviderContext } from './providers';

/**
 * Point-in-time fundamentals for back tests and paper runs (Design v1.2
 * item 6, ADR 0043). Observations are kept once for every tenant; a company
 * is fetched again through the tenant's company data feed when its last
 * sync is older than a day, so a new 10-Q reaches running strategies within
 * a day of being filed.
 */

export const FUNDAMENTALS_TTL_MS = 24 * 60 * 60 * 1000;

export const NO_COMPANY_FEED =
  'Fundamental metrics read company filings: add an SEC EDGAR company data feed in Settings › Data feeds';

export interface FundamentalsResult {
  /** Observations by instrument id, sorted by when they became known. */
  byId: Map<string, FundamentalObservation[]>;
  warnings: string[];
  /** Companies left unsynced because the time budget ran out. */
  unsynced: number;
}

export interface FundamentalsLoadOptions {
  /** Called after each company fetched, e.g. to keep a queue lease. */
  onProgress?: () => Promise<void>;
  /** Stop fetching after this long and use what is stored (the screener); no limit by default. */
  budgetMs?: number;
  /** One warning per symbol without filings (default); false leaves them out. */
  perSymbolWarnings?: boolean;
}

export type FundamentalsLoader = (
  userId: string,
  instruments: readonly { id: string; symbol: string }[],
  load?: FundamentalsLoadOptions,
) => Promise<FundamentalsResult>;

export interface FundamentalsLoaderOptions {
  db: Database;
  fundamentals: FundamentalsRegistry;
  privateKey: CredentialKey | undefined;
  now?: () => Date;
  ttlMs?: number;
  logger?: Pick<Logger, 'warn'>;
}

export function fundamentalsLoader(options: FundamentalsLoaderOptions): FundamentalsLoader {
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? FUNDAMENTALS_TTL_MS;
  return async (userId, instruments, load = {}) => {
    const byId = new Map<string, FundamentalObservation[]>();
    const warnings: string[] = [];
    let unsynced = 0;
    if (instruments.length === 0) return { byId, warnings, unsynced };
    const started = Date.now();
    const perSymbol = load.perSymbolWarnings ?? true;

    const opened = await withTenant(options.db, { userId }, async (tx) => {
      const feed = await activeFundamentalsFeed(tx);
      const provider = feed ? options.fundamentals[feed.provider] : undefined;
      if (!feed || !provider?.companies || !provider.pointInTime) return undefined;
      const credential =
        provider.needsCredential && feed.credentialRef
          ? await openCredential(tx, {
              userId,
              id: feed.credentialRef,
              privateKey: options.privateKey,
            })
          : undefined;
      return { provider, ctx: { now, credential, userId } satisfies ProviderContext };
    });
    if (!opened) throw new UnsupportedBarRequestError(NO_COMPANY_FEED);
    const { provider, ctx } = opened;

    const ciks = await (provider.companies as NonNullable<typeof provider.companies>)(ctx);
    const cikOf = new Map<string, number>();
    for (const i of instruments) {
      const cik = ciks.get(i.symbol.toUpperCase());
      if (cik === undefined) {
        if (perSymbol)
          warnings.push(`${i.symbol}: no SEC filings, so its fundamentals are unknown`);
      } else cikOf.set(i.id, cik);
    }
    const unique = [...new Set(cikOf.values())];
    const synced = await fundamentalSyncTimes(options.db, unique);
    const symbolOf = new Map<number, string>();
    for (const i of instruments) {
      const cik = cikOf.get(i.id);
      if (cik !== undefined && !symbolOf.has(cik)) symbolOf.set(cik, i.symbol);
    }
    for (const cik of unique) {
      const last = synced.get(cik);
      if (last && now().getTime() - last.getTime() < ttlMs) continue;
      if (load.budgetMs !== undefined && Date.now() - started >= load.budgetMs) {
        unsynced++;
        continue;
      }
      const symbol = symbolOf.get(cik) ?? String(cik);
      try {
        const observations = await (
          provider.pointInTime as NonNullable<typeof provider.pointInTime>
        )(ctx, cik);
        await saveFundamentals(
          options.db,
          { cik, symbol, syncedAt: now(), status: observations ? 'ok' : 'missing' },
          observations ?? [],
        );
      } catch (error) {
        const e = error as { name?: string; message?: string };
        options.logger?.warn(
          { cik, err: { name: e.name, message: e.message } },
          'fundamentals sync failed',
        );
        warnings.push(
          last
            ? `${symbol}: SEC EDGAR did not answer, so filings stored on ${last.toISOString().slice(0, 10)} were used`
            : `${symbol}: SEC EDGAR did not answer, so its fundamentals are unknown`,
        );
      }
      await load.onProgress?.();
    }

    const stored = await loadFundamentals(options.db, unique);
    for (const [id, cik] of cikOf) {
      const list = stored.get(cik);
      if (list && list.length > 0) byId.set(id, list);
    }
    return { byId, warnings, unsynced };
  };
}
