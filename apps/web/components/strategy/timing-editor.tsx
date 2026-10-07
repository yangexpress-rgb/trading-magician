'use client';

import {
  isoToZonedWallTime,
  LEG_EVENTS,
  PHASE_EVENTS,
  RELATIVE_UNITS,
  zonedWallTimeToIso,
  type PhaseName,
  type PlannedOrder,
  type Timing,
} from '@tm/domain';
import { useMemo } from 'react';
import { LEG_EVENT_LABELS, PHASE_EVENT_LABELS, UNIT_LABELS } from '@/lib/strategy-text';
import { useEditor } from './editor-context';
import { MiniInput, MiniSelect } from './fields';

type Path = readonly (string | number)[];

const MODES = [
  { mode: 'immediate', label: 'Immediately' },
  { mode: 'exact', label: 'At an exact date and time' },
  { mode: 'relative', label: 'After a delay' },
] as const;

function zoneList(current: string[]): string[] {
  const all =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
  return [...new Set([...current, ...all])];
}

/** Planned-order timing (Design v1.0 §6.8): immediate, exact zoned time, or relative delay. */
export function TimingEditor({
  order,
  phase,
  legs,
  path,
  onChange,
}: {
  order: PlannedOrder;
  phase: PhaseName;
  /** Every other leg in the strategy, as reference choices. */
  legs: { id: string; label: string; phase: PhaseName }[];
  path: Path;
  onChange: (patch: Pick<PlannedOrder, 'timing' | 'timingOnly'>) => void;
}) {
  const { timeZone, issueAt, editable } = useEditor();
  const t = order.timing;
  const id = (f: string) => `${order.id}-timing-${f}`;
  const err = (...rest: (string | number)[]) => issueAt([...path, ...rest]);
  const zones = useMemo(
    () => zoneList([timeZone, ...(t.mode === 'exact' ? [t.zone] : [])]),
    [timeZone, t],
  );

  const setMode = (mode: Timing['mode']) => {
    if (mode === t.mode) return;
    const timing: Timing =
      mode === 'immediate'
        ? { mode }
        : mode === 'exact'
          ? { mode, at: '', zone: timeZone }
          : {
              mode,
              amount: 5,
              unit: 'min',
              reference: {
                kind: 'phase',
                event: phase === 'entry' ? 'entry_trigger' : 'entry_submitted',
              },
            };
    onChange({ timing, timingOnly: order.timingOnly });
  };

  return (
    <fieldset className="min-w-0 rounded-md border border-line p-2" disabled={!editable}>
      <legend className="px-1 text-xs font-semibold">Timing</legend>
      <div
        className="flex flex-wrap gap-x-4 gap-y-1"
        role="radiogroup"
        aria-label="When this order becomes eligible"
      >
        {MODES.map((m) => (
          <label key={m.mode} className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name={id('mode')}
              value={m.mode}
              checked={t.mode === m.mode}
              onChange={() => setMode(m.mode)}
            />
            {m.label}
          </label>
        ))}
      </div>

      {t.mode === 'exact' && (
        <div className="mt-2 grid-fields-wide gap-2">
          <MiniInput
            id={id('at')}
            label="Date and time"
            type="datetime-local"
            value={(t.at && isoToZonedWallTime(t.at, t.zone)) || ''}
            error={err('timing', 'at')}
            onChange={(e) =>
              onChange({
                timing: { ...t, at: zonedWallTimeToIso(e.target.value, t.zone) ?? e.target.value },
                timingOnly: order.timingOnly,
              })
            }
          />
          <MiniSelect
            id={id('zone')}
            label="Time zone"
            value={t.zone}
            error={err('timing', 'zone')}
            onChange={(e) => {
              // Keep the same wall-clock time in the newly chosen zone.
              const local = t.at ? isoToZonedWallTime(t.at, t.zone) : undefined;
              const zone = e.target.value;
              onChange({
                timing: { ...t, zone, at: (local && zonedWallTimeToIso(local, zone)) || t.at },
                timingOnly: order.timingOnly,
              });
            }}
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </MiniSelect>
        </div>
      )}

      {t.mode === 'relative' && (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-[6rem_8rem_1fr]">
          <MiniInput
            id={id('amount')}
            label="Wait"
            type="number"
            min={0}
            step="any"
            value={Number.isFinite(t.amount) ? String(t.amount) : ''}
            error={err('timing', 'amount')}
            onChange={(e) =>
              onChange({
                timing: {
                  ...t,
                  amount: e.target.value === '' ? Number.NaN : Number(e.target.value),
                },
                timingOnly: order.timingOnly,
              })
            }
          />
          <MiniSelect
            id={id('unit')}
            label="Unit"
            value={t.unit}
            onChange={(e) =>
              onChange({
                timing: { ...t, unit: e.target.value as typeof t.unit },
                timingOnly: order.timingOnly,
              })
            }
          >
            {RELATIVE_UNITS.map((u) => (
              <option key={u} value={u}>
                {UNIT_LABELS[u]}
              </option>
            ))}
          </MiniSelect>
          <MiniSelect
            id={id('reference')}
            label="After"
            className="col-span-2 sm:col-span-1"
            value={
              t.reference.kind === 'phase'
                ? `phase:${t.reference.event}`
                : `leg:${t.reference.legId}:${t.reference.event}`
            }
            error={err('timing')}
            onChange={(e) => {
              const [kind, a, b] = e.target.value.split(':');
              const reference =
                kind === 'phase'
                  ? { kind: 'phase' as const, event: a as (typeof PHASE_EVENTS)[number] }
                  : {
                      kind: 'leg' as const,
                      legId: a ?? '',
                      event: b as (typeof LEG_EVENTS)[number],
                    };
              onChange({ timing: { ...t, reference }, timingOnly: order.timingOnly });
            }}
          >
            <optgroup label="Strategy events">
              {PHASE_EVENTS.map((ev) => (
                <option key={ev} value={`phase:${ev}`}>
                  {PHASE_EVENT_LABELS[ev]}
                </option>
              ))}
            </optgroup>
            {legs.length > 0 && (
              <optgroup label="Another leg">
                {legs.flatMap((l) =>
                  LEG_EVENTS.map((ev) => (
                    <option key={`${l.id}:${ev}`} value={`leg:${l.id}:${ev}`}>
                      {l.label} ({l.phase === 'entry' ? 'Entry' : 'Exit'}) {LEG_EVENT_LABELS[ev]}
                    </option>
                  )),
                )}
              </optgroup>
            )}
            {t.reference.kind === 'leg' &&
              !legs.some((l) => l.id === (t.reference as { legId: string }).legId) && (
                <option value={`leg:${t.reference.legId}:${t.reference.event}`}>
                  A removed leg
                </option>
              )}
          </MiniSelect>
        </div>
      )}

      {t.mode !== 'immediate' && (
        <label className="mt-2 flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={order.timingOnly}
            onChange={(e) => onChange({ timing: t, timingOnly: e.target.checked })}
          />
          Timing only: don&rsquo;t also wait for the {phase === 'entry' ? 'Entry' : 'Exit'}{' '}
          conditions
        </label>
      )}
    </fieldset>
  );
}
