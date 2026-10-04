import { loadWorkerEnv } from './env';
import { createHealthServer } from './health';
import { createLogger } from './logger';

const env = loadWorkerEnv();
const logger = createLogger(env.LOG_LEVEL);
const server = createHealthServer();

server.listen(env.WORKER_HEALTH_PORT, () => {
  logger.info({ port: env.WORKER_HEALTH_PORT }, 'worker health endpoint listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'worker shutting down');
    server.close(() => process.exit(0));
  });
}
