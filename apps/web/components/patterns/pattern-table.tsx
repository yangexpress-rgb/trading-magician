import type { PatternRow } from '@tm/db';
import { hitRateWords, patternChip, ruleWords } from '@tm/domain';
import { Table, Td, TdNumeric, Th } from '@tm/ui';
import Link from 'next/link';
import { PatternChip } from './pattern-chip';

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** A scan's finalists (brief §8): the holdout figures only, never the discovery rate. */
export function PatternTable({ patterns, label }: { patterns: PatternRow[]; label: string }) {
  return (
    <Table label={label}>
      <thead>
        <tr>
          <Th numeric>#</Th>
          <Th>Rule</Th>
          <Th>Status</Th>
          <Th numeric>Holdout hit rate</Th>
          <Th numeric>Base rate</Th>
          <Th numeric>Lift</Th>
        </tr>
      </thead>
      <tbody>
        {patterns.map((p) => (
          <tr key={p.id}>
            <TdNumeric>{p.rank}</TdNumeric>
            <Td>
              <Link href={`/research/patterns/${p.id}`} className="text-accent hover:underline">
                {ruleWords(p.rule)}
              </Link>
            </Td>
            <Td>
              <PatternChip chip={patternChip(p.status, p.decayState)} />
            </Td>
            <TdNumeric>{hitRateWords(p.stats.holdout)}</TdNumeric>
            <TdNumeric>{pct(p.stats.holdout.baseRate)}</TdNumeric>
            <TdNumeric>{p.stats.holdout.n ? `${p.stats.holdout.lift.toFixed(2)}×` : '—'}</TdNumeric>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
