'use client';

import {
  REQUIRED_RISK_LIMITS,
  TRIGGER_MODES,
  type ExecutionPolicy,
  type Phase,
  type PhaseName,
  type RiskProfile,
  type StrategyDefinition,
} from '@tm/domain';
import { Card } from '@tm/ui';
import { RISK_FIELDS, TRIGGER_LABELS } from '@/lib/strategy-text';
import { useEditor } from './editor-context';
import { MiniInput, MiniSelect, RowButton } from './fields';
import { ScheduleField } from './slots-editor';

const intOrNaN = (v: string) => (v === '' ? Number.NaN : Number(v));

/** Trigger mode and debounce for one phase (§6.5), behind a disclosure. */
export function TriggerSettings({
  phase,
  value,
  onChange,
}: {
  phase: PhaseName;
  value: Phase['trigger'];
  onChange: (trigger: Phase['trigger']) => void;
}) {
  const { issueAt, editable } = useEditor();
  const err = (k: string) => issueAt([phase, 'trigger', k]);
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm font-medium">Trigger options</summary>
      <fieldset disabled={!editable} className="mt-2 grid-fields-wide gap-2">
        <legend className="sr-only">{phase === 'entry' ? 'Entry' : 'Exit'} trigger options</legend>
        <MiniSelect
          id={`${phase}-trigger-mode`}
          label="Fire"
          value={value.mode}
          onChange={(e) => onChange({ ...value, mode: e.target.value as Phase['trigger']['mode'] })}
        >
          {TRIGGER_MODES.map((m) => (
            <option key={m} value={m}>
              {TRIGGER_LABELS[m]}
            </option>
          ))}
        </MiniSelect>
        <MiniInput
          id={`${phase}-trigger-cooldown`}
          label="Cooldown (seconds)"
          type="number"
          min={0}
          step={1}
          value={Number.isFinite(value.cooldownSec) ? String(value.cooldownSec) : ''}
          error={err('cooldownSec')}
          onChange={(e) => onChange({ ...value, cooldownSec: intOrNaN(e.target.value) })}
        />
        <MiniInput
          id={`${phase}-trigger-confirm`}
          label="Confirmation bars"
          type="number"
          min={0}
          step={1}
          value={Number.isFinite(value.confirmationBars) ? String(value.confirmationBars) : ''}
          error={err('confirmationBars')}
          onChange={(e) => onChange({ ...value, confirmationBars: intOrNaN(e.target.value) })}
        />
      </fieldset>
    </details>
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
      <Card aria-labelledby="execution-heading">
        <h2 id="execution-heading" className="text-lg font-semibold">
          Execution
        </h2>
        <p className="mb-3 text-sm text-ink-muted">
          How legs are sent and what happens when one doesn&rsquo;t fill. Brokers rarely fill
          several instruments as one atomic order.
        </p>
        <ScheduleField definition={definition} onChange={onChange} />
        <fieldset disabled={!editable} className="grid-fields-wide gap-3">
          <legend className="sr-only">Execution policy</legend>
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
          Checked before every order. Limits marked required must be set before the strategy can
          start. Amounts are in {baseCurrency}.
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
