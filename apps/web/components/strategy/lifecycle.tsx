'use client';

import { ApiError, type StrategyDetailDto, type ValidateStrategyDto } from '@tm/contracts';
import {
  STATUS_LABELS,
  type StrategyDefinition,
  type StrategyStatus,
  type ValidationIssue,
} from '@tm/domain';
import { Alert, Button, Card, Dialog } from '@tm/ui';
import { useCallback, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { apiClient } from '@/lib/api-client';
import { describeHolding } from '@/lib/order-text';
import { describeIssueLocation } from '@/lib/strategy-text';
import {
  ActiveRun,
  BacktestInputsForm,
  BacktestResults,
  RunHistory,
  useBacktests,
} from './backtest';
import { useEditor } from './editor-context';

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
}: {
  open: boolean;
  onClose: () => void;
  strategyName: string;
  definition: StrategyDefinition;
  warnings: readonly ValidationIssue[];
  /** The activation gate (§7.4): when the strategy was last tested, and whether it changed since. */
  backtest: [string, string][];
  /** What earlier runs of this strategy still hold. */
  positions: string;
  busy: boolean;
  error: string | null;
  onConfirm: (acknowledged: string[]) => void;
}) {
  const { instruments, accounts, baseCurrency } = useEditor();
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const unique = uniqueWarnings(warnings);
  const allAcknowledged = unique.every((w) => acknowledged.has(w.code));

  const legs = [...definition.entry.orders, ...definition.exit.orders];
  const accountNames = [...new Set(legs.map((l) => l.accountId))].map(
    (id) => accounts.find((a) => a.id === id)?.nickname ?? 'Unknown account',
  );
  const symbols = [...new Set(legs.map((l) => l.instrumentId))].map(
    (id) => instruments.find((i) => i.id === id)?.symbol ?? '?',
  );
  const exposure = definition.risk.maxStrategyExposure;

  const rows: [string, string][] = [
    ['Strategy', strategyName],
    ['Mode', 'Paper (simulated orders, no real money)'],
    ['Accounts', accountNames.join(', ') || 'None'],
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
      title="Start on paper?"
      description="Starting pins these exact rules as a version and marks the strategy as actively executing."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (allAcknowledged) onConfirm(unique.map((w) => w.code));
        }}
      >
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
        <p className="mt-3 text-sm text-ink-muted">
          Orders go to the simulated paper broker as the rules trigger. You can follow them in
          Orders.
        </p>
        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!allAcknowledged || busy}>
            {busy ? 'Starting…' : 'Start on paper'}
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
}: {
  open: boolean;
  onClose: () => void;
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
      title="Stop execution?"
      description="The strategy stops generating new orders. Working orders and positions are left as they are. You can choose to cancel or close them below."
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
            <span>Cancel this strategy&apos;s working orders</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={closePositions}
              onChange={(e) => setClosePositions(e.target.checked)}
            />
            <span>Close this strategy&apos;s positions with market orders</span>
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
            {busy ? 'Stopping…' : 'Stop execution'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type Busy = null | 'status' | 'start' | 'stop';

/**
 * Back Test panel (§7, §15.1) with the execution controls placed right after
 * Run back test (§5.2, §7.4). Back testing itself arrives in Phase 2, so the
 * inputs are shown but Run is disabled.
 */
export function BackTestPanel({
  strategyId,
  strategyName,
  status,
  rowVersion,
  dirty,
  definition,
  validation,
  onChanged,
  onBacktestFinished,
}: {
  strategyId: string;
  strategyName: string;
  status: StrategyStatus;
  rowVersion: number;
  dirty: boolean;
  definition: StrategyDefinition;
  validation: ValidationState;
  onChanged: (detail: StrategyDetailDto) => void;
  /** Called when a run ends, so validation can pick up the new back test. */
  onBacktestFinished: () => void;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [dialog, setDialog] = useState<null | 'start' | 'stop'>(null);
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
  const backtests = useBacktests(strategyId);
  const activeId = backtests.active?.id;
  const [watching, setWatching] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (activeId) setWatching(activeId);
    else if (watching) {
      setWatching(undefined);
      onBacktestFinished();
    }
  }, [activeId, watching, onBacktestFinished]);

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

  const canStart = status === 'under_testing' || status === 'off';
  const errors = validation.kind === 'ready' ? validation.result.errors.length : 0;
  const startBlocked =
    status === 'created'
      ? 'Move this strategy to Under testing before starting it.'
      : dirty
        ? 'Save your changes before starting.'
        : validation.kind === 'loading' || (validation.kind === 'ready' && validation.checking)
          ? 'Checking the strategy…'
          : validation.kind === 'error'
            ? 'The strategy could not be checked. Use Check again under Validation.'
            : errors > 0
              ? `Fix the ${errors === 1 ? 'problem' : `${errors} problems`} listed under Validation first.`
              : null;

  const runBlocked = dirty
    ? 'Save your changes before running a back test.'
    : validation.kind === 'loading' || (validation.kind === 'ready' && validation.checking)
      ? 'Checking the strategy…'
      : validation.kind === 'error'
        ? 'The strategy could not be checked. Use Check again under Validation.'
        : errors > 0
          ? `Fix the ${errors === 1 ? 'problem' : `${errors} problems`} listed under Validation first.`
          : null;
  const latest = backtests.runs?.find((r) => r.status === 'completed');
  const draftHash = validation.kind === 'ready' ? validation.result.definitionHash : null;
  const latestText = latest?.finishedAt
    ? `${new Date(latest.finishedAt).toLocaleString('en-US')} (version ${latest.versionNo})`
    : 'None yet';
  const draftTested = !latest
    ? 'Not tested'
    : dirty
      ? 'Unsaved changes are not tested'
      : draftHash === null
        ? 'Checking…'
        : latest.definitionHash === draftHash
          ? 'Matches the latest back test'
          : 'Changed since the latest back test';

  return (
    <>
      <Card aria-labelledby="backtest-heading">
        <h2 id="backtest-heading" className="text-lg font-semibold">
          Back Test
        </h2>
        <p className="mb-3 text-sm text-ink-muted">
          Runs the saved rules over historical data. Results are estimates, not guarantees.
        </p>

        <BacktestInputsForm state={backtests} blocked={runBlocked} />
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-ink-muted">Latest back test</dt>
          <dd className="text-content">{latestText}</dd>
          <dt className="text-ink-muted">Current draft</dt>
          <dd className="text-content">{draftTested}</dd>
        </dl>

        <section aria-labelledby="execution-heading" className="mt-4 border-t border-line pt-4">
          <h3 id="execution-heading" className="text-sm font-semibold">
            Execution
          </h3>
          <p className="mt-1 text-sm">
            Status: <span className="font-medium">{STATUS_LABELS[status]}</span>
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {status === 'actively_executing' ? (
              <Button variant="danger" onClick={() => setDialog('stop')} disabled={busy !== null}>
                Stop execution
              </Button>
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
          {status === 'actively_executing' && justStarted && (
            <div className="mt-3">
              <Alert tone="ok">
                Started on paper.{' '}
                <Link href={`/orders?started=${strategyId}`} className="underline">
                  Follow its orders in Orders
                </Link>
              </Alert>
            </div>
          )}
          {status !== 'actively_executing' && startBlocked && (
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
        </section>

        <ActiveRun state={backtests} />
        {backtests.loadError && (
          <div className="mt-3">
            <Alert>{backtests.loadError}</Alert>
          </div>
        )}
        <RunHistory state={backtests} />

        {dialog === 'start' && validation.kind === 'ready' && (
          <StartDialog
            open
            onClose={() => setDialog(null)}
            strategyName={strategyName}
            definition={definition}
            warnings={validation.result.warnings}
            backtest={[
              ['Latest back test', latestText],
              ['Rules since then', draftTested],
            ]}
            positions={positions}
            busy={busy === 'start'}
            error={error}
            onConfirm={(acknowledgedWarnings) =>
              act('start', () =>
                apiClient.strategies.start(strategyId, {
                  rowVersion,
                  mode: 'paper',
                  confirmed: true,
                  acknowledgedWarnings,
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
            onConfirm={({ reason, ...choices }) =>
              act('stop', () =>
                apiClient.strategies.stop(strategyId, {
                  rowVersion,
                  ...choices,
                  ...(reason ? { reason } : {}),
                }),
              )
            }
          />
        )}
      </Card>
      <BacktestResults state={backtests} />
    </>
  );
}
