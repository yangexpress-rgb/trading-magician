'use client';

import { ApiError } from '@tm/contracts';
import {
  canonicalJson,
  strategyDefinitionSchema,
  type ConditionGroup,
  type PhaseName,
  type StrategyDefinition,
  type StrategyStatus,
} from '@tm/domain';
import { Alert, Button, Card } from '@tm/ui';
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
import { BackTestPanel, useValidation, ValidationPanel } from '@/components/strategy/lifecycle';
import { OrdersEditor } from '@/components/strategy/orders-editor';
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
  instruments,
  accounts,
  timeZone,
  baseCurrency,
  children,
}: Props) {
  const router = useRouter();
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

  const ctx: EditorContextValue = useMemo(
    () => ({
      instruments,
      accounts,
      timeZone,
      baseCurrency,
      issueAt: (path) => issues.get(pathKey(path)),
      editable,
    }),
    [instruments, accounts, timeZone, baseCurrency, issues, editable],
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
        {(['entry', 'exit'] as const).map((phase) => {
          const title = phase === 'entry' ? 'Entry' : 'Exit';
          return (
            <Card key={phase}>
              <h2 id={`${phase}-heading`} className="text-lg font-semibold">
                {title}
              </h2>
              <p className="mb-3 text-sm text-ink-muted">
                {phase === 'entry'
                  ? 'The strategy enters when these conditions qualify.'
                  : 'After Entry fills, the strategy exits when these conditions qualify.'}
              </p>
              <ConditionTreeEditor
                root={definition[phase].condition}
                onChange={setPhaseCondition(phase)}
                label={`${title} conditions`}
                path={[phase, 'condition']}
              />
              <TriggerSettings
                phase={phase}
                value={definition[phase].trigger}
                onChange={(trigger) => edit((d) => ({ ...d, [phase]: { ...d[phase], trigger } }))}
              />
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
