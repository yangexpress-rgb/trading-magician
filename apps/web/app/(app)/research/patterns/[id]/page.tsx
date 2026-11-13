import {
  getPattern,
  getPatternScan,
  listPatternOccurrences,
  patternEventPaths,
  theoryNumberById,
  withTenant,
} from '@tm/db';
import {
  eventStudy,
  hitRateWords,
  outcomeWords,
  patternChip,
  ruleWords,
  VERIFY,
  type PatternWindowStats,
} from '@tm/domain';
import { Card, PageHeader, Table, Td, TdNumeric, Th } from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { EventStudyChart } from '@/components/patterns/event-study-chart';
import { PatternActionButton } from '@/components/patterns/pattern-actions';
import { PatternChip } from '@/components/patterns/pattern-chip';
import { ResearchNav } from '@/components/research/research-nav';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';
import { promotePatternAction, reverifyPatternAction } from '../actions';

export const metadata: Metadata = { title: 'Pattern · Quantitative Research' };
export const dynamic = 'force-dynamic';

const OCCURRENCE_ROWS = 200;
const BEFORE = 10;

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
const pValue = (p: number | null) => (p === null ? '—' : p < 0.0001 ? '< 0.0001' : p.toFixed(4));

const WINDOW_LABEL = {
  discovery: 'Discovery',
  holdout: 'Holdout',
  fresh: 'Since verification',
} as const;

function StatsRow({ label, s }: { label: string; s: PatternWindowStats }) {
  return (
    <tr>
      <Td>{label}</Td>
      <TdNumeric>{hitRateWords(s)}</TdNumeric>
      <TdNumeric>{pct(s.baseRate)}</TdNumeric>
      <TdNumeric>{s.n ? `${s.lift.toFixed(2)}×` : '—'}</TdNumeric>
      <TdNumeric>{s.n ? pct(s.wilsonLower) : '—'}</TdNumeric>
      <TdNumeric>{pValue(s.pValue)}</TdNumeric>
    </tr>
  );
}

/** One pattern's evidence (brief §8): the numbers by window, the event study, every occurrence. */
export default async function PatternPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const tenant = await requireTenant();
  const data = await withTenant(appDb(), tenant, async (tx) => {
    const pattern = await getPattern(tx, id);
    if (!pattern) return null;
    const scan = await getPatternScan(tx, pattern.scanId);
    if (!scan) return null;
    const after = Math.min(scan.config.outcome.horizon + 5, 60);
    const [occurrences, holdoutPaths, discoveryPaths, theoryNumber] = await Promise.all([
      listPatternOccurrences(tx, id),
      patternEventPaths(tx, id, 'holdout', BEFORE, after),
      patternEventPaths(tx, id, 'discovery', BEFORE, after),
      pattern.promotedTheoryId ? theoryNumberById(tx, pattern.promotedTheoryId) : null,
    ]);
    return { pattern, scan, occurrences, holdoutPaths, discoveryPaths, theoryNumber, after };
  });
  if (!data) notFound();
  const { pattern, scan, occurrences, theoryNumber, after } = data;
  const s = pattern.stats;
  const fresh = (pattern.decayStats?.fresh ?? null) as PatternWindowStats | null;
  const chip = patternChip(pattern.status, pattern.decayState);
  const shown = [...occurrences]
    .sort((a, b) => (a.asOf < b.asOf ? 1 : a.asOf > b.asOf ? -1 : a.symbol.localeCompare(b.symbol)))
    .slice(0, OCCURRENCE_ROWS);
  const reverifyAsked = Boolean(pattern.decayStats?.reverifyRequestedAt);
  const reverify = (pattern.decayStats?.reverify ?? null) as {
    stats: PatternWindowStats;
    from: string;
    to: string;
    verified: boolean;
    failedChecks: string[];
  } | null;
  return (
    <>
      <PageHeader title="Quantitative Research" description={scan.summary} />
      <ResearchNav />
      <div className="space-y-6">
        <p className="text-sm">
          <Link
            href={`/research/patterns/scans/${scan.id}`}
            className="text-accent hover:underline"
          >
            ← This scan&rsquo;s patterns
          </Link>
        </p>
        <Card>
          <section aria-labelledby="pattern-heading" className="space-y-4">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <h2 id="pattern-heading" className="text-lg font-semibold">
                  Pattern #{pattern.rank}
                </h2>
                <p className="text-prose">
                  {ruleWords(pattern.rule)}, the stock {outcomeWords(scan.config.outcome)}.
                </p>
              </div>
              <PatternChip chip={chip} />
            </header>
            <p className="text-sm">
              Holdout: <span className="text-content">{hitRateWords(s.holdout)}</span> against a
              base rate of {pct(s.holdout.baseRate)}.
            </p>
            {s.failedChecks.length > 0 && (
              <p className="text-sm text-ink-muted">Not verified: {s.failedChecks.join('; ')}.</p>
            )}
            <p className="text-sm text-ink-muted">
              This scan tried {scan.candidatesTested?.toLocaleString('en-US') ?? '?'} rules, so many
              will look good by chance. Verified means the holdout (days the search never saw) has
              at least {VERIFY.holdoutMinN} occurrences, lift of at least {VERIFY.minLift}×, a 95%
              lower bound above the base rate, and survives a {VERIFY.fdrQ * 100}% false-discovery
              correction across the scan&rsquo;s {scan.finalists ?? '?'} finalists. Occurrences of
              the same stock on nearby days overlap, so the p-value is optimistic.
            </p>
            <div className="flex flex-wrap items-start gap-4">
              {theoryNumber ? (
                <p className="text-sm">
                  In the Theory Library as{' '}
                  <Link href={`/library/${theoryNumber}`} className="text-accent hover:underline">
                    {theoryNumber}
                  </Link>
                  .
                </p>
              ) : (
                <PatternActionButton
                  action={promotePatternAction}
                  patternId={pattern.id}
                  label="Promote to Theory Library"
                  variant="primary"
                  {...(pattern.status === 'candidate'
                    ? {
                        confirm:
                          'This pattern did not verify. Promote it anyway, marked Candidate?',
                      }
                    : {})}
                />
              )}
              {pattern.status === 'verified' &&
                (reverifyAsked ? (
                  <p className="text-sm text-ink-muted">
                    Re-verification queued: it runs with the next batch run of the miner.
                  </p>
                ) : (
                  <PatternActionButton
                    action={reverifyPatternAction}
                    patternId={pattern.id}
                    label="Re-verify now"
                  />
                ))}
            </div>
          </section>
        </Card>
        <Card>
          <section aria-labelledby="stats-heading" className="space-y-4">
            <h2 id="stats-heading" className="text-lg font-semibold">
              Evidence by window
            </h2>
            <Table label="Pattern statistics by window">
              <thead>
                <tr>
                  <Th>Window</Th>
                  <Th numeric>Hit rate</Th>
                  <Th numeric>Base rate</Th>
                  <Th numeric>Lift</Th>
                  <Th numeric>95% lower bound</Th>
                  <Th numeric>p-value</Th>
                </tr>
              </thead>
              <tbody>
                <StatsRow label="Holdout (unseen days)" s={s.holdout} />
                {fresh && (
                  <StatsRow
                    label={`Since verification (to ${pattern.lastScored ?? '?'})`}
                    s={fresh}
                  />
                )}
                <StatsRow label="Discovery (where the rule was found)" s={s.discovery} />
              </tbody>
            </Table>
            {reverify && (
              <p className="text-sm">
                Re-verification on everything after the discovery window:{' '}
                {reverify.verified
                  ? 'passes the holdout test again.'
                  : `does not pass (${reverify.failedChecks.join('; ')}).`}
              </p>
            )}
            {pattern.decayState === null && pattern.lastScored && (
              <p className="text-sm text-ink-muted">
                Fewer than 10 occurrences since verification so far: no decay state yet.
              </p>
            )}
            <p className="text-sm text-ink-muted">
              The discovery figures are biased upward: the search picked this rule because they
              looked good.
            </p>
          </section>
        </Card>
        <Card>
          <section aria-labelledby="event-heading" className="space-y-4">
            <h2 id="event-heading" className="text-lg font-semibold">
              Event study
            </h2>
            <h3 className="text-sm font-semibold">Holdout occurrences</h3>
            <EventStudyChart
              points={eventStudy(data.holdoutPaths, BEFORE, after)}
              label="Mean move around holdout occurrences"
            />
            <h3 className="text-sm font-semibold">Discovery occurrences</h3>
            <EventStudyChart
              points={eventStudy(data.discoveryPaths, BEFORE, after)}
              label="Mean move around discovery occurrences"
            />
          </section>
        </Card>
        <Card>
          <section aria-labelledby="occ-heading" className="space-y-4">
            <h2 id="occ-heading" className="text-lg font-semibold">
              Occurrences ({occurrences.length.toLocaleString('en-US')})
            </h2>
            {occurrences.length > OCCURRENCE_ROWS && (
              <p className="text-sm text-ink-muted">The latest {OCCURRENCE_ROWS} are shown.</p>
            )}
            <Table label="Pattern occurrences">
              <thead>
                <tr>
                  <Th>Day</Th>
                  <Th>Symbol</Th>
                  <Th>Window</Th>
                  <Th>Hit</Th>
                  <Th numeric>Best run-up</Th>
                  <Th numeric>Worst drawdown</Th>
                  <Th numeric>Return at {scan.config.outcome.horizon}d</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((o) => (
                  <tr key={`${o.instrumentId}-${o.asOf}`}>
                    <Td>{o.asOf}</Td>
                    <Td>{o.symbol}</Td>
                    <Td>{WINDOW_LABEL[o.window]}</Td>
                    <Td>{o.hit ? 'Yes' : 'No'}</Td>
                    <TdNumeric>{signed(o.maxRunup)}</TdNumeric>
                    <TdNumeric>{signed(o.maxDrawdown)}</TdNumeric>
                    <TdNumeric>{signed(o.forwardReturn)}</TdNumeric>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="text-sm text-ink-muted">
              Measured from each day&rsquo;s close with daily highs and lows. Universes are
              today&rsquo;s members (survivorship bias).
            </p>
          </section>
        </Card>
      </div>
    </>
  );
}
