/**
 * Moves the research tables from Core into the Research Store (ADR 0115).
 *
 *   pnpm --filter @tm/db research:move          copy (repeatable; never deletes)
 *   pnpm --filter @tm/db research:clear-core    copy again, and only if that
 *       copied nothing and every count matches, empty Core's copies
 *
 * Needs DATABASE_URL (Core owner) and RESEARCH_DATABASE_URL (Research owner).
 */
import postgres from 'postgres';
import { clearCoreCopies, moveResearchTables, verified } from '../src/research-move';

const coreUrl = process.env.DATABASE_URL;
const researchUrl = process.env.RESEARCH_DATABASE_URL;
if (!coreUrl || !researchUrl) {
  process.stderr.write('DATABASE_URL and RESEARCH_DATABASE_URL are both required.\n');
  process.exit(1);
}
const mode = process.argv[2] === 'clear-core' ? 'clear-core' : 'move';
const core = postgres(coreUrl, { max: 2, onnotice: () => undefined });
const research = postgres(researchUrl, { max: 2, onnotice: () => undefined });
const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
try {
  const moves = await moveResearchTables(core, research, { log });
  process.stdout.write(
    '\ntable | core rows | research before | copied | without parent | research after\n',
  );
  for (const m of moves)
    process.stdout.write(
      `${m.table} | ${m.coreRows} | ${m.researchBefore} | ${m.inserted} | ${m.skipped} | ${m.researchAfter}\n`,
    );
  const ok = verified(moves);
  process.stdout.write(
    ok
      ? '\nVERIFIED: this pass copied nothing new and Research holds every Core row.\n'
      : '\nNot verified yet: run research:move again after writers point at Research.\n',
  );
  if (mode === 'clear-core') {
    if (!ok) throw new Error('Refused to clear Core: the move did not verify');
    await clearCoreCopies(core, moves);
    process.stdout.write('Core copies of the research tables emptied.\n');
  }
} finally {
  await Promise.all([core.end(), research.end()]);
}
