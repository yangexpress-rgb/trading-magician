import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from '@tm/alpaca/testing';
import { FAKE_SEC_DATA_URL, FAKE_SEC_WWW_URL, FakeSec } from '@tm/sec/testing';
import { StripeBilling } from '@tm/billing';
import { createDb, withTenant } from '@tm/db';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';
import { startBacktestLoop, type BacktestLoop } from './backtests';
import { startBillingLoop, type BillingLoop } from './billing-sync';
import { loadWorkerEnv, shiftedClock } from './env';
import { createHealthServer } from './health';
import { loadCredentialKey } from './credential-key';
import { startFeedCheckLoop, type FeedCheckLoop } from './feed-checks';
import { startHeartbeatLoop, type HeartbeatLoop } from './heartbeat';
import { createErrorReporter, createLogger } from './logger';
import { alpacaBrokerProvider, alpacaProvider, type AlpacaProviderOptions } from './alpaca';
import { startBrokerCheckLoop, type BrokerCheckLoop } from './broker-checks';
import { startInstrumentLookupLoop, type LookupLoop } from './instrument-lookups';
import { startPriceChartLoop, type PriceChartLoop } from './price-charts';
import { startStockScreenLoop, type StockScreenLoop } from './stock-screens';
import { startCompanyReportLoop, type CompanyReportLoop } from './company-reports';
import { demoProvider, type FundamentalsRegistry, type ProviderRegistry } from './providers';
import { secProvider, type SecProviderOptions } from './sec';
import { createRoutedHistory } from './routed-history';
import { startRuntimeLoop, type RuntimeLoop } from './runtime';
import { startValuationLoop, type ValuationLoop } from './valuations';

const env = loadWorkerEnv();
const reporter = createErrorReporter({
  dsn: env.SENTRY_DSN,
  service: 'worker',
  environment: env.SENTRY_ENVIRONMENT ?? env.RAILWAY_ENVIRONMENT_NAME ?? env.NODE_ENV,
  release: env.RAILWAY_GIT_COMMIT_SHA,
});
const logger = createLogger(env.LOG_LEVEL, { reporter });

// Report what would otherwise only crash the process, then crash as before
// so Railway restarts it (restartPolicyType ALWAYS).
const crash = (kind: string, reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.fatal({ err, kind }, 'worker crashed');
  void reporter.flush().finally(() => process.exit(1));
};
process.on('uncaughtException', (error) => crash('uncaught exception', error));
process.on('unhandledRejection', (reason) => crash('unhandled rejection', reason));

let loop: BacktestLoop | undefined;
let runtimes: RuntimeLoop | undefined;
let feedChecks: FeedCheckLoop | undefined;
let lookups: LookupLoop | undefined;
let charts: PriceChartLoop | undefined;
let screens: StockScreenLoop | undefined;
let companies: CompanyReportLoop | undefined;
let brokerChecks: BrokerCheckLoop | undefined;
let valuations: ValuationLoop | undefined;
let billing: BillingLoop | undefined;
let heartbeat: HeartbeatLoop | undefined;
let fakeTicker: ReturnType<typeof setInterval> | undefined;
let closeDb: (() => Promise<void>) | undefined;
const databaseUrl = env.DATABASE_WORKER_URL ?? env.DATABASE_APP_URL;
if (databaseUrl) {
  if (!env.DATABASE_WORKER_URL) {
    logger.warn('DATABASE_WORKER_URL is not set; stored provider credentials cannot be opened');
  }
  // Fails start-up if the KMS key cannot be read, rather than failing every provider call later.
  const credentialKey = await loadCredentialKey(env);
  if (credentialKey) {
    logger.info(
      {
        keyId: credentialKey.keyId,
        source: env.CREDENTIALS_KMS_KEY_ID ? 'aws-kms' : 'environment (development only)',
      },
      'credential key loaded',
    );
  }
  const handle = createDb(databaseUrl, { max: 4 });
  closeDb = handle.close;
  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const now = env.PAPER_CLOCK_START ? shiftedClock(env.PAPER_CLOCK_START) : undefined;
  if (now) logger.warn({ start: env.PAPER_CLOCK_START }, 'paper runtimes use a shifted clock');
  const quotes = (clock: () => Date) => createDemoLiveFeed({ now: clock });
  const history = (clock: () => Date) => createDemoHistoryProvider({ now: clock });
  let alpacaOptions: AlpacaProviderOptions = {};
  if (env.ALPACA_FAKE) {
    const fake = new FakeAlpaca({ now: now ?? (() => new Date()) });
    alpacaOptions = {
      fetch: fake.fetch,
      fake: { tradingUrl: FAKE_ALPACA_TRADING_URL, dataUrl: FAKE_ALPACA_DATA_URL },
    };
    // The fake's simulated market works resting orders as time passes.
    fakeTicker = setInterval(() => void fake.tick().catch(() => undefined), 500);
    logger.warn('Alpaca calls go to a local fake');
  }
  const providers: ProviderRegistry = {
    demo: demoProvider(quotes, history),
    alpaca: alpacaProvider(alpacaOptions),
  };
  const brokers = { alpaca: alpacaBrokerProvider(alpacaOptions) };
  let secOptions: SecProviderOptions = {};
  if (env.SEC_FAKE) {
    const fake = new FakeSec({ now: now ?? (() => new Date()) });
    secOptions = {
      fetch: fake.fetch,
      fake: { wwwUrl: FAKE_SEC_WWW_URL, dataUrl: FAKE_SEC_DATA_URL },
    };
    logger.warn('SEC EDGAR calls go to a local fake');
  }
  const fundamentals: FundamentalsRegistry = { sec: secProvider(secOptions) };
  const db = handle.db;
  loop = startBacktestLoop({
    db,
    provider: (userId) =>
      createRoutedHistory({
        inTenant: (fn) => withTenant(db, { userId }, fn),
        userId,
        now: () => new Date(),
        providers,
        privateKey: credentialKey,
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
    brokers,
    privateKey: credentialKey,
    logger,
    pollMs: env.RUNTIME_POLL_MS,
  });
  logger.info({ workerId }, 'paper strategy runtimes started');
  feedChecks = startFeedCheckLoop({
    ...(now ? { now } : {}),
    db: handle.db,
    providers,
    fundamentals,
    privateKey: credentialKey,
    logger,
    pollMs: env.FEED_CHECK_POLL_MS,
  });
  brokerChecks = startBrokerCheckLoop({
    ...(now ? { now } : {}),
    db,
    brokers,
    privateKey: credentialKey,
    logger,
    pollMs: env.FEED_CHECK_POLL_MS,
  });
  valuations = startValuationLoop({
    ...(now ? { now } : {}),
    db,
    providers,
    brokers,
    privateKey: credentialKey,
    logger,
    pollMs: env.FEED_CHECK_POLL_MS,
    everySeconds: env.VALUATION_EVERY_SEC,
  });
  billing = startBillingLoop({
    db,
    provider: env.STRIPE_SECRET_KEY
      ? new StripeBilling({ secretKey: env.STRIPE_SECRET_KEY })
      : undefined,
    fakePrices: env.BILLING_FAKE,
    logger,
    pollMs: 60_000,
  });
  heartbeat = startHeartbeatLoop({ db, instance: workerId, logger, everyMs: env.HEARTBEAT_MS });
  lookups = startInstrumentLookupLoop({
    db,
    providers,
    privateKey: credentialKey,
    logger,
    pollMs: env.FEED_CHECK_POLL_MS,
  });
  charts = startPriceChartLoop({
    db,
    providers,
    privateKey: credentialKey,
    logger,
    pollMs: env.BACKTEST_POLL_MS,
  });
  screens = startStockScreenLoop({
    db,
    providers,
    fundamentals,
    privateKey: credentialKey,
    logger,
    pollMs: env.BACKTEST_POLL_MS,
  });
  companies = startCompanyReportLoop({
    db,
    fundamentals,
    privateKey: credentialKey,
    logger,
    pollMs: env.BACKTEST_POLL_MS,
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
      await Promise.all([
        loop?.stop(),
        runtimes?.stop(),
        feedChecks?.stop(),
        lookups?.stop(),
        charts?.stop(),
        screens?.stop(),
        companies?.stop(),
        brokerChecks?.stop(),
        valuations?.stop(),
        billing?.stop(),
        heartbeat?.stop(),
      ]);
      clearInterval(fakeTicker);
      await Promise.all([closeDb?.(), reporter.flush()]);
      server.close(() => process.exit(0));
    })();
  });
}
