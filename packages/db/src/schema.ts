import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
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
]);
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
  ...timestamps(),
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

export const entitlements = pgTable('entitlement', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  planCode: text('plan_code').notNull(),
  /** Resolved feature and limit values; plans are configuration, not code (§4.3). */
  limits: jsonb('limits').notNull(),
  ...timestamps(),
  rowVersion: rowVersion(),
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
    userId: uuid('user_id').notNull(),
    actorType: auditActorType('actor_type').notNull(),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id'),
    beforeRef: text('before_ref'),
    afterRef: text('after_ref'),
    context: jsonb('context').notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_event_user_time_idx').on(t.userId, t.occurredAt)],
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
    ...timestamps(),
  },
  (t) => [
    foreignKey({ columns: [t.underlyingId], foreignColumns: [t.id] }),
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

export const dataFeedConnections = pgTable(
  'data_feed_connection',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    /** Reference into the secret vault; never the secret itself (§9.2). */
    credentialRef: text('credential_ref'),
    assetClasses: assetClass('asset_classes').array().notNull(),
    isRealtime: boolean('is_realtime').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    health: connectionHealth('health').notNull().default('unknown'),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    ...timestamps(),
    rowVersion: rowVersion(),
  },
  (t) => [unique('data_feed_connection_id_user_uq').on(t.id, t.userId)],
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
    ...timestamps(),
    rowVersion: rowVersion(),
  },
  (t) => [
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
    credentialRef: text('credential_ref'),
    isActive: boolean('is_active').notNull().default(true),
    health: connectionHealth('health').notNull().default('unknown'),
    ...timestamps(),
    rowVersion: rowVersion(),
  },
  (t) => [
    unique('broker_connection_id_user_uq').on(t.id, t.userId),
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
    maskedExternalId: text('masked_external_id').notNull(),
    mode: tradingMode('mode').notNull().default('paper'),
    currency: char('currency', { length: 3 }).notNull(),
    /** Supported asset classes, order types, time-in-force values, etc. */
    capabilities: jsonb('capabilities').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    ...timestamps(),
    rowVersion: rowVersion(),
  },
  (t) => [
    foreignKey({
      columns: [t.brokerConnectionId, t.userId],
      foreignColumns: [brokerConnections.id, brokerConnections.userId],
    }).onDelete('cascade'),
    unique('trading_account_id_user_uq').on(t.id, t.userId),
    uniqueIndex('trading_account_one_default_idx')
      .on(t.userId)
      .where(sql`${t.isDefault}`),
    check('trading_account_paper_only', sql`${t.mode} = 'paper'`),
  ],
);
