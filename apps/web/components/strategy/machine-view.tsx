'use client';

import { ApiError, type StrategyDetailDto, type StrategyRunStateDto } from '@tm/contracts';
import type { MachineDefinition, StrategyDefinition, StrategyStatus } from '@tm/domain';
import { Alert, Button, Card, ModeBadge } from '@tm/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  EditorContext,
  type AccountOption,
  pathKey,
  type EditorContextValue,
  type InstrumentOption,
} from '@/components/strategy/editor-context';
import { useBacktests } from '@/components/strategy/backtest';
import {
  BackTestSection,
  backtestStanding,
  ExecutionSection,
  useValidation,
} from '@/components/strategy/lifecycle';
import {
  StateTotals,
  TransitionsTable,
  WhyLines,
  type StayRow,
  type WhyCheck,
} from '@/components/strategy/machine-report';
import { MachineBuilder } from '@/components/strategy/machine-builder';
import { PageSection } from '@/components/strategy/page-sections';
import { useRowVersion } from '@/components/strategy/row-version';
import { apiClient } from '@/lib/api-client';

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
  /** NYSE sessions in the current state, the entry day counting as day 1 (§2.1). */
  daysInState: number | null;
  transitions: {
    seq: number;
    kind: 'start' | 'switch';
    decidedOn: string;
    fromStateId: string | null;
    toStateId: string;
    rowId: string | null;
    why: WhyCheck[];
    outcome: string;
    rounds: number;
    completedOn: string | null;
  }[];
  /** Stays since the run started trading, with their P/L (§2.6, O269). */
  stays: StayRow[];
}

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
  instruments: initialInstruments,
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
  const backtests = useBacktests(strategyId);
  const { latestText, draftTested } = backtestStanding(backtests, validation, false);
  const [instruments, setInstruments] = useState<readonly InstrumentOption[]>(initialInstruments);
  // Any symbol a picker looks up joins every picker at once (N193, ADR 0069).
  const addInstrument = useCallback(
    (found: InstrumentOption) =>
      setInstruments((list) =>
        list.some((i) => i.id === found.id)
          ? list
          : [...list, found].sort((a, b) => a.symbol.localeCompare(b.symbol)),
      ),
    [],
  );
  const editable = status !== 'actively_executing';
  const serverIssues = useMemo(() => {
    const m = new Map<string, string>();
    if (validation.kind === 'ready')
      for (const issue of [...validation.result.errors, ...validation.result.warnings]) {
        const k = pathKey(issue.path.filter((p): p is string | number => typeof p !== 'symbol'));
        if (!m.has(k)) m.set(k, issue.message);
      }
    return m;
  }, [validation]);
  const symbols = useMemo(() => new Map(instruments.map((i) => [i.id, i.symbol])), [instruments]);
  const symbol = (id: string) => symbols.get(id);
  const stateNames = new Map(machine.machine.states.map((s) => [s.id, s.name]));
  const stateName = (id: string | null) => (id ? (stateNames.get(id) ?? '?') : '');

  const ctx: EditorContextValue = useMemo(
    () => ({
      instruments,
      addInstrument,
      accounts,
      timeZone,
      baseCurrency,
      issueAt: () => undefined,
      editable,
      slotMode: 'none',
      universeClasses: [],
    }),
    [instruments, addInstrument, accounts, timeZone, baseCurrency, editable],
  );

  return (
    <EditorContext.Provider value={ctx}>
      <div className="space-y-10">
        <PageSection
          id="strategy"
          description="A state machine: at each daily close the rows are tested from the top, and the first true one decides the state."
        >
          <MachineBuilder
            strategyId={strategyId}
            machine={machine}
            rowVersion={rowVersion}
            editable={editable}
            serverIssues={serverIssues}
            onSaved={(detail: StrategyDetailDto) => {
              setRowVersion(detail.rowVersion);
              router.refresh();
            }}
          />
          {!editable && (
            <p className="text-sm text-ink-muted">
              Stop the strategy to change its states and rows.
            </p>
          )}
        </PageSection>
        <PageSection
          id="back-test"
          description="Replays the states over daily bars, at most 5 years, rebalancing at each switch. Results are estimates, not guarantees."
        >
          <BackTestSection
            backtests={backtests}
            dirty={false}
            validation={validation}
            latestText={latestText}
            draftTested={draftTested}
            definition={carrier}
            instruments={instruments}
            machine={machine}
          />
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
              machine={machine}
              symbol={symbol}
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
            machine={machine}
            validation={validation}
            latestText={latestText}
            draftTested={draftTested}
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
  machine,
  symbol,
  onConfirmed,
}: {
  strategyId: string;
  run: MachineRunView;
  stateName: (id: string | null) => string;
  baseCurrency: string;
  machine: MachineDefinition;
  symbol: (id: string) => string | undefined;
  onConfirmed: () => void;
}) {
  const last = run.transitions.at(-1);
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
          {run.confirmed && run.daysInState !== null && <span> · day {run.daysInState} in it</span>}
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
      {last && (
        <div className="mt-3 rounded-md border border-line p-3">
          <h3 className="text-sm font-semibold">
            Last transition, {last.decidedOn}:{' '}
            {last.kind === 'start'
              ? `start in ${stateName(last.toStateId)}`
              : `${stateName(last.fromStateId)} → ${stateName(last.toStateId)}`}
          </h3>
          <div className="mt-1">
            <WhyLines machine={machine} rowId={last.rowId} why={last.why} symbol={symbol} />
          </div>
        </div>
      )}
      {run.stays.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold">Time in each state since Start</h3>
          <StateTotals stays={run.stays} name={stateName} />
        </>
      )}
      {run.transitions.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold">Transitions</h3>
          <TransitionsTable
            label="Run transitions"
            transitions={run.transitions.map((t) => ({
              key: t.seq,
              kind: t.kind,
              on: t.decidedOn,
              fromStateId: t.fromStateId,
              toStateId: t.toStateId,
              rowId: t.rowId,
              why: t.why,
              outcome: t.outcome,
              attempts: t.rounds,
              completedOn: t.completedOn,
            }))}
            name={stateName}
            machine={machine}
            symbol={symbol}
          />
        </>
      )}
    </Card>
  );
}
