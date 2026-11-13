'use server';

import {
  getPattern,
  getPatternScan,
  instrumentsBySymbol,
  LibraryError,
  listOptionUniverse,
  promotePattern,
  queuePatternScan,
  requestReverify,
  withTenant,
} from '@tm/db';
import {
  FACTOR_CATALOGUE_VERSION,
  FACTOR_CATEGORIES,
  patternScanInputSchema,
  scanFactors,
  scanSummary,
  stockGroupSymbols,
  type FactorCategory,
  type PatternScanConfig,
} from '@tm/domain';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { appDb } from '@/lib/server/db';
import { logger } from '@/lib/server/log';
import { requireTenant } from '@/lib/server/session';

/** Research › Patterns' changes (pattern brief §6, §9, §10). */
export interface PatternActionState {
  status: 'idle' | 'done' | 'error';
  message?: string;
}

const num = (v: FormDataEntryValue | null) => (v === null || v === '' ? undefined : Number(v));
const text = (v: FormDataEntryValue | null) =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/** Queues a scan from the New scan form; the miner runs it at its next batch run. */
export async function startPatternScan(
  _prev: PatternActionState,
  form: FormData,
): Promise<PatternActionState> {
  const tenant = await requireTenant();
  const universe = String(form.get('universe') ?? 'group:sp500');
  const categories = FACTOR_CATEGORIES.filter((c) => form.getAll('categories').includes(c));
  const parsed = patternScanInputSchema.safeParse({
    universe:
      universe === 'options' ? { kind: 'options' } : { kind: 'group', id: universe.slice(6) },
    outcome: {
      direction: form.get('direction') === 'plunge' ? 'plunge' : 'spike',
      pct: num(form.get('pct')),
      horizon: num(form.get('horizon')),
    },
    categories,
    maxDepth: num(form.get('maxDepth')),
    minSupport: num(form.get('minSupport')),
    range: {
      ...(text(form.get('from')) ? { from: text(form.get('from')) } : {}),
      ...(text(form.get('to')) ? { to: text(form.get('to')) } : {}),
    },
  });
  if (!parsed.success)
    return {
      status: 'error',
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  const input = parsed.data;
  let id: string;
  try {
    id = await withTenant(appDb(), tenant, async (tx) => {
      const memberIds =
        input.universe.kind === 'options'
          ? (await listOptionUniverse(tx)).map((u) => u.underlyingId)
          : [...(await instrumentsBySymbol(tx, stockGroupSymbols(input.universe.id))).values()];
      if (memberIds.length === 0)
        throw new Error('That universe has no instruments in the factor store yet');
      const config: PatternScanConfig = {
        ...input,
        memberIds: [...new Set(memberIds)].sort(),
        factors: scanFactors(input.categories as FactorCategory[]),
        catalogueVersion: FACTOR_CATALOGUE_VERSION,
      };
      return queuePatternScan(tx, tenant.userId, config, scanSummary(input));
    });
  } catch (error) {
    logger().error({ err: error }, 'Pattern scan not queued');
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'The scan could not be queued.',
    };
  }
  revalidatePath('/research/patterns');
  redirect(`/research/patterns/scans/${id}`);
}

const uuid = z.string().uuid();

/** Promotes a pattern into the Theory Library (brief §9): one theory, no strategy. */
export async function promotePatternAction(
  _prev: PatternActionState,
  form: FormData,
): Promise<PatternActionState> {
  const tenant = await requireTenant();
  const id = uuid.safeParse(form.get('patternId'));
  if (!id.success) return { status: 'error', message: 'Unknown pattern.' };
  let number: string;
  try {
    number = await withTenant(appDb(), tenant, async (tx) => {
      const pattern = await getPattern(tx, id.data);
      if (!pattern) throw new LibraryError('not_found', 'Unknown pattern.');
      const scan = await getPatternScan(tx, pattern.scanId);
      if (!scan) throw new LibraryError('not_found', 'Unknown scan.');
      return (await promotePattern(tx, tenant.userId, pattern, scan)).registrationNumber;
    });
  } catch (error) {
    if (error instanceof LibraryError) return { status: 'error', message: error.message };
    logger().error({ err: error }, 'Pattern promotion failed');
    return { status: 'error', message: 'The pattern could not be promoted. Try again.' };
  }
  revalidatePath(`/research/patterns/${id.data}`);
  return { status: 'done', message: `Promoted to the Theory Library as ${number}.` };
}

/** Queues a re-verification (brief §10): the miner runs it at its next batch run. */
export async function reverifyPatternAction(
  _prev: PatternActionState,
  form: FormData,
): Promise<PatternActionState> {
  const tenant = await requireTenant();
  const id = uuid.safeParse(form.get('patternId'));
  if (!id.success) return { status: 'error', message: 'Unknown pattern.' };
  await withTenant(appDb(), tenant, (tx) => requestReverify(tx, id.data));
  revalidatePath(`/research/patterns/${id.data}`);
  return {
    status: 'done',
    message: 'Re-verification queued: it runs with the next batch run of the miner.',
  };
}
