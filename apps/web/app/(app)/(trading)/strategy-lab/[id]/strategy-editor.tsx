'use client';

import { ApiError } from '@tm/contracts';
import {
  canonicalJson,
  DEFAULT_TRIGGER,
  directionOf,
  hasGroups,
  slotModeOf,
  type SlotMode,
  strategyDefinitionSchema,
  type ConditionGroup,
  type PhaseName,
  type StrategyDefinition,
  type StrategyStatus,
  STATUS_LABELS,
} from '@tm/domain';
import { Alert, Button, Card, cx, ModeBadge } from '@tm/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ConditionTreeEditor } from '@/components/strategy/condition-editor';
import {
  EditorContext,
  pathKey,
  type AccountOption,
  type EditorContextValue,
  type InstrumentOption,
  type MlModelOption,
  type OptionUnderlying,
} from '@/components/strategy/editor-context';
import { useBacktests } from '@/components/strategy/backtest';
import {
  BackTestSection,
  backtestStanding,
  type DraftTested,
  ExecutionSection,
  useValidation,
  ValidationPanel,
  type ValidationState,
} from '@/components/strategy/lifecycle';
import { PageSection, SectionNav } from '@/components/strategy/page-sections';
import { useRowVersion } from '@/components/strategy/row-version';
import { OrdersEditor } from '@/components/strategy/orders-editor';
import {
  ExitRulesEditor,
  ExitScheduleField,
  RiskDistanceEditor,
  ScheduleField,
  WhatToTrade,
} from '@/components/strategy/slots-editor';
import {
  addGroup,
  DIRECTION_LABELS,
  DirectionField,
  GroupHeader,
  GroupScope,
  MAX_GROUPS,
} from '@/components/strategy/entry-groups';
import { ExecutionAndRisk, TriggerSettings } from '@/components/strategy/settings-editor';
import { apiClient } from '@/lib/api-client';
import { tradedAssets } from '@/lib/slot-edits';

interface Props {
  strategyId: string;
  strategyName: string;
  status: StrategyStatus;
  initialDefinition: StrategyDefinition;
  initialRowVersion: number;
  instruments: InstrumentOption[];
  /** Underlyings with options signals, for the options metric picker (brief v2 §6). */
  optionUnderlyings?: OptionUnderlying[];
  /** Registered model series for `ml.score` (ML brief v1 §8). */
  mlModels?: MlModelOption[];
  accounts: AccountOption[];
  timeZone: string;
  baseCurrency: string;
  /** Versions and status history, rendered last in the Execution section. */
  history?: ReactNode;
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

const NO_UNDERLYINGS: OptionUnderlying[] = [];
const NO_MODELS: MlModelOption[] = [];

export function StrategyEditor({
  strategyId,
  strategyName,
  status,
  initialDefinition,
  initialRowVersion,
  instruments: initialInstruments,
  optionUnderlyings = NO_UNDERLYINGS,
  mlModels = NO_MODELS,
  accounts,
  timeZone,
  baseCurrency,
  history,
}: Props) {
  const router = useRouter();
  const [instruments, setInstruments] = useState(initialInstruments);
  const [definition, setDefinition] = useState(initialDefinition);
  const [savedJson, setSavedJson] = useState(() => canonicalJson(initialDefinition));
  // Shared with the header's inline rename (N190).
  const [rowVersion, setRowVersion] = useRowVersion(initialRowVersion);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });

  const editable = status !== 'actively_executing';
  const rulesDirty = useMemo(
    () => canonicalJson(definition) !== savedJson,
    [definition, savedJson],
  );
  const dirty = rulesDirty;
  const issues = useMemo(() => structuralIssues(definition), [definition]);
  const { state: validation, recheck } = useValidation(strategyId, rowVersion);
  const backtests = useBacktests(strategyId);
  const { latestText, draftTested } = backtestStanding(backtests, validation, rulesDirty);

  // When a run ends, check again so validation picks up the new back test.
  const activeId = backtests.active?.id;
  const [watching, setWatching] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (activeId) setWatching(activeId);
    else if (watching) {
      setWatching(undefined);
      recheck();
    }
  }, [activeId, watching, recheck]);

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

  async function onSave() {
    if (issues.size > 0) {
      setSave({ kind: 'error', message: 'Fix the highlighted fields before saving.' });
      return;
    }
    setSave({ kind: 'saving' });
    try {
      const saved = await apiClient.strategies.update(strategyId, {
        rowVersion,
        definition,
      });
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
  // What to trade (ADR 0073): a list group's members, or the Entry legs' instruments.
  const trade = definition.trade;
  const memberIds =
    trade.kind === 'group'
      ? trade.universe.type === 'list'
        ? trade.universe.instrumentIds
        : undefined
      : definition.entry.rankedLegs
        ? definition.entry.orders.map((o) => o.instrumentId)
        : undefined;
  const universeKey = memberIds
    ? memberIds.join(',')
    : trade.kind === 'group' && trade.universe.type === 'builtin'
      ? trade.universe.id
      : '';
  const universeClasses = useMemo(() => {
    if (!memberIds) return ['stock'];
    const classes = new Set(
      memberIds.map((id) => instruments.find((i) => i.id === id)?.assetClass ?? 'stock'),
    );
    return [...classes];
  }, [universeKey, instruments]);

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

  // New conditions start on the stock or ETF in What to trade (N273).
  const defaultInstrumentId = trade.kind === 'assets' ? tradedAssets(definition)[0] : undefined;

  const ctx: EditorContextValue = useMemo(
    () => ({
      instruments,
      defaultInstrumentId,
      addInstrument,
      accounts,
      timeZone,
      baseCurrency,
      issueAt: (path) => issues.get(pathKey(path)),
      editable,
      slotMode,
      universeClasses,
      optionUnderlyings,
      mlModels,
    }),
    [
      instruments,
      defaultInstrumentId,
      addInstrument,
      accounts,
      timeZone,
      baseCurrency,
      issues,
      editable,
      slotMode,
      universeClasses,
      optionUnderlyings,
      mlModels,
    ],
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
        <SectionNav
          states={{
            strategy: dirty ? 'unsaved changes' : strategyState(validation),
            'back-test': BACKTEST_STATE[draftTested],
            execution: STATUS_LABELS[status],
          }}
        />
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

      <div className="space-y-10">
        <PageSection
          id="strategy"
          description="What it trades, when it enters and exits, how orders are sent and the limits they must stay inside."
        >
          {/* Its theory is changed from the line under its name (N191, N192). */}
          <PhaseCards
            definition={definition}
            onChange={edit}
            slotMode={slotMode}
            groupTitle={hasGroups(definition) ? 'Group 1' : undefined}
          />
          {(definition.groups ?? []).map((g, i) => (
            <section
              key={g.id}
              aria-label={`Entry group ${i + 2}: ${g.label}`}
              className="rounded-lg border border-line p-3"
            >
              {/* One summary row per group, so two groups don't read as two strategies (ADR 0049). */}
              <details>
                <summary className="cursor-pointer text-sm">
                  <span className="font-semibold">
                    Entry group {i + 2}: {g.label}
                  </span>{' '}
                  <span className="text-ink-muted">
                    · {DIRECTION_LABELS[directionOf(g.entry)].split(':')[0]} ·{' '}
                    {g.entry.orders.length} Entry {g.entry.orders.length === 1 ? 'leg' : 'legs'},{' '}
                    {g.exit.orders.length} Exit {g.exit.orders.length === 1 ? 'leg' : 'legs'}
                  </span>
                </summary>
                <div className="mt-3 space-y-4">
                  <GroupHeader definition={definition} index={i} onChange={edit} />
                  <GroupScope definition={definition} index={i} onChange={edit}>
                    {(own, set) => (
                      <PhaseCards
                        definition={own}
                        onChange={set}
                        slotMode="none"
                        groupTitle={g.label}
                        idPrefix={`group-${g.id}-`}
                      />
                    )}
                  </GroupScope>
                </div>
              </details>
            </section>
          ))}
          {editable && slotMode === 'none' && (definition.groups?.length ?? 0) < MAX_GROUPS && (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" size="sm" onClick={() => edit((d) => addGroup(d))}>
                Add an entry group
              </Button>
              <p className="text-sm text-ink-muted">
                For example a short breakdown beside a long breakout. The strategy holds one
                position at a time: a group enters only while no position is open, and never flips
                one.
              </p>
            </div>
          )}
          <ExecutionAndRisk definition={definition} onChange={edit} />
          <ValidationPanel
            validation={validation}
            definition={definition}
            dirty={rulesDirty}
            onRecheck={recheck}
          />
        </PageSection>
        <PageSection
          id="back-test"
          description="Runs the saved rules over historical data. Results are estimates, not guarantees."
        >
          <BackTestSection
            backtests={backtests}
            dirty={rulesDirty}
            validation={validation}
            latestText={latestText}
            draftTested={draftTested}
            definition={definition}
            instruments={instruments}
          />
        </PageSection>
        <PageSection
          id="execution"
          badge={<ModeBadge mode="paper" />}
          description="Starting it sends orders to your paper account. Nothing here trades real money."
        >
          <ExecutionSection
            strategyId={strategyId}
            strategyName={strategyName}
            status={status}
            rowVersion={rowVersion}
            dirty={rulesDirty}
            definition={definition}
            validation={validation}
            latestText={latestText}
            draftTested={draftTested}
            onChanged={(detail) => {
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

const BACKTEST_STATE: Record<DraftTested, string> = {
  not_tested: 'not tested',
  unsaved: 'unsaved changes',
  checking: 'checking…',
  matches: 'matches latest',
  changed: 'changed since latest',
};

/** The Strategy jump link's state: what Validation found in the saved draft. */
function strategyState(validation: ValidationState): string {
  if (validation.kind === 'loading') return 'checking…';
  if (validation.kind === 'error') return 'not checked';
  const { errors, warnings } = validation.result;
  const parts = [
    errors.length > 0 && `${errors.length} ${errors.length === 1 ? 'problem' : 'problems'}`,
    warnings.length > 0 && `${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'saved';
}

/**
 * One entry group's Entry and Exit cards: the strategy's own, or a further
 * group's (v1.2 item 8) edited on that group's own definition.
 */
function PhaseCards({
  definition,
  onChange,
  slotMode,
  groupTitle,
  idPrefix = '',
}: {
  definition: StrategyDefinition;
  onChange: (def: StrategyDefinition) => void;
  slotMode: SlotMode;
  /** Set when the strategy has several entry groups. */
  groupTitle?: string | undefined;
  idPrefix?: string;
}) {
  const own = idPrefix === '';
  const direction = directionOf(definition.entry) === 'long' ? 'Long' : 'Short';
  const setPhaseCondition = (phase: PhaseName) => (condition: ConditionGroup) =>
    onChange({ ...definition, [phase]: { ...definition[phase], condition } });
  return (
    <>
      {own && <WhatToTrade definition={definition} onChange={onChange} />}
      {(['entry', 'exit'] as const).map((phase) => {
        const title = phase === 'entry' ? 'Entry' : 'Exit';
        const heading = groupTitle ? `${title}: ${groupTitle} (${direction})` : title;
        // One field, named for its job (ADR 0049).
        const conditionTitle = phase === 'exit' ? 'Exit when' : 'Enter when';
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
              id={`${idPrefix}${phase}-heading`}
              className={cx(
                'text-lg font-semibold',
                phase === 'entry' ? 'text-entry' : 'text-exit',
              )}
            >
              {heading}
            </h2>
            <p className="mb-3 text-sm text-ink-muted">
              {phase === 'entry'
                ? 'The strategy enters when these conditions qualify.'
                : 'After Entry fills, the strategy exits when these conditions qualify.'}
            </p>
            {phase === 'entry' && slotMode === 'none' && (
              <DirectionField definition={definition} id={`${idPrefix}entry-direction`} />
            )}
            {/* Each phase has its own "when" (ADR 0073): Check Entry and Check Exit. */}
            {phase === 'entry' && own && (
              <ScheduleField definition={definition} onChange={onChange} />
            )}
            {phase === 'exit' && own && (
              <ExitScheduleField definition={definition} onChange={onChange} />
            )}
            {phase === 'entry' && (
              <RiskDistanceEditor definition={definition} onChange={onChange} idPrefix={idPrefix} />
            )}
            <h3 className="mb-1 text-base font-semibold text-cond">{conditionTitle}</h3>
            {phase === 'entry' && slotMode === 'selection' && (
              <p className="mb-2 text-xs text-ink-muted">
                Conditions on &ldquo;this stock&rdquo; are checked for each pick; conditions on a
                named symbol, such as a market regime filter, are checked once for the whole
                strategy. Leave it empty to enter on every Check Entry.
              </p>
            )}
            <ConditionTreeEditor
              root={definition[phase].condition}
              onChange={setPhaseCondition(phase)}
              label={groupTitle ? `${conditionTitle}: ${groupTitle}` : conditionTitle}
              path={[phase, 'condition']}
            />
            {slotMode === 'none' && definition[phase].trigger ? (
              <TriggerSettings
                idPrefix={idPrefix}
                phase={phase}
                value={definition[phase].trigger ?? DEFAULT_TRIGGER}
                onChange={(trigger) =>
                  onChange({ ...definition, [phase]: { ...definition[phase], trigger } })
                }
              />
            ) : (
              <p className="mt-3 text-xs text-ink-muted">
                {phase === 'entry'
                  ? `With ${slotMode === 'selection' ? 'a group' : 'per-leg conditions'} each instrument is evaluated on its own at every Check Entry.`
                  : 'Exit when exits on every Check Exit it is true: there is nothing to confirm or wait for.'}
              </p>
            )}
            {phase === 'exit' && <ExitRulesEditor definition={definition} onChange={onChange} />}
            <OrdersEditor definition={definition} phase={phase} onChange={onChange} />
          </Card>
        );
      })}
    </>
  );
}
