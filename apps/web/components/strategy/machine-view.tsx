'use client';

import { ApiError, type StrategyDetailDto, type StrategyRunStateDto } from '@tm/contracts';
import type { MachineDefinition, StrategyDefinition, StrategyStatus } from '@tm/domain';
import { Alert, Button, Card, ModeBadge, Table, Td, Th } from '@tm/ui';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import {
  EditorContext,
  type AccountOption,
  type EditorContextValue,
  type InstrumentOption,
} from '@/components/strategy/editor-context';
import { ExecutionSection, useValidation } from '@/components/strategy/lifecycle';
import { PageSection } from '@/components/strategy/page-sections';
import { useRowVersion } from '@/components/strategy/row-version';
import { apiClient } from '@/lib/api-client';
import { describeMachineCondition } from '@/lib/strategy-text';

/** A run's machine state as the page gets it (ADR 0124 P3a). */
export interface MachineRunView {
  runtimeId: string;
  accountName: string;
  /** The state the run holds now, by its decisions so far. */
  currentStateId: string | null;
  since: string | null;
  lastDecidedOn: string | null;
  confirmed: boolean;
  proposal: {
    through: string;
    stateId: string;
    since: string;
    switches: number;
    legs: { symbol: string; side: 'buy' | 'sell'; quantity: string }[];
    equity: string;
  } | null;
  transitions: {
    seq: number;
    kind: 'start' | 'switch';
    decidedOn: string;
    fromStateId: string | null;
    toStateId: string;
    outcome: string;
    rounds: number;
    completedOn: string | null;
  }[];
}

const OUTCOME_TEXT: Record<string, string> = {
  rebalancing: 'Rebalancing',
  completed: 'Done',
  incomplete: 'Done, some legs short',
  stuck: 'Stuck: needs you',
  superseded: 'Replaced by a newer switch',
  switched_no_orders: 'Switched, nothing to trade',
};

/**
 * A state-machine strategy's page (ADR 0124 P3a): its states and rows read
 * only (the builder is P3b), the replay at Start with its Confirm button, the
 * run's transitions, and the usual Start and Stop.
 */
export function MachineView({
  strategyId,
  strategyName,
  status,
  run,
  runs,
  machine,
  carrier,
  machineRuns,
  instruments,
  accounts,
  timeZone,
  baseCurrency,
  history,
  initialRowVersion,
}: {
  initialRowVersion: number;
  strategyId: string;
  strategyName: string;
  status: StrategyStatus;
  run: StrategyRunStateDto | null;
  runs: readonly StrategyRunStateDto[];
  machine: MachineDefinition;
  carrier: StrategyDefinition;
  machineRuns: readonly MachineRunView[];
  instruments: readonly InstrumentOption[];
  accounts: readonly AccountOption[];
  timeZone: string;
  baseCurrency: string;
  history: ReactNode;
}) {
  const router = useRouter();
  const [rowVersion, setRowVersion] = useRowVersion(initialRowVersion);
  const { state: validation } = useValidation(strategyId, rowVersion);
  const symbols = useMemo(() => new Map(instruments.map((i) => [i.id, i.symbol])), [instruments]);
  const symbol = (id: string) => symbols.get(id);
  const stateNames = new Map(machine.machine.states.map((s) => [s.id, s.name]));
  const stateName = (id: string | null) => (id ? (stateNames.get(id) ?? '?') : '');
  const rowNumber = new Map(machine.machine.rows.map((r, i) => [r.id, `row ${i + 1}`]));

  const ctx: EditorContextValue = useMemo(
    () => ({
      instruments,
      accounts,
      timeZone,
      baseCurrency,
      issueAt: () => undefined,
      editable: false,
      slotMode: 'none',
      universeClasses: [],
    }),
    [instruments, accounts, timeZone, baseCurrency],
  );

  const risk = machine.risk;
  const riskLines = [
    risk.maxOrderPctEquity && `Largest order ${risk.maxOrderPctEquity}% of equity`,
    risk.maxStrategyPctEquity && `Largest holding ${risk.maxStrategyPctEquity}% of equity`,
    risk.maxActiveOrders && `At most ${risk.maxActiveOrders} working orders`,
    risk.dailyLossLimit && `Daily loss limit ${baseCurrency} ${risk.dailyLossLimit}`,
    risk.priceCollarPct && `Price collar ${risk.priceCollarPct}%`,
    risk.maxDrawdownPct && `Pause at a ${risk.maxDrawdownPct}% drawdown`,
  ].filter(Boolean) as string[];

  return (
    <EditorContext.Provider value={ctx}>
      <div className="space-y-10">
        <PageSection
          id="strategy"
          description="A state machine: at each daily close the rows are tested from the top, and the first true one decides the state. Editing comes with the builder."
        >
          <Card aria-labelledby="machine-states-heading">
            <h2 id="machine-states-heading" className="text-lg font-semibold">
              States
            </h2>
            <ul className="mt-2 space-y-1 text-sm">
              {machine.machine.states.map((s) => {
                const held = s.targets.reduce((n, t) => n + Number(t.weightPct), 0);
                return (
                  <li key={s.id}>
                    <span className="font-semibold">{s.name}</span>:{' '}
                    <span className="text-content">
                      {s.targets.length === 0
                        ? '100% cash'
                        : [
                            ...s.targets.map(
                              (t) => `${symbol(t.instrumentId) ?? '?'} ${t.weightPct}%`,
                            ),
                            ...(held < 100 ? [`cash ${+(100 - held).toFixed(4)}%`] : []),
                          ].join(', ')}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
          <Card aria-labelledby="machine-rows-heading">
            <h2 id="machine-rows-heading" className="text-lg font-semibold">
              Rows
            </h2>
            <Table label="State machine rows" sortable={false}>
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>When</Th>
                  <Th>Then</Th>
                </tr>
              </thead>
              <tbody>
                {machine.machine.rows.map((r, i) => (
                  <tr key={r.id}>
                    <Td>{i + 1}</Td>
                    <Td>
                      <span className="text-content">
                        {r.label && <span className="font-semibold">{r.label}: </span>}
                        {r.condition && r.condition.children.length > 0
                          ? describeMachineCondition(
                              r.condition,
                              symbol,
                              (id) => stateNames.get(id),
                              (id) => rowNumber.get(id) ?? '?',
                            )
                          : 'Always'}
                      </span>
                    </Td>
                    <Td>
                      {r.outcome.kind === 'stay' ? 'Stay' : `Go to ${stateName(r.outcome.stateId)}`}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card aria-labelledby="machine-risk-heading">
            <h2 id="machine-risk-heading" className="text-lg font-semibold">
              Risk
            </h2>
            <ul className="mt-2 list-disc pl-5 text-sm">
              {riskLines.length === 0 ? (
                <li>Account limits only</li>
              ) : (
                riskLines.map((l) => <li key={l}>{l}</li>)
              )}
              <li>No strategy trailing stop: the rows decide every exit.</li>
            </ul>
          </Card>
        </PageSection>
        <PageSection
          id="execution"
          badge={<ModeBadge mode="paper" />}
          description="Start replays the rows over the history first, with no orders. Nothing trades until you confirm."
        >
          {machineRuns.map((r) => (
            <MachineRunCard
              key={r.runtimeId}
              strategyId={strategyId}
              run={r}
              stateName={stateName}
              baseCurrency={baseCurrency}
              onConfirmed={() => router.refresh()}
            />
          ))}
          <ExecutionSection
            strategyId={strategyId}
            strategyName={strategyName}
            status={status}
            run={run}
            runs={runs}
            rowVersion={rowVersion}
            dirty={false}
            definition={carrier}
            validation={validation}
            latestText="Back tests of state machines come with the builder"
            draftTested="not_tested"
            onChanged={(detail: StrategyDetailDto) => {
              setRowVersion(detail.rowVersion);
              router.refresh();
            }}
            history={history}
          />
        </PageSection>
      </div>
    </EditorContext.Provider>
  );
}

function MachineRunCard({
  strategyId,
  run,
  stateName,
  baseCurrency,
  onConfirmed,
}: {
  strategyId: string;
  run: MachineRunView;
  stateName: (id: string | null) => string;
  baseCurrency: string;
  onConfirmed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.strategies.confirmMachineStart(strategyId, run.runtimeId);
      onConfirmed();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not confirm Start. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const headingId = `machine-run-${run.runtimeId}`;
  return (
    <Card aria-labelledby={headingId}>
      <h2 id={headingId} className="text-lg font-semibold">
        State on {run.accountName}
      </h2>
      {!run.proposal && !run.confirmed ? (
        <p className="mt-1 text-sm text-ink-muted">
          Replaying the rows over the history. This takes a minute after Start.
        </p>
      ) : (
        <p className="mt-1 text-sm">
          <span className="font-semibold">{stateName(run.currentStateId)}</span>
          {run.since && ` since ${run.since}`}
          {run.lastDecidedOn && (
            <span className="text-ink-muted"> · last close decided {run.lastDecidedOn}</span>
          )}
        </p>
      )}
      {run.proposal && !run.confirmed && (
        <div className="mt-3 space-y-2">
          <Alert tone="info">
            The replay through {run.proposal.through} ends in{' '}
            <strong>{stateName(run.proposal.stateId)}</strong> (since {run.proposal.since}, after{' '}
            {run.proposal.switches} {run.proposal.switches === 1 ? 'switch' : 'switches'}). No
            orders have been placed. Confirm to adopt this state and place its rebalance.
          </Alert>
          {run.proposal.legs.length === 0 ? (
            <p className="text-sm">Nothing to trade: the account already holds this state.</p>
          ) : (
            <ul className="list-disc pl-5 text-sm">
              {run.proposal.legs.map((l) => (
                <li key={`${l.side}-${l.symbol}`} className="text-content">
                  {l.side === 'buy' ? 'Buy' : 'Sell'} {l.quantity} {l.symbol}
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-ink-muted">
            Sized on equity of {baseCurrency} {run.proposal.equity}; sells go first, then buys.
          </p>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button onClick={confirm} disabled={busy}>
            {busy ? 'Confirming…' : 'Confirm Start'}
          </Button>
        </div>
      )}
      {run.transitions.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold">Transitions</h3>
          <Table label="State machine transitions" sortable={false}>
            <thead>
              <tr>
                <Th>Decided</Th>
                <Th>Change</Th>
                <Th>Outcome</Th>
                <Th>Rounds</Th>
              </tr>
            </thead>
            <tbody>
              {[...run.transitions].reverse().map((t) => (
                <tr key={t.seq}>
                  <Td>{t.decidedOn}</Td>
                  <Td>
                    {t.kind === 'start'
                      ? `Start in ${stateName(t.toStateId)}`
                      : `${stateName(t.fromStateId)} → ${stateName(t.toStateId)}`}
                  </Td>
                  <Td>
                    {OUTCOME_TEXT[t.outcome] ?? t.outcome}
                    {t.completedOn && ` (${t.completedOn})`}
                  </Td>
                  <Td>{t.rounds}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </Card>
  );
}
