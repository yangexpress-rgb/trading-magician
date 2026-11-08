/**
 * The Strategy Library convention v2 renumbering (ADR 0055, brief "Strategy
 * Library v2" §1.3). Dry run by default: prints every old → new number, the
 * related-list rewrites and any problem, and writes nothing.
 *
 *   pnpm --filter @tm/db library:renumber-v2 [-- --apply]
 *
 * With --apply it renumbers in one transaction (all or nothing), adds the v2
 * convention row, writes one history row per entry and runs the brief's
 * checks before committing. Any difference from the brief's mapping table
 * stops the run before anything is written. Re-running after an apply changes
 * nothing. Needs the owner connection (DATABASE_URL). Staging only with
 * Yong's OK.
 */
import { createDb } from '../src/client';
import { loadOwnerDbEnv } from '../src/env';
import { applyRenumberV2, planRenumberV2, type RenumberPlan } from '../src/library-renumber';

const apply = process.argv.slice(2).includes('--apply');
const out = (line = '') => process.stdout.write(`${line}\n`);

function print(plan: RenumberPlan) {
  out(
    `Entries: ${plan.rows.length}. Counter: ${plan.counter}. Convention v2 row: ${plan.v2Exists ? 'present' : 'to be added'}.`,
  );
  out('');
  out('seq  old        new          table  built (this database)        name');
  for (const r of plan.rows) {
    out(
      [
        String(r.sequenceNo).padStart(3),
        r.oldNumber.padEnd(10),
        r.newNumber.padEnd(12),
        (r.action === 'already_v2' ? 'done' : r.inTable ? 'ok' : 'n/a').padEnd(6),
        (r.builtStrategyName ?? '-').slice(0, 28).padEnd(28),
        r.name,
      ].join(' '),
    );
  }
  out('');
  out('Related lists rewritten:');
  const changed = plan.rows.filter(
    (r) => JSON.stringify(r.relatedBefore) !== JSON.stringify(r.relatedAfter),
  );
  for (const r of changed) {
    out(`  ${r.newNumber}: ${r.relatedBefore.join(', ')} → ${r.relatedAfter.join(', ')}`);
  }
  if (!changed.length) out('  (none)');
  out('');
  out(`Next Days + Stock registration would be: ${plan.nextPreview}`);
  out('');
  if (plan.problems.length) {
    out('PROBLEMS (nothing will be written):');
    for (const p of plan.problems) out(`  - ${p}`);
  } else out("No problems: every number matches the brief's table.");
}

const { DATABASE_URL } = loadOwnerDbEnv();
const { db, close } = createDb(DATABASE_URL, { max: 1 });
try {
  if (!apply) {
    const plan = await db.transaction((tx) => planRenumberV2(tx));
    print(plan);
    out('');
    out('Dry run. Add --apply to renumber.');
    process.exitCode = plan.problems.length ? 1 : 0;
  } else {
    const result = await db.transaction((tx) => applyRenumberV2(tx));
    print(result);
    out('');
    out(`Applied: ${result.renumbered} entries renumbered.`);
    for (const line of result.verification) out(`  ✓ ${line}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await close();
}
