/**
 * The Strategy Library v2 field backfill (ADR 0055, brief "Strategy Library
 * v2" §2.3). Dry run by default: prints a Markdown report of every value it
 * would write, with its source, and lists every value left Not specified. It
 * writes nothing.
 *
 *   pnpm --filter @tm/db library:backfill-v2 [-- --apply] [-- --out report.md]
 *
 * With --apply it writes the values in one transaction, with one history row
 * per entry ("Backfilled Library v2 fields", naming the fields). A field that
 * already holds someone's value is kept. Re-running changes nothing. Needs the
 * owner connection (DATABASE_URL). Staging only, after Yong has reviewed the
 * dry-run report.
 */
import { writeFileSync } from 'node:fs';
import {
  DATA_NEED_LABELS,
  DIRECTION_LABELS,
  MATURITY_LABELS,
  REBALANCE_LABELS,
  SIZING_LABELS,
  STOP_LABELS,
  UNIVERSE_LABELS,
  type DataNeed,
  type LibraryParameter,
} from '@tm/domain';
import { createDb } from '../src/client';
import { loadOwnerDbEnv } from '../src/env';
import {
  applyBackfillV2,
  planBackfillV2,
  type BackfillFieldPlan,
  type BackfillPlan,
} from '../src/library-backfill-v2';
import { DEFAULT_SOURCES, type BackfillField } from '../src/library-backfill-v2-data';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const outIndex = args.indexOf('--out');
const outFile = outIndex >= 0 ? args[outIndex + 1] : undefined;

const LABELS: Record<string, string> = {
  direction: 'Direction',
  parameters: 'Parameters',
  positionSizing: 'Position sizing',
  stopLoss: 'Stop loss',
  rebalanceSchedule: 'Rebalance schedule',
  maturity: 'Maturity',
  keyRisks: 'Key risks',
  dataNeeds: 'Data needs',
  universe: 'Universe',
};

function show(field: string, value: unknown): string {
  if (value === null || value === undefined) return 'Not specified';
  const pair = (label: string | undefined, detail?: string) =>
    detail ? `${label ?? '?'} — ${detail}` : (label ?? '?');
  const v = value as Record<string, string>;
  switch (field) {
    case 'direction':
      return DIRECTION_LABELS[value as keyof typeof DIRECTION_LABELS];
    case 'maturity':
      return MATURITY_LABELS[value as keyof typeof MATURITY_LABELS];
    case 'parameters': {
      const list = value as LibraryParameter[];
      return list.length
        ? list.map((p) => `${p.name} = ${p.value}${p.unit ? ` ${p.unit}` : ''}`).join('; ')
        : 'Not specified';
    }
    case 'positionSizing':
      return pair(SIZING_LABELS[v.method as keyof typeof SIZING_LABELS], v.detail);
    case 'stopLoss':
      return pair(STOP_LABELS[v.method as keyof typeof STOP_LABELS], v.detail);
    case 'rebalanceSchedule':
      return pair(REBALANCE_LABELS[v.schedule as keyof typeof REBALANCE_LABELS], v.detail);
    case 'universe':
      return pair(UNIVERSE_LABELS[v.kind as keyof typeof UNIVERSE_LABELS], v.detail);
    case 'dataNeeds': {
      const list = value as DataNeed[];
      return list.length ? list.map((d) => DATA_NEED_LABELS[d]).join(', ') : 'Not specified';
    }
    default:
      return String(value);
  }
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function report(plan: BackfillPlan, applied: boolean): string {
  const lines: string[] = [];
  const out = (l = '') => lines.push(l);
  const all = plan.entries.flatMap((e) => e.fields);
  const count = (a: BackfillFieldPlan['action']) => all.filter((f) => f.action === a).length;
  out(`# Strategy Library v2 field backfill — ${applied ? 'applied' : 'dry run'}`);
  out();
  out(`Generated ${new Date().toISOString()}. ${plan.entries.length} seed entries.`);
  out(
    `Fields to set: ${count('set')}. Already the same: ${count('same')}. Kept because someone already wrote a value: ${count('kept')}.`,
  );
  out(
    `Not specified after the backfill: ${all.filter((f) => f.unspecified).length} values (listed at the end).`,
  );
  if (plan.problems.length) {
    out();
    out('## Problems (nothing will be written)');
    for (const p of plan.problems) out(`- ${p}`);
  }
  if (plan.missing.length) out(`\nSeed entries not in this library: ${plan.missing.join(', ')}.`);
  if (plan.skipped.length) {
    out(
      `\nNot from the seed, left alone: ${plan.skipped.map((s) => `${s.registrationNumber} ${s.name}`).join('; ')}.`,
    );
  }
  for (const e of plan.entries) {
    out();
    out(`## ${e.registrationNumber} — ${e.name}`);
    out();
    out('| Field | Value | Source | Action |');
    out('|---|---|---|---|');
    for (const f of e.fields) {
      const action = f.action === 'kept' ? `kept (now: ${show(f.field, f.current)})` : f.action;
      out(
        `| ${LABELS[f.field]} | ${cell(show(f.field, f.value))} | ${cell(f.unspecified && f.source === DEFAULT_SOURCES[f.field as BackfillField] ? 'not in the sources' : f.source)} | ${cell(action)} |`,
      );
    }
    for (const n of e.notes) out(`\n- Note: ${n}`);
  }
  out();
  out('## Every value left Not specified');
  out();
  for (const e of plan.entries) {
    const u = e.fields.filter((f) => f.unspecified).map((f) => LABELS[f.field]);
    if (u.length) out(`- ${e.registrationNumber}: ${u.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

const { DATABASE_URL } = loadOwnerDbEnv();
const { db, close } = createDb(DATABASE_URL, { max: 1 });
try {
  const plan = apply
    ? await db.transaction((tx) => applyBackfillV2(tx))
    : await db.transaction((tx) => planBackfillV2(tx));
  const text = report(plan, apply);
  if (outFile) writeFileSync(outFile, text);
  process.stdout.write(text);
  if (apply)
    process.stdout.write(`\nApplied: ${'updated' in plan ? plan.updated : 0} entries updated.\n`);
  else process.stdout.write('\nDry run. Add --apply to write.\n');
  process.exitCode = plan.problems.length ? 1 : 0;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await close();
}
