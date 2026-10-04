import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createDb } from '@tm/db';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';
import { startBacktestLoop, type BacktestLoop } from './backtests';
import { loadWorkerEnv, shiftedClock } from './env';
import { createHealthServer } from './health';
import { createLogger } from './logger';
import { startRuntimeLoop, type RuntimeLoop } from './runtime';

const env = loadWorkerEnv();
const logger = createLogger(env.LOG_LEVEL);

let loop: BacktestLoop | undefined;
let runtimes: RuntimeLoop | undefined;
let closeDb: (() => Promise<void>) | undefined;
const databaseUrl = env.DATABASE_WORKER_URL ?? env.DATABASE_APP_URL;
if (databaseUrl) {
  if (!env.DATABASE_WORKER_URL) {
    logger.warn('DATABASE_WORKER_URL is not set; stored provider credentials cannot be opened');
  }
  const handle = createDb(databaseUrl, { max: 4 });
  closeDb = handle.close;
  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  loop = startBacktestLoop({
    db: handle.db,
    provider: createDemoHistoryProvider(),
    workerId,
    logger,
    pollMs: env.BACKTEST_POLL_MS,
  });
  logger.info({ workerId }, 'back-test queue started');
  const now = env.PAPER_CLOCK_START ? shiftedClock(env.PAPER_CLOCK_START) : undefined;
  if (now) logger.warn({ start: env.PAPER_CLOCK_START }, 'paper runtimes use a shifted clock');
  runtimes = startRuntimeLoop({
    ...(now ? { now } : {}),
    db: handle.db,
    workerId,
    history: (now) => createDemoHistoryProvider({ now }),
    quotes: (now) => createDemoLiveFeed({ now }),
    logger,
    pollMs: env.RUNTIME_POLL_MS,
  });
  logger.info({ workerId }, 'paper strategy runtimes started');
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
      await Promise.all([loop?.stop(), runtimes?.stop()]);
      await closeDb?.();
      server.close(() => process.exit(0));
    })();
  });
}
