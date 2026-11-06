'use client';

import { ApiError } from '@tm/contracts';
import {
  canonicalJson,
  slotModeOf,
  strategyDefinitionSchema,
  type ConditionGroup,
  type PhaseName,
  type StrategyDefinition,
  type StrategyStatus,
} from '@tm/domain';
import { Alert, Button, Card, cx } from '@tm/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ConditionTreeEditor } from '@/components/strategy/condition-editor';
import {
  EditorContext,
  pathKey,
  type AccountOption,
  type EditorContextValue,
  type InstrumentOption,
} from '@/components/strategy/editor-context';
import { InstrumentFinder } from '@/components/strategy/instrument-finder';
import { BackTestPanel, useValidation, ValidationPanel } from '@/components/strategy/lifecycle';
import { OrdersEditor } from '@/components/strategy/orders-editor';
import { EntryStructure, ExitRulesEditor } from '@/components/strategy/slots-editor';
import { ExecutionAndRisk, TriggerSettings } from '@/components/strategy/settings-editor';
import { apiClient } from '@/lib/api-client';

interface Props {
  strategyId: string;
  strategyName: string;
  status: StrategyStatus;
  initialDefinition: StrategyDefinition;
  initialRowVersion: number;
  instruments: InstrumentOption[];
  accounts: AccountOption[];
  timeZone: string;
  baseCurrency: string;
  /** Rendered after the Back Test panel. */
  children?: ReactNode;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string; conflict?: boolean };

/** Structural problems (schema-level), keyed by path, shown next to fields. */
function structuralIssues(def: StrategyDefinition): Map<string, string> {
  const result = strategyDefinitionSchema.safeParse(def);
  const map = new Map<string, string>();
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = pathKey(issue.path.filter((p): p is string | number => typeof p !== 'symbol'));
      if (!map.has(key)) map.set(key, issue.message);
    }
  }
  return map;
}

export function StrategyEditor({
  strategyId,
  strategyName,
  status,
  initialDefinition,
  initialRowVersion,
  instruments: initialInstruments,
  accounts,
  timeZone,
  baseCurrency,
  children,
}: Props) {
  const router = useRouter();
  const [instruments, setInstruments] = useState(initialInstruments);
  const [definition, setDefinition] = useState(initialDefinition);
  const [savedJson, setSavedJson] = useState(() => canonicalJson(initialDefinition));
  const [rowVersion, setRowVersion] = useState(initialRowVersion);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });

  const editable = status !== 'actively_executing';
  const dirty = useMemo(() => canonicalJson(definition) !== savedJson, [definition, savedJson]);
  const issues = useMemo(() => structuralIssues(definition), [definition]);
  const { state: validation, recheck } = useValidation(strategyId, rowVersion);

  // Warn before leaving with unsaved edits (§5.1).
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const edit = useCallback(
    (next: StrategyDefinition | ((d: StrategyDefinition) => StrategyDefinition)) => {
      setDefinition(next);
      setSave({ kind: 'idle' });
    },
    [],
  );
  const setPhaseCondition = (phase: PhaseName) => (condition: ConditionGroup) =>
    edit((d) => ({ ...d, [phase]: { ...d[phase], condition } }));

  async function onSave() {
    if (issues.size > 0) {
      setSave({ kind: 'error', message: 'Fix the highlighted fields before saving.' });
      return;
    }
    setSave({ kind: 'saving' });
    try {
      const saved = await apiClient.strategies.update(strategyId, { rowVersion, definition });
      setRowVersion(saved.rowVersion);
      setSavedJson(canonicalJson(saved.definition));
      setDefinition(saved.definition);
      setSave({ kind: 'saved' });
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') {
        setSave({ kind: 'error', message: e.message, conflict: true });
      } else {
        setSave({
          kind: 'error',
          message:
            e instanceof ApiError
              ? e.message
              : 'Could not save. Check your connection and try again.',
        });
      }
    }
  }

  const slotMode = slotModeOf(definition);
  const universe = definition.entry.selection?.universe;
  const universeKey =
    universe?.type === 'list' ? universe.instrumentIds.join(',') : (universe?.id ?? '');
  const universeClasses = useMemo(() => {
    if (!universe || universe.type === 'builtin') return ['stock'];
    const classes = new Set(
      universe.instrumentIds.map(
        (id) => instruments.find((i) => i.id === id)?.assetClass ?? 'stock',
      ),
    );
    return [...classes];
  }, [universeKey, instruments]);

  const ctx: EditorContextValue = useMemo(
    () => ({
      instruments,
      accounts,
      timeZone,
      baseCurrency,
      issueAt: (path) => issues.get(pathKey(path)),
      editable,
      slotMode,
      universeClasses,
    }),
    [instruments, accounts, timeZone, baseCurrency, issues, editable, slotMode, universeClasses],
  );

  const stateText =
    save.kind === 'saving'
      ? 'Saving…'
      : dirty
        ? 'Unsaved changes'
        : save.kind === 'saved'
          ? 'All changes saved'
          : 'No unsaved changes';

  return (
    <EditorContext.Provider value={ctx}>
      <div className="sticky top-0 z-10 -mx-1 mb-4 flex flex-wrap items-center gap-3 border-b border-line bg-canvas/95 px-1 py-2 backdrop-blur">
        <p id="save-state" className="text-sm text-ink-muted" role="status" aria-live="polite">
          {stateText}
        </p>
        {validation.kind === 'ready' &&
          (validation.result.errors.length > 0 || validation.result.warnings.length > 0) && (
            <a href="#validation" className="text-sm">
              {[
                validation.result.errors.length > 0 &&
                  `${validation.result.errors.length} ${validation.result.errors.length === 1 ? 'problem' : 'problems'}`,
                validation.result.warnings.length > 0 &&
                  `${validation.result.warnings.length} ${validation.result.warnings.length === 1 ? 'warning' : 'warnings'}`,
              ]
                .filter(Boolean)
                .join(', ')}
            </a>
          )}
        {editable && (
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            disabled={!dirty || save.kind === 'saving'}
            className="ml-auto"
          >
            Save draft
          </Button>
        )}
      </div>
      {save.kind === 'error' && (
        <div className="mb-4">
          <Alert>
            {save.message}{' '}
            {save.conflict && (
              <button type="button" className="underline" onClick={() => window.location.reload()}>
                Reload the latest version
              </button>
            )}
          </Alert>
        </div>
      )}
      {!editable && (
        <div className="mb-4">
          <Alert tone="info">This strategy is running on paper. Stop it to change its rules.</Alert>
        </div>
      )}

      <div className="space-y-6">
        <InstrumentFinder
          instruments={instruments}
          editable={editable}
          onFound={(found) =>
            setInstruments((list) =>
              list.some((i) => i.id === found.id)
                ? list
                : [...list, found].sort((a, b) => a.symbol.localeCompare(b.symbol)),
            )
          }
        />
        {(['entry', 'exit'] as const).map((phase) => {
          const title = phase === 'entry' ? 'Entry' : 'Exit';
          return (
            <Card
              key={phase}
              className={
                phase === 'entry'
                  ? 'border-l-4 border-l-entry bg-entry-soft!'
                  : 'border-l-4 border-l-exit bg-exit-soft!'
              }
            >
              <h2
                id={`${phase}-heading`}
                className={cx(
                  'text-lg font-semibold',
                  phase === 'entry' ? 'text-entry' : 'text-exit',
                )}
              >
                {title}
              </h2>
              <p className="mb-3 text-sm text-ink-muted">
                {phase === 'entry'
                  ? 'The strategy enters when these conditions qualify.'
                  : 'After Entry fills, the strategy exits when these conditions qualify.'}
              </p>
              {phase === 'entry' && <EntryStructure definition={definition} onChange={edit} />}
              <h3 className="mb-2 text-base font-semibold text-cond">{title} conditions</h3>
              <ConditionTreeEditor
                root={definition[phase].condition}
                onChange={setPhaseCondition(phase)}
                label={`${title} conditions`}
                path={[phase, 'condition']}
              />
              {phase === 'exit' && <ExitRulesEditor definition={definition} onChange={edit} />}
              {slotMode === 'none' ? (
                <TriggerSettings
                  phase={phase}
                  value={definition[phase].trigger}
                  onChange={(trigger) => edit((d) => ({ ...d, [phase]: { ...d[phase], trigger } }))}
                />
              ) : (
                <p className="mt-3 text-xs text-ink-muted">
                  Trigger options don&rsquo;t apply here: with{' '}
                  {slotMode === 'selection' ? 'a Selection group' : 'per-leg conditions'} each
                  instrument is evaluated on its own at every scheduled evaluation.
                </p>
              )}
              <OrdersEditor definition={definition} phase={phase} onChange={edit} />
            </Card>
          );
        })}
        <ExecutionAndRisk definition={definition} onChange={edit} />
        <ValidationPanel
          validation={validation}
          definition={definition}
          dirty={dirty}
          onRecheck={recheck}
        />
        <BackTestPanel
          strategyId={strategyId}
          strategyName={strategyName}
          status={status}
          rowVersion={rowVersion}
          dirty={dirty}
          definition={definition}
          validation={validation}
          onBacktestFinished={recheck}
          onChanged={(detail) => {
            setRowVersion(detail.rowVersion);
            router.refresh();
          }}
        />
        {children}
      </div>
    </EditorContext.Provider>
  );
}
