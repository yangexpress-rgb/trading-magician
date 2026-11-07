'use client';

import {
  BAR_INTERVALS,
  CALC_OPS,
  CONTEXT_INSTRUMENT_ID,
  getIndicator,
  getMetric,
  BUILDER_INDICATORS,
  isFundamentalMetric,
  isOptionsMetric,
  isRankingMetric,
  METRICS,
  resolveMetricParams,
  STAT_FUNCTIONS,
  MARKET_FIELDS,
  POSITION_FIELDS,
  PRICE_ADJUSTMENTS,
  randomId,
  resolveIndicatorParams,
  SESSIONS,
  type CalcExpr,
  type Expr,
  type IndicatorExpr,
  type MarketExpr,
  type MetricExpr,
  type MetricRef,
  type PositionExpr,
  type StatFunction,
} from '@tm/domain';
import { cx } from '@tm/ui';
import {
  ADJUSTMENT_LABELS,
  CALC_LABELS,
  FIELD_LABELS,
  INTERVAL_LABELS,
  POSITION_FIELD_LABELS,
} from '@/lib/strategy-text';
import { useEditor } from './editor-context';
import { MiniInput, MiniSelect, RowButton } from './fields';
import { InstrumentSelect } from './instrument-select';

type Path = readonly (string | number)[];
type Kind = Expr['kind'];
/**
 * The Type choices: fundamental (v1.2 item 6) and options (options brief v2 §6)
 * metrics are registry metrics listed on their own.
 */
type UiKind = Kind | 'fundamental' | 'options';

const KIND_LABELS: Record<UiKind, string> = {
  constant: 'Fixed value',
  market: 'Market data',
  indicator: 'Indicator',
  position: 'Position (after Entry fills)',
  calc: 'Calculation',
  metric: 'Metric (price-based, shared registry)',
  fundamental: 'Fundamental metric (company filings)',
  options: 'Options metric (end-of-day)',
  stat: 'Statistic (std. dev., z-score, Bollinger, BandWidth)',
};

type MetricCategoryFilter = 'price' | 'fundamental' | 'options';

const categoryOf = (metric: string): MetricCategoryFilter =>
  isFundamentalMetric(metric) ? 'fundamental' : isOptionsMetric(metric) ? 'options' : 'price';

const uiKindOf = (expr: Expr): UiKind => {
  if (expr.kind !== 'metric') return expr.kind;
  const category = categoryOf(expr.metric);
  return category === 'price' ? 'metric' : category;
};

/** The options metric a new options value starts on: the 5-day expected move (brief §4.1). */
const DEFAULT_OPTIONS_METRIC = 'options.expected_move_5d_pct';

export const STAT_LABELS: Record<StatFunction, string> = {
  STDDEV: 'Standard deviation',
  ZSCORE: 'Z-score',
  BB_UPPER: 'Bollinger upper band',
  BB_MIDDLE: 'Bollinger middle band',
  BB_LOWER: 'Bollinger lower band',
  BANDWIDTH: 'Bollinger BandWidth',
};

const STAT_HELP: Record<StatFunction, string> = {
  STDDEV: 'Sample standard deviation (n − 1) of the input over the last N bars.',
  ZSCORE: '(Input − its N-bar average) ÷ its N-bar sample standard deviation.',
  BB_UPPER: 'N-bar average of the input plus the multiplier × its standard deviation.',
  BB_MIDDLE: 'N-bar average of the input.',
  BB_LOWER: 'N-bar average of the input minus the multiplier × its standard deviation.',
  BANDWIDTH:
    '(Upper band − lower band) ÷ middle band, from the same bands. Volatility-squeeze rules compare it with its lowest value over, say, 120 bars.',
};

const isBand = (fn: StatFunction) => fn.startsWith('BB_') || fn === 'BANDWIDTH';

/** Metrics the picker offers: those defined for every one of the asset classes. */
export function metricsForClasses(classes: readonly string[]) {
  return METRICS.filter((m) => classes.every((c) => m.assetClasses.includes(c)));
}

export function defaultMetricRef(metric = 'return'): MetricRef {
  const spec = getMetric(metric) ?? METRICS[0];
  if (!spec) throw new Error('The metric registry is empty');
  return { metric: spec.id, params: resolveMetricParams(spec, {}) };
}

function seriesDefaults(instrumentId: string) {
  return {
    instrumentId,
    interval: '1d' as const,
    adjustment: 'split_and_dividend' as const,
    session: 'regular' as const,
    offset: 0,
  };
}

/** A fresh expression of `kind`, keeping the instrument the user already picked. */
export function newExpr(kind: Kind, instrumentId: string, from?: Expr): Expr {
  const instrument =
    from &&
    (from.kind === 'market' ||
      from.kind === 'indicator' ||
      from.kind === 'position' ||
      from.kind === 'metric')
      ? from.instrumentId
      : instrumentId;
  switch (kind) {
    case 'constant':
      return { kind, id: randomId(), value: '0' };
    case 'market':
      return { kind, id: randomId(), field: 'close', ...seriesDefaults(instrument) };
    case 'indicator': {
      const spec = BUILDER_INDICATORS[0];
      if (!spec) throw new Error('The indicator catalog is empty');
      return {
        kind,
        id: randomId(),
        name: spec.name,
        params: resolveIndicatorParams(spec, {}),
        field: spec.defaultField ?? 'close',
        ...seriesDefaults(instrument),
      };
    }
    case 'position':
      return {
        kind,
        id: randomId(),
        field: 'gain_pct',
        instrumentId: instrument,
        interval: '1d',
        adjustment: 'split_and_dividend',
        session: 'regular',
      };
    case 'calc':
      return {
        kind,
        id: randomId(),
        op: 'sub',
        args: [
          from ? { ...from, id: randomId() } : newExpr('market', instrument),
          newExpr('constant', instrument),
        ],
      };
    case 'metric':
      return { kind, id: randomId(), ...defaultMetricRef(), instrumentId: instrument };
    case 'stat':
      return {
        kind,
        id: randomId(),
        fn: 'ZSCORE',
        period: 20,
        input:
          from && from.kind !== 'stat' && from.kind !== 'constant'
            ? { ...from, id: randomId() }
            : newExpr('market', instrument),
      };
  }
}

const MAX_NESTING = 5;

/**
 * The reusable expression row (Design v1.0 §6.4, §15.1). Used for both sides of
 * every comparison and for calculation arguments. Each market or indicator
 * expression picks its own instrument.
 */
export function ExpressionEditor({
  expr,
  onChange,
  legend,
  path,
  depth = 0,
}: {
  expr: Expr;
  onChange: (expr: Expr) => void;
  legend: string;
  path: Path;
  depth?: number;
}) {
  const { instruments, issueAt, editable, slotMode, optionUnderlyings = [] } = useEditor();
  const fallbackInstrument =
    slotMode !== 'none' ? CONTEXT_INSTRUMENT_ID : (instruments[0]?.id ?? '');
  const id = (field: string) => `${expr.id}-${field}`;
  const err = (...rest: (string | number)[]) => issueAt([...path, ...rest]);
  // Position values exist only once Entry has filled, so only Exit offers them.
  const kinds = (Object.keys(KIND_LABELS) as UiKind[]).filter(
    (k) => k !== 'position' || path[0] === 'exit' || expr.kind === 'position',
  );

  return (
    <fieldset
      className={cx(
        'min-w-0 rounded-md border border-line p-2',
        depth > 0 ? 'bg-surface-2' : 'bg-surface',
      )}
      disabled={!editable}
    >
      <legend className="px-1 text-xs font-semibold">{legend}</legend>
      <div className="grid-fields-wide gap-2">
        <MiniSelect
          id={id('kind')}
          label="Type"
          value={uiKindOf(expr)}
          onChange={(e) => {
            const kind = e.target.value as UiKind;
            if ((kind === 'calc' || kind === 'stat') && depth >= MAX_NESTING) return;
            if (kind === 'fundamental') {
              const metric = newExpr('metric', fallbackInstrument, expr);
              onChange({ ...metric, ...defaultMetricRef('pe') } as Expr);
              return;
            }
            if (kind === 'options') {
              // Only recorded underlyings have options signals; keep the pick if it is one.
              const metric = newExpr('metric', fallbackInstrument, expr) as MetricExpr;
              const recorded =
                metric.instrumentId === CONTEXT_INSTRUMENT_ID ||
                optionUnderlyings.some((u) => u.id === metric.instrumentId);
              const instrumentId = recorded
                ? metric.instrumentId
                : (optionUnderlyings[0]?.id ?? metric.instrumentId);
              onChange({ ...metric, ...defaultMetricRef(DEFAULT_OPTIONS_METRIC), instrumentId });
              return;
            }
            onChange(newExpr(kind, fallbackInstrument, expr));
          }}
        >
          {kinds.map((k) => (
            <option
              key={k}
              value={k}
              disabled={(k === 'calc' || k === 'stat') && depth >= MAX_NESTING}
            >
              {KIND_LABELS[k]}
            </option>
          ))}
        </MiniSelect>

        {expr.kind === 'constant' && (
          <MiniInput
            id={id('value')}
            label="Value"
            inputMode="decimal"
            value={expr.value}
            error={err('value')}
            onChange={(e) => onChange({ ...expr, value: e.target.value.trim() })}
          />
        )}

        {(expr.kind === 'market' || expr.kind === 'indicator') && (
          <SeriesFields expr={expr} onChange={onChange} id={id} err={err} />
        )}

        {expr.kind === 'position' && (
          <PositionFields expr={expr} onChange={onChange} id={id} err={err} />
        )}

        {expr.kind === 'metric' && (
          <MetricFields
            expr={expr}
            onChange={onChange}
            id={id}
            err={err}
            category={categoryOf(expr.metric)}
          />
        )}

        {expr.kind === 'stat' && (
          <>
            <MiniSelect
              id={id('fn')}
              label="Function"
              value={expr.fn}
              onChange={(e) => {
                const fn = e.target.value as StatFunction;
                const { multiplier, ...rest } = expr;
                onChange(
                  isBand(fn) ? { ...rest, fn, multiplier: multiplier ?? '2' } : { ...rest, fn },
                );
              }}
            >
              {STAT_FUNCTIONS.map((f) => (
                <option key={f} value={f}>
                  {STAT_LABELS[f]}
                </option>
              ))}
            </MiniSelect>
            <MiniInput
              id={id('period')}
              label="Period (bars)"
              type="number"
              min={2}
              max={500}
              step={1}
              value={Number.isFinite(expr.period) ? String(expr.period) : ''}
              error={err('period')}
              onChange={(e) =>
                onChange({
                  ...expr,
                  period: e.target.value === '' ? Number.NaN : Number(e.target.value),
                })
              }
            />
            {isBand(expr.fn) && (
              <MiniInput
                id={id('multiplier')}
                label="Std. dev. multiplier"
                inputMode="decimal"
                value={expr.multiplier ?? ''}
                error={err('multiplier')}
                onChange={(e) => onChange({ ...expr, multiplier: e.target.value.trim() })}
              />
            )}
            <MiniInput
              id={id('offset')}
              label="Bars ago"
              type="number"
              min={0}
              max={500}
              step={1}
              value={String(expr.offset ?? 0)}
              error={err('offset')}
              onChange={(e) => {
                const { offset: _o, ...rest } = expr;
                void _o;
                const n = e.target.value === '' ? 0 : Number(e.target.value);
                onChange(n ? { ...rest, offset: n } : rest);
              }}
            />
            <p className="col-span-full text-xs text-ink-muted">{STAT_HELP[expr.fn]}</p>
          </>
        )}

        {expr.kind === 'calc' && (
          <MiniSelect
            id={id('op')}
            label="Operation"
            value={expr.op}
            onChange={(e) =>
              onChange(withCalcOp(expr, e.target.value as CalcExpr['op'], fallbackInstrument))
            }
          >
            {CALC_OPS.map((op) => (
              <option key={op} value={op}>
                {CALC_LABELS[op]}
              </option>
            ))}
          </MiniSelect>
        )}
      </div>

      {expr.kind === 'stat' && (
        <div className="mt-2">
          <ExpressionEditor
            expr={expr.input}
            legend={`${legend}, input (a price or a calculated expression)`}
            path={[...path, 'input']}
            depth={depth + 1}
            onChange={(input) => onChange({ ...expr, input })}
          />
        </div>
      )}

      {expr.kind === 'calc' && (
        <div className="mt-2 space-y-2">
          {err('args') && <p className="text-xs font-medium text-danger">{err('args')}</p>}
          {expr.args.map((arg, i) => (
            <div key={arg.id} className="flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <ExpressionEditor
                  expr={arg}
                  legend={`${legend}, value ${i + 1}`}
                  path={[...path, 'args', i]}
                  depth={depth + 1}
                  onChange={(next) =>
                    onChange({ ...expr, args: expr.args.map((a, j) => (j === i ? next : a)) })
                  }
                />
              </div>
              {(expr.op === 'min' || expr.op === 'max') && expr.args.length > 2 && (
                <RowButton
                  label={`Remove ${legend.toLowerCase()}, value ${i + 1}`}
                  onClick={() => onChange({ ...expr, args: expr.args.filter((_, j) => j !== i) })}
                >
                  Remove
                </RowButton>
              )}
            </div>
          ))}
          {(expr.op === 'min' || expr.op === 'max') && (
            <RowButton
              label={`Add a value to ${legend.toLowerCase()}`}
              onClick={() =>
                onChange({ ...expr, args: [...expr.args, newExpr('constant', fallbackInstrument)] })
              }
            >
              + Add value
            </RowButton>
          )}
        </div>
      )}
    </fieldset>
  );
}

function withCalcOp(expr: CalcExpr, op: CalcExpr['op'], instrumentId: string): CalcExpr {
  const unary = op === 'neg' || op === 'abs';
  const variadic = op === 'min' || op === 'max';
  let args = expr.args;
  if (unary) args = args.slice(0, 1);
  else if (!variadic) args = args.slice(0, 2);
  while (args.length < (unary ? 1 : 2)) args = [...args, newExpr('constant', instrumentId)];
  return { ...expr, op, args };
}

function SeriesFields({
  expr,
  onChange,
  id,
  err,
}: {
  expr: MarketExpr | IndicatorExpr;
  onChange: (expr: Expr) => void;
  id: (field: string) => string;
  err: (...rest: (string | number)[]) => string | undefined;
}) {
  const spec = expr.kind === 'indicator' ? getIndicator(expr.name) : undefined;
  const showField = expr.kind === 'market' || spec?.defaultField !== null;

  return (
    <>
      {expr.kind === 'indicator' && (
        <MiniSelect
          id={id('indicator')}
          label="Indicator"
          value={expr.name}
          error={err('name')}
          onChange={(e) => {
            const next = getIndicator(e.target.value);
            if (!next) return;
            onChange({
              ...expr,
              name: next.name,
              params: resolveIndicatorParams(next, {}),
              field: next.defaultField ?? 'close',
              // v1.2 item 7: Highest/Lowest start one bar back (prior-bar breakout).
              offset: next.builderOffset ?? 0,
            });
          }}
        >
          {/* RSI and Bollinger bands are metrics and statistics now (ADR 0049); a saved
              one the migration kept as an indicator still shows, but isn't offered. */}
          {!BUILDER_INDICATORS.some((i) => i.name === expr.name) && (
            <option value={expr.name}>
              {spec ? `${spec.label} (${spec.name}), kept as saved` : `${expr.name} (unsupported)`}
            </option>
          )}
          {BUILDER_INDICATORS.map((i) => (
            <option key={i.name} value={i.name}>
              {i.label} ({i.name})
            </option>
          ))}
        </MiniSelect>
      )}
      <InstrumentSelect
        id={id('instrument')}
        value={expr.instrumentId}
        error={err('instrumentId')}
        onChange={(instrumentId) => onChange({ ...expr, instrumentId })}
      />
      {showField && (
        <MiniSelect
          id={id('field')}
          label={expr.kind === 'indicator' ? 'Applied to' : 'Field'}
          value={expr.field}
          onChange={(e) => onChange({ ...expr, field: e.target.value as MarketExpr['field'] })}
        >
          {MARKET_FIELDS.map((f) => (
            <option key={f} value={f}>
              {FIELD_LABELS[f]}
            </option>
          ))}
        </MiniSelect>
      )}
      <MiniSelect
        id={id('interval')}
        label="Bar interval"
        value={expr.interval}
        onChange={(e) => onChange({ ...expr, interval: e.target.value as MarketExpr['interval'] })}
      >
        {BAR_INTERVALS.map((b) => (
          <option key={b} value={b}>
            {INTERVAL_LABELS[b]}
          </option>
        ))}
      </MiniSelect>

      {expr.kind === 'indicator' &&
        spec?.params.map((p) => {
          const value = expr.params[p.name];
          const setParam = (v: number | string) =>
            onChange({ ...expr, params: { ...expr.params, [p.name]: v } });
          return p.kind === 'enum' ? (
            <MiniSelect
              key={p.name}
              id={id(`param-${p.name}`)}
              label={p.label}
              value={String(value ?? p.default)}
              onChange={(e) => setParam(e.target.value)}
            >
              {p.options?.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </MiniSelect>
          ) : (
            <MiniInput
              key={p.name}
              id={id(`param-${p.name}`)}
              label={p.label}
              type="number"
              inputMode={p.kind === 'int' ? 'numeric' : 'decimal'}
              step={p.kind === 'int' ? 1 : 'any'}
              min={p.min}
              max={p.max}
              value={value === undefined ? '' : String(value)}
              onChange={(e) => setParam(e.target.value === '' ? '' : Number(e.target.value))}
            />
          );
        })}
      {expr.kind === 'indicator' && err('params') && (
        <p className="col-span-full text-xs font-medium text-danger">{err('params')}</p>
      )}
      {expr.kind === 'indicator' && spec?.builderOffset !== undefined && (
        <MiniInput
          id={id('offset')}
          label="Bars ago"
          type="number"
          min={0}
          max={500}
          step={1}
          value={String(expr.offset)}
          error={err('offset')}
          onChange={(e) =>
            onChange({ ...expr, offset: e.target.value === '' ? 0 : Number(e.target.value) })
          }
        />
      )}
      {expr.kind === 'indicator' && spec?.help && (
        <p className="col-span-full text-xs text-ink-muted">
          {spec.help(resolveIndicatorParams(spec, expr.params), expr.offset)}
        </p>
      )}

      <details className="col-span-full">
        <summary className="cursor-pointer text-xs font-medium text-ink-muted">
          More options
        </summary>
        <div className="mt-2 grid-fields-wide gap-2">
          {spec?.builderOffset === undefined && (
            <MiniInput
              id={id('offset')}
              label="Bars ago"
              type="number"
              min={0}
              max={500}
              step={1}
              value={String(expr.offset)}
              error={err('offset')}
              onChange={(e) =>
                onChange({ ...expr, offset: e.target.value === '' ? 0 : Number(e.target.value) })
              }
            />
          )}
          <MiniSelect
            id={id('adjustment')}
            label="Price adjustment"
            value={expr.adjustment}
            onChange={(e) =>
              onChange({ ...expr, adjustment: e.target.value as MarketExpr['adjustment'] })
            }
          >
            {PRICE_ADJUSTMENTS.map((a) => (
              <option key={a} value={a}>
                {ADJUSTMENT_LABELS[a]}
              </option>
            ))}
          </MiniSelect>
          <MiniSelect
            id={id('session')}
            label="Session"
            value={expr.session}
            onChange={(e) =>
              onChange({ ...expr, session: e.target.value as MarketExpr['session'] })
            }
          >
            {SESSIONS.map((s) => (
              <option key={s} value={s}>
                {s === 'regular' ? 'Regular hours' : 'Including extended hours'}
              </option>
            ))}
          </MiniSelect>
        </div>
      </details>
    </>
  );
}

/**
 * A value from the cycle's own position: its average Entry fill price, gain,
 * profit or quantity. Gain and profit are marked at the close of each
 * completed bar of the chosen interval, which is also how often they update.
 */
function PositionFields({
  expr,
  onChange,
  id,
  err,
}: {
  expr: PositionExpr;
  onChange: (expr: Expr) => void;
  id: (field: string) => string;
  err: (...rest: (string | number)[]) => string | undefined;
}) {
  return (
    <>
      <InstrumentSelect
        id={id('instrument')}
        value={expr.instrumentId}
        error={err('instrumentId')}
        onChange={(instrumentId) => onChange({ ...expr, instrumentId })}
      />
      <MiniSelect
        id={id('field')}
        label="Value"
        value={expr.field}
        onChange={(e) => onChange({ ...expr, field: e.target.value as PositionExpr['field'] })}
      >
        {POSITION_FIELDS.map((f) => (
          <option key={f} value={f}>
            {POSITION_FIELD_LABELS[f]}
          </option>
        ))}
      </MiniSelect>
      <MiniSelect
        id={id('interval')}
        label="Check every"
        value={expr.interval}
        onChange={(e) =>
          onChange({ ...expr, interval: e.target.value as PositionExpr['interval'] })
        }
      >
        {BAR_INTERVALS.map((b) => (
          <option key={b} value={b}>
            {INTERVAL_LABELS[b]}
          </option>
        ))}
      </MiniSelect>
      <p className="col-span-full text-xs text-ink-muted">
        {expr.field === 'gain_pct'
          ? 'Percent above your average Entry fill price (below it for a short), at each bar close.'
          : expr.field === 'entry_price'
            ? 'Your average Entry fill price in this cycle.'
            : expr.field === 'pnl'
              ? 'Unrealized profit or loss in dollars, at each bar close.'
              : 'Shares held in this cycle; negative when short.'}
      </p>
    </>
  );
}

/**
 * The registry metric fields (v1.2 item 1): metric, its parameters, and the
 * instrument. The same definitions rank Selection groups.
 */
function MetricFields({
  expr,
  onChange,
  id,
  err,
  category,
}: {
  expr: MetricExpr;
  onChange: (expr: Expr) => void;
  id: (field: string) => string;
  err: (...rest: (string | number)[]) => string | undefined;
  category: MetricCategoryFilter;
}) {
  const { instruments, universeClasses } = useEditor();
  const classes =
    expr.instrumentId === CONTEXT_INSTRUMENT_ID
      ? universeClasses
      : [instruments.find((i) => i.id === expr.instrumentId)?.assetClass ?? 'stock'];
  return (
    <>
      {category === 'options' ? (
        <OptionsUnderlyingSelect
          id={id('instrument')}
          value={expr.instrumentId}
          error={err('instrumentId')}
          onChange={(instrumentId) => onChange({ ...expr, instrumentId })}
        />
      ) : (
        <InstrumentSelect
          id={id('instrument')}
          value={expr.instrumentId}
          error={err('instrumentId')}
          onChange={(instrumentId) => onChange({ ...expr, instrumentId })}
        />
      )}
      <MetricRefFields
        value={{ metric: expr.metric, params: expr.params }}
        classes={classes}
        id={id}
        error={err('metric') ?? err('params')}
        category={category}
        label={
          category === 'fundamental'
            ? 'Fundamental metric'
            : category === 'options'
              ? 'Options metric'
              : 'Metric'
        }
        onChange={(ref) => onChange({ ...expr, metric: ref.metric, params: ref.params })}
      />
      {category === 'options' && <OptionsFreshness instrumentId={expr.instrumentId} />}
    </>
  );
}

/**
 * The underlying of an options metric: only those in the options recording
 * (options brief v2 §6), plus "This instrument" for per-leg or Selection
 * rules. A stock or ETF joins the recording when a saved strategy trades it.
 */
function OptionsUnderlyingSelect({
  id,
  value,
  error,
  onChange,
}: {
  id: string;
  value: string;
  error: string | undefined;
  onChange: (instrumentId: string) => void;
}) {
  const { instruments, slotMode, optionUnderlyings = [] } = useEditor();
  const listed = value === CONTEXT_INSTRUMENT_ID || optionUnderlyings.some((u) => u.id === value);
  const current = instruments.find((i) => i.id === value);
  return (
    <MiniSelect
      id={id}
      label="Underlying"
      value={value}
      error={error}
      onChange={(e) => onChange(e.target.value)}
    >
      {!listed && (
        <option value={value}>
          {current ? `${current.symbol} (not recorded yet)` : 'Choose an underlying'}
        </option>
      )}
      {slotMode !== 'none' && <option value={CONTEXT_INSTRUMENT_ID}>This instrument</option>}
      {optionUnderlyings.map((u) => (
        <option key={u.id} value={u.id}>
          {u.symbol}
        </option>
      ))}
    </MiniSelect>
  );
}

/** How fresh an underlying's options data is: the as-of date of its latest signal. */
function OptionsFreshness({ instrumentId }: { instrumentId: string }) {
  const { optionUnderlyings = [] } = useEditor();
  const u = optionUnderlyings.find((x) => x.id === instrumentId);
  const text =
    instrumentId === CONTEXT_INSTRUMENT_ID
      ? 'Reads each instrument’s latest end-of-day options signal; unknown where it has none.'
      : !u
        ? 'Not in the options recording yet: saving the strategy adds it, and data starts with the next recorded session.'
        : u.latestAsOf
          ? `Latest options signal: ${u.latestAsOf} (end of day, from CBOE delayed quotes).`
          : 'No options signal stored yet: data starts with the next recorded session.';
  return <p className="col-span-full text-xs text-ink-muted">{text}</p>;
}

/** Metric picker and parameters, shared by conditions, ranking and fire mode. */
export function MetricRefFields({
  value,
  classes,
  id,
  error,
  label = 'Metric',
  category,
  onChange,
}: {
  value: MetricRef;
  classes: readonly string[];
  id: (field: string) => string;
  error?: string | undefined;
  label?: string;
  /**
   * Only one category's metrics; every category, grouped, when absent
   * (ranking and fire mode).
   */
  category?: MetricCategoryFilter | undefined;
  onChange: (ref: MetricRef) => void;
}) {
  const { instruments } = useEditor();
  const spec = getMetric(value.metric);
  const offered = metricsForClasses(classes).filter((m) =>
    category ? categoryOf(m.id) === category : isRankingMetric(m.id),
  );
  const groups = [
    { label: 'Price-based', metrics: offered.filter((m) => categoryOf(m.id) === 'price') },
    {
      label: 'Options (daily recording)',
      metrics: offered.filter((m) => categoryOf(m.id) === 'options'),
    },
    {
      label: 'Fundamental (company filings)',
      metrics: offered.filter((m) => isFundamentalMetric(m.id)),
    },
  ].filter((g) => g.metrics.length > 0);
  return (
    <>
      <MiniSelect
        id={id('metric')}
        label={label}
        value={value.metric}
        error={error}
        onChange={(e) => {
          const ref = defaultMetricRef(e.target.value);
          // A benchmark defaults to SPY when the strategy knows it (v1.2 item 1).
          const next = getMetric(ref.metric);
          for (const p of next?.params ?? []) {
            if (p.kind === 'instrument' && !ref.params[p.name]) {
              const spy = instruments.find((i) => i.symbol === 'SPY') ?? instruments[0];
              if (spy) ref.params = { ...ref.params, [p.name]: spy.id };
            }
          }
          onChange(ref);
        }}
      >
        {!offered.some((m) => m.id === value.metric) && (
          <option value={value.metric}>
            {spec ? `${spec.label} (not for these instruments)` : `${value.metric} (unsupported)`}
          </option>
        )}
        {category
          ? offered.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))
          : groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.metrics.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ))}
      </MiniSelect>
      {spec?.params.map((p) => {
        const v = value.params[p.name] ?? p.default;
        const setParam = (next: number | string) =>
          onChange({ ...value, params: { ...value.params, [p.name]: next } });
        if (p.kind === 'instrument') {
          return (
            <InstrumentSelect
              key={p.name}
              id={id(`metric-${p.name}`)}
              label={p.label}
              value={String(v)}
              allowContext={false}
              onChange={setParam}
            />
          );
        }
        return p.kind === 'enum' ? (
          <MiniSelect
            key={p.name}
            id={id(`metric-${p.name}`)}
            label={p.label}
            value={String(v)}
            onChange={(e) => setParam(e.target.value)}
          >
            {p.options?.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </MiniSelect>
        ) : (
          <MiniInput
            key={p.name}
            id={id(`metric-${p.name}`)}
            label={p.label}
            type="number"
            step={p.kind === 'int' ? 1 : 'any'}
            min={p.min}
            max={p.max}
            value={String(v)}
            onChange={(e) => setParam(e.target.value === '' ? '' : Number(e.target.value))}
          />
        );
      })}
      {spec && <p className="col-span-full text-xs text-ink-muted">{spec.help}</p>}
    </>
  );
}
