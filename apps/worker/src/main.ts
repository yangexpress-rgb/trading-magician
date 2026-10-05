import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from '@tm/alpaca/testing';
import { createDb, withTenant } from '@tm/db';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';
import { startBacktestLoop, type BacktestLoop } from './backtests';
import { loadWorkerEnv, shiftedClock } from './env';
import { createHealthServer } from './health';
import { startFeedCheckLoop, type FeedCheckLoop } from './feed-checks';
import { createLogger } from './logger';
import { alpacaProvider } from './alpaca';
import { startInstrumentLookupLoop, type LookupLoop } from './instrument-lookups';
import { demoProvider, type ProviderRegistry } from './providers';
import { createRoutedHistory } from './routed-history';
import { startRuntimeLoop, type RuntimeLoop } from './runtime';

const env = loadWorkerEnv();
const logger = createLogger(env.LOG_LEVEL);

let loop: BacktestLoop | undefined;
let runtimes: RuntimeLoop | undefined;
let feedChecks: FeedCheckLoop | undefined;
let lookups: LookupLoop | undefined;
let closeDb: (() => Promise<void>) | undefined;
const databaseUrl = env.DATABASE_WORKER_URL ?? env.DATABASE_APP_URL;
if (databaseUrl) {
  if (!env.DATABASE_WORKER_URL) {
    logger.warn('DATABASE_WORKER_URL is not set; stored provider credentials cannot be opened');
  }
  const handle = createDb(databaseUrl, { max: 4 });
  closeDb = handle.close;
  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const now = env.PAPER_CLOCK_START ? shiftedClock(env.PAPER_CLOCK_START) : undefined;
  if (now) logger.warn({ start: env.PAPER_CLOCK_START }, 'paper runtimes use a shifted clock');
  const quotes = (clock: () => Date) => createDemoLiveFeed({ now: clock });
  const history = (clock: () => Date) => createDemoHistoryProvider({ now: clock });
  let alpaca = alpacaProvider();
  if (env.ALPACA_FAKE) {
    const fake = new FakeAlpaca({ now: now ?? (() => new Date()) });
    alpaca = alpacaProvider({
      fetch: fake.fetch,
      fake: { tradingUrl: FAKE_ALPACA_TRADING_URL, dataUrl: FAKE_ALPACA_DATA_URL },
    });
    logger.warn('Alpaca calls go to a local fake');
  }
  const providers: ProviderRegistry = { demo: demoProvider(quotes, history), alpaca };
  const db = handle.db;
  loop = startBacktestLoop({
    db,
    provider: (userId) =>
      createRoutedHistory({
        inTenant: (fn) => withTenant(db, { userId }, fn),
        userId,
        now: () => new Date(),
        providers,
        privateKey: env.CREDENTIALS_PRIVATE_KEY,
      }),
    workerId,
    logger,
    pollMs: env.BACKTEST_POLL_MS,
  });
  logger.info({ workerId }, 'back-test queue started');
  runtimes = startRuntimeLoop({
    ...(now ? { now } : {}),
    db: handle.db,
    workerId,
    history,
    quotes,
    providers,
    privateKey: env.CREDENTIALS_PRIVATE_KEY,
    logger,
    pollMs: env.RUNTIME_POLL_MS,
  });
  logger.info({ workerId }, 'paper strategy runtimes started');
  feedChecks = startFeedCheckLoop({
    ...(now ? { now } : {}),
    db: handle.db,
    providers,
    privateKey: env.CREDENTIALS_PRIVATE_KEY,
    logger,
    pollMs: env.FEED_CHECK_POLL_MS,
  });
  lookups = startInstrumentLookupLoop({
    db,
    providers,
    privateKey: env.CREDENTIALS_PRIVATE_KEY,
    logger,
    pollMs: env.FEED_CHECK_POLL_MS,
  });
} else {
  logger.warn('No database URL is set; the worker runs no jobs');
}

const server = createHealthServer(loop ? 'backtests+runtimes' : 'none');
server.listen(env.WORKER_HEALTH_PORT, () => {
  logger.info({ port: env.WORKER_HEALTH_PORT }, 'worker health endpoint listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'worker shutting down');
    // Finish the current run (or give up its lease to lapse), then exit.
    void (async () => {
      await Promise.all([loop?.stop(), runtimes?.stop(), feedChecks?.stop(), lookups?.stop()]);
      await closeDb?.();
      server.close(() => process.exit(0));
    })();
  });
}
