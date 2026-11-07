import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
/** Incremented by the application on every update; used for optimistic concurrency. */
const rowVersion = () => integer('row_version').notNull().default(1);
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const assetClass = pgEnum('asset_class', [
  'stock',
  'etf',
  'option',
  'future',
  'forex',
  'crypto',
  // Indices a strategy watches but never trades, such as the VIX (v1.2 item 5, ADR 0042).
  'index',
]);
/** Whether an instrument can be traded or only watched (v1.2 item 5, ADR 0042). */
export const instrumentKind = pgEnum('instrument_kind', ['tradable', 'indicator_only']);
export const optionRight = pgEnum('option_right', ['call', 'put']);
/** `live` exists in the vocabulary only; CHECK constraints below forbid it (ADR 0002). */
export const tradingMode = pgEnum('trading_mode', ['paper', 'live']);
export const connectionHealth = pgEnum('connection_health', [
  'unknown',
  'healthy',
  'degraded',
  'down',
]);
export const marketDataType = pgEnum('market_data_type', ['quotes', 'trades', 'bars']);
export const feedEntitlement = pgEnum('feed_entitlement', ['unknown', 'entitled', 'not_entitled']);
export const routeSource = pgEnum('route_source', ['primary', 'fallback']);
export const auditActorType = pgEnum('audit_actor_type', ['user', 'system']);

// ---------------------------------------------------------------------------
// Identity (§13.1). The `user` table is shared with the auth library (M0.3).
// ---------------------------------------------------------------------------

export const users = pgTable('user', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  /**
   * When the person deleted their account (§20 #14, design v1.1 C6). Sign-in
   * is refused from then on; the worker purges the account 30 days later.
   */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  /** When the purge ran: personal details gone, order and audit records kept. */
  purgedAt: timestamp('purged_at', { withTimezone: true }),
  /**
   * When an admin locked the account (ADR 0037). Sign-in is refused and every
   * session ended until an admin unlocks it.
   */
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  ...timestamps(),
});

/**
 * Who may open the admin page (ADR 0037). Granted only from the command line
 * with the owner connection, never from the app; no app role can read or write
 * it except through the admin_* functions.
 */
export const platformAdmins = pgTable('platform_admin', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Auth library tables (Better Auth). Only the tm_auth role can read them. */
export const sessions = pgTable(
  'session',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...timestamps(),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

export const accounts = pgTable(
  'account',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    /** Password hash for email/password sign-in. */
    password: text('password'),
    ...timestamps(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

export const verifications = pgTable(
  'verification',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

/** Shared rate-limit counters so limits hold across web instances (§16.1). */
export const rateLimits = pgTable('rate_limit', {
  id: id(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});

/**
 * Invite codes for the controlled launch (§16.4, ADR 0026). The code itself is
 * stored as a SHA-256 hash, so a leaked database row cannot be redeemed. One
 * code admits one person.
 */
export const invites = pgTable('invite', {
  id: id(),
  codeHash: char('code_hash', { length: 64 }).notNull().unique(),
  /** Who it was minted for, for the owner's own notes. No email is required. */
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimedBy: uuid('claimed_by').references(() => users.id, { onDelete: 'set null' }),
});

/**
 * Fixed-window counters for the app's own rate limits, shared by every web
 * instance (ADR 0025). Only `rate_limit_hit` touches it.
 */
export const apiRateLimits = pgTable('api_rate_limit', {
  key: text('key').primaryKey(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull(),
});

/** When each worker last showed it was alive, for the system health check (ADR 0025). */
export const serviceHeartbeats = pgTable('service_heartbeat', {
  service: text('service').primaryKey(),
  instance: text('instance').notNull(),
  beatAt: timestamp('beat_at', { withTimezone: true }).notNull(),
});

export const profiles = pgTable('profile', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  /** IANA zone. All timestamps are stored in UTC and displayed in this zone (§5.1). */
  timezone: text('timezone').notNull().default('America/New_York'),
  baseCurrency: char('base_currency', { length: 3 }).notNull().default('USD'),
  locale: text('locale').notNull().default('en-US'),
  notificationPrefs: jsonb('notification_prefs').notNull().default({}),
  ...timestamps(),
  rowVersion: rowVersion(),
});

/**
 * The plan catalog (§4.3; ADR 0022). Global configuration, read-only to the
 * app: a limit changes by updating a row, without a release. `offered` plans
 * are the ones people can choose; exactly one is the default for new users.
 */
export const plans = pgTable(
  'plan',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Price per interval in minor units (cents); 0 for a free plan. */
    priceMinor: integer('price_minor').notNull().default(0),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    interval: text('interval').notNull().default('month'),
    limits: jsonb('limits').notNull(),
    offered: boolean('offered').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    /** The billing provider's price for this plan (ADR 0023); null when it can't be bought. */
    stripePriceId: text('stripe_price_id').unique(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('plan_one_default')
      .on(t.isDefault)
      .where(sql`${t.isDefault}`),
    check('plan_price_not_negative', sql`${t.priceMinor} >= 0`),
    check(
      'plan_paper_only',
      sql`coalesce((${t.limits} ->> 'realIntegrations')::boolean, false) = false`,
    ),
  ],
);

export const entitlements = pgTable('entitlement', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  planCode: text('plan_code')
    .notNull()
    .references(() => plans.code),
  /** Per-user exceptions on top of the plan's limits; usually empty. */
  overrides: jsonb('overrides').notNull().default({}),
  ...timestamps(),
  rowVersion: rowVersion(),
});

export const subscriptionStatus = pgEnum('subscription_status', [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]);

/**
 * A workspace's subscription as the billing provider last reported it (§13.1;
 * ADR 0023). Webhooks are authoritative; the app writes it only through the
 * apply_subscription function, which also moves the entitlement's plan.
 */
export const subscriptions = pgTable(
  'subscription',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('stripe'),
    customerId: text('customer_id').notNull(),
    subscriptionId: text('subscription_id').unique(),
    status: subscriptionStatus('status'),
    priceId: text('price_id'),
    /** The plan this subscription pays for; the entitlement may differ during a grace period. */
    planCode: text('plan_code').references(() => plans.code),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    /** Set when a payment fails; the paid plan holds until then (ADR 0024). */
    graceEndsAt: timestamp('grace_ends_at', { withTimezone: true }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    syncLeaseExpiresAt: timestamp('sync_lease_expires_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [unique('subscription_customer_unique').on(t.provider, t.customerId)],
);

/**
 * Billing webhook events already applied, by the provider's event id, so a
 * replayed event changes nothing (§19.8). Ids and types only; no payloads.
 */
export const billingEvents = pgTable('billing_event', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull().default('stripe'),
  type: text('type').notNull(),
  userId: uuid('user_id'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Audit (§16.2). Append-only, enforced by grants and a trigger. `user_id` has no
// foreign key so the trail outlives account deletion; it must never hold PII
// beyond that identifier (retention policy: §20 #14).
// ---------------------------------------------------------------------------

export const auditEvents = pgTable(
  'audit_event',
  {
    id: id(),
    /** Null only for operator actions that belong to no workspace (invite codes, ADR 0034). */
    userId: uuid('user_id'),
    actorType: auditActorType('actor_type').notNull(),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id'),
    beforeRef: text('before_ref'),
    afterRef: text('after_ref'),
    context: jsonb('context').notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_event_user_time_idx').on(t.userId, t.occurredAt),
    check(
      'audit_event_operator_is_system',
      sql`${t.userId} IS NOT NULL OR ${t.actorType} = 'system'`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Reference data (§13.5). Global, read-only for the app role. Ticker is never a key.
// ---------------------------------------------------------------------------

export const instruments = pgTable(
  'instrument',
  {
    id: id(),
    assetClass: assetClass('asset_class').notNull(),
    symbol: text('symbol').notNull(),
    venue: text('venue').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    displayName: text('display_name').notNull(),
    tickSize: numeric('tick_size', { mode: 'string' }).notNull(),
    lotSize: numeric('lot_size', { mode: 'string' }).notNull().default('1'),
    multiplier: numeric('multiplier', { mode: 'string' }).notNull().default('1'),
    underlyingId: uuid('underlying_id'),
    expiry: date('expiry', { mode: 'string' }),
    strike: numeric('strike', { mode: 'string' }),
    optionRight: optionRight('option_right'),
    futureRoot: text('future_root'),
    contractMonth: char('contract_month', { length: 7 }),
    providerIds: jsonb('provider_ids').notNull().default({}),
    isDemo: boolean('is_demo').notNull().default(false),
    /** Indices are indicator-only: conditions read them, no leg or order trades them. */
    kind: instrumentKind('kind').notNull().default('tradable'),
    /** Whether the broker lends it for short selling, as last seen; null when unknown (v1.2 item 8). */
    shortable: boolean('shortable'),
    ...timestamps(),
  },
  (t) => [
    foreignKey({ columns: [t.underlyingId], foreignColumns: [t.id] }),
    check(
      'instrument_index_kind',
      sql`(${t.assetClass}::text = 'index') = (${t.kind} = 'indicator_only')`,
    ),
    unique('instrument_identity_uq')
      .on(t.assetClass, t.symbol, t.venue, t.expiry, t.strike, t.optionRight, t.contractMonth)
      .nullsNotDistinct(),
    check('instrument_tick_positive', sql`${t.tickSize} > 0`),
    check(
      'instrument_option_fields',
      sql`(${t.assetClass} = 'option') = (${t.expiry} IS NOT NULL AND ${t.strike} IS NOT NULL AND ${t.optionRight} IS NOT NULL AND ${t.underlyingId} IS NOT NULL)`,
    ),
    check(
      'instrument_future_fields',
      sql`${t.assetClass} <> 'future' OR (${t.futureRoot} IS NOT NULL AND ${t.contractMonth} IS NOT NULL AND ${t.expiry} IS NOT NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Integrations (§13.4). Phase 1 only provisions demo connections.
// Composite (id, user_id) keys let child rows reference only same-tenant parents.
// ---------------------------------------------------------------------------

/**
 * Provider credentials (§9.2–9.3, §16.1; ADR 0015). The secret is sealed before
 * it reaches the database: an AES-256-GCM data key per secret, wrapped with the
 * worker's RSA public key. The web role can write these columns but cannot read
 * the sealed ones; only the worker's login (tm_secrets) can, and only the worker
 * holds the private key. `hint` keeps the last characters of each field.
 */
export const instrumentLookupStatus = pgEnum('instrument_lookup_status', [
  'pending',
  'found',
  'not_found',
  'failed',
]);

/**
 * A person's request to find a real US stock or ETF by symbol (ADR 0017). The
 * worker answers it through the tenant's data feed, since only it can open
 * the provider key, and registers the instrument it finds.
 */
export const instrumentLookups = pgTable(
  'instrument_lookup',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The ticker to try first; null when what was typed cannot be one. */
    symbol: text('symbol'),
    /** What the person typed: a ticker or a company name (ADR 0029). */
    query: text('query'),
    status: instrumentLookupStatus('status').notNull().default('pending'),
    instrumentId: uuid('instrument_id').references(() => instruments.id),
    /** When nothing trades as the symbol: the closest listings by symbol or name, unregistered. */
    candidates: jsonb('candidates').notNull().default([]),
    /** Short and secret-free; shown to the person. */
    message: text('message'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index('instrument_lookup_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    check('instrument_lookup_symbol', sql`${t.symbol} ~ '^[A-Z][A-Z0-9.]{0,9}$'`),
    check('instrument_lookup_has_text', sql`${t.symbol} IS NOT NULL OR ${t.query} IS NOT NULL`),
    check('instrument_lookup_query', sql`length(${t.query}) BETWEEN 1 AND 60`),
    check(
      'instrument_lookup_found_has_instrument',
      sql`(${t.status} = 'found') = (${t.instrumentId} IS NOT NULL)`,
    ),
  ],
);

export const priceChartStatus = pgEnum('price_chart_status', ['pending', 'ready', 'failed']);

/**
 * A person's request for a price chart in Quantitative Research (ADR 0029).
 * Bars come through the tenant's bars route, which only the worker can open,
 * so the web app queues the request and the worker stores the bars on the row.
 * Rows are short-lived: the worker deletes those older than a day.
 */
export const priceCharts = pgTable(
  'price_chart',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    interval: text('interval').notNull(),
    range: text('range').notNull(),
    /** Inclusive New York dates the bars cover. */
    fromDate: date('from_date').notNull(),
    toDate: date('to_date').notNull(),
    status: priceChartStatus('status').notNull().default('pending'),
    /** `[startMs, open, high, low, close, volume][]`, oldest first. */
    bars: jsonb('bars'),
    warnings: jsonb('warnings').notNull().default([]),
    /** The data feed that answered, by its name in Settings › Data feeds. */
    source: text('source'),
    /** Short and secret-free; shown to the person. */
    message: text('message'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index('price_chart_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index('price_chart_reuse_idx').on(t.userId, t.instrumentId, t.interval, t.range, t.createdAt),
    check('price_chart_interval', sql`${t.interval} IN ('5m', '1h', '1d')`),
    check('price_chart_range', sql`${t.range} IN ('1d', '1w', '1m', '3m', '6m', '1y', '5y')`),
    check('price_chart_dates', sql`${t.fromDate} <= ${t.toDate}`),
    check('price_chart_ready_has_bars', sql`(${t.status} = 'ready') = (${t.bars} IS NOT NULL)`),
  ],
);

export const stockScreenStatus = pgEnum('stock_screen_status', ['pending', 'ready', 'failed']);

/**
 * Stock screens for Quantitative Research (ADR 0030): the web app asks, the
 * worker fills in one row of key values per US stock or ETF the tenant's data
 * feed covers. A cache of provider data, cleared after a day.
 */
export const stockScreens = pgTable(
  'stock_screen',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: stockScreenStatus('status').notNull().default('pending'),
    /** Which stocks: the S&P 500 members, or every listing the feed covers. */
    universe: text('universe').notNull().default('all'),
    /** New York date of the session the screen calls today. */
    sessionDate: date('session_date'),
    /** Row tuples in the order of `SCREEN_TEXT_COLUMNS`, `SCREEN_PRICE_COLUMNS`, lastAt, instrumentId, `SCREEN_FUNDAMENTAL_COLUMNS`. */
    rows: jsonb('rows'),
    rowCount: integer('row_count'),
    warnings: jsonb('warnings').notNull().default([]),
    /** The data feed that answered, by its name in Settings › Data feeds. */
    source: text('source'),
    /** Short and secret-free; shown to the person. */
    message: text('message'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index('stock_screen_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index('stock_screen_reuse_idx').on(t.userId, t.createdAt),
    check('stock_screen_universe', sql`${t.universe} IN ('sp500', 'all')`),
    check('stock_screen_ready_has_rows', sql`(${t.status} = 'ready') = (${t.rows} IS NOT NULL)`),
  ],
);

export const companyReportStatus = pgEnum('company_report_status', ['pending', 'ready', 'failed']);

/**
 * Company pages for Quantitative Research (ADR 0031): the web app asks for a
 * symbol, the worker fills in the profile, financials and filings from the
 * tenant's company data feed. A cache of provider data, cleared after a day.
 */
export const companyReports = pgTable(
  'company_report',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    status: companyReportStatus('status').notNull().default('pending'),
    /** A `CompanyReport` from `@tm/domain`, once ready. */
    report: jsonb('report'),
    /** The company data feed that answered, by its name in Settings › Data feeds. */
    source: text('source'),
    /** Short and secret-free; shown to the person. */
    message: text('message'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index('company_report_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index('company_report_reuse_idx').on(t.userId, t.symbol, t.createdAt),
    check('company_report_symbol', sql`${t.symbol} ~ '^[A-Z][A-Z0-9.]{0,9}$'`),
    check(
      'company_report_ready_has_report',
      sql`(${t.status} = 'ready') = (${t.report} IS NOT NULL)`,
    ),
  ],
);

export const credentials = pgTable(
  'credential',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    label: text('label').notNull(),
    environment: tradingMode('environment').notNull().default('paper'),
    /** Field name to its masked tail, e.g. { keyId: '••••7Q2A' }. Never the value. */
    hint: jsonb('hint').notNull(),
    keyId: text('key_id').notNull(),
    wrappedKey: bytea('wrapped_key').notNull(),
    iv: bytea('iv').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    authTag: bytea('auth_tag').notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    ...timestamps(),
    rowVersion: rowVersion(),
  },
  (t) => [
    unique('credential_id_user_uq').on(t.id, t.userId),
    check('credential_paper_only', sql`${t.environment} = 'paper'`),
  ],
);

export const dataFeedConnections = pgTable(
  'data_feed_connection',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    /** The credential this feed signs in with; never the secret itself (§9.2). */
    credentialRef: uuid('credential_ref'),
    assetClasses: assetClass('asset_classes').array().notNull(),
    isRealtime: boolean('is_realtime').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    health: connectionHealth('health').notNull().default('unknown'),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    /** Whether the account may receive this data (§9.2), from the last check. */
    entitlement: feedEntitlement('entitlement').notNull().default('unknown'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    /** A short, secret-free reason from the last failed check. */
    lastError: text('last_error'),
    /** Set by "Test"; the worker checks the feed soon after and clears it. */
    checkRequestedAt: timestamp('check_requested_at', { withTimezone: true }),
    checkLeaseExpiresAt: timestamp('check_lease_expires_at', { withTimezone: true }),
    /**
     * A custom REST feed's description (`CustomRestConfig`, ADR 0041): URLs,
     * sign-in method, JSON paths and limits. Never the key, which is sealed in
     * `credential`. Null for every other provider.
     */
    config: jsonb('config'),
    ...timestamps(),
    rowVersion: rowVersion(),
  },
  (t) => [
    unique('data_feed_connection_id_user_uq').on(t.id, t.userId),
    check(
      'data_feed_connection_custom_config',
      sql`(${t.provider} = 'custom_rest') = (${t.config} IS NOT NULL)`,
    ),
    foreignKey({
      name: 'data_feed_connection_credential_fk',
      columns: [t.credentialRef, t.userId],
      foreignColumns: [credentials.id, credentials.userId],
    }),
  ],
);

export const customFeedTestStatus = pgEnum('custom_feed_test_status', [
  'pending',
  'succeeded',
  'failed',
]);

/**
 * "Test" on a custom REST feed before it is saved (ADR 0041): the web app
 * stores the description and the symbol, the worker fetches and maps one
 * daily-bars and one quote answer and stores what it read or the exact
 * reason it failed. Saving needs a succeeded test of the same description
 * and key. Cleared after a day.
 */
export const customFeedTests = pgTable(
  'custom_feed_test',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The checked description, as it would be saved. */
    config: jsonb('config').notNull(),
    /** sha256 of the canonical description and the key's id, matched on save. */
    digest: text('digest').notNull(),
    credentialRef: uuid('credential_ref'),
    symbol: text('symbol').notNull(),
    status: customFeedTestStatus('status').notNull().default('pending'),
    /** What was read: a few bars, their count and the quote; secret-free. */
    result: jsonb('result'),
    /** The failure, exact and secret-free. */
    message: text('message'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'custom_feed_test_credential_fk',
      columns: [t.credentialRef, t.userId],
      foreignColumns: [credentials.id, credentials.userId],
    }).onDelete('cascade'),
    index('custom_feed_test_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    check('custom_feed_test_symbol', sql`${t.symbol} ~ '^[A-Z][A-Z0-9.-]{0,11}$'`),
  ],
);

/**
 * What custom REST feeds answered, kept in the database (ADR 0041) so a
 * back test, a chart and every worker reuse one fetch: daily bars per symbol
 * and date range, and the latest quote per symbol.
 */
export const customFeedCache = pgTable(
  'custom_feed_cache',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    feedId: uuid('feed_id').notNull(),
    kind: text('kind').notNull(),
    symbol: text('symbol').notNull(),
    /** New York dates for bars; empty for a quote. */
    rangeFrom: text('range_from').notNull().default(''),
    rangeTo: text('range_to').notNull().default(''),
    payload: jsonb('payload').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('custom_feed_cache_key').on(t.feedId, t.kind, t.symbol, t.rangeFrom, t.rangeTo),
    foreignKey({
      name: 'custom_feed_cache_feed_fk',
      columns: [t.feedId, t.userId],
      foreignColumns: [dataFeedConnections.id, dataFeedConnections.userId],
    }).onDelete('cascade'),
    check('custom_feed_cache_kind', sql`${t.kind} in ('bars', 'quote')`),
  ],
);

/**
 * Requests each custom REST feed has made, per minute and per day, counted in
 * the database so every worker keeps to the same limit (ADR 0041).
 */
export const customFeedUsage = pgTable(
  'custom_feed_usage',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    feedId: uuid('feed_id').notNull(),
    period: text('period').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('custom_feed_usage_key').on(t.feedId, t.period, t.windowStart),
    foreignKey({
      name: 'custom_feed_usage_feed_fk',
      columns: [t.feedId, t.userId],
      foreignColumns: [dataFeedConnections.id, dataFeedConnections.userId],
    }).onDelete('cascade'),
    check('custom_feed_usage_period', sql`${t.period} in ('minute', 'day')`),
  ],
);

export const dataRoutes = pgTable(
  'data_route',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assetClass: assetClass('asset_class').notNull(),
    venue: text('venue'),
    dataType: marketDataType('data_type').notNull(),
    primaryFeedId: uuid('primary_feed_id').notNull(),
    fallbackFeedId: uuid('fallback_feed_id'),
    /** Which feed prices come from now; the runtime fails over and back (ADR 0016). */
    activeSource: routeSource('active_source').notNull().default('primary'),
    switchedAt: timestamp('switched_at', { withTimezone: true }),
    /** While on the fallback: since when the primary has looked healthy again. */
    primaryOkSince: timestamp('primary_ok_since', { withTimezone: true }),
    ...timestamps(),
    rowVersion: rowVersion(),
  },
  (t) => [
    unique('data_route_id_user_uq').on(t.id, t.userId),
    foreignKey({
      columns: [t.primaryFeedId, t.userId],
      foreignColumns: [dataFeedConnections.id, dataFeedConnections.userId],
    }),
    foreignKey({
      columns: [t.fallbackFeedId, t.userId],
      foreignColumns: [dataFeedConnections.id, dataFeedConnections.userId],
    }),
    unique('data_route_target_uq')
      .on(t.userId, t.assetClass, t.venue, t.dataType)
      .nullsNotDistinct(),
    check(
      'data_route_fallback_present',
      sql`${t.activeSource} = 'primary' OR ${t.fallbackFeedId} IS NOT NULL`,
    ),
    check(
      'data_route_fallback_differs',
      sql`${t.fallbackFeedId} IS NULL OR ${t.fallbackFeedId} <> ${t.primaryFeedId}`,
    ),
  ],
);

export const brokerConnections = pgTable(
  'broker_connection',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    environment: tradingMode('environment').notNull().default('paper'),
    credentialRef: uuid('credential_ref'),
    isActive: boolean('is_active').notNull().default(true),
    health: connectionHealth('health').notNull().default('unknown'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    /** Short and secret-free; shown to the person. */
    lastError: text('last_error'),
    /** Set by Connect or Test; the worker checks the platform and discovers its accounts. */
    checkRequestedAt: timestamp('check_requested_at', { withTimezone: true }),
    checkLeaseExpiresAt: timestamp('check_lease_expires_at', { withTimezone: true }),
    ...timestamps(),
    rowVersion: rowVersion(),
  },
  (t) => [
    unique('broker_connection_id_user_uq').on(t.id, t.userId),
    foreignKey({
      name: 'broker_connection_credential_fk',
      columns: [t.credentialRef, t.userId],
      foreignColumns: [credentials.id, credentials.userId],
    }),
    check('broker_connection_paper_only', sql`${t.environment} = 'paper'`),
  ],
);

export const tradingAccounts = pgTable(
  'trading_account',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    brokerConnectionId: uuid('broker_connection_id').notNull(),
    nickname: text('nickname').notNull(),
    /** The broker's own account id, matched on rediscovery; shown only masked. */
    externalId: text('external_id'),
    maskedExternalId: text('masked_external_id').notNull(),
    mode: tradingMode('mode').notNull().default('paper'),
    currency: char('currency', { length: 3 }).notNull(),
    /** Supported asset classes, order types, time-in-force values, etc. */
    capabilities: jsonb('capabilities').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    /**
     * Equity before anything the app traded (ADR 0020): fixed for the demo
     * account, taken from the broker at the first valuation for others.
     */
    startingEquity: numeric('starting_equity'),
    valuedAt: timestamp('valued_at', { withTimezone: true }),
    valuationLeaseExpiresAt: timestamp('valuation_lease_expires_at', { withTimezone: true }),
    ...timestamps(),
    rowVersion: rowVersion(),
  },
  (t) => [
    foreignKey({
      columns: [t.brokerConnectionId, t.userId],
      foreignColumns: [brokerConnections.id, brokerConnections.userId],
    }).onDelete('cascade'),
    unique('trading_account_id_user_uq').on(t.id, t.userId),
    unique('trading_account_external_uq').on(t.brokerConnectionId, t.externalId),
    uniqueIndex('trading_account_one_default_idx')
      .on(t.userId)
      .where(sql`${t.isDefault}`),
    check('trading_account_paper_only', sql`${t.mode} = 'paper'`),
  ],
);

// ---------------------------------------------------------------------------
// Strategies (§6.1–6.3, §13.2; proposal §4.4). The definition is one validated
// JSON document (schema in @tm/domain). The draft is mutable; versions are
// immutable snapshots, protected by grants and a trigger.
// ---------------------------------------------------------------------------

export const strategyStatus = pgEnum('strategy_status', [
  'created',
  'under_testing',
  'actively_executing',
  'off',
]);
export const strategyPhase = pgEnum('strategy_phase', ['entry', 'exit']);
export const strategyInstrumentRole = pgEnum('strategy_instrument_role', ['condition', 'order']);

export const strategies = pgTable(
  'strategy',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: strategyStatus('status').notNull().default('created'),
    draftDefinition: jsonb('draft_definition').notNull(),
    draftSchemaVersion: integer('draft_schema_version').notNull(),
    /** sha256 of the canonical draft JSON; compared with versions and back tests. */
    draftHash: text('draft_hash').notNull(),
    /** Latest immutable version. FK added in 0005_strategy_security (circular). */
    currentVersionId: uuid('current_version_id'),
    hasBeenActive: boolean('has_been_active').notNull().default(false),
    baseCurrency: char('base_currency', { length: 3 }).notNull(),
    timezone: text('timezone').notNull(),
    dataRouteId: uuid('data_route_id'),
    defaultAccountId: uuid('default_account_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /** Soft delete: versions and history stay linked to orders (§6.2). */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps(),
    rowVersion: rowVersion(),
  },
  (t) => [
    unique('strategy_id_user_uq').on(t.id, t.userId),
    foreignKey({
      columns: [t.dataRouteId, t.userId],
      foreignColumns: [dataRoutes.id, dataRoutes.userId],
    }),
    foreignKey({
      columns: [t.defaultAccountId, t.userId],
      foreignColumns: [tradingAccounts.id, tradingAccounts.userId],
    }),
    index('strategy_user_updated_idx').on(t.userId, t.updatedAt),
    check('strategy_name_length', sql`char_length(${t.name}) between 1 and 120`),
    check('strategy_description_length', sql`char_length(${t.description}) <= 2000`),
    check('strategy_tags_count', sql`coalesce(array_length(${t.tags}, 1), 0) <= 20`),
  ],
);

export const strategyVersions = pgTable(
  'strategy_version',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    strategyId: uuid('strategy_id').notNull(),
    versionNo: integer('version_no').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    definition: jsonb('definition').notNull(),
    definitionHash: text('definition_hash').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.strategyId, t.userId],
      foreignColumns: [strategies.id, strategies.userId],
    }).onDelete('cascade'),
    unique('strategy_version_id_user_uq').on(t.id, t.userId),
    unique('strategy_version_no_uq').on(t.strategyId, t.versionNo),
    check('strategy_version_no_positive', sql`${t.versionNo} > 0`),
  ],
);

export const strategyInstruments = pgTable(
  'strategy_instrument',
  {
    userId: uuid('user_id').notNull(),
    strategyId: uuid('strategy_id').notNull(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    phase: strategyPhase('phase').notNull(),
    role: strategyInstrumentRole('role').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.strategyId, t.userId],
      foreignColumns: [strategies.id, strategies.userId],
    }).onDelete('cascade'),
    unique('strategy_instrument_uq').on(t.strategyId, t.instrumentId, t.phase, t.role),
    index('strategy_instrument_lookup_idx').on(t.userId, t.instrumentId),
  ],
);

export const strategyStatusChanges = pgTable(
  'strategy_status_change',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    strategyId: uuid('strategy_id').notNull(),
    fromStatus: strategyStatus('from_status').notNull(),
    toStatus: strategyStatus('to_status').notNull(),
    versionId: uuid('version_id'),
    reason: text('reason'),
    acknowledgedWarnings: text('acknowledged_warnings')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.strategyId, t.userId],
      foreignColumns: [strategies.id, strategies.userId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.versionId, t.userId],
      foreignColumns: [strategyVersions.id, strategyVersions.userId],
    }),
    index('strategy_status_change_strategy_idx').on(t.strategyId, t.changedAt),
  ],
);

// ---------------------------------------------------------------------------
// Back tests (§7, §13.3, §14.2; ADR 0009). A run pins an immutable strategy
// version; the worker claims queued runs through SECURITY DEFINER functions and
// then works inside the run's tenant like any other request.
// ---------------------------------------------------------------------------

export const backtestRunStatus = pgEnum('backtest_run_status', [
  'queued',
  'running',
  'completed',
  'failed',
  'canceled',
]);

export const backtestRuns = pgTable(
  'backtest_run',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    strategyId: uuid('strategy_id').notNull(),
    versionId: uuid('version_id').notNull(),
    definitionHash: text('definition_hash').notNull(),
    status: backtestRunStatus('status').notNull().default('queued'),
    /** Validated `BacktestInputs` from @tm/backtest. */
    inputs: jsonb('inputs').notNull(),
    dataSource: text('data_source').notNull(),
    engineVersion: text('engine_version'),
    dataVersions: text('data_versions')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** `BacktestMetrics`, for lists and the activation gate. */
    summary: jsonb('summary'),
    /** Equity, contributions, fills, warnings and assumptions (`BacktestResult` minus trades). */
    result: jsonb('result'),
    error: text('error'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('backtest_run_id_user_uq').on(t.id, t.userId),
    foreignKey({
      columns: [t.strategyId, t.userId],
      foreignColumns: [strategies.id, strategies.userId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.versionId, t.userId],
      foreignColumns: [strategyVersions.id, strategyVersions.userId],
    }),
    index('backtest_run_strategy_idx').on(t.strategyId, t.createdAt),
    index('backtest_run_queue_idx')
      .on(t.createdAt)
      .where(sql`${t.status} in ('queued', 'running')`),
    check(
      'backtest_run_finished',
      sql`(${t.status} in ('completed', 'failed', 'canceled')) = (${t.finishedAt} is not null)`,
    ),
    check('backtest_run_error_length', sql`char_length(${t.error}) <= 500`),
  ],
);

export const backtestTrades = pgTable(
  'backtest_trade',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    runId: uuid('run_id').notNull(),
    cycle: integer('cycle').notNull(),
    status: text('status').notNull(),
    entryTime: timestamp('entry_time', { withTimezone: true }),
    exitTime: timestamp('exit_time', { withTimezone: true }),
    grossPnl: numeric('gross_pnl').notNull(),
    costs: numeric('costs').notNull(),
    netPnl: numeric('net_pnl').notNull(),
    returnPct: numeric('return_pct'),
    /** `BacktestTradeLeg[]`: each leg's side, quantity and average price. */
    legs: jsonb('legs').notNull(),
    /** Why the cycle exited (v1.2): exit condition, time stop or rebalance. Null on older runs. */
    exitReason: text('exit_reason'),
    /** Two-sided strategies (v1.2 item 8): long or short, and the entry group's name. */
    direction: text('direction'),
    entryGroup: text('entry_group'),
  },
  (t) => [
    foreignKey({
      columns: [t.runId, t.userId],
      foreignColumns: [backtestRuns.id, backtestRuns.userId],
    }).onDelete('cascade'),
    unique('backtest_trade_cycle_uq').on(t.runId, t.cycle),
    check('backtest_trade_status', sql`${t.status} in ('closed', 'open', 'aborted')`),
    check(
      'backtest_trade_exit_reason',
      sql`${t.exitReason} is null or ${t.exitReason} in ('condition', 'time_stop', 'rebalance')`,
    ),
    check(
      'backtest_trade_direction',
      sql`${t.direction} is null or ${t.direction} in ('long', 'short')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Paper execution (§6.5–6.9, §8, §13.3–13.4; ADR 0010). A runtime runs one
// pinned strategy version; each Entry-to-Exit pass is a cycle. Order intents
// are immutable (§8.2); the broker's view of each order lives beside the
// intent in `broker_order`, and every change is appended to `order_event`.
// ---------------------------------------------------------------------------

export const runtimeStatus = pgEnum('runtime_status', ['running', 'paused', 'stopped']);
export const cycleStatus = pgEnum('cycle_status', [
  'entry_working',
  'open',
  'exit_working',
  'closed',
  'aborted',
]);
/** Canonical order states (§8.4), mirrored from `ORDER_STATES` in @tm/domain. */
export const orderState = pgEnum('order_state', [
  'planned',
  'scheduled',
  'pending_risk',
  'ready',
  'submitted',
  'acknowledged',
  'partially_filled',
  'filled',
  'canceled',
  'rejected',
  'expired',
  'failed',
]);
export const scheduledActionStatus = pgEnum('scheduled_action_status', [
  'pending',
  'done',
  'canceled',
]);

export const strategyRuntimes = pgTable(
  'strategy_runtime',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    strategyId: uuid('strategy_id').notNull(),
    versionId: uuid('version_id').notNull(),
    mode: tradingMode('mode').notNull().default('paper'),
    status: runtimeStatus('status').notNull().default('running'),
    pauseReason: text('pause_reason'),
    /** Trigger state and day-start equity carried between passes (`RuntimeState` in db/runtime.ts). */
    state: jsonb('state').notNull().default({}),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
    startedBy: uuid('started_by').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    stoppedBy: uuid('stopped_by'),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    /** Last resume; automatic pauses only count rejections after it. */
    resumedAt: timestamp('resumed_at', { withTimezone: true }),
    ...timestamps(),
    rowVersion: rowVersion(),
  },
  (t) => [
    unique('strategy_runtime_id_user_uq').on(t.id, t.userId),
    foreignKey({
      columns: [t.strategyId, t.userId],
      foreignColumns: [strategies.id, strategies.userId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.versionId, t.userId],
      foreignColumns: [strategyVersions.id, strategyVersions.userId],
    }),
    uniqueIndex('strategy_runtime_one_active_idx')
      .on(t.strategyId)
      .where(sql`${t.status} <> 'stopped'`),
    index('strategy_runtime_lease_idx')
      .on(t.leaseExpiresAt)
      .where(sql`${t.status} = 'running'`),
    check('strategy_runtime_paper_only', sql`${t.mode} = 'paper'`),
    check(
      'strategy_runtime_stopped',
      sql`(${t.status} = 'stopped') = (${t.stoppedAt} is not null)`,
    ),
    check('strategy_runtime_pause_reason_length', sql`char_length(${t.pauseReason}) <= 500`),
  ],
);

export const strategyCycles = pgTable(
  'strategy_cycle',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    runtimeId: uuid('runtime_id').notNull(),
    seq: integer('seq').notNull(),
    status: cycleStatus('status').notNull().default('entry_working'),
    entryTriggerEventId: uuid('entry_trigger_event_id'),
    exitTriggerEventId: uuid('exit_trigger_event_id'),
    entryTriggeredAt: timestamp('entry_triggered_at', { withTimezone: true }).notNull(),
    positionOpenedAt: timestamp('position_opened_at', { withTimezone: true }),
    exitTriggeredAt: timestamp('exit_triggered_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    realizedPnl: numeric('realized_pnl'),
    /** `CycleState` from @tm/domain, apart from `status`, which has its own column. */
    state: jsonb('state').notNull(),
    note: text('note'),
    ...timestamps(),
    rowVersion: rowVersion(),
  },
  (t) => [
    unique('strategy_cycle_id_user_uq').on(t.id, t.userId),
    unique('strategy_cycle_seq_uq').on(t.runtimeId, t.seq),
    foreignKey({
      columns: [t.runtimeId, t.userId],
      foreignColumns: [strategyRuntimes.id, strategyRuntimes.userId],
    }).onDelete('cascade'),
    check('strategy_cycle_seq_positive', sql`${t.seq} > 0`),
    check(
      'strategy_cycle_closed',
      sql`(${t.status} in ('closed', 'aborted')) = (${t.closedAt} is not null)`,
    ),
  ],
);

export const triggerEvents = pgTable(
  'trigger_event',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    runtimeId: uuid('runtime_id').notNull(),
    cycleId: uuid('cycle_id'),
    phase: strategyPhase('phase').notNull(),
    /** Time of the newest market data the evaluation used. */
    dataTime: timestamp('data_time', { withTimezone: true }).notNull(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Truth of the condition tree: true, false or unknown (missing or stale data). */
    result: text('result').notNull(),
    /** Whether the trigger mode and debounce rules let it fire (§6.5 step 6). */
    qualified: boolean('qualified').notNull(),
    /** Evaluated leaf values by node id. */
    values: jsonb('values').notNull(),
  },
  (t) => [
    unique('trigger_event_id_user_uq').on(t.id, t.userId),
    foreignKey({
      columns: [t.runtimeId, t.userId],
      foreignColumns: [strategyRuntimes.id, strategyRuntimes.userId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.cycleId, t.userId],
      foreignColumns: [strategyCycles.id, strategyCycles.userId],
    }).onDelete('cascade'),
    index('trigger_event_runtime_idx').on(t.runtimeId, t.evaluatedAt),
    check('trigger_event_result', sql`${t.result} in ('true', 'false', 'unknown')`),
  ],
);

export const scheduledActions = pgTable(
  'scheduled_action',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    runtimeId: uuid('runtime_id').notNull(),
    cycleId: uuid('cycle_id').notNull(),
    kind: text('kind').notNull(),
    phase: text('phase').notNull(),
    legId: text('leg_id'),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    /** The durable event the timing is relative to (§6.8), e.g. `order_event`. */
    referenceKind: text('reference_kind'),
    referenceId: uuid('reference_id'),
    /** One action per purpose, so a restarted worker cannot schedule it twice. */
    dedupeKey: text('dedupe_key').notNull(),
    status: scheduledActionStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    doneAt: timestamp('done_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('scheduled_action_id_user_uq').on(t.id, t.userId),
    unique('scheduled_action_dedupe_uq').on(t.userId, t.dedupeKey),
    foreignKey({
      columns: [t.cycleId, t.userId],
      foreignColumns: [strategyCycles.id, strategyCycles.userId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.runtimeId, t.userId],
      foreignColumns: [strategyRuntimes.id, strategyRuntimes.userId],
    }).onDelete('cascade'),
    index('scheduled_action_due_idx')
      .on(t.dueAt)
      .where(sql`${t.status} = 'pending'`),
    check('scheduled_action_kind', sql`${t.kind} in ('submit_leg', 'leg_timeout', 'expire_order')`),
    check('scheduled_action_phase', sql`${t.phase} in ('entry', 'exit', 'flatten')`),
    check('scheduled_action_done', sql`(${t.status} = 'pending') = (${t.doneAt} is null)`),
  ],
);

export const orderIntents = pgTable(
  'order_intent',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    runtimeId: uuid('runtime_id').notNull(),
    strategyId: uuid('strategy_id').notNull(),
    versionId: uuid('version_id').notNull(),
    cycleId: uuid('cycle_id').notNull(),
    phase: text('phase').notNull(),
    plannedOrderId: text('planned_order_id'),
    /** Entry batch or Exit round the leg belongs to; part of the idempotency key. */
    attempt: integer('attempt').notNull().default(1),
    legLabel: text('leg_label').notNull(),
    triggerEventId: uuid('trigger_event_id'),
    scheduledActionId: uuid('scheduled_action_id'),
    eligibleAt: timestamp('eligible_at', { withTimezone: true }).notNull(),
    accountId: uuid('account_id').notNull(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    side: text('side').notNull(),
    direction: text('direction').notNull(),
    quantity: numeric('quantity').notNull(),
    orderType: text('order_type').notNull(),
    limitPrice: numeric('limit_price'),
    stopPrice: numeric('stop_price'),
    timeInForce: text('time_in_force').notNull(),
    extendedHours: boolean('extended_hours').notNull().default(false),
    referencePrice: numeric('reference_price').notNull(),
    /** `RiskCheckResult` from @tm/domain: every check that ran, with limits and values. */
    risk: jsonb('risk').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    source: text('source').notNull().default('strategy'),
    mode: tradingMode('mode').notNull().default('paper'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('order_intent_id_user_uq').on(t.id, t.userId),
    unique('order_intent_idempotency_uq').on(t.userId, t.idempotencyKey),
    foreignKey({
      columns: [t.runtimeId, t.userId],
      foreignColumns: [strategyRuntimes.id, strategyRuntimes.userId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.cycleId, t.userId],
      foreignColumns: [strategyCycles.id, strategyCycles.userId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.versionId, t.userId],
      foreignColumns: [strategyVersions.id, strategyVersions.userId],
    }),
    foreignKey({
      columns: [t.accountId, t.userId],
      foreignColumns: [tradingAccounts.id, tradingAccounts.userId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.triggerEventId, t.userId],
      foreignColumns: [triggerEvents.id, triggerEvents.userId],
    }),
    index('order_intent_cycle_idx').on(t.cycleId, t.createdAt),
    index('order_intent_user_created_idx').on(t.userId, t.createdAt),
    check('order_intent_paper_only', sql`${t.mode} = 'paper'`),
    check('order_intent_quantity_positive', sql`${t.quantity} > 0`),
    check('order_intent_phase', sql`${t.phase} in ('entry', 'exit', 'flatten')`),
    check('order_intent_direction', sql`${t.direction} in ('buy', 'sell')`),
    check(
      'order_intent_side',
      sql`${t.side} in ('buy', 'sell', 'sell_short', 'buy_to_cover', 'close', 'reduce')`,
    ),
    check(
      'order_intent_order_type',
      sql`${t.orderType} in ('market', 'limit', 'stop', 'stop_limit')`,
    ),
    check('order_intent_tif', sql`${t.timeInForce} in ('day', 'gtc', 'ioc', 'fok')`),
    check('order_intent_source', sql`${t.source} in ('strategy', 'user', 'system')`),
  ],
);

export const brokerOrders = pgTable(
  'broker_order',
  {
    intentId: uuid('intent_id').primaryKey(),
    userId: uuid('user_id').notNull(),
    state: orderState('state').notNull(),
    brokerOrderId: text('broker_order_id'),
    rawStatus: text('raw_status'),
    filledQuantity: numeric('filled_quantity').notNull().default('0'),
    averagePrice: numeric('average_price'),
    fees: numeric('fees').notNull().default('0'),
    overfilled: boolean('overfilled').notNull().default(false),
    reason: text('reason'),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    filledAt: timestamp('filled_at', { withTimezone: true }),
    terminalAt: timestamp('terminal_at', { withTimezone: true }),
    ...timestamps(),
    rowVersion: rowVersion(),
  },
  (t) => [
    foreignKey({
      columns: [t.intentId, t.userId],
      foreignColumns: [orderIntents.id, orderIntents.userId],
    }).onDelete('cascade'),
    index('broker_order_state_idx').on(t.userId, t.state),
    check('broker_order_filled_nonnegative', sql`${t.filledQuantity} >= 0`),
    check('broker_order_reason_length', sql`char_length(${t.reason}) <= 500`),
  ],
);

export const orderEvents = pgTable(
  'order_event',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    intentId: uuid('intent_id').notNull(),
    /** Insertion order; several events can share one transaction's timestamp. */
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    /** Who caused it: the app, the broker, a person, or reconciliation (§16.2). */
    source: text('source').notNull(),
    fromState: orderState('from_state'),
    toState: orderState('to_state'),
    /** The broker's update id; a repeat of the same id is ignored (§8.5). */
    brokerEventId: text('broker_event_id'),
    /** Normalized update, including the raw broker status. Never holds secrets. */
    payload: jsonb('payload').notNull(),
    providerAt: timestamp('provider_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.intentId, t.userId],
      foreignColumns: [orderIntents.id, orderIntents.userId],
    }).onDelete('cascade'),
    unique('order_event_broker_uq').on(t.intentId, t.brokerEventId),
    index('order_event_intent_idx').on(t.intentId, t.seq),
    check('order_event_source', sql`${t.source} in ('app', 'broker', 'user', 'reconciliation')`),
  ],
);

export const fills = pgTable(
  'fill',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    intentId: uuid('intent_id').notNull(),
    brokerFillId: text('broker_fill_id').notNull(),
    quantity: numeric('quantity').notNull(),
    price: numeric('price').notNull(),
    fee: numeric('fee').notNull().default('0'),
    filledAt: timestamp('filled_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.intentId, t.userId],
      foreignColumns: [orderIntents.id, orderIntents.userId],
    }).onDelete('cascade'),
    unique('fill_broker_uq').on(t.intentId, t.brokerFillId),
    index('fill_user_time_idx').on(t.userId, t.filledAt),
    check('fill_quantity_positive', sql`${t.quantity} > 0`),
    check('fill_price_positive', sql`${t.price} > 0`),
  ],
);

export const positionSnapshots = pgTable(
  'position_snapshot',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    accountId: uuid('account_id').notNull(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    quantity: numeric('quantity').notNull(),
    averageCost: numeric('average_cost'),
    /** `app` is derived from fills; `broker` is what the broker reported. */
    source: text('source').notNull(),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.userId],
      foreignColumns: [tradingAccounts.id, tradingAccounts.userId],
    }).onDelete('cascade'),
    index('position_snapshot_lookup_idx').on(t.accountId, t.instrumentId, t.asOf),
    check('position_snapshot_source', sql`${t.source} in ('app', 'broker')`),
  ],
);

/** Where the runtime has read each account's broker updates up to (§8.5). */
export const brokerSyncs = pgTable(
  'broker_sync',
  {
    accountId: uuid('account_id').primaryKey(),
    userId: uuid('user_id').notNull(),
    cursor: text('cursor'),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    /** Last periodic reconciliation of this account (§8.5), on the runtime's clock. */
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.userId],
      foreignColumns: [tradingAccounts.id, tradingAccounts.userId],
    }).onDelete('cascade'),
  ],
);

/**
 * Daily equity per account (Design v1.0 §10.2; ADR 0020): one row per NYSE
 * session, rewritten during it and final from its 4:00 pm close.
 */
export const accountValuations = pgTable(
  'account_valuation',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    accountId: uuid('account_id').notNull(),
    sessionDate: date('session_date').notNull(),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    final: boolean('final').notNull().default(false),
    startingEquity: numeric('starting_equity'),
    appEquity: numeric('app_equity'),
    brokerEquity: numeric('broker_equity'),
    brokerCash: numeric('broker_cash'),
    realized: numeric('realized').notNull(),
    unrealized: numeric('unrealized').notNull(),
    fees: numeric('fees').notNull(),
    marketValue: numeric('market_value').notNull(),
    /** Open books valued at a stale or missing price. */
    staleMarks: integer('stale_marks').notNull().default(0),
    /** Broker equity less app equity; null when the broker reports none. */
    difference: numeric('difference'),
    positionDifferences: jsonb('position_differences').notNull().default([]),
    flagged: boolean('flagged').notNull().default(false),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.userId],
      foreignColumns: [tradingAccounts.id, tradingAccounts.userId],
    }).onDelete('cascade'),
    unique('account_valuation_session_uq').on(t.accountId, t.sessionDate),
    index('account_valuation_user_idx').on(t.userId, t.sessionDate),
  ],
);

/** Daily value per book: strategy runtime, account and instrument (ADR 0020). */
export const bookValuations = pgTable(
  'book_valuation',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    runtimeId: uuid('runtime_id').notNull(),
    accountId: uuid('account_id').notNull(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    sessionDate: date('session_date').notNull(),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    quantity: numeric('quantity').notNull(),
    costBasis: numeric('cost_basis').notNull(),
    mark: numeric('mark'),
    markAt: timestamp('mark_at', { withTimezone: true }),
    markStale: boolean('mark_stale').notNull().default(false),
    marketValue: numeric('market_value').notNull(),
    unrealized: numeric('unrealized').notNull(),
    realized: numeric('realized').notNull(),
    realizedGross: numeric('realized_gross').notNull(),
    fees: numeric('fees').notNull(),
    openFees: numeric('open_fees').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.userId],
      foreignColumns: [tradingAccounts.id, tradingAccounts.userId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.runtimeId, t.userId],
      foreignColumns: [strategyRuntimes.id, strategyRuntimes.userId],
    }).onDelete('cascade'),
    unique('book_valuation_session_uq').on(t.runtimeId, t.accountId, t.instrumentId, t.sessionDate),
    index('book_valuation_user_idx').on(t.userId, t.sessionDate),
  ],
);

/** The per-user kill switch (§8.1): while set, no new orders are submitted. */
export const executionControls = pgTable('execution_control', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  haltedAt: timestamp('halted_at', { withTimezone: true }),
  haltedBy: uuid('halted_by'),
  reason: text('reason'),
  ...timestamps(),
});

// ---------------------------------------------------------------------------
// The simulated paper broker's own books (ADR 0011). Kept apart from the app's
// orders, as a real broker's would be, so reconciliation has two sides.
// ---------------------------------------------------------------------------

export const paperOrders = pgTable(
  'paper_order',
  {
    brokerOrderId: text('broker_order_id').primaryKey(),
    userId: uuid('user_id').notNull(),
    accountId: uuid('account_id').notNull(),
    clientOrderId: text('client_order_id').notNull(),
    /** The `BrokerOrderRequest` as received. */
    request: jsonb('request').notNull(),
    status: text('status').notNull(),
    filled: numeric('filled').notNull().default('0'),
    triggered: boolean('triggered').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    updateCount: integer('update_count').notNull().default(0),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.userId],
      foreignColumns: [tradingAccounts.id, tradingAccounts.userId],
    }).onDelete('cascade'),
    unique('paper_order_client_uq').on(t.accountId, t.clientOrderId),
    index('paper_order_working_idx')
      .on(t.userId)
      .where(sql`${t.status} = 'working'`),
    check(
      'paper_order_status',
      sql`${t.status} in ('working', 'filled', 'canceled', 'expired', 'rejected')`,
    ),
  ],
);

export const paperUpdates = pgTable(
  'paper_update',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id').notNull(),
    accountId: uuid('account_id').notNull(),
    brokerOrderId: text('broker_order_id').notNull(),
    /** The `BrokerOrderUpdate` as published. */
    update: jsonb('update').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.userId],
      foreignColumns: [tradingAccounts.id, tradingAccounts.userId],
    }).onDelete('cascade'),
    index('paper_update_account_idx').on(t.accountId, t.seq),
    index('paper_update_order_idx').on(t.brokerOrderId, t.seq),
  ],
);

export const paperPositions = pgTable(
  'paper_position',
  {
    userId: uuid('user_id').notNull(),
    accountId: uuid('account_id').notNull(),
    instrumentId: uuid('instrument_id').notNull(),
    quantity: numeric('quantity').notNull(),
    averageCost: numeric('average_cost'),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.userId],
      foreignColumns: [tradingAccounts.id, tradingAccounts.userId],
    }).onDelete('cascade'),
    unique('paper_position_uq').on(t.accountId, t.instrumentId),
  ],
);

// ---------------------------------------------------------------------------
// Incidents and notifications (Design v1.0 §8.5, §8.6, §16.3; ADR 0014)
// ---------------------------------------------------------------------------

export const INCIDENT_KINDS = [
  'reconciliation_mismatch',
  'repeated_rejects',
  'stale_data',
  'feed_loss',
  'broker_disconnected',
] as const;

/** Something that made execution unsafe or uncertain; open until resolved. */
export const executionIncidents = pgTable(
  'execution_incident',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** The runtime it concerns, if one; account-wide incidents have none. */
    runtimeId: uuid('runtime_id'),
    accountId: uuid('account_id'),
    summary: text('summary').notNull(),
    details: jsonb('details').notNull().default({}),
    /** Runtimes it paused, so the banner can say what stopped. */
    pausedRuntimes: integer('paused_runtimes').notNull().default(0),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    resolution: text('resolution'),
    ...timestamps(),
  },
  (t) => [
    unique('execution_incident_id_user_uq').on(t.id, t.userId),
    // One open incident per kind and subject, so a recurring problem is not repeated.
    uniqueIndex('execution_incident_open_uq')
      .on(
        t.userId,
        t.kind,
        sql`coalesce(${t.runtimeId}::text, '')`,
        sql`coalesce(${t.accountId}::text, '')`,
      )
      .where(sql`${t.resolvedAt} is null`),
    index('execution_incident_user_idx').on(t.userId, t.openedAt),
    check(
      'execution_incident_kind',
      sql`${t.kind} in ('reconciliation_mismatch', 'repeated_rejects', 'stale_data', 'feed_loss', 'broker_disconnected')`,
    ),
    check('execution_incident_summary_length', sql`char_length(${t.summary}) <= 500`),
    check('execution_incident_resolution_length', sql`char_length(${t.resolution}) <= 500`),
    check(
      'execution_incident_resolved',
      sql`(${t.resolvedAt} is null) = (${t.resolvedBy} is null)`,
    ),
  ],
);

export const NOTIFICATION_KINDS = [
  'strategy_started',
  'strategy_stopped',
  'triggered',
  'order_rejected',
  'partial_fill',
  'filled',
  'disconnect',
  'stale_data',
  'risk_pause',
  'reconciliation_mismatch',
  'billing',
] as const;

/** In-app notifications (§16.3). Email and push come with Phase 4 preferences. */
export const notifications = pgTable(
  'notification',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** An in-app path to what it is about, e.g. /orders?strategy=… */
    link: text('link'),
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),
    /** Repeats of the same event are stored once. */
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    unique('notification_dedupe_uq').on(t.userId, t.dedupeKey),
    index('notification_user_idx').on(t.userId, t.createdAt),
    index('notification_unread_idx')
      .on(t.userId)
      .where(sql`${t.readAt} is null`),
    check(
      'notification_kind',
      sql`${t.kind} in ('strategy_started', 'strategy_stopped', 'triggered', 'order_rejected', 'partial_fill', 'filled', 'disconnect', 'stale_data', 'risk_pause', 'reconciliation_mismatch', 'billing')`,
    ),
    check('notification_title_length', sql`char_length(${t.title}) <= 200`),
    check('notification_body_length', sql`char_length(${t.body}) <= 1000`),
    check('notification_link_relative', sql`${t.link} like '/%' and ${t.link} not like '//%'`),
  ],
);

/**
 * Point-in-time fundamentals (Design v1.2 item 6, ADR 0043): one row per
 * value a company's filings made known, from the filing's acceptance time.
 * Filings are public, so the rows are kept once for every tenant; only the
 * worker (tm_secrets) reads and writes them. A restatement is a new row.
 */
export const fundamentalCompanies = pgTable(
  'fundamental_company',
  {
    cik: integer('cik').primaryKey(),
    symbol: text('symbol').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull(),
    /** 'ok', or 'missing' when EDGAR has no company facts for it. */
    status: text('status').notNull(),
  },
  (t) => [
    index('fundamental_company_symbol_idx').on(t.symbol),
    check('fundamental_company_status', sql`${t.status} in ('ok', 'missing')`),
  ],
);

export const fundamentalObservations = pgTable(
  'fundamental_observation',
  {
    cik: integer('cik')
      .notNull()
      .references(() => fundamentalCompanies.cik, { onDelete: 'cascade' }),
    field: text('field').notNull(),
    value: numeric('value').notNull(),
    periodEnd: date('period_end').notNull(),
    availableFrom: timestamp('available_from', { withTimezone: true }).notNull(),
    accession: text('accession').notNull(),
    form: text('form').notNull(),
  },
  (t) => [
    primaryKey({ name: 'fundamental_observation_pk', columns: [t.cik, t.field, t.accession] }),
    index('fundamental_observation_lookup_idx').on(t.cik, t.availableFrom),
  ],
);
