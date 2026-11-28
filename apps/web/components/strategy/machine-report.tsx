'use client';

import type { MachineDefinition, MachineCondition } from '@tm/domain';
import { Table, Td, Th } from '@tm/ui';
import { Signed } from '@/components/signed';
import { Truth } from '@/components/strategy/backtest-detail';
import { formatSignedMoney } from '@/lib/backtest-text';
import { describeMachineCondition } from '@/lib/strategy-text';

/**
 * State-stay reporting for a state machine (state-machine brief v1.4 §2.6, §5;
 * ADR 0124 P3b): time and return in each state, each stay, and the transitions
 * with the deciding row's Why lines. Shared by back test results, the run view
 * and Performance.
 */

export interface StayRow {
  stateId: string;
  from: string;
  to: string;
  sessions: number;
  /** Equity change over the stay, in %; null when it can't be valued. */
  returnPct: string | null;
  /** On paper: the strategy's P/L over the stay in dollars (O269); absent in back tests. */
  pnl?: string | null | undefined;
  ongoing: boolean;
}

export interface WhyCheck {
  id: string;
  truth: boolean | null;
  left?: string | null;
  right?: string | null;
  upper?: string | null;
}

export interface TransitionRow {
  key: string | number;
  kind: 'start' | 'switch';
  on: string;
  fromStateId: string | null;
  toStateId: string;
  rowId: string | null;
  why: readonly WhyCheck[];
  outcome: string;
  attempts: number;
  completedOn?: string | null | undefined;
}

export const OUTCOME_TEXT: Record<string, string> = {
  rebalancing: 'Rebalancing',
  completed: 'Done',
  done: 'Done',
  incomplete: 'Not finished yet',
  stuck: 'Stuck: needs you',
  superseded: 'Replaced by a newer switch',
  switched_no_orders: 'Switched, nothing to trade',
};

type Names = (stateId: string | null) => string;

/** Each state's total: stays, sessions, share of the run and compounded return. */
export function stateTotals(stays: readonly StayRow[]) {
  const by = new Map<
    string,
    { stays: number; sessions: number; growth: number; valued: boolean; pnl: number | null }
  >();
  for (const s of stays) {
    const t = by.get(s.stateId) ?? { stays: 0, sessions: 0, growth: 1, valued: true, pnl: null };
    t.stays++;
    t.sessions += s.sessions;
    if (s.pnl !== undefined && s.pnl !== null) t.pnl = (t.pnl ?? 0) + Number(s.pnl);
    if (s.returnPct === null) t.valued = false;
    else t.growth *= 1 + Number(s.returnPct) / 100;
    by.set(s.stateId, t);
  }
  const total = [...by.values()].reduce((n, t) => n + t.sessions, 0);
  return [...by.entries()].map(([stateId, t]) => ({
    stateId,
    stays: t.stays,
    sessions: t.sessions,
    sharePct: total > 0 ? (100 * t.sessions) / total : 0,
    returnPct: t.valued ? ((t.growth - 1) * 100).toFixed(2) : null,
    pnl: t.pnl === null ? null : t.pnl.toFixed(2),
  }));
}

const pct = (v: string | null) =>
  v === null ? '—' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`;

/** Whether the stays carry dollar P/L (paper) rather than equity return (back test). */
const isPaper = (stays: readonly StayRow[]) => stays.some((s) => s.pnl !== undefined);

function StayFigure({
  row,
  paper,
}: {
  row: { returnPct: string | null; pnl?: string | null | undefined };
  paper: boolean;
}) {
  const v = paper ? (row.pnl ?? null) : row.returnPct;
  if (v === null) return <>—</>;
  return <Signed value={v}>{paper ? formatSignedMoney(v) : pct(v)}</Signed>;
}

export function StateTotals({ stays, name }: { stays: readonly StayRow[]; name: Names }) {
  const totals = stateTotals(stays);
  const paper = isPaper(stays);
  if (totals.length === 0)
    return <p className="text-sm text-ink-muted">No days in any state yet.</p>;
  return (
    <Table label="Time in each state">
      <thead>
        <tr>
          <Th>State</Th>
          <Th numeric>Stays</Th>
          <Th numeric>Days</Th>
          <Th numeric>Share of days</Th>
          <Th numeric>{paper ? 'P/L in state' : 'Return in state'}</Th>
        </tr>
      </thead>
      <tbody>
        {totals.map((t) => (
          <tr key={t.stateId}>
            <Td className="font-medium">{name(t.stateId)}</Td>
            <Td numeric>{t.stays}</Td>
            <Td numeric>{t.sessions}</Td>
            <Td numeric>{t.sharePct.toFixed(1)}%</Td>
            <Td numeric sortValue={(paper ? t.pnl : t.returnPct) ?? ''}>
              <StayFigure row={t} paper={paper} />
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function StaysTable({ stays, name }: { stays: readonly StayRow[]; name: Names }) {
  const paper = isPaper(stays);
  return (
    <Table label="State stays" sortable={false}>
      <thead>
        <tr>
          <Th>State</Th>
          <Th>From</Th>
          <Th>To</Th>
          <Th numeric>Days</Th>
          <Th numeric>{paper ? 'P/L' : 'Return'}</Th>
        </tr>
      </thead>
      <tbody>
        {[...stays].reverse().map((s) => (
          <tr key={`${s.stateId}-${s.from}`}>
            <Td className="font-medium">{name(s.stateId)}</Td>
            <Td>{s.from}</Td>
            <Td>{s.ongoing ? `${s.to} (still in it)` : s.to}</Td>
            <Td numeric>{s.sessions}</Td>
            <Td numeric>
              <StayFigure row={s} paper={paper} />
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** The deciding row's checks, each with its words and the values it compared. */
export function WhyLines({
  machine,
  rowId,
  why,
  symbol,
}: {
  machine: MachineDefinition | null;
  rowId: string | null;
  why: readonly WhyCheck[];
  symbol: (id: string) => string | undefined;
}) {
  const row = machine?.machine.rows.find((r) => r.id === rowId);
  const index = machine?.machine.rows.findIndex((r) => r.id === rowId) ?? -1;
  if (!rowId) return <p className="text-sm text-ink-muted">The run's start: no row decided it.</p>;
  const stateName = (id: string) => machine?.machine.states.find((s) => s.id === id)?.name;
  const rowName = (id: string) => {
    const i = machine?.machine.rows.findIndex((r) => r.id === id) ?? -1;
    return i >= 0 ? `row ${i + 1}` : '?';
  };
  const nodes = new Map<string, MachineCondition>();
  const walk = (n: MachineCondition) => {
    nodes.set(n.id, n);
    if (n.kind === 'group') n.children.forEach(walk);
  };
  if (row?.condition) walk(row.condition);
  return (
    <div className="space-y-1 text-sm">
      <p>
        Decided by <span className="font-semibold">row {index >= 0 ? index + 1 : '?'}</span>
        {row?.label ? ` (${row.label})` : ''}
        {!row?.condition || row.condition.children.length === 0 ? ': always true' : ''}
      </p>
      {why.length > 0 && (
        <ul className="space-y-1">
          {why.map((c) => {
            const node = nodes.get(c.id);
            const values = [c.left, c.right, c.upper].filter((v) => v !== undefined);
            return (
              <li key={c.id} className="flex flex-wrap items-baseline gap-2">
                <Truth value={c.truth} />
                <span className="text-content">
                  {node ? describeMachineCondition(node, symbol, stateName, rowName) : c.id}
                </span>
                {values.length > 0 && (
                  <span className="text-ink-muted">
                    ({values.map((v) => v ?? 'unknown').join(' vs ')})
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function TransitionsTable({
  transitions,
  name,
  machine,
  symbol,
  label = 'State transitions',
}: {
  transitions: readonly TransitionRow[];
  name: Names;
  machine: MachineDefinition | null;
  symbol: (id: string) => string | undefined;
  label?: string;
}) {
  return (
    <Table label={label} sortable={false}>
      <thead>
        <tr>
          <Th>Decided</Th>
          <Th>Change</Th>
          <Th>Outcome</Th>
          <Th numeric>Attempts</Th>
          <Th>Why</Th>
        </tr>
      </thead>
      <tbody>
        {[...transitions].reverse().map((t) => (
          <tr key={t.key}>
            <Td>{t.on}</Td>
            <Td>
              {t.kind === 'start'
                ? `Start in ${name(t.toStateId)}`
                : `${name(t.fromStateId)} → ${name(t.toStateId)}`}
            </Td>
            <Td>
              {OUTCOME_TEXT[t.outcome] ?? t.outcome}
              {t.completedOn ? ` (${t.completedOn})` : ''}
            </Td>
            <Td numeric>{t.attempts}</Td>
            <Td>
              {t.kind === 'start' ? (
                <span className="text-sm text-ink-muted">Replayed state</span>
              ) : (
                <details>
                  <summary className="cursor-pointer text-sm">Why</summary>
                  <div className="mt-1">
                    <WhyLines machine={machine} rowId={t.rowId} why={t.why} symbol={symbol} />
                  </div>
                </details>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
