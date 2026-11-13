import {
  BACKTEST_LOOKBACKS,
  DEFAULT_BACKTEST_INPUTS,
  lookbackFits,
  lookbackStart,
  matchingBacktestInterval,
  type BacktestInterval,
  type BacktestLookback,
} from '@tm/backtest';
import {
  createStrategyRequest,
  startBacktestRequest,
  updateStrategyRequest,
  type BacktestRunDto,
  type BacktestTradeDto,
} from '@tm/contracts';
import {
  createStrategy,
  getBacktest,
  getLibraryEntry,
  getStockScreen,
  getStockScreenData,
  getStrategy,
  listAccountValuations,
  listBacktests,
  listBacktestTrades,
  listLibraryEntries,
  listPlatforms,
  listStrategies,
  loadStrategyRow,
  loadValidationContext,
  registerLibraryEntry,
  requestStockScreen,
  schema,
  sql,
  updateStrategy,
  validateStoredStrategy,
  type AgentScope,
  type Transaction,
} from '@tm/db';
import {
  BUILT_STATUSES,
  DATA_NEEDS,
  fromScreenTuple,
  LIBRARY_CATEGORIES,
  LIBRARY_STATUSES,
  nyDate,
  registerLibraryEntrySchema,
  STOCK_GROUP_IDS,
  STRATEGY_STATUSES,
  type ConditionNode,
  type StrategyDefinition,
  type ValidationResult,
} from '@tm/domain';
import {
  describeCondition,
  describeIssueLocation,
  type SymbolLookup,
} from '@tm/domain/strategy-text';
import { z } from 'zod';
import { buildCycles, type CycleView } from '@/lib/backtest-cycles';
import { comparisonEvidence, comparisonsOf } from '@/lib/backtest-explain';
import {
  COLUMN_BY_KEY,
  filterRows,
  sortRows,
  type ScreenFilters,
  type SortKey,
} from '@/lib/screener';
import { HttpError } from '../api-errors';
import { queueBacktest } from '../backtest-start';
import { strategySummary } from './strategy-summary';

/**
 * The agent tool catalogue (Bring your own AI agent brief §4, ADR 0092).
 *
 * Every tool calls the same service functions the screens' routes call,
 * inside the person's tenant transaction, so validation, plan limits,
 * row-level security and the paper-only rules apply to agents exactly as to
 * clicks. No tool talks to the broker.
 *
 * THIS LIST IS THE SECURITY BOUNDARY. There are no tools, at any scope, to
 * start or stop execution, place, change or cancel orders, send or accept
 * shares, change billing or plans, change credentials or data feeds, manage
 * invites or users, or delete anything. Adding a tool fails the tool-list
 * snapshot test until the design doc says so.
 */

export interface ToolContext {
  userId: string;
  /** Runs `fn` in a transaction scoped to the connection's person. */
  tx: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
  /** The app's own origin, for links back into the app. */
  appUrl: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Counts one hit for `key`; seconds to wait when over `perMinute`, else 0. */
  rateLimit: (key: string, perMinute: number) => Promise<number>;
}

export interface AgentTool {
  name: string;
  title: string;
  description: string;
  scope: AgentScope;
  input: z.ZodType;
  run: (ctx: ToolContext, args: never) => Promise<unknown>;
}

function tool<S extends z.ZodType>(t: {
  name: string;
  title: string;
  description: string;
  scope: AgentScope;
  input: S;
  run: (ctx: ToolContext, args: z.output<S>) => Promise<unknown>;
}): AgentTool {
  return t as unknown as AgentTool;
}

// ---------------------------------------------------------------------------
// Shared helpers

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const strategyRef = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe('The strategy: its number, such as S00012 or S00012-SD, or its id');

/** A strategy by id, or by its Lab number with or without the suffix (ADR 0065). */
async function resolveStrategy(t: Transaction, ref: string): Promise<string> {
  if (UUID.test(ref)) {
    await loadStrategyRow(t, ref);
    return ref;
  }
  const number = ref.trim().toUpperCase();
  const rows = await t
    .select({ id: schema.strategies.id })
    .from(schema.strategies)
    .where(
      sql`${schema.strategies.deletedAt} is null and (${schema.strategies.labNumber} = ${number} or split_part(${schema.strategies.labNumber}, '-', 1) = ${number})`,
    )
    .limit(2);
  if (rows.length !== 1 || !rows[0]) {
    throw new HttpError(
      'not_found',
      rows.length > 1
        ? `More than one strategy matches ${ref}; use the full number or the id`
        : `No strategy has the number ${ref}`,
    );
  }
  return rows[0].id;
}

async function symbolLookup(t: Transaction): Promise<SymbolLookup> {
  const ctx = await loadValidationContext(t);
  return (id) => ctx.instruments.get(id)?.symbol;
}

function readableValidation(v: ValidationResult, def: StrategyDefinition) {
  const issue = (i: ValidationResult['errors'][number]) => ({
    where: describeIssueLocation(i.path, def),
    message: i.message,
    code: i.code,
    path: i.path,
  });
  return {
    canRun: v.errors.length === 0,
    errors: v.errors.map(issue),
    warnings: v.warnings.map(issue),
  };
}

const strategyUrl = (ctx: ToolContext, id: string) => `${ctx.appUrl}/strategy-lab/${id}`;

/** JSON as the screens receive it: dates as ISO strings. */
const asJson = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;

// ---------------------------------------------------------------------------
// Read tools

const searchTheories = tool({
  name: 'search_theories',
  title: 'Search theories',
  description:
    'Search the Theory Library (published trading strategy ideas, numbered like T00012-SD) by text and filters. Returns numbers, names and short descriptions; use get_theory for one in full.',
  scope: 'read',
  input: z.object({
    query: z
      .string()
      .trim()
      .max(100)
      .optional()
      .describe('Words in the name, description or number'),
    category: z.enum(LIBRARY_CATEGORIES).optional(),
    built: z.enum(BUILT_STATUSES).optional().describe('Whether a strategy is built from it'),
    dataNeed: z.enum(DATA_NEEDS).optional().describe('Only theories that need this data'),
    status: z.enum([...LIBRARY_STATUSES, 'all']).default('registered'),
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
  }),
  run: async (ctx, a) => {
    const { items, total } = await ctx.tx((t) =>
      listLibraryEntries(t, {
        search: a.query,
        category: a.category,
        built: a.built,
        dataNeed: a.dataNeed,
        status: a.status,
        viewerId: ctx.userId,
        sort: 'number',
        direction: 'asc',
      }),
    );
    return {
      total,
      offset: a.offset,
      items: items.slice(a.offset, a.offset + a.limit).map((e) => ({
        number: e.registrationNumber,
        name: e.name,
        category: e.category,
        status: e.status,
        built: e.builtStatus,
        direction: e.direction,
        maturity: e.maturity,
        dataNeeds: e.dataNeeds,
        assets: e.assets,
        shortDescription: e.shortDescription,
        tags: e.tags,
      })),
    };
  },
});

const getTheory = tool({
  name: 'get_theory',
  title: 'Get a theory',
  description:
    'One Theory Library entry in full by its number (T00012-SD; former numbers still work): description, entry and exit rules, data it needs, its revisions.',
  scope: 'read',
  input: z.object({ number: z.string().trim().min(5).max(16) }),
  run: async (ctx, a) => {
    const entry = await ctx.tx((t) => getLibraryEntry(t, ctx.userId, a.number.toUpperCase()));
    if (!entry) throw new HttpError('not_found', 'No theory has that number');
    return {
      ...asJson<Record<string, unknown>>(entry),
      url: `${ctx.appUrl}/library/${entry.registrationNumber}`,
    };
  },
});

const listStrategiesTool = tool({
  name: 'list_strategies',
  title: 'List strategies',
  description:
    "The person's Strategy Lab strategies, by number. `total` counts every match; page with limit and offset.",
  scope: 'read',
  input: z.object({
    query: z
      .string()
      .trim()
      .max(100)
      .optional()
      .describe('Words in the name, description, tags or number'),
    status: z.array(z.enum(STRATEGY_STATUSES)).max(10).optional(),
    archived: z.enum(['exclude', 'include', 'only']).default('exclude'),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  }),
  run: async (ctx, a) => {
    const { items, total } = await ctx.tx((t) =>
      listStrategies(t, {
        search: a.query,
        statuses: a.status,
        archived: a.archived,
        sort: 'number',
        direction: 'asc',
        limit: a.limit,
        offset: a.offset,
      }),
    );
    return {
      total,
      offset: a.offset,
      items: items.map((s) => ({
        id: s.id,
        number: s.labNumber,
        name: s.name,
        theory: s.theoryNumber,
        status: s.status,
        instruments: s.instruments.map((i) => i.symbol),
        versionNo: s.currentVersionNo,
        latestBacktest: s.latestBacktest,
        archived: s.archivedAt !== null,
        updatedAt: s.updatedAt.toISOString(),
      })),
    };
  },
});

const getStrategyTool = tool({
  name: 'get_strategy',
  title: 'Get a strategy',
  description:
    "One strategy in full: its definition JSON (the format create_strategy and update_strategy take), the app's plain-words summary of its rules, whether it can run and why not, and its versions. Use rowVersion when updating.",
  scope: 'read',
  input: z.object({ strategy: strategyRef }),
  run: async (ctx, a) =>
    ctx.tx(async (t) => {
      const id = await resolveStrategy(t, a.strategy);
      const detail = await getStrategy(t, id);
      const row = await loadStrategyRow(t, id);
      const { validation } = await validateStoredStrategy(t, id);
      const symbol = await symbolLookup(t);
      return {
        id: detail.id,
        number: detail.labNumber,
        name: detail.name,
        description: detail.description,
        tags: detail.tags,
        status: detail.status,
        theory: detail.library?.registrationNumber ?? null,
        rowVersion: row.rowVersion,
        summary: strategySummary(detail.definition, symbol),
        validation: readableValidation(validation, detail.definition),
        definition: detail.definition,
        currentVersion: asJson(detail.currentVersion),
        hasUnpublishedChanges: detail.hasUnpublishedChanges,
        url: strategyUrl(ctx, id),
      };
    }),
});

const listBacktestsTool = tool({
  name: 'list_backtests',
  title: 'List back tests',
  description: "A strategy's back test runs, newest first, with status and headline metrics.",
  scope: 'read',
  input: z.object({ strategy: strategyRef }),
  run: async (ctx, a) =>
    ctx.tx(async (t) => {
      const id = await resolveStrategy(t, a.strategy);
      const runs = await listBacktests(t, id);
      return { strategyId: id, runs: asJson(runs) };
    }),
});

/** Each comparison of a condition as it read on one bar, with its Why line (N218). */
function whyLines(
  condition: ConditionNode | undefined,
  bar: CycleView['entry']['bar'],
  symbol: SymbolLookup,
): string[] {
  if (!condition || !bar) return [];
  const byId = new Map(bar.checks.map((c) => [c.id, c]));
  return comparisonsOf(condition).map((c) => {
    const ev = comparisonEvidence(c, byId.get(c.id), symbol);
    return `${describeCondition(c, symbol)} — ${ev.reason ?? 'not checked on this bar'}`;
  });
}

const getBacktestTool = tool({
  name: 'get_backtest',
  title: 'Get a back test',
  description:
    'A back test run: status, inputs, metrics, and its cycles (entry to exit) with P/L, exit reason and the Why lines that show what each Entry and Exit condition read when it fired. A queued or running run has no cycles yet: call again until status is completed.',
  scope: 'read',
  input: z.object({
    runId: z.uuid(),
    cycleLimit: z.number().int().min(0).max(500).default(50),
    cycleOffset: z.number().int().min(0).default(0),
  }),
  run: async (ctx, a) =>
    ctx.tx(async (t) => {
      const run = asJson<BacktestRunDto>(await getBacktest(t, a.runId));
      const { result, ...summary } = run;
      if (!result) return { ...summary, cycles: { total: 0, items: [] } };
      const trades = asJson<BacktestTradeDto[]>(await listBacktestTrades(t, a.runId));
      const symbols = result.symbols ?? {};
      const symbol: SymbolLookup = (id) => symbols[id];
      const cycles = buildCycles(result, trades);
      return {
        ...summary,
        warnings: result.warnings,
        url: `${strategyUrl(ctx, run.strategyId)}?run=${run.id}`,
        cycles: {
          total: cycles.length,
          offset: a.cycleOffset,
          items: cycles.slice(a.cycleOffset, a.cycleOffset + a.cycleLimit).map((c) => ({
            cycle: c.cycle,
            status: c.status,
            symbols: c.symbols,
            direction: c.direction,
            entryTime: c.trade?.entryTime ?? c.entry.decidedAt,
            exitTime: c.trade?.exitTime ?? null,
            netPnl: c.trade?.netPnl ?? null,
            returnPct: c.trade?.returnPct ?? null,
            exitReason: c.exitReason,
            heldDays: c.heldDays,
            entryWhy: whyLines(c.entry.report?.condition, c.entry.bar, symbol),
            exitWhy: whyLines(c.exit.report?.condition, c.exit.bar, symbol),
            legs: c.legs,
          })),
        },
      };
    }),
});

const screenColumn = z
  .string()
  .refine((k) => COLUMN_BY_KEY.has(k as never), 'Not a screener column')
  .describe('A screener column, such as last, changePct, dollarVolume, marketCap or pe');

const screenStocks = tool({
  name: 'screen_stocks',
  title: 'Screen stocks',
  description:
    "The stock screener (Quantitative Research): today's prices and key figures for a stock group, filtered and sorted. Each row has the instrumentId strategies use. A screen takes some seconds; if it is still pending, call again with the screenId it returned.",
  scope: 'read',
  input: z.object({
    universe: z.enum([...STOCK_GROUP_IDS, 'all']).default('sp500'),
    screenId: z.uuid().optional().describe('A pending screen from an earlier call'),
    text: z
      .string()
      .trim()
      .max(60)
      .default('')
      .describe('Start of a symbol, or a word of the name'),
    type: z.enum(['all', 'stock', 'etf']).default('all'),
    exchange: z.string().trim().max(20).default(''),
    sector: z.string().trim().max(60).default(''),
    ranges: z
      .record(screenColumn, z.object({ min: z.number().optional(), max: z.number().optional() }))
      .default({}),
    sort: z
      .object({ key: z.string().max(40), dir: z.enum(['asc', 'desc']) })
      .default({ key: 'dollarVolume', dir: 'desc' }),
    limit: z.number().int().min(1).max(200).default(25),
  }),
  run: async (ctx, a) => {
    let screen = a.screenId
      ? await ctx.tx((t) => getStockScreen(t, a.screenId as string))
      : await ctx.tx((t) => requestStockScreen(t, { userId: ctx.userId, universe: a.universe }));
    const deadline = ctx.now().getTime() + 20_000;
    while (screen.status === 'pending' && ctx.now().getTime() < deadline) {
      await ctx.sleep(1_500);
      screen = await ctx.tx((t) => getStockScreen(t, screen.id));
    }
    if (screen.status === 'pending') {
      return {
        status: 'pending',
        screenId: screen.id,
        next: 'The screen is still being made. Call screen_stocks again with this screenId in a few seconds.',
      };
    }
    if (screen.status === 'failed') {
      throw new HttpError('unavailable', screen.message ?? 'The screen could not be made.');
    }
    const data = await ctx.tx((t) => getStockScreenData(t, screen.id));
    const filters: ScreenFilters = {
      text: a.text,
      type: a.type,
      exchange: a.exchange,
      sector: a.sector,
      ranges: a.ranges,
    };
    const rows = sortRows(
      filterRows((data.rows ?? []).map(fromScreenTuple), filters, data.universe),
      { key: a.sort.key as SortKey, dir: a.sort.dir },
    );
    return {
      status: 'ready',
      screenId: screen.id,
      universe: data.universe,
      sessionDate: data.sessionDate,
      source: data.source,
      warnings: data.warnings,
      matched: rows.length,
      rows: rows.slice(0, a.limit),
    };
  },
});

const getPaperAccounts = tool({
  name: 'get_paper_accounts',
  title: 'Get paper accounts',
  description:
    "The person's trading platforms and paper accounts, with each account's latest equity. Read only: nothing here can change an account.",
  scope: 'read',
  input: z.object({}),
  run: async (ctx) =>
    ctx.tx(async (t) => {
      const platforms = await listPlatforms(t);
      const out = [];
      for (const p of platforms) {
        const accounts = [];
        for (const acc of p.accounts) {
          const latest = (await listAccountValuations(t, acc.id)).at(-1) ?? null;
          accounts.push({
            id: acc.id,
            nickname: acc.nickname,
            account: acc.maskedExternalId,
            mode: acc.mode,
            currency: acc.currency,
            isDefault: acc.isDefault,
            isActive: acc.isActive,
            usedBy: acc.usedBy,
            equity: latest && {
              sessionDate: latest.sessionDate,
              asOf: latest.asOf,
              appEquity: latest.appEquity,
              brokerEquity: latest.brokerEquity,
            },
          });
        }
        out.push({
          id: p.id,
          name: p.name,
          provider: p.provider,
          environment: p.environment,
          health: p.health,
          accounts,
        });
      }
      return { platforms: out };
    }),
});

// ---------------------------------------------------------------------------
// Operate tools

const DEFINITION_HELP =
  'The strategy definition JSON, in the same format get_strategy returns (schemaVersion, trade, entry, exit, execution, risk). Copy the shape of an existing strategy and change it; instrumentId values come from get_strategy or screen_stocks rows. Omit it to start from an empty strategy with the default settings.';

const createStrategyTool = tool({
  name: 'create_strategy',
  title: 'Create a strategy',
  description: `Creates a Strategy Lab strategy, saved exactly as the builder saves one. Returns its number and the validation errors and warnings the builder would show. An invalid definition creates nothing and returns the same field errors the app shows. ${DEFINITION_HELP}`,
  scope: 'operate',
  input: z.object({
    name: z.string().max(120),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string().max(32)).max(20).optional(),
    theory: z
      .string()
      .trim()
      .max(16)
      .optional()
      .describe('A theory number this strategy builds on'),
    definition: z.record(z.string(), z.unknown()).optional().describe(DEFINITION_HELP),
  }),
  run: async (ctx, a) => {
    // The exact request the builder sends, checked by the same schema.
    const parsed = createStrategyRequest.safeParse({
      name: a.name,
      description: a.description,
      tags: a.tags,
      definition: a.definition,
      library: a.theory ? { kind: 'entry', registrationNumber: a.theory } : undefined,
    });
    if (!parsed.success) {
      throw new HttpError(
        'bad_request',
        'Some fields need attention',
        parsed.error.issues.map((i) => ({
          path: i.path.filter((p): p is string | number => typeof p !== 'symbol'),
          message: i.message,
        })),
      );
    }
    return ctx.tx(async (t) => {
      const s = await createStrategy(t, ctx.userId, parsed.data);
      const { validation } = await validateStoredStrategy(t, s.id);
      return {
        id: s.id,
        number: s.labNumber,
        name: s.name,
        theory: s.library?.registrationNumber ?? null,
        validation: readableValidation(validation, s.definition),
        url: strategyUrl(ctx, s.id),
      };
    });
  },
});

const updateStrategyTool = tool({
  name: 'update_strategy',
  title: 'Update a strategy',
  description: `Saves changes to a strategy, as the builder's Save does: name, description, tags, theory, definition. Pass rowVersion from get_strategy to refuse the save if someone changed it since; leave it out to save over the latest. A strategy that is running keeps its running version until it is restarted in the app. ${DEFINITION_HELP}`,
  scope: 'operate',
  input: z.object({
    strategy: strategyRef,
    rowVersion: z.number().int().positive().optional(),
    name: z.string().max(120).optional(),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string().max(32)).max(20).optional(),
    theory: z
      .string()
      .trim()
      .max(16)
      .nullable()
      .optional()
      .describe('A theory number, or null to refer to none'),
    definition: z.record(z.string(), z.unknown()).optional().describe(DEFINITION_HELP),
  }),
  run: async (ctx, a) =>
    ctx.tx(async (t) => {
      const id = await resolveStrategy(t, a.strategy);
      const rowVersion = a.rowVersion ?? (await loadStrategyRow(t, id)).rowVersion;
      const parsed = updateStrategyRequest.safeParse({
        rowVersion,
        name: a.name,
        description: a.description,
        tags: a.tags,
        definition: a.definition,
        library:
          a.theory === undefined
            ? undefined
            : a.theory === null
              ? { kind: 'none' }
              : { kind: 'entry', registrationNumber: a.theory },
      });
      if (!parsed.success) {
        throw new HttpError(
          'bad_request',
          'Some fields need attention',
          parsed.error.issues.map((i) => ({
            path: i.path.filter((p): p is string | number => typeof p !== 'symbol'),
            message: i.message,
          })),
        );
      }
      const s = await updateStrategy(t, ctx.userId, id, parsed.data);
      const { validation } = await validateStoredStrategy(t, id);
      const row = await loadStrategyRow(t, id);
      return {
        id: s.id,
        number: s.labNumber,
        name: s.name,
        rowVersion: row.rowVersion,
        validation: readableValidation(validation, s.definition),
        url: strategyUrl(ctx, s.id),
      };
    }),
});

/** The longest look-back up to a year the strategy's bars allow, as the run form picks (N234). */
function defaultLookback(to: string, interval: BacktestInterval): BacktestLookback {
  const fits = BACKTEST_LOOKBACKS.filter(
    (l) =>
      lookbackFits(to, l, interval) &&
      BACKTEST_LOOKBACKS.indexOf(l) <= BACKTEST_LOOKBACKS.indexOf('1y'),
  );
  return fits[fits.length - 1] ?? '1w';
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const runBacktestTool = tool({
  name: 'run_backtest',
  title: 'Run a back test',
  description:
    "Queues a back test of a strategy's saved rules, as the Back test panel's Run does. The bar size follows the strategy. The run covers the look-back period before the end date (default: today, and the longest look-back up to 1 year the bars allow). Returns the run id at once; read the result with get_backtest until its status is completed.",
  scope: 'operate',
  input: z.object({
    strategy: strategyRef,
    endDate: date.optional().describe('Default today; a run ending today reads up to yesterday'),
    lookBack: z.enum(BACKTEST_LOOKBACKS).optional(),
    initialCapital: z.string().optional().describe('Default 100000'),
    slippageBps: z.string().optional().describe('Default 5'),
    commissionPerShare: z.string().optional(),
    commissionMin: z.string().optional(),
    symbols: z
      .array(z.string())
      .max(600)
      .optional()
      .describe('Group strategies: test only these members'),
  }),
  run: async (ctx, a) => {
    // The Back test panel's own limit on starting runs (ADR 0026).
    const wait = await ctx.rateLimit(`backtest:${ctx.userId}`, 20);
    if (wait > 0)
      throw new HttpError('rate_limited', `Too many back tests started. Wait ${wait} seconds.`);
    return ctx.tx(async (t) => {
      const id = await resolveStrategy(t, a.strategy);
      const detail = await getStrategy(t, id);
      const interval =
        matchingBacktestInterval(detail.definition)?.interval ?? DEFAULT_BACKTEST_INPUTS.interval;
      const today = nyDate(ctx.now().toISOString());
      const endDate = a.endDate ?? today;
      const lookback = a.lookBack ?? defaultLookback(endDate, interval);
      const endsToday = endDate >= today;
      const from = lookbackStart(endsToday ? today : endDate, lookback);
      const parsed = startBacktestRequest.safeParse({
        from,
        to: endDate,
        lookback,
        interval,
        ...(a.initialCapital !== undefined ? { initialCapital: a.initialCapital } : {}),
        ...(a.slippageBps !== undefined ? { slippageBps: a.slippageBps } : {}),
        ...(a.commissionPerShare !== undefined ? { commissionPerShare: a.commissionPerShare } : {}),
        ...(a.commissionMin !== undefined ? { commissionMin: a.commissionMin } : {}),
        ...(a.symbols ? { symbols: a.symbols.map((s) => s.trim().toUpperCase()) } : {}),
      });
      if (!parsed.success) {
        throw new HttpError(
          'bad_request',
          'Some fields need attention',
          parsed.error.issues.map((i) => ({
            path: i.path.filter((p): p is string | number => typeof p !== 'symbol'),
            message: i.message,
          })),
        );
      }
      const run = asJson<BacktestRunDto>(
        await queueBacktest(t, ctx.userId, id, parsed.data, ctx.now()),
      );
      return {
        runId: run.id,
        strategyId: id,
        status: run.status,
        inputs: run.inputs,
        next: 'Call get_backtest with this runId until status is completed (a daily run usually takes seconds to a minute).',
      };
    });
  },
});

const createTheoryTool = tool({
  name: 'create_theory',
  title: 'Create a theory',
  description:
    "Registers a new Theory Library entry from structured fields, as the Library's Register form does; the number is issued at once. Codes: timeframeCode and assetClassCode are single letters from the Library conventions (for example timeframe S = swing, asset class S = stocks).",
  scope: 'operate',
  input: registerLibraryEntrySchema,
  run: async (ctx, a) =>
    ctx.tx(async (t) => {
      const entry = await registerLibraryEntry(t, ctx.userId, a);
      return {
        number: entry.registrationNumber,
        name: a.name,
        status: 'registered',
        url: `${ctx.appUrl}/library/${entry.registrationNumber}`,
      };
    }),
});

/** Every tool an agent can call, in the order tools/list gives them. */
export const AGENT_TOOLS: readonly AgentTool[] = [
  searchTheories,
  getTheory,
  listStrategiesTool,
  getStrategyTool,
  listBacktestsTool,
  getBacktestTool,
  screenStocks,
  getPaperAccounts,
  createStrategyTool,
  updateStrategyTool,
  runBacktestTool,
  createTheoryTool,
];

export const toolByName = (name: string) => AGENT_TOOLS.find((t) => t.name === name);

/** A tool as tools/list describes it (MCP 2025-06-18). */
export function toolListing(t: AgentTool) {
  const inputSchema = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete inputSchema.$schema;
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: t.scope === 'read',
      destructiveHint: false,
      idempotentHint: t.scope === 'read',
      openWorldHint: false,
    },
  };
}
