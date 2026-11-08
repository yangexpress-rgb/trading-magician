import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from '@tm/alpaca/testing';
import { FAKE_SEC_DATA_URL, FAKE_SEC_WWW_URL, FakeSec } from '@tm/sec/testing';
import { StripeBilling } from '@tm/billing';
import { createDb, withTenant } from '@tm/db';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';
import { resolveBuiltinUniverse } from './universes';
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
import { fundamentalsLoader } from './fundamentals';
import { createRoutedHistory } from './routed-history';
import { customRestProvider } from './custom-rest';
import { cboeProvider } from './cboe';
import { fakeCboeFetch } from './cboe-fake';
import { fakeCustomTransport } from './custom-rest-fake';
import { startRuntimeLoop, type RuntimeLoop } from './runtime';
import { startValuationLoop, type ValuationLoop } from './valuations';
import {
  AlpacaClient,
  createAlpacaHistory,
  fetchOptionBars,
  fetchOptionContracts,
  lookupAlpacaAsset,
} from '@tm/alpaca';
import { cboeOptionsSource } from './options/cboe-options';
import { fakeCboeOptionsFetch } from './options/cboe-options-fake';
import { optionsFeedProvider } from './options/feed';
import { resolveOptionsAlpacaKey } from './options/app-key';
import { startLiveChainLoop, type LiveChainLoop } from './options/live-chain';
import { startOptionsLoop, type OptionsLoop } from './options/loop';
import { marketInputs } from './options/market-inputs';

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
let optionsLoop: OptionsLoop | undefined;
let liveChains: LiveChainLoop | undefined;
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
  const customTransport = env.CUSTOM_REST_FAKE
    ? fakeCustomTransport({ now: now ?? (() => new Date()) })
    : undefined;
  if (customTransport) logger.warn('Custom REST feeds reach a local fake JSON API');
  const providers: ProviderRegistry = {
    demo: demoProvider(quotes, history),
    alpaca: alpacaProvider(alpacaOptions),
    custom_rest: customRestProvider({ transport: customTransport }),
    cboe: cboeProvider({
      fetch: env.CBOE_FAKE ? fakeCboeFetch(now ?? (() => new Date())) : undefined,
      historyUrl: env.CBOE_HISTORY_URL,
      fredUrl: env.FRED_CSV_URL,
    }),
  };
  if (env.CBOE_FAKE) logger.warn('CBOE index history comes from a local fake');
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
  const companyFilings = fundamentalsLoader({
    db,
    fundamentals,
    privateKey: credentialKey,
    logger,
  });
  loop = startBacktestLoop({
    db,
    provider: (userId) =>
      createRoutedHistory({
        inTenant: (fn) => withTenant(db, { userId }, fn),
        userId,
        now: () => new Date(),
        providers,
        privateKey: credentialKey,
        patient: true,
      }),
    resolveUniverse: (userId) =>
      resolveBuiltinUniverse({
        db,
        userId,
        providers,
        privateKey: credentialKey,
        now: () => new Date(),
      }),
    fundamentals: companyFilings,
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
    fundamentals: companyFilings,
    logger,
    pollMs: env.RUNTIME_POLL_MS,
  });
  logger.info({ workerId }, 'paper strategy runtimes started');
  feedChecks = startFeedCheckLoop({
    ...(now ? { now } : {}),
    db: handle.db,
    providers,
    fundamentals,
    options: { cboe_options: optionsFeedProvider() },
    privateKey: credentialKey,
    logger,
    customTransport,
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
    filings: companyFilings,
    privateKey: credentialKey,
    logger,
    pollMs: env.BACKTEST_POLL_MS,
  });
  {
    // Options data (ADR 0047) is recorded once for every tenant, so the closes and
    // the history rebuild go through one key: the worker's own, or else a platform
    // admin's Alpaca paper feed (ADR 0050).
    const resolved = env.ALPACA_FAKE
      ? undefined
      : await resolveOptionsAlpacaKey({
          db,
          env: { keyId: env.OPTIONS_ALPACA_KEY_ID, secretKey: env.OPTIONS_ALPACA_SECRET_KEY },
          privateKey: credentialKey,
          logger,
        });
    const appKey = env.ALPACA_FAKE
      ? new FakeAlpaca({ now: () => new Date() }).credentials
      : resolved
        ? { keyId: resolved.keyId, secretKey: resolved.secretKey }
        : undefined;
    if (resolved?.source === 'admin_feed')
      logger.info("options data uses the platform admin's Alpaca paper feed key");
    const client = appKey
      ? new AlpacaClient({
          credentials: appKey,
          fetch: alpacaOptions.fetch,
          // The recording yields to strategies and screens on a shared key (ADR 0052);
          // the local fake has no limit to share.
          background: !alpacaOptions.fake,
          ...(alpacaOptions.fake
            ? {
                tradingUrl: alpacaOptions.fake.tradingUrl,
                dataUrl: alpacaOptions.fake.dataUrl,
                allowLocal: true,
              }
            : {}),
        })
      : undefined;
    if (!appKey) {
      logger.warn(
        'No Alpaca key for options data (OPTIONS_ALPACA_KEY_ID unset and no admin Alpaca feed): option chains are stored, but signals wait for an Alpaca close and the history rebuild waits',
      );
    }
    const history = client ? createAlpacaHistory(client, { patient: true }) : undefined;
    const chains = cboeOptionsSource({
      fetch: env.CBOE_OPTIONS_FAKE ? fakeCboeOptionsFetch(() => new Date()) : undefined,
      baseUrl: env.CBOE_OPTIONS_URL,
    });
    const inputs = marketInputs({
      history,
      fredUrl: env.FRED_CSV_URL,
      fixedRate: env.CBOE_OPTIONS_FAKE ? 0.04 : undefined,
    });
    // Research › Options asks for live chains whether or not the daily recording runs (ADR 0048).
    liveChains = startLiveChainLoop({ db, chains, inputs, logger });
    if (env.OPTIONS_RECORDING === 'on') {
      optionsLoop = startOptionsLoop({
        db,
        logger,
        historyDays: env.OPTIONS_HISTORY_DAYS,
        chains,
        inputs,
        rebuild: client
          ? {
              contracts: (q) => fetchOptionContracts(client, q),
              bars: (symbols, from, to) => fetchOptionBars(client, symbols, from, to),
            }
          : undefined,
        lookup: client
          ? async (symbol) => {
              const found = await lookupAlpacaAsset(client, symbol);
              return (
                found && {
                  assetClass: found.assetClass,
                  symbol: found.symbol,
                  venue: found.venue,
                  displayName: found.displayName,
                  providerId: found.providerId,
                  shortable: found.shortable,
                }
              );
            }
          : undefined,
      });
      logger.info('options recording started');
    }
    if (env.CBOE_OPTIONS_FAKE) logger.warn('CBOE options files come from a local fake');
  }
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
        optionsLoop?.stop(),
        liveChains?.stop(),
        billing?.stop(),
        heartbeat?.stop(),
      ]);
      clearInterval(fakeTicker);
      await Promise.all([closeDb?.(), reporter.flush()]);
      server.close(() => process.exit(0));
    })();
  });
}
