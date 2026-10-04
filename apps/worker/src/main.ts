import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createDb } from '@tm/db';
import { createDemoHistoryProvider } from '@tm/market-data';
import { startBacktestLoop, type BacktestLoop } from './backtests';
import { loadWorkerEnv } from './env';
import { createHealthServer } from './health';
import { createLogger } from './logger';

const env = loadWorkerEnv();
const logger = createLogger(env.LOG_LEVEL);

let loop: BacktestLoop | undefined;
let closeDb: (() => Promise<void>) | undefined;
if (env.DATABASE_APP_URL) {
  const handle = createDb(env.DATABASE_APP_URL, { max: 4 });
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
} else {
  logger.warn('DATABASE_APP_URL is not set; the worker runs no jobs');
}

const server = createHealthServer(loop ? 'backtests' : 'none');
server.listen(env.WORKER_HEALTH_PORT, () => {
  logger.info({ port: env.WORKER_HEALTH_PORT }, 'worker health endpoint listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'worker shutting down');
    // Finish the current run (or give up its lease to lapse), then exit.
    void (async () => {
      await loop?.stop();
      await closeDb?.();
      server.close(() => process.exit(0));
    })();
  });
}
