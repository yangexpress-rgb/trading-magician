'use client';

import {
  ApiError,
  type StrategyDetailDto,
  type StrategyRunStateDto,
  type ValidateStrategyDto,
} from '@tm/contracts';
import {
  finestBarMinutes,
  PDT_EQUITY,
  PDT_WARNING,
  STATUS_LABELS,
  type MachineDefinition,
  type StrategyDefinition,
  type StrategyStatus,
  type ValidationIssue,
} from '@tm/domain';
import { Alert, Button, Card, cx, Dialog } from '@tm/ui';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api-client';
import { describeHolding } from '@/lib/order-text';
import { describeIssueLocation, LEG_FAILURE_LABELS, MULTI_LEG_LABELS } from '@/lib/strategy-text';
import {
  ActiveRun,
  BacktestInputsForm,
  BacktestResults,
  RunHistory,
  type BacktestsState,
} from './backtest';
import { accountText, AccountLabel, groupAccounts } from '@/components/accounts/account-label';
import { useEditor, type AccountOption } from './editor-context';

export type ValidationState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; result: ValidateStrategyDto; checking: boolean };

/**
 * Server-side validation of the saved draft (§6.10). Re-runs whenever the
 * strategy's row version changes, i.e. after every save or status change,
 * because the server also checks accounts and feeds the editor can't see.
 */
export function useValidation(strategyId: string, rowVersion: number) {
  const [state, setState] = useState<ValidationState>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((s) => (s.kind === 'ready' ? { ...s, checking: true } : { kind: 'loading' }));
    apiClient.strategies.validate(strategyId).then(
      (result) => {
        if (!cancelled) setState({ kind: 'ready', result, checking: false });
      },
      (e: unknown) => {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: e instanceof ApiError ? e.message : 'Could not check this strategy.',
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [strategyId, rowVersion, nonce]);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);
  return { state, recheck };
}

function errorMessage(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const details = (e.body.details as { details?: unknown } | undefined)?.details;
  return Array.isArray(details) && details.length > 0
    ? `${e.message}: ${details.join('; ')}`
    : e.message;
}

function IssueList({
  issues,
  definition,
}: {
  issues: readonly ValidationIssue[];
  definition: StrategyDefinition;
}) {
  return (
    <ul className="mt-1 space-y-1 text-sm">
      {issues.map((issue, i) => (
        <li key={`${issue.code}-${i}`} className="flex flex-wrap gap-x-2">
          <span className="font-medium text-ink-muted">
            {describeIssueLocation(issue.path, definition)}:
          </span>
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** Problems that block starting, and warnings that need acknowledging (§6.10). */
export function ValidationPanel({
  validation,
  definition,
  dirty,
  onRecheck,
}: {
  validation: ValidationState;
  definition: StrategyDefinition;
  dirty: boolean;
  onRecheck: () => void;
}) {
  return (
    <Card id="validation" aria-labelledby="validation-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="validation-heading" className="text-lg font-semibold">
          Validation
        </h2>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={onRecheck}
          disabled={validation.kind === 'loading'}
        >
          Check again
        </Button>
      </div>
      <p className="mb-3 text-sm text-ink-muted">
        {dirty
          ? 'Showing results for the last saved draft. Save to check your latest changes.'
          : 'Checks the saved draft against your accounts, data feeds and risk limits.'}
      </p>
      {validation.kind === 'loading' && <p className="text-sm">Checking the strategy…</p>}
      {validation.kind === 'error' && <Alert>{validation.message}</Alert>}
      {validation.kind === 'ready' && (
        <div className="space-y-3" aria-busy={validation.checking}>
          {validation.result.errors.length === 0 && validation.result.warnings.length === 0 && (
            <p className="text-sm font-medium text-ok">No problems found.</p>
          )}
          {validation.result.errors.length > 0 && (
            <section aria-labelledby="validation-errors">
              <h3 id="validation-errors" className="text-sm font-semibold text-danger">
                {validation.result.errors.length === 1
                  ? '1 problem blocks starting'
                  : `${validation.result.errors.length} problems block starting`}
              </h3>
              <IssueList issues={validation.result.errors} definition={definition} />
            </section>
          )}
          {validation.result.warnings.length > 0 && (
            <section aria-labelledby="validation-warnings">
              <h3 id="validation-warnings" className="text-sm font-semibold text-warn">
                {validation.result.warnings.length === 1
                  ? '1 warning to acknowledge when starting'
                  : `${validation.result.warnings.length} warnings to acknowledge when starting`}
              </h3>
              <IssueList issues={validation.result.warnings} definition={definition} />
            </section>
          )}
        </div>
      )}
    </Card>
  );
}

/** One entry per warning code; the server acknowledges by code. */
function uniqueWarnings(warnings: readonly ValidationIssue[]) {
  const byCode = new Map<string, { code: string; message: string; count: number }>();
  for (const w of warnings) {
    const seen = byCode.get(w.code);
    if (seen) seen.count += 1;
    else byCode.set(w.code, { code: w.code, message: w.message, count: 1 });
  }
  return [...byCode.values()];
}

function StartDialog({
  open,
  onClose,
  strategyName,
  definition,
  warnings,
  backtest,
  positions,
  busy,
  error,
  onConfirm,
  choices,
  initialAccountId,
}: {
  open: boolean;
  onClose: () => void;
  strategyName: string;
  definition: StrategyDefinition;
  /** Accounts it can start on: those without a run of this strategy (N308). */
  choices: readonly AccountOption[];
  initialAccountId: string | undefined;
  warnings: readonly ValidationIssue[];
  /** The activation gate (§7.4): when the strategy was last tested, and whether it changed since. */
  backtest: [string, string][];
  /** What earlier runs of this strategy still hold. */
  positions: string;
  busy: boolean;
  error: string | null;
  onConfirm: (acknowledged: string[], account: AccountOption) => void;
}) {
  const { instruments, baseCurrency } = useEditor();
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [realMoney, setRealMoney] = useState(false);
  const [accountId, setAccountId] = useState(initialAccountId ?? choices[0]?.id ?? '');
  const accountFieldId = useId();
  const unique = uniqueWarnings(warnings);
  const allAcknowledged = unique.every((w) => acknowledged.has(w.code));
  const chosen = choices.find((a) => a.id === accountId);
  const live = chosen?.mode === 'live';
  const grouped = groupAccounts(choices);
  const money = (v: string | null | undefined) => (v ? `${baseCurrency} ${v}` : 'Not set');
  // Pattern-day-trader awareness (N320): an intraday run on a live margin account under $25,000.
  const pdtWarning =
    live &&
    chosen.brokerMargin !== false &&
    chosen.brokerEquity != null &&
    Number(chosen.brokerEquity) < PDT_EQUITY &&
    (finestBarMinutes(definition) < 1440 || definition.execution.flattenAtSessionEnd === true);

  const legs = [...definition.entry.orders, ...definition.exit.orders];
  const symbols = [...new Set(legs.map((l) => l.instrumentId))].map(
    (id) => instruments.find((i) => i.id === id)?.symbol ?? '?',
  );
  const exposure = definition.risk.maxStrategyExposure;

  const rows: [string, string][] = [
    ['Strategy', strategyName],
    [
      'Mode',
      live ? 'LIVE (real orders with real money)' : 'Paper (simulated orders, no real money)',
    ],
    ...(live && chosen
      ? ([
          ['Account', `${chosen.nickname} (LIVE)`],
          ['Account exposure limit', money(chosen.maxExposure)],
          ['Account daily loss limit', money(chosen.dailyLossLimit)],
          [
            'Pilot caps',
            chosen.pilot
              ? `${money(chosen.pilot.maxOrder)} per order, ${money(chosen.pilot.maxExposure)} in total`
              : 'Pilot mode ended',
          ],
          ...(chosen.brokerDayTrades != null
            ? ([['Day trades in 5 days', String(chosen.brokerDayTrades)]] as [string, string][])
            : []),
        ] as [string, string][])
      : []),
    ['Instruments', symbols.join(', ') || 'None'],
    [
      'Order legs',
      `${definition.entry.orders.length} Entry, ${definition.exit.orders.length} Exit`,
    ],
    ['Maximum exposure', exposure ? `${baseCurrency} ${exposure}` : 'Not set'],
    ['Existing positions', positions],
    ...backtest,
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={live ? 'Start on real money?' : 'Start on paper?'}
      description="Starting pins these exact rules as a version and runs them on the account you choose."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (allAcknowledged && chosen && (!live || realMoney))
            onConfirm(
              unique.map((w) => w.code),
              chosen,
            );
        }}
      >
        <div className="mb-3">
          <label htmlFor={accountFieldId} className="text-sm font-semibold">
            Which account?
          </label>
          <select
            id={accountFieldId}
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setRealMoney(false);
            }}
            className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
          >
            {grouped.paper.length > 0 && (
              <optgroup label="Paper accounts">
                {grouped.paper.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountText(a.nickname, a.mode)}
                  </option>
                ))}
              </optgroup>
            )}
            {grouped.live.length > 0 && (
              <optgroup label="Live accounts">
                {grouped.live.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountText(a.nickname, a.mode)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <p className="mt-1 text-xs text-ink-muted">
            Every order of this run goes to this account. Its orders, positions and results are kept
            apart from the strategy&rsquo;s runs on other accounts.
          </p>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {rows.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-ink-muted">{term}</dt>
              <dd className="text-content">{value}</dd>
            </div>
          ))}
        </dl>
        {unique.length > 0 && (
          <fieldset className="mt-4 rounded-md border border-warn/40 bg-warn-soft p-3">
            <legend className="px-1 text-sm font-semibold">Acknowledge each warning</legend>
            <ul className="space-y-2">
              {unique.map((w) => (
                <li key={w.code}>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={acknowledged.has(w.code)}
                      onChange={(e) => {
                        const next = new Set(acknowledged);
                        if (e.target.checked) next.add(w.code);
                        else next.delete(w.code);
                        setAcknowledged(next);
                      }}
                    />
                    <span>
                      {w.message}
                      {w.count > 1 && ` (${w.count} places)`}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        {pdtWarning && (
          <div className="mt-3">
            <Alert tone="warn">{PDT_WARNING}</Alert>
          </div>
        )}
        {live && (
          <label className="mt-4 flex items-start gap-2 rounded-md border border-danger/40 bg-danger-soft p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={realMoney}
              onChange={(e) => setRealMoney(e.target.checked)}
            />
            <span>
              I understand this run sends real orders with real money to {chosen.nickname}.
            </span>
          </label>
        )}
        <p className="mt-3 text-sm text-ink-muted">
          Orders go to {chosen ? chosen.nickname : 'the account'} as the rules trigger. You can
          follow them in Orders.
        </p>
        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!allAcknowledged || !chosen || (live && !realMoney) || busy}
          >
            {busy ? 'Starting…' : live ? 'Start on real money' : 'Start on paper'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function StopDialog({
  open,
  onClose,
  busy,
  error,
  onConfirm,
  accountName,
}: {
  open: boolean;
  onClose: () => void;
  /** The one run's account, when only that run stops (N308); otherwise every run stops. */
  accountName?: string | undefined;
  busy: boolean;
  error: string | null;
  onConfirm: (choice: {
    reason: string;
    cancelOpenOrders: boolean;
    closePositions: boolean;
  }) => void;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [cancelOpenOrders, setCancelOpenOrders] = useState(false);
  const [closePositions, setClosePositions] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={accountName ? `Stop the run on ${accountName}?` : 'Stop execution?'}
      description={
        accountName
          ? `This run stops generating new orders. Runs on other accounts carry on. Working orders and positions on ${accountName} are left as they are. You can choose to cancel or close them below.`
          : 'The strategy stops generating new orders. Working orders and positions are left as they are. You can choose to cancel or close them below.'
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm({ reason: reason.trim(), cancelOpenOrders, closePositions });
        }}
      >
        <fieldset className="mb-3 space-y-2">
          <legend className="text-sm font-medium">Also, separately</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={cancelOpenOrders}
              onChange={(e) => setCancelOpenOrders(e.target.checked)}
            />
            <span>Cancel {accountName ? 'this run' : 'this strategy'}&apos;s working orders</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={closePositions}
              onChange={(e) => setClosePositions(e.target.checked)}
            />
            <span>
              Close {accountName ? 'this run' : 'this strategy'}&apos;s positions with market orders
            </span>
          </label>
        </fieldset>
        <label htmlFor={reasonId} className="text-sm font-semibold text-ink-muted">
          Reason (optional)
        </label>
        <textarea
          id={reasonId}
          value={reason}
          maxLength={500}
          rows={2}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
        />
        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" disabled={busy}>
            {busy ? 'Stopping…' : accountName ? 'Stop this run' : 'Stop execution'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type Busy = null | 'status' | 'start' | 'stop';

/** Why a run or a start can't happen yet, or null (§6.10, §7.4). */
function blockedByChecks(dirty: boolean, validation: ValidationState, action: string) {
  if (dirty) return `Save your changes before ${action}.`;
  if (validation.kind === 'loading' || (validation.kind === 'ready' && validation.checking))
    return 'Checking the strategy…';
  if (validation.kind === 'error')
    return 'The strategy could not be checked. Use Check again under Validation.';
  const errors = validation.result.errors.length;
  return errors > 0
    ? `Fix the ${errors === 1 ? 'problem' : `${errors} problems`} listed under Validation first.`
    : null;
}

export type DraftTested = 'not_tested' | 'unsaved' | 'checking' | 'matches' | 'changed';

export const DRAFT_TESTED_TEXT: Record<DraftTested, string> = {
  not_tested: 'Not tested',
  unsaved: 'Unsaved changes are not tested',
  checking: 'Checking…',
  matches: 'Matches the latest back test',
  changed: 'Changed since the latest back test',
};

/** The latest completed back test and whether the rules changed since (§7.4). */
export function backtestStanding(
  backtests: BacktestsState,
  validation: ValidationState,
  dirty: boolean,
): { latestText: string; draftTested: DraftTested } {
  const latest = backtests.runs?.find((r) => r.status === 'completed');
  const draftHash = validation.kind === 'ready' ? validation.result.definitionHash : null;
  const latestText = latest?.finishedAt
    ? `${new Date(latest.finishedAt).toLocaleString('en-US')} (version ${latest.versionNo})`
    : 'None yet';
  const draftTested: DraftTested = !latest
    ? 'not_tested'
    : dirty
      ? 'unsaved'
      : draftHash === null
        ? 'checking'
        : latest.definitionHash === draftHash
          ? 'matches'
          : 'changed';
  return { latestText, draftTested };
}

/**
 * Section 2 (N175): run a back test, its history and its results (§7, §15.1).
 * Start and Stop live in the Execution section.
 */
export function BackTestSection({
  backtests,
  dirty,
  validation,
  latestText,
  draftTested,
  definition,
  instruments,
  machine,
}: {
  /** A state machine's document (ADR 0124 P3b): its results read by state. */
  machine?: MachineDefinition | null;
  backtests: BacktestsState;
  dirty: boolean;
  validation: ValidationState;
  latestText: string;
  draftTested: DraftTested;
  /** The rules: they set the bars (N233) and the group to narrow (N235). */
  definition: StrategyDefinition;
  /** Instruments the editor knows, to name a list group's members. */
  instruments?: readonly { id: string; symbol: string }[];
}) {
  return (
    <>
      <Card aria-labelledby="backtest-heading">
        <h2 id="backtest-heading" className="text-lg font-semibold">
          Run a back test
        </h2>
        <p className="mb-3 text-sm text-ink-muted">
          {machine
            ? 'Replays the states over daily bars and rebalances at each switch. Results are estimates, not guarantees.'
            : 'Runs the saved rules over historical data. Results are estimates, not guarantees.'}
        </p>
        <BacktestInputsForm
          state={backtests}
          blocked={blockedByChecks(dirty, validation, 'running a back test')}
          definition={definition}
          instruments={instruments}
        />
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-ink-muted">Latest back test</dt>
          <dd className="text-content">{latestText}</dd>
          <dt className="text-ink-muted">Current draft</dt>
          <dd className="text-content">{DRAFT_TESTED_TEXT[draftTested]}</dd>
        </dl>
        <ActiveRun state={backtests} />
        {backtests.loadError && (
          <div className="mt-3">
            <Alert>{backtests.loadError}</Alert>
          </div>
        )}
        <RunHistory state={backtests} />
      </Card>
      <BacktestResults
        state={backtests}
        machine={machine ?? null}
        symbol={(id) => instruments?.find((i) => i.id === id)?.symbol}
      />
    </>
  );
}

function Check({ ok, children }: { ok: boolean | 'warn'; children: ReactNode }) {
  return (
    <li className="flex items-baseline gap-2">
      <span
        aria-hidden="true"
        className={cx(
          'w-4 shrink-0 font-bold',
          ok === true ? 'text-ok' : ok === 'warn' ? 'text-warn' : 'text-danger',
        )}
      >
        {ok === true ? '✓' : ok === 'warn' ? '!' : '✗'}
      </span>
      <span>
        <span className="sr-only">
          {ok === true ? 'Done: ' : ok === 'warn' ? 'Note: ' : 'Not yet: '}
        </span>
        {children}
      </span>
    </li>
  );
}

/**
 * A paused run (N286): the same reason the Orders banner and the pause
 * notification give, and the same Resume the Orders page offers.
 */
function PausedPanel({ strategyId, run }: { strategyId: string; run: StrategyRunStateDto }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-2">
      <Alert tone="warn">
        <span className="font-semibold">Paused on {run.accountName}.</span>{' '}
        {run.pauseReason ?? 'No reason was recorded.'} It sends no new orders until it is resumed.
        <span className="mt-2 flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              apiClient.execution.resume(run.runtimeId).then(
                () => router.refresh(),
                (e: unknown) => {
                  setError(errorMessage(e, 'Could not resume it. Try again from Orders.'));
                  setBusy(false);
                },
              );
            }}
          >
            {busy ? 'Resuming…' : 'Resume'}
          </Button>
          <Link href={`/orders?strategy=${strategyId}`} className="underline">
            See it in Orders
          </Link>
        </span>
      </Alert>
      {error && (
        <div className="mt-2">
          <Alert>{error}</Alert>
        </div>
      )}
    </div>
  );
}

/** The strategy's runs, one per account (N308): where, how, since when, and Stop for each. */
function RunList({
  runs,
  busy,
  onStop,
}: {
  runs: readonly StrategyRunStateDto[];
  busy: boolean;
  onStop: (run: StrategyRunStateDto) => void;
}) {
  return (
    <ul
      className="mt-2 divide-y divide-line rounded-md border border-line text-sm"
      aria-label="Runs"
    >
      {runs.map((r) => (
        <li key={r.runtimeId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
          <AccountLabel name={r.accountName} mode={r.accountMode} className="font-medium" />
          <span className={r.status === 'paused' ? 'font-medium text-warn' : 'text-ok'}>
            {r.status === 'paused' ? 'Paused' : 'Running'}
          </span>
          <span className="text-ink-muted">
            since{' '}
            {new Date(r.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            {r.versionNo !== null && ` · version ${r.versionNo}`}
          </span>
          {runs.length > 1 && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              disabled={busy}
              onClick={() => onStop(r)}
            >
              Stop this run
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Section 3 (N176): readiness, status, Start and Stop (§5.2, §7.4), where it
 * runs on paper, and the versions and status history passed in by the page.
 */
export function ExecutionSection({
  strategyId,
  strategyName,
  status,
  run = null,
  runs: runsProp,
  rowVersion,
  dirty,
  definition,
  validation,
  latestText,
  draftTested,
  onChanged,
  history,
}: {
  strategyId: string;
  strategyName: string;
  status: StrategyStatus;
  /** Its paper run; a pause shows here with its reason and a Resume button (N286). */
  run?: StrategyRunStateDto | null;
  /** Every run that is not stopped, one per account (N308). */
  runs?: readonly StrategyRunStateDto[] | undefined;
  rowVersion: number;
  dirty: boolean;
  definition: StrategyDefinition;
  validation: ValidationState;
  latestText: string;
  draftTested: DraftTested;
  onChanged: (detail: StrategyDetailDto) => void;
  /** Versions and status history, rendered last. */
  history?: ReactNode;
}) {
  const { accounts } = useEditor();
  const [busy, setBusy] = useState<Busy>(null);
  const [dialog, setDialog] = useState<null | 'start' | 'stop'>(null);
  /** The one run Stop applies to (N308); undefined stops every run. */
  const [stopRun, setStopRun] = useState<StrategyRunStateDto | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [justStarted, setJustStarted] = useState(false);
  const [positions, setPositions] = useState('Checking…');
  useEffect(() => {
    if (dialog !== 'start') return;
    let cancelled = false;
    apiClient.positions.list().then(
      ({ positions: all }) => {
        if (cancelled) return;
        const mine = all.filter((p) => p.strategyId === strategyId);
        setPositions(
          mine.length === 0
            ? 'None'
            : `${mine.map((p) => `${p.symbol} ${describeHolding(p.quantity).toLowerCase()}`).join(', ')} from an earlier run`,
        );
      },
      () => !cancelled && setPositions('Could not be checked'),
    );
    return () => {
      cancelled = true;
    };
  }, [dialog, strategyId]);
  const hintId = useId();

  async function act(kind: Exclude<Busy, null>, run: () => Promise<StrategyDetailDto>) {
    setBusy(kind);
    setError(null);
    setPanelError(null);
    try {
      onChanged(await run());
      setJustStarted(kind === 'start');
      setDialog(null);
    } catch (e) {
      const message = errorMessage(e, 'Something went wrong. Try again.');
      if (dialog) setError(message);
      else setPanelError({ message, conflict: e instanceof ApiError && e.code === 'conflict' });
    } finally {
      setBusy(null);
    }
  }

  const setStatus = (to: 'created' | 'under_testing') =>
    act('status', () => apiClient.strategies.update(strategyId, { rowVersion, status: to }));

  const running = status === 'actively_executing';
  const runs = runsProp ?? (run ? [run] : []);
  const paused = running && runs.length > 0 && runs.every((r) => r.status === 'paused');
  // Accounts with no run of this strategy yet: a strategy runs once per account (N308).
  const choices = accounts.filter((a) => !runs.some((r) => r.accountId === a.id));
  const legsAccount = [...definition.entry.orders, ...definition.exit.orders][0]?.accountId;
  const initialAccountId = choices.some((a) => a.id === legsAccount)
    ? legsAccount
    : (choices.find((a) => a.isDefault && a.mode === 'paper') ?? groupAccounts(choices).paper[0])
        ?.id;
  const canStart = status === 'under_testing' || status === 'off';
  const startBlocked =
    status === 'created'
      ? 'Move this strategy to Under testing before starting it.'
      : blockedByChecks(dirty, validation, 'starting');

  const errors = validation.kind === 'ready' ? validation.result.errors.length : 0;
  const warnings = validation.kind === 'ready' ? validation.result.warnings.length : 0;
  const legs = [...definition.entry.orders, ...definition.exit.orders];
  const accountNames = [...new Set(legs.map((l) => l.accountId))]
    .map((id) => accounts.find((a) => a.id === id)?.nickname)
    .filter((n): n is string => Boolean(n));
  const ex = definition.execution;

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card aria-labelledby="lifecycle-heading">
          <h2 id="lifecycle-heading" className="text-lg font-semibold">
            {paused ? 'Paused on paper' : running ? 'Running on paper' : 'Ready to start'}
          </h2>
          {running && runs.length > 0 && (
            <RunList
              runs={runs}
              busy={busy !== null}
              onStop={(r) => {
                setError(null);
                setStopRun(r);
                setDialog('stop');
              }}
            />
          )}
          {runs
            .filter((r) => r.status === 'paused')
            .map((r) => (
              <PausedPanel key={r.runtimeId} strategyId={strategyId} run={r} />
            ))}
          {!running && (
            <ul className="mt-2 space-y-1 text-sm" aria-label="Before starting">
              <Check ok={canStart}>
                {canStart ? `Status is ${STATUS_LABELS[status]}` : 'Move it to Under testing first'}
              </Check>
              <Check ok={!dirty}>{dirty ? 'Save your changes first' : 'Saved'}</Check>
              <Check
                ok={
                  validation.kind === 'ready' && !validation.checking && errors === 0
                    ? true
                    : validation.kind === 'error' || errors > 0
                      ? false
                      : 'warn'
                }
              >
                {validation.kind === 'loading' ||
                (validation.kind === 'ready' && validation.checking) ? (
                  'Checking the strategy…'
                ) : validation.kind === 'error' ? (
                  <a href="#validation">Validation could not run</a>
                ) : errors > 0 ? (
                  <a href="#validation">
                    {errors === 1 ? '1 problem' : `${errors} problems`} under Validation
                  </a>
                ) : (
                  <>
                    Validation: no problems
                    {warnings > 0 && (
                      <>
                        {' · '}
                        <a href="#validation">
                          {warnings === 1 ? '1 warning' : `${warnings} warnings`}
                        </a>{' '}
                        to acknowledge
                      </>
                    )}
                  </>
                )}
              </Check>
              <Check ok={draftTested === 'matches' ? true : 'warn'}>
                <a href="#back-test">
                  {draftTested === 'matches'
                    ? 'Latest back test matches these rules'
                    : draftTested === 'not_tested'
                      ? 'Not back tested yet'
                      : DRAFT_TESTED_TEXT[draftTested]}
                </a>
              </Check>
            </ul>
          )}
          <p className="mt-3 text-sm">
            Status: <span className="font-medium">{STATUS_LABELS[status]}</span>
            {paused && (
              <>
                {' · '}
                <span className="font-medium text-warn">Paused</span>
              </>
            )}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {running ? (
              <>
                {choices.length > 0 && (
                  <Button
                    disabled={startBlocked !== null || busy !== null}
                    aria-describedby={startBlocked ? hintId : undefined}
                    onClick={() => {
                      setError(null);
                      setDialog('start');
                    }}
                  >
                    Start on another account
                  </Button>
                )}
                <Button
                  variant="danger"
                  onClick={() => {
                    setStopRun(undefined);
                    setDialog('stop');
                  }}
                  disabled={busy !== null}
                >
                  {runs.length > 1 ? 'Stop every run' : 'Stop execution'}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                disabled={!canStart || startBlocked !== null || busy !== null}
                aria-describedby={startBlocked ? hintId : undefined}
                onClick={() => {
                  setError(null);
                  setDialog('start');
                }}
              >
                Start execution
              </Button>
            )}
            {(status === 'created' || status === 'off') && (
              <Button onClick={() => setStatus('under_testing')} disabled={busy !== null}>
                Move to Under testing
              </Button>
            )}
            {status === 'under_testing' && (
              <Button variant="ghost" onClick={() => setStatus('created')} disabled={busy !== null}>
                Move back to Created
              </Button>
            )}
          </div>
          {running && justStarted && (
            <div className="mt-3">
              <Alert tone="ok">
                Started on paper.{' '}
                <Link href={`/orders?started=${strategyId}`} className="underline">
                  Follow its orders in Orders
                </Link>
              </Alert>
            </div>
          )}
          {startBlocked && (!running || choices.length > 0) && (
            <p id={hintId} className="mt-2 text-sm text-ink-muted">
              {startBlocked}
            </p>
          )}
          {panelError && (
            <div className="mt-3">
              <Alert>
                {panelError.message}{' '}
                {panelError.conflict && (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => window.location.reload()}
                  >
                    Reload the latest version
                  </button>
                )}
              </Alert>
            </div>
          )}
        </Card>
        <Card aria-labelledby="on-paper-heading">
          <h2 id="on-paper-heading" className="text-lg font-semibold">
            On paper
          </h2>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-ink-muted">Send legs</dt>
            <dd className="text-content">{MULTI_LEG_LABELS[ex.multiLegPolicy]}</dd>
            <dt className="text-ink-muted">If a leg fails</dt>
            <dd className="text-content">{LEG_FAILURE_LABELS[ex.onLegFailure]}</dd>
            <dt className="text-ink-muted">{running ? 'Runs on' : 'Starts on'}</dt>
            <dd className="text-content">
              {running && runs.length > 0
                ? runs.map((r) => accountText(r.accountName, r.accountMode)).join(', ')
                : accountNames.length > 0
                  ? accountNames.join(', ')
                  : '—'}
            </dd>
            <dt className="text-ink-muted">Latest back test</dt>
            <dd className="text-content">{latestText}</dd>
          </dl>
          <p className="mt-1 text-xs text-ink-muted">
            Change how orders are sent under <a href="#order-handling-heading">Order handling</a>.
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link href={`/orders?strategy=${strategyId}`}>This strategy&rsquo;s orders ›</Link>
            <Link href={`/performance?strategy=${strategyId}`}>Its performance ›</Link>
          </div>
        </Card>
      </div>
      {history}

      {dialog === 'start' && validation.kind === 'ready' && (
        <StartDialog
          open
          onClose={() => setDialog(null)}
          strategyName={strategyName}
          definition={definition}
          warnings={validation.result.warnings}
          backtest={[
            ['Latest back test', latestText],
            ['Rules since then', DRAFT_TESTED_TEXT[draftTested]],
          ]}
          positions={positions}
          choices={choices}
          initialAccountId={initialAccountId}
          busy={busy === 'start'}
          error={error}
          onConfirm={(acknowledgedWarnings, account) =>
            act('start', () =>
              apiClient.strategies.start(strategyId, {
                rowVersion,
                mode: account.mode,
                confirmed: true,
                acknowledgedWarnings,
                accountId: account.id,
                ...(account.mode === 'live' ? { liveConfirmed: true as const } : {}),
              }),
            )
          }
        />
      )}
      {dialog === 'stop' && (
        <StopDialog
          open
          onClose={() => setDialog(null)}
          busy={busy === 'stop'}
          error={error}
          accountName={runs.length > 1 ? stopRun?.accountName : undefined}
          onConfirm={({ reason, ...stopChoices }) =>
            act('stop', () =>
              apiClient.strategies.stop(strategyId, {
                rowVersion,
                ...stopChoices,
                ...(reason ? { reason } : {}),
                ...(runs.length > 1 && stopRun ? { runtimeId: stopRun.runtimeId } : {}),
              }),
            )
          }
        />
      )}
    </>
  );
}
