'use client';

import { ApiError, type LibraryEntryDto } from '@tm/contracts';
import {
  CATEGORY_LABELS,
  DATA_NEED_LABELS,
  DATA_NEEDS,
  DIRECTION_LABELS,
  DURATION_UNITS,
  EVIDENCE_LABELS,
  EVIDENCE_LEVELS,
  LIBRARY_CATEGORIES,
  LIBRARY_DIRECTIONS,
  LIBRARY_MATURITIES,
  MATURITY_LABELS,
  PARAMETERS_MAX,
  REBALANCE_LABELS,
  REBALANCE_SCHEDULES,
  SHORT_DESCRIPTION_MAX,
  SIZING_LABELS,
  SIZING_METHODS,
  STOP_LABELS,
  STOP_METHODS,
  UNIVERSE_KINDS,
  UNIVERSE_LABELS,
  type ConventionTables,
  type DataNeed,
  type LibraryDirection,
  type LibraryMaturity,
  type DurationUnit,
  type EvidenceLevel,
  type LibraryCategory,
  type LibraryDuration,
} from '@tm/domain';
import { Alert, Button, Card, SelectField, TextField } from '@tm/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { apiClient } from '@/lib/api-client';
import {
  clearedProfileFields,
  loadProfileDraft,
  profileToRecord,
  unloadedFieldsMessage,
  unloadedProfileFields,
  type PairDraft,
  type ParameterDraft,
} from '@/lib/library-profile-form';
import { codeOption } from '@/lib/library-text';

/**
 * The register and edit form of the Strategy Library (ADR 0051). Registering
 * shows the number the entry is expected to get, from the server, which
 * reserves nothing: the number is issued only when the form is saved. Editing
 * covers every field except the number and the convention version, and needs
 * a change note.
 */

export interface LinkableStrategy {
  id: string;
  name: string;
  archived: boolean;
}

interface DurationDraft {
  kind: 'every' | 'per' | 'unknown';
  value: string;
  unit: DurationUnit | '';
  low: string;
  high: string;
}

interface UsedByDraft {
  who: string;
  what: string;
  evidence: EvidenceLevel | '';
  source: string;
}

interface SourceDraft {
  title: string;
  url: string;
  citation: string;
}

const UNIT_LABELS: Record<DurationUnit, string> = {
  seconds: 'seconds',
  minutes: 'minutes',
  hours: 'hours',
  days: 'days',
  weeks: 'weeks',
  months: 'months',
  quarters: 'quarters',
  years: 'years',
};

const control =
  'mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-muted aria-[invalid=true]:border-danger';

function toDraft(d: LibraryDuration | undefined, fallback: DurationDraft['kind']): DurationDraft {
  if (!d) return { kind: fallback, value: '', unit: '', low: '', high: '' };
  if (d.kind === 'unknown') return { kind: 'unknown', value: '', unit: '', low: '', high: '' };
  return {
    kind: d.kind,
    value: String(d.value),
    unit: d.unit,
    low: d.low === undefined ? '' : String(d.low),
    high: d.high === undefined ? '' : String(d.high),
  };
}

function fromDraft(d: DurationDraft): unknown {
  if (d.kind === 'unknown') return { kind: 'unknown' };
  const n = (s: string) => (s.trim() === '' ? undefined : Number(s));
  return {
    kind: d.kind,
    value: n(d.value),
    unit: d.unit || undefined,
    ...(n(d.low) !== undefined || n(d.high) !== undefined
      ? { low: n(d.low), high: n(d.high) }
      : {}),
  };
}

const splitList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export function LibraryEntryForm({
  mode,
  tables,
  conventionLabel,
  existingNames,
  strategies,
  entry,
}: {
  mode: 'register' | 'edit';
  /** The current convention's code tables (register) or the issuing one's (edit). */
  tables: ConventionTables;
  conventionLabel: string;
  existingNames: { registrationNumber: string; name: string }[];
  strategies: LinkableStrategy[];
  entry?: LibraryEntryDto;
}) {
  const router = useRouter();
  const [recordType, setRecordType] = useState(
    entry?.recordTypeCode ?? tables.recordType[0]?.code ?? 'S',
  );
  const [timeframe, setTimeframe] = useState(entry?.timeframeCode ?? '');
  const [assetClass, setAssetClass] = useState(entry?.assetClassCode ?? '');
  const [name, setName] = useState(entry?.name ?? '');
  const [category, setCategory] = useState<LibraryCategory | ''>(entry?.category ?? '');
  const [tags, setTags] = useState(entry?.tags.join(', ') ?? '');
  const [shortDescription, setShortDescription] = useState(entry?.shortDescription ?? '');
  const [longDescription, setLongDescription] = useState(entry?.longDescription ?? '');
  const [assets, setAssets] = useState(entry?.assets ?? '');
  const [dataRequirements, setDataRequirements] = useState(entry?.dataRequirements ?? '');
  const [entryRule, setEntryRule] = useState(entry?.entry ?? '');
  const [exitRule, setExitRule] = useState(entry?.exit ?? '');
  const [frequency, setFrequency] = useState(toDraft(entry?.frequency, 'every'));
  const [turnaround, setTurnaround] = useState(toDraft(entry?.turnaround, 'every'));
  const [usedBy, setUsedBy] = useState<UsedByDraft[]>(entry?.usedBy ?? []);
  const [trackRecord, setTrackRecord] = useState(entry?.trackRecord ?? '');
  const [backtestSummary, setBacktestSummary] = useState(entry?.backtestSummary ?? '');
  const [sources, setSources] = useState<SourceDraft[]>(
    entry?.sources.map((s) => ({ title: s.title, url: s.url ?? '', citation: s.citation ?? '' })) ??
      [],
  );
  const [related, setRelated] = useState(
    entry?.relatedEntries.map((r) => r.registrationNumber).join(', ') ?? '',
  );
  const [builtStrategyId, setBuiltStrategyId] = useState(entry?.builtStrategyId ?? '');
  // The stored profile as the form opened it; saves compare against this.
  const [loaded] = useState(() => loadProfileDraft(entry));
  const [direction, setDirection] = useState<LibraryDirection | ''>(loaded.direction);
  const [parameters, setParameters] = useState<ParameterDraft[]>(loaded.parameters);
  const [sizing, setSizing] = useState<PairDraft>(loaded.sizing);
  const [stop, setStop] = useState<PairDraft>(loaded.stop);
  const [schedule, setSchedule] = useState<PairDraft>(loaded.schedule);
  const [universe, setUniverse] = useState<PairDraft>(loaded.universe);
  const [maturity, setMaturity] = useState<LibraryMaturity>(loaded.maturity);
  const [keyRisks, setKeyRisks] = useState(loaded.keyRisks);
  const [dataNeeds, setDataNeeds] = useState<DataNeed[]>(loaded.dataNeeds);
  const [changeNote, setChangeNote] = useState('');
  const [preview, setPreview] = useState<{ number?: string; error?: string }>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Live preview of the expected number; nothing is reserved.
  useEffect(() => {
    if (mode !== 'register' || !timeframe || !assetClass) {
      setPreview({});
      return;
    }
    let live = true;
    const load = () =>
      apiClient.library
        .nextNumber({ recordType, timeframe, asset: assetClass })
        .then((r) => live && setPreview({ number: r.registrationNumber }))
        .catch(
          (e: unknown) =>
            live &&
            setPreview({ error: e instanceof ApiError ? e.message : 'Preview unavailable' }),
        );
    void load();
    // Someone else may register meanwhile; keep the preview fresh.
    const timer = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [mode, recordType, timeframe, assetClass]);

  const duplicate = existingNames.find(
    (n) =>
      n.registrationNumber !== entry?.registrationNumber &&
      n.name.trim().toLowerCase() === name.trim().toLowerCase() &&
      name.trim() !== '',
  );
  const otherLink =
    entry?.builtStrategyId && !strategies.some((s) => s.id === entry.builtStrategyId)
      ? entry.builtStrategyId
      : null;

  async function submit() {
    setPending(true);
    setError(undefined);
    setFieldErrors({});
    const profile = {
      direction,
      parameters,
      sizing,
      stop,
      schedule,
      universe,
      maturity,
      keyRisks,
      dataNeeds,
    };
    if (mode === 'edit') {
      // Refuse rather than wipe a stored field the form did not load.
      const unloaded = unloadedProfileFields(entry, loaded);
      if (unloaded.length) {
        setError(unloadedFieldsMessage(unloaded));
        setPending(false);
        return;
      }
    }
    const fields = {
      name,
      category: category || undefined,
      tags: splitList(tags),
      shortDescription,
      longDescription,
      assets,
      dataRequirements,
      entry: entryRule,
      exit: exitRule,
      frequency: fromDraft(frequency),
      turnaround: fromDraft(turnaround),
      usedBy,
      trackRecord,
      backtestSummary,
      sources,
      relatedEntries: splitList(related),
      builtStrategyId: builtStrategyId || null,
      ...profileToRecord(profile, entry),
    };
    try {
      if (mode === 'register') {
        const saved = await apiClient.library.register({
          ...fields,
          recordTypeCode: recordType,
          timeframeCode: timeframe,
          assetClassCode: assetClass,
        } as never);
        router.push(`/library/${saved.registrationNumber}`);
      } else if (entry) {
        await apiClient.library.update(entry.registrationNumber, {
          ...fields,
          changeNote,
          rowVersion: entry.rowVersion,
          clearedFields: clearedProfileFields(entry, loaded, profile),
        } as never);
        router.push(`/library/${entry.registrationNumber}`);
        router.refresh();
      }
    } catch (e) {
      if (e instanceof ApiError) {
        const map: Record<string, string> = {};
        for (const issue of e.body.issues ?? []) {
          const key = issue.path.join('.');
          map[key] ??= issue.message;
        }
        setFieldErrors(map);
        setError(
          e.body.issues?.length
            ? `${e.body.issues.length === 1 ? 'One field needs' : `${e.body.issues.length} fields need`} attention: ${e.body.issues[0]?.message ?? ''}`
            : e.message,
        );
      } else setError('Could not save. Try again.');
      setPending(false);
    }
  }

  const err = (path: string) => fieldErrors[path];

  return (
    <form action={submit} className="space-y-4" noValidate>
      {mode === 'register' && (
        <Card>
          <h2 className="mb-1 font-semibold">Registration number</h2>
          <p className="mb-3 text-sm text-ink-muted">
            The letters come from convention {conventionLabel}: record type, the timeframe the
            strategy decides on (not how long it holds), and what it trades. The number is issued
            when you save and never changes.
          </p>
          <div className="grid-fields gap-3">
            {tables.recordType.length > 1 && (
              <SelectField
                label="Record type"
                name="lib-record-type"
                value={recordType}
                onChange={(e) => setRecordType(e.target.value)}
              >
                {tables.recordType.map((c) => (
                  <option key={c.code} value={c.code}>
                    {codeOption(c)}
                  </option>
                ))}
              </SelectField>
            )}
            <SelectField
              label="Timeframe (decision timescale)"
              name="lib-timeframe"
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              error={err('timeframeCode')}
              required
            >
              <option value="">Choose…</option>
              {tables.timeframe.map((c) => (
                <option key={c.code} value={c.code} title={c.note}>
                  {codeOption(c)}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Asset class (what it trades)"
              name="lib-asset-class"
              value={assetClass}
              onChange={(e) => setAssetClass(e.target.value)}
              error={err('assetClassCode')}
              hint="An index used only as a signal does not set this."
              required
            >
              <option value="">Choose…</option>
              {tables.assetClass.map((c) => (
                <option key={c.code} value={c.code} title={c.note}>
                  {codeOption(c)}
                </option>
              ))}
            </SelectField>
          </div>
          <p className="mt-3 text-sm" aria-live="polite" data-testid="number-preview">
            {preview.number ? (
              <>
                This will be registered as{' '}
                <span className="font-mono font-semibold">{preview.number}</span> if saved now.
              </>
            ) : preview.error ? (
              <span className="text-danger">{preview.error}</span>
            ) : (
              <span className="text-ink-muted">
                Choose a timeframe and an asset class to see the expected number.
              </span>
            )}
          </p>
        </Card>
      )}

      <Card>
        <h2 className="mb-3 font-semibold">What it is</h2>
        <div className="space-y-3">
          <TextField
            label="Name"
            name="lib-name"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={err('name')}
            hint={
              duplicate
                ? `${duplicate.registrationNumber} already uses this name. Names need not be unique; the number is the identity.`
                : undefined
            }
          />
          <div className="grid-fields gap-3">
            <SelectField
              label="Category"
              name="lib-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as LibraryCategory)}
              error={err('category')}
              required
            >
              <option value="">Choose…</option>
              {LIBRARY_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Tags (optional, comma-separated)"
              name="lib-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              error={
                err('tags') ??
                fieldErrors[Object.keys(fieldErrors).find((k) => k.startsWith('tags.')) ?? '']
              }
              placeholder="needs-options, paper-only"
            />
          </div>
          <TextArea
            label={`Short description (${shortDescription.length}/${SHORT_DESCRIPTION_MAX})`}
            name="lib-short"
            rows={2}
            maxLength={SHORT_DESCRIPTION_MAX}
            value={shortDescription}
            onChange={(e) => setShortDescription(e.target.value)}
            error={err('shortDescription')}
            hint="One or two sentences: what it is. Shown in the list."
          />
          <TextArea
            label="Long description"
            name="lib-long"
            rows={7}
            value={longDescription}
            onChange={(e) => setLongDescription(e.target.value)}
            error={err('longDescription')}
            hint="The idea, how it works, conditions in words, risks and caveats. Markdown: **bold**, *italic*, - lists, [links](https://…)."
          />
          <TextField
            label="Assets traded"
            name="lib-assets"
            required
            maxLength={500}
            value={assets}
            onChange={(e) => setAssets(e.target.value)}
            error={err('assets')}
            placeholder="S&P 500 stocks, SPY only, 9 sector ETFs…"
          />
          <TextArea
            label="Data requirements (optional)"
            name="lib-data"
            rows={2}
            value={dataRequirements}
            onChange={(e) => setDataRequirements(e.target.value)}
            error={err('dataRequirements')}
            hint="What it needs to run, and what blocks it if it is not built."
          />
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 font-semibold">Trading rules and time</h2>
        <div className="space-y-3">
          <TextArea
            label="Entry"
            name="lib-entry"
            rows={3}
            value={entryRule}
            onChange={(e) => setEntryRule(e.target.value)}
            error={err('entry')}
            hint="The condition, the timing or both, in words with the numbers."
          />
          <TextArea
            label="Exit"
            name="lib-exit"
            rows={3}
            value={exitRule}
            onChange={(e) => setExitRule(e.target.value)}
            error={err('exit')}
            hint="The condition, timing, stops and time stops, in words."
          />
          <DurationFields
            legend="Frequency: how often it opens new positions"
            name="lib-frequency"
            value={frequency}
            onChange={setFrequency}
            kinds={['every', 'per']}
            errors={fieldErrors}
            path="frequency"
          />
          <DurationFields
            legend="Turnaround time: typical holding period"
            name="lib-turnaround"
            value={turnaround}
            onChange={setTurnaround}
            kinds={['every', 'unknown']}
            errors={fieldErrors}
            path="turnaround"
          />
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 font-semibold">Strategy profile</h2>
        <p className="mb-3 text-sm text-ink-muted">
          What the research says about how it trades. Leave a choice at Not specified when the
          research does not say; it is shown as such, never left blank.
        </p>
        <div className="space-y-4">
          <div className="grid-fields gap-3">
            <SelectField
              label="Direction"
              name="lib-direction"
              value={direction}
              onChange={(e) => setDirection(e.target.value as LibraryDirection | '')}
              error={err('direction')}
            >
              <option value="">Not specified</option>
              {LIBRARY_DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {DIRECTION_LABELS[d]}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Maturity"
              name="lib-maturity"
              value={maturity}
              onChange={(e) => setMaturity(e.target.value as LibraryMaturity)}
              error={err('maturity')}
              hint="Paper trading and live are set by hand."
              required
            >
              {LIBRARY_MATURITIES.map((m) => (
                <option key={m} value={m}>
                  {MATURITY_LABELS[m]}
                </option>
              ))}
            </SelectField>
          </div>

          <fieldset>
            <legend className="text-sm font-medium">
              Parameters ({parameters.length}/{PARAMETERS_MAX})
            </legend>
            <p className="text-xs text-ink-muted">
              The numbers the rules use, such as a 200-day lookback.
            </p>
            {err('parameters') && (
              <p className="mt-1 text-xs font-medium text-danger">{err('parameters')}</p>
            )}
            <div className="mt-2 space-y-2">
              {parameters.map((p, i) => (
                <div
                  key={i}
                  className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[2fr_2fr_1fr_auto]"
                >
                  <TextField
                    label={`Parameter ${i + 1}`}
                    name={`lib-param-${i}-name`}
                    maxLength={80}
                    value={p.name}
                    onChange={(e) => setParameters(edit(parameters, i, { name: e.target.value }))}
                    error={err(`parameters.${i}.name`)}
                  />
                  <TextField
                    label="Value"
                    name={`lib-param-${i}-value`}
                    maxLength={120}
                    value={p.value}
                    onChange={(e) => setParameters(edit(parameters, i, { value: e.target.value }))}
                    error={err(`parameters.${i}.value`)}
                  />
                  <TextField
                    label="Unit (optional)"
                    name={`lib-param-${i}-unit`}
                    maxLength={20}
                    value={p.unit}
                    onChange={(e) => setParameters(edit(parameters, i, { unit: e.target.value }))}
                    error={err(`parameters.${i}.unit`)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setParameters(parameters.filter((_, j) => j !== i))}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              {parameters.length < PARAMETERS_MAX && (
                <Button
                  size="sm"
                  onClick={() => setParameters([...parameters, { name: '', value: '', unit: '' }])}
                >
                  Add a parameter
                </Button>
              )}
            </div>
          </fieldset>

          <PairFields
            legend="Position sizing"
            name="lib-sizing"
            choiceLabel="Method"
            options={SIZING_METHODS.map((m) => [m, SIZING_LABELS[m]])}
            value={sizing}
            onChange={setSizing}
            errors={fieldErrors}
            path="positionSizing"
          />
          <PairFields
            legend="Stop loss"
            name="lib-stop"
            choiceLabel="Method"
            options={STOP_METHODS.map((m) => [m, STOP_LABELS[m]])}
            value={stop}
            onChange={setStop}
            errors={fieldErrors}
            path="stopLoss"
          />
          <PairFields
            legend="Rebalance schedule"
            name="lib-schedule"
            choiceLabel="Schedule"
            options={REBALANCE_SCHEDULES.map((m) => [m, REBALANCE_LABELS[m]])}
            value={schedule}
            onChange={setSchedule}
            errors={fieldErrors}
            path="rebalanceSchedule"
          />
          <PairFields
            legend="Universe: what it picks from"
            name="lib-universe"
            choiceLabel="Kind"
            options={UNIVERSE_KINDS.map((m) => [m, UNIVERSE_LABELS[m]])}
            value={universe}
            onChange={setUniverse}
            errors={fieldErrors}
            path="universe"
          />

          <TextArea
            label="Key risks (optional)"
            name="lib-key-risks"
            rows={3}
            maxLength={4000}
            value={keyRisks}
            onChange={(e) => setKeyRisks(e.target.value)}
            error={err('keyRisks')}
            hint="How it fails: the conditions that hurt it and what the research leaves out."
          />

          <fieldset>
            <legend className="text-sm font-medium">Data needs</legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {DATA_NEEDS.map((d) => (
                <label key={d} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    name="lib-data-needs"
                    value={d}
                    checked={dataNeeds.includes(d)}
                    onChange={(e) =>
                      setDataNeeds(
                        e.target.checked ? [...dataNeeds, d] : dataNeeds.filter((x) => x !== d),
                      )
                    }
                  />
                  {DATA_NEED_LABELS[d]}
                </label>
              ))}
            </div>
            {err('dataNeeds') && (
              <p className="mt-1 text-xs font-medium text-danger">{err('dataNeeds')}</p>
            )}
          </fieldset>
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 font-semibold">Who used it before</h2>
        <p className="mb-3 text-sm text-ink-muted">
          Name a person or firm only with a source, and say how solid the evidence is. Leave it
          empty when no prior use is known.
        </p>
        <div className="space-y-3">
          {usedBy.map((u, i) => (
            <fieldset key={i} className="rounded-md border border-line p-3">
              <legend className="px-1 text-sm font-medium">Prior user {i + 1}</legend>
              <div className="grid-fields-wide gap-3">
                <TextField
                  label="Who"
                  name={`lib-usedby-${i}-who`}
                  value={u.who}
                  onChange={(e) => setUsedBy(edit(usedBy, i, { who: e.target.value }))}
                  error={err(`usedBy.${i}.who`)}
                />
                <SelectField
                  label="Evidence"
                  name={`lib-usedby-${i}-evidence`}
                  value={u.evidence}
                  onChange={(e) =>
                    setUsedBy(edit(usedBy, i, { evidence: e.target.value as EvidenceLevel }))
                  }
                  error={err(`usedBy.${i}.evidence`)}
                >
                  <option value="">Choose…</option>
                  {EVIDENCE_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {EVIDENCE_LABELS[l]}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  label="What they did"
                  name={`lib-usedby-${i}-what`}
                  value={u.what}
                  onChange={(e) => setUsedBy(edit(usedBy, i, { what: e.target.value }))}
                  error={err(`usedBy.${i}.what`)}
                />
                <TextField
                  label="Source (link or citation)"
                  name={`lib-usedby-${i}-source`}
                  value={u.source}
                  onChange={(e) => setUsedBy(edit(usedBy, i, { source: e.target.value }))}
                  error={err(`usedBy.${i}.source`)}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => setUsedBy(usedBy.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </fieldset>
          ))}
          <Button
            size="sm"
            onClick={() => setUsedBy([...usedBy, { who: '', what: '', evidence: '', source: '' }])}
          >
            Add a prior user
          </Button>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 font-semibold">Evidence and links</h2>
        <div className="space-y-3">
          <TextArea
            label="Track record (optional)"
            name="lib-track"
            rows={3}
            value={trackRecord}
            onChange={(e) => setTrackRecord(e.target.value)}
            error={err('trackRecord')}
            hint="Published or observed results with their window and caveats (back test or live, survivorship, costs). Never a promise."
          />
          <TextField
            label="Back test summary (optional)"
            name="lib-backtest"
            maxLength={500}
            value={backtestSummary}
            onChange={(e) => setBacktestSummary(e.target.value)}
            error={err('backtestSummary')}
            placeholder="Window, return, max drawdown, cycles"
          />
          <div className="space-y-3">
            <p className="text-sm font-medium">Sources (optional)</p>
            {sources.map((s, i) => (
              <fieldset key={i} className="rounded-md border border-line p-3">
                <legend className="px-1 text-sm font-medium">Source {i + 1}</legend>
                <div className="grid-fields-wide gap-3">
                  <TextField
                    label="Title"
                    name={`lib-source-${i}-title`}
                    value={s.title}
                    onChange={(e) => setSources(edit(sources, i, { title: e.target.value }))}
                    error={err(`sources.${i}.title`)}
                  />
                  <TextField
                    label="Link"
                    name={`lib-source-${i}-url`}
                    type="url"
                    value={s.url}
                    onChange={(e) => setSources(edit(sources, i, { url: e.target.value }))}
                    error={err(`sources.${i}.url`)}
                  />
                  <TextField
                    label="Citation"
                    name={`lib-source-${i}-citation`}
                    value={s.citation}
                    onChange={(e) => setSources(edit(sources, i, { citation: e.target.value }))}
                    error={err(`sources.${i}.citation`)}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  onClick={() => setSources(sources.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </fieldset>
            ))}
            <Button
              size="sm"
              onClick={() => setSources([...sources, { title: '', url: '', citation: '' }])}
            >
              Add a source
            </Button>
          </div>
          <TextField
            label="Related entries (optional, registration numbers, comma-separated)"
            name="lib-related"
            value={related}
            onChange={(e) => setRelated(e.target.value)}
            error={
              err('relatedEntries') ??
              fieldErrors[
                Object.keys(fieldErrors).find((k) => k.startsWith('relatedEntries.')) ?? ''
              ]
            }
          />
          <SelectField
            label="Built in Strategy Lab (optional)"
            name="lib-built"
            value={builtStrategyId}
            onChange={(e) => setBuiltStrategyId(e.target.value)}
            error={err('builtStrategyId')}
            hint="Link one of your own strategies. Others see the entry as built without seeing your strategy."
          >
            <option value="">Not built</option>
            {otherLink && (
              <option value={otherLink}>Keep the current link (another member’s strategy)</option>
            )}
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.archived ? `${s.name} (archived)` : s.name}
              </option>
            ))}
          </SelectField>
        </div>
      </Card>

      {mode === 'edit' && (
        <Card>
          <TextField
            label="Change note"
            name="lib-change-note"
            required
            maxLength={500}
            value={changeNote}
            onChange={(e) => setChangeNote(e.target.value)}
            error={err('changeNote')}
            hint="What changed and why, in a sentence. It is kept in the entry’s history."
          />
        </Card>
      )}

      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : mode === 'register' ? 'Register' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

function edit<T>(list: T[], i: number, patch: Partial<T>): T[] {
  return list.map((item, j) => (j === i ? { ...item, ...patch } : item));
}

function TextArea({
  label,
  name,
  error,
  hint,
  ...rest
}: {
  label: ReactNode;
  name: string;
  error?: string | undefined;
  hint?: ReactNode;
} & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const described = error ? `${name}-error` : hint ? `${name}-hint` : undefined;
  return (
    <div>
      <label htmlFor={name} className="block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={name}
        name={name}
        aria-invalid={!!error}
        aria-describedby={described}
        className={control}
        {...rest}
      />
      {hint && !error && (
        <p id={`${name}-hint`} className="mt-1 text-xs text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${name}-error`} className="mt-1 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function PairFields({
  legend,
  name,
  choiceLabel,
  options,
  value,
  onChange,
  errors,
  path,
}: {
  legend: string;
  name: string;
  choiceLabel: string;
  options: [string, string][];
  value: PairDraft;
  onChange: (d: PairDraft) => void;
  errors: Record<string, string>;
  path: string;
}) {
  const error = Object.entries(errors).find(([k]) => k === path || k.startsWith(`${path}.`))?.[1];
  return (
    <fieldset>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_2fr]">
        <SelectField
          label={choiceLabel}
          name={`${name}-choice`}
          value={value.choice}
          onChange={(e) => onChange({ ...value, choice: e.target.value })}
        >
          {options.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Detail (optional)"
          name={`${name}-detail`}
          maxLength={500}
          value={value.detail}
          onChange={(e) => onChange({ ...value, detail: e.target.value })}
        />
      </div>
      {error && <p className="mt-1 text-xs font-medium text-danger">{error}</p>}
    </fieldset>
  );
}

const KIND_LABELS: Record<DurationDraft['kind'], string> = {
  every: 'Once every…',
  per: 'Times per…',
  unknown: 'Unknown',
};

function DurationFields({
  legend,
  name,
  value,
  onChange,
  kinds,
  errors,
  path,
}: {
  legend: string;
  name: string;
  value: DurationDraft;
  onChange: (d: DurationDraft) => void;
  kinds: DurationDraft['kind'][];
  errors: Record<string, string>;
  path: string;
}) {
  const id = useId();
  const set = (patch: Partial<DurationDraft>) => onChange({ ...value, ...patch });
  const error = Object.entries(errors).find(([k]) => k === path || k.startsWith(`${path}.`))?.[1];
  return (
    <fieldset aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="mt-1 grid-fields gap-3">
        <SelectField
          label="Kind"
          name={`${name}-kind`}
          value={value.kind}
          onChange={(e) => set({ kind: e.target.value as DurationDraft['kind'] })}
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </SelectField>
        {value.kind !== 'unknown' && (
          <>
            <TextField
              label={value.kind === 'per' ? 'Typical count' : 'Typical value'}
              name={`${name}-value`}
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={value.value}
              onChange={(e) => set({ value: e.target.value })}
            />
            <SelectField
              label={value.kind === 'per' ? 'Per' : 'Unit'}
              name={`${name}-unit`}
              value={value.unit}
              onChange={(e) => set({ unit: e.target.value as DurationUnit })}
            >
              <option value="">Choose…</option>
              {DURATION_UNITS.map((u) => (
                <option key={u} value={u}>
                  {value.kind === 'per' ? UNIT_LABELS[u].replace(/s$/, '') : UNIT_LABELS[u]}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Range low (optional)"
              name={`${name}-low`}
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={value.low}
              onChange={(e) => set({ low: e.target.value })}
            />
            <TextField
              label="Range high (optional)"
              name={`${name}-high`}
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={value.high}
              onChange={(e) => set({ high: e.target.value })}
            />
          </>
        )}
      </div>
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}
