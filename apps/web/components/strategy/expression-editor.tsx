'use client';

import {
  BAR_INTERVALS,
  CALC_OPS,
  getIndicator,
  INDICATORS,
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
  type PositionExpr,
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

type Path = readonly (string | number)[];
type Kind = Expr['kind'];

const KIND_LABELS: Record<Kind, string> = {
  constant: 'Fixed value',
  market: 'Market data',
  indicator: 'Indicator',
  position: 'Position (after Entry fills)',
  calc: 'Calculation',
};

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
    from && (from.kind === 'market' || from.kind === 'indicator' || from.kind === 'position')
      ? from.instrumentId
      : instrumentId;
  switch (kind) {
    case 'constant':
      return { kind, id: randomId(), value: '0' };
    case 'market':
      return { kind, id: randomId(), field: 'close', ...seriesDefaults(instrument) };
    case 'indicator': {
      const spec = INDICATORS[0];
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
  const { instruments, issueAt, editable } = useEditor();
  const fallbackInstrument = instruments[0]?.id ?? '';
  const id = (field: string) => `${expr.id}-${field}`;
  const err = (...rest: (string | number)[]) => issueAt([...path, ...rest]);
  // Position values exist only once Entry has filled, so only Exit offers them.
  const kinds = (Object.keys(KIND_LABELS) as Kind[]).filter(
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
          value={expr.kind}
          onChange={(e) => {
            const kind = e.target.value as Kind;
            if (kind === 'calc' && depth >= MAX_NESTING) return;
            onChange(newExpr(kind, fallbackInstrument, expr));
          }}
        >
          {kinds.map((k) => (
            <option key={k} value={k} disabled={k === 'calc' && depth >= MAX_NESTING}>
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
  const { instruments } = useEditor();
  const spec = expr.kind === 'indicator' ? getIndicator(expr.name) : undefined;
  const showField = expr.kind === 'market' || spec?.defaultField !== null;
  const known = instruments.some((i) => i.id === expr.instrumentId);

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
            });
          }}
        >
          {!spec && <option value={expr.name}>{expr.name} (unsupported)</option>}
          {INDICATORS.map((i) => (
            <option key={i.name} value={i.name}>
              {i.label} ({i.name})
            </option>
          ))}
        </MiniSelect>
      )}
      <MiniSelect
        id={id('instrument')}
        label="Instrument"
        value={expr.instrumentId}
        error={err('instrumentId')}
        onChange={(e) => onChange({ ...expr, instrumentId: e.target.value })}
      >
        {!known && <option value={expr.instrumentId}>Choose an instrument</option>}
        {instruments.map((i) => (
          <option key={i.id} value={i.id}>
            {i.symbol} · {i.displayName}
          </option>
        ))}
      </MiniSelect>
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

      <details className="col-span-full">
        <summary className="cursor-pointer text-xs font-medium text-ink-muted">
          More options
        </summary>
        <div className="mt-2 grid-fields-wide gap-2">
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
  const { instruments } = useEditor();
  const known = instruments.some((i) => i.id === expr.instrumentId);
  return (
    <>
      <MiniSelect
        id={id('instrument')}
        label="Instrument"
        value={expr.instrumentId}
        error={err('instrumentId')}
        onChange={(e) => onChange({ ...expr, instrumentId: e.target.value })}
      >
        {!known && <option value={expr.instrumentId}>Choose an instrument</option>}
        {instruments.map((i) => (
          <option key={i.id} value={i.id}>
            {i.symbol} · {i.displayName}
          </option>
        ))}
      </MiniSelect>
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
