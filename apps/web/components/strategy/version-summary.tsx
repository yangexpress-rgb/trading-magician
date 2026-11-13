import type { PhaseName, StrategyDefinition } from '@tm/domain';
import { Card } from '@tm/ui';
import {
  describeCondition,
  describeLeg,
  describeTiming,
  LEG_FAILURE_LABELS,
  MARKET_HOURS_LABELS,
  MULTI_LEG_LABELS,
  RISK_FIELDS,
  describeTrigger,
} from '@/lib/strategy-text';

const PHASE_TITLE: Record<PhaseName, string> = { entry: 'Entry', exit: 'Exit' };

/** Label–value rows: muted label, value as content (brief v2.2 D3, N128). */
function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[12rem_1fr] sm:items-baseline">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-sm text-ink-muted">{term}</dt>
          <dd className="text-base text-content">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Read-only text rendering of a saved strategy version (§6.2). */
export function VersionSummary({
  definition,
  symbols,
  accounts,
  baseCurrency,
}: {
  definition: StrategyDefinition;
  symbols: ReadonlyMap<string, string>;
  accounts: ReadonlyMap<string, string>;
  baseCurrency: string;
}) {
  const symbol = (id: string) => symbols.get(id);
  const legs = [...definition.entry.orders, ...definition.exit.orders];
  const labelOf = (id: string) => legs.find((l) => l.id === id)?.legLabel;
  const ex = definition.execution;

  return (
    <div className="space-y-6">
      {(['entry', 'exit'] as const).map((phase) => {
        const p = definition[phase];
        return (
          <Card key={phase} aria-labelledby={`${phase}-heading`}>
            <h2 id={`${phase}-heading`} className="text-lg font-semibold">
              {PHASE_TITLE[phase]}
            </h2>
            <p className="mt-3 max-w-prose text-base">
              <span className="text-sm text-ink-muted">Qualifies when: </span>
              <span className="text-prose">{describeCondition(p.condition, symbol)}</span>
            </p>
            <p className="mt-2 max-w-prose text-base">
              <span className="text-sm text-ink-muted">Fires: </span>
              <span className="text-prose">{describeTrigger(p.trigger)}</span>
            </p>
            {p.orders.length === 0 ? (
              <p className="mt-3 text-sm text-ink-muted">No orders.</p>
            ) : (
              <ol className="mt-3 space-y-2">
                {p.orders.map((o) => (
                  <li key={o.id} className="rounded-md border border-line p-3 text-sm">
                    <p className="font-medium">{o.legLabel}</p>
                    <p className="text-base text-prose">
                      {describeLeg(o, symbol, baseCurrency, definition.entry.risk)}
                    </p>
                    <p className="text-ink-muted">
                      {accounts.get(o.accountId) ?? 'Unknown account'} · Timing:{' '}
                      {describeTiming(o, labelOf, ex.timingOnly)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        );
      })}
      <Card aria-labelledby="order-handling-heading">
        <h2 id="order-handling-heading" className="mb-3 text-lg font-semibold">
          Order handling
        </h2>
        <Rows
          rows={[
            ['Send legs', MULTI_LEG_LABELS[ex.multiLegPolicy]],
            ...(ex.multiLegPolicy !== 'concurrent' && ex.legOrder
              ? [
                  [
                    'Submission order',
                    ex.legOrder.map((id) => labelOf(id) ?? 'removed leg').join(', '),
                  ] as [string, string],
                ]
              : []),
            ['Leg timeout', `${ex.legTimeoutSec} seconds`],
            ['If a leg fails', LEG_FAILURE_LABELS[ex.onLegFailure]],
            ['When the market is closed', MARKET_HOURS_LABELS[ex.marketHoursPolicy]],
            ['Holiday calendar', ex.holidayCalendar],
            ['Stale data after', `${ex.staleDataSec} seconds`],
            ['Flatten at session end', ex.flattenAtSessionEnd ? 'On' : 'Off'],
          ]}
        />
      </Card>
      <Card aria-labelledby="risk-heading">
        <h2 id="risk-heading" className="mb-3 text-lg font-semibold">
          Risk limits
        </h2>
        <Rows
          rows={RISK_FIELDS.map(({ key, label, unit }) => {
            const v = definition.risk[key];
            if (v === undefined) return [label, 'Not set'];
            return [
              label,
              unit === 'money' ? `${baseCurrency} ${v}` : unit === 'pct' ? `${v}%` : String(v),
            ];
          })}
        />
      </Card>
    </div>
  );
}
