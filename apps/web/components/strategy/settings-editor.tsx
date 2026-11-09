'use client';

import {
  REQUIRED_RISK_LIMITS,
  slotModeOf,
  type ExecutionPolicy,
  type PhaseName,
  type RiskProfile,
  type StrategyDefinition,
  type Trigger,
} from '@tm/domain';
import { Card } from '@tm/ui';
import { RISK_FIELDS } from '@/lib/strategy-text';
import { useEditor } from './editor-context';
import { MiniInput, MiniSelect, RowButton } from './fields';

const intOrNaN = (v: string) => (v === '' ? Number.NaN : Number(v));

type FireWhen = 'becomes_true' | 'after_bars' | 'while_true' | 'once_per_cycle';

const FIRE_WHEN_LABELS: Record<FireWhen, string> = {
  becomes_true: 'As soon as it becomes true (default)',
  after_bars: 'After it has been true for N bars',
  while_true: 'Repeatedly while true',
  once_per_cycle: 'Once per cycle, when it becomes true',
};

const fireWhenOf = (t: Trigger): FireWhen =>
  t.mode === 'on_transition' ? (t.confirmationBars > 0 ? 'after_bars' : 'becomes_true') : t.mode;

/**
 * When a phase fires (§6.5, ADR 0049): one "Fire when" choice for the trigger
 * mode and confirmation together, and a cooldown counted in bars.
 */
export function TriggerSettings({
  phase,
  value,
  onChange,
  idPrefix = '',
}: {
  phase: PhaseName;
  value: Trigger;
  onChange: (trigger: Trigger) => void;
  /** Keeps ids unique when several entry groups are shown (v1.2 item 8). */
  idPrefix?: string;
}) {
  const { issueAt, editable } = useEditor();
  const err = (k: string) => issueAt([phase, 'trigger', k]);
  const when = fireWhenOf(value);
  const showBars = when === 'after_bars' || value.confirmationBars > 0;
  return (
    <fieldset disabled={!editable} className="mt-3 grid-fields-wide gap-2">
      <legend className="sr-only">{phase === 'entry' ? 'Entry' : 'Exit'} trigger</legend>
      <MiniSelect
        id={`${idPrefix}${phase}-trigger-mode`}
        label="Fire when"
        value={when}
        error={err('confirmationBars')}
        onChange={(e) => {
          const next = e.target.value as FireWhen;
          onChange(
            next === 'becomes_true'
              ? { ...value, mode: 'on_transition', confirmationBars: 0 }
              : next === 'after_bars'
                ? {
                    ...value,
                    mode: 'on_transition',
                    confirmationBars: Math.max(1, value.confirmationBars),
                  }
                : { ...value, mode: next, confirmationBars: 0 },
          );
        }}
      >
        {(Object.keys(FIRE_WHEN_LABELS) as FireWhen[]).map((m) => (
          <option key={m} value={m}>
            {FIRE_WHEN_LABELS[m]}
          </option>
        ))}
      </MiniSelect>
      {showBars && (
        <MiniInput
          id={`${idPrefix}${phase}-trigger-confirm`}
          label="N: bars true in a row"
          type="number"
          min={when === 'after_bars' ? 2 : 1}
          step={1}
          value={Number.isFinite(value.confirmationBars) ? String(value.confirmationBars + 1) : ''}
          onChange={(e) =>
            onChange({
              ...value,
              confirmationBars:
                e.target.value === '' ? Number.NaN : Math.max(0, Number(e.target.value) - 1),
            })
          }
        />
      )}
      <MiniInput
        id={`${idPrefix}${phase}-trigger-cooldown`}
        label="Then wait (bars) before firing again"
        type="number"
        min={0}
        step={1}
        value={Number.isFinite(value.cooldownBars) ? String(value.cooldownBars) : ''}
        error={err('cooldownBars')}
        onChange={(e) => onChange({ ...value, cooldownBars: intOrNaN(e.target.value) })}
      />
    </fieldset>
  );
}

/** Execution policy (§6.7, §6.9) and risk limits (§6.10). Advanced fields sit in disclosures. */
export function ExecutionAndRisk({
  definition,
  onChange,
}: {
  definition: StrategyDefinition;
  onChange: (def: StrategyDefinition) => void;
}) {
  const { issueAt, editable, baseCurrency } = useEditor();
  const ex = definition.execution;
  const risk = definition.risk;
  const setEx = (patch: Partial<ExecutionPolicy>) =>
    onChange({ ...definition, execution: { ...ex, ...patch } });
  const legs = [...definition.entry.orders, ...definition.exit.orders];
  const required = new Set<string>(REQUIRED_RISK_LIMITS);
  // The leg timeout applies only when a phase sends several legs (ADR 0049).
  const phases = [definition, ...(definition.groups ?? [])];
  const multiLeg =
    slotModeOf(definition) === 'none' &&
    phases.some((p) => p.entry.orders.length > 1 || p.exit.orders.length > 1);
  const slots = slotModeOf(definition) !== 'none';

  const order = ex.legOrder ?? legs.map((l) => l.id);
  const moveLeg = (i: number, delta: -1 | 1) => {
    const next = [...order];
    const [id] = next.splice(i, 1);
    if (id === undefined) return;
    next.splice(i + delta, 0, id);
    setEx({ legOrder: next });
  };

  return (
    <>
      <Card aria-labelledby="order-handling-heading">
        <h2 id="order-handling-heading" className="scroll-mt-16 text-lg font-semibold">
          Order handling
        </h2>
        <p className="mb-3 text-sm text-ink-muted">
          How legs are sent and what happens when one doesn&rsquo;t fill. Brokers rarely fill
          several instruments as one atomic order. Back tests use these settings too.
        </p>
        <fieldset disabled={!editable} className="grid-fields-wide gap-3">
          <legend className="sr-only">Order handling</legend>
          <MiniSelect
            id="exec-policy"
            label="Send legs"
            value={ex.multiLegPolicy}
            onChange={(e) => {
              const multiLegPolicy = e.target.value as ExecutionPolicy['multiLegPolicy'];
              setEx({
                multiLegPolicy,
                ...(multiLegPolicy !== 'concurrent' && !ex.legOrder
                  ? { legOrder: legs.map((l) => l.id) }
                  : {}),
              });
            }}
          >
            <option value="concurrent">All at once</option>
            <option value="sequential">One after another, in order</option>
            <option value="after_prior_fill">Next leg only after the previous one fills</option>
          </MiniSelect>
          {multiLeg && (
            <MiniInput
              id="exec-timeout"
              label="Leg timeout (seconds)"
              type="number"
              min={1}
              step={1}
              value={Number.isFinite(ex.legTimeoutSec) ? String(ex.legTimeoutSec) : ''}
              error={issueAt(['execution', 'legTimeoutSec'])}
              onChange={(e) => setEx({ legTimeoutSec: intOrNaN(e.target.value) })}
            />
          )}
          <MiniSelect
            id="exec-failure"
            label="If a leg fails or times out"
            value={ex.onLegFailure}
            onChange={(e) =>
              setEx({ onLegFailure: e.target.value as ExecutionPolicy['onLegFailure'] })
            }
          >
            <option value="cancel_remaining">Cancel the remaining legs</option>
            <option value="flatten_filled">Cancel the rest and close filled legs</option>
            <option value="leave_and_alert">Leave orders as they are and alert me</option>
          </MiniSelect>
          <MiniSelect
            id="exec-market-hours"
            label="When the market is closed"
            value={ex.marketHoursPolicy}
            onChange={(e) =>
              setEx({ marketHoursPolicy: e.target.value as ExecutionPolicy['marketHoursPolicy'] })
            }
          >
            <option value="queue">Queue until the next regular session</option>
            <option value="cancel">Cancel the order</option>
            <option value="extended_if_supported">Send in extended hours if allowed</option>
          </MiniSelect>
          <MiniSelect
            id="exec-calendar"
            label="Holiday calendar"
            value={ex.holidayCalendar}
            disabled
          >
            <option value="NYSE">NYSE</option>
          </MiniSelect>
        </fieldset>

        {(!slots || ex.timingOnly) && (
          <div className="mt-3">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                disabled={!editable}
                checked={ex.timingOnly === true}
                aria-describedby="exec-timing-only-help"
                onChange={(e) => {
                  const { timingOnly: _t, ...rest } = ex;
                  void _t;
                  onChange({
                    ...definition,
                    execution: e.target.checked ? { ...rest, timingOnly: true } : rest,
                  });
                }}
              />
              Allow timed entries without conditions
            </label>
            {issueAt(['execution', 'timingOnly']) && (
              <p className="text-xs font-medium text-danger">
                {issueAt(['execution', 'timingOnly'])}
              </p>
            )}
            <p id="exec-timing-only-help" className="mt-1 text-xs text-ink-muted">
              On: a leg timed for an exact date or after a delay goes on its timing alone, without
              waiting for its phase&rsquo;s conditions, and an Entry leg at an exact time opens a
              cycle by itself. Off: timed legs also wait for the conditions.
            </p>
          </div>
        )}

        {ex.multiLegPolicy !== 'concurrent' && (
          <div className="mt-3">
            <h3 className="text-sm font-semibold">Submission order</h3>
            {issueAt(['execution', 'legOrder']) && (
              <p className="text-xs font-medium text-danger">
                {issueAt(['execution', 'legOrder'])}
              </p>
            )}
            <ol className="mt-1 space-y-1 text-sm">
              {order.map((legId, i) => (
                <li key={legId} className="flex items-center gap-2">
                  <span className="w-6 text-ink-muted">{i + 1}.</span>
                  <span className="flex-1">
                    {legs.find((l) => l.id === legId)?.legLabel ?? 'Removed leg'}
                  </span>
                  {editable && (
                    <>
                      <RowButton
                        label={`Send ${legs.find((l) => l.id === legId)?.legLabel ?? 'leg'} earlier`}
                        disabled={i === 0}
                        onClick={() => moveLeg(i, -1)}
                      >
                        ↑
                      </RowButton>
                      <RowButton
                        label={`Send ${legs.find((l) => l.id === legId)?.legLabel ?? 'leg'} later`}
                        disabled={i === order.length - 1}
                        onClick={() => moveLeg(i, 1)}
                      >
                        ↓
                      </RowButton>
                    </>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}

        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium">Cycle and data options</summary>
          <fieldset disabled={!editable} className="mt-2 grid-fields-wide gap-3">
            <legend className="sr-only">Cycle and data options</legend>
            <MiniSelect
              id="exec-milestone"
              label="Start Exit monitoring after"
              value={ex.entryMilestone}
              onChange={(e) =>
                setEx({ entryMilestone: e.target.value as ExecutionPolicy['entryMilestone'] })
              }
            >
              <option value="full_fill">Entry fully fills (default)</option>
              <option value="partial_fill">Entry partially fills</option>
            </MiniSelect>
            <MiniSelect
              id="exec-reentry"
              label="Re-entry"
              value={ex.reentry.mode}
              onChange={(e) => {
                const mode = e.target.value as ExecutionPolicy['reentry']['mode'];
                setEx({
                  reentry: mode === 'pyramid' ? { mode, cap: ex.reentry.cap ?? 2 } : { mode },
                });
              }}
            >
              <option value="single_cycle">One open cycle at a time (default)</option>
              <option value="pyramid">Add to the position, up to a cap</option>
              <option value="independent_cycles">Independent cycles</option>
            </MiniSelect>
            {ex.reentry.mode === 'pyramid' && (
              <MiniInput
                id="exec-cap"
                label="Maximum entries"
                type="number"
                min={1}
                step={1}
                value={ex.reentry.cap === undefined ? '' : String(ex.reentry.cap)}
                error={issueAt(['execution', 'reentry', 'cap'])}
                onChange={(e) =>
                  setEx({
                    reentry: e.target.value
                      ? { mode: 'pyramid', cap: Number(e.target.value) }
                      : { mode: 'pyramid' },
                  })
                }
              />
            )}
            <MiniInput
              id="exec-stale"
              label="Treat data as stale after (seconds)"
              type="number"
              min={1}
              step={1}
              value={Number.isFinite(ex.staleDataSec) ? String(ex.staleDataSec) : ''}
              error={issueAt(['execution', 'staleDataSec'])}
              onChange={(e) => setEx({ staleDataSec: intOrNaN(e.target.value) })}
            />
          </fieldset>
        </details>
      </Card>

      <Card aria-labelledby="risk-heading">
        <h2 id="risk-heading" className="text-lg font-semibold">
          Risk limits
        </h2>
        <p className="mb-3 text-sm text-ink-muted">
          Checked before every order, in back tests and on paper. Limits marked required must be set
          before the strategy can start. Amounts are in {baseCurrency}.
        </p>
        <fieldset disabled={!editable} className="grid-fields-wide gap-3">
          <legend className="sr-only">Risk limits</legend>
          {RISK_FIELDS.map(({ key, label, unit }) => {
            const value = risk[key];
            const suffix = unit === 'money' ? ` (${baseCurrency})` : unit === 'pct' ? ' (%)' : '';
            return (
              <MiniInput
                key={key}
                id={`risk-${key}`}
                label={`${label}${suffix}${required.has(key) ? ' · required' : ''}`}
                inputMode={unit === 'count' ? 'numeric' : 'decimal'}
                value={value === undefined ? '' : String(value)}
                error={issueAt(['risk', key])}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const rest = Object.fromEntries(
                    Object.entries(risk).filter(([k]) => k !== key),
                  ) as Record<string, unknown>;
                  const next =
                    raw === '' ? rest : { ...rest, [key]: unit === 'count' ? Number(raw) : raw };
                  onChange({ ...definition, risk: next as RiskProfile });
                }}
              />
            );
          })}
        </fieldset>
      </Card>
    </>
  );
}
