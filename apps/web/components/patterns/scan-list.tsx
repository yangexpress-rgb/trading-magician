import type { PatternScanRow } from '@tm/db';
import { Badge, Table, Td, TdNumeric, Th, type Tone } from '@tm/ui';
import Link from 'next/link';

const STATUS: Record<PatternScanRow['status'], { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
};

const n = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-US'));

/** Scans, newest first (brief §6): what was asked, and how many rules were tried. */
export function ScanList({ scans }: { scans: PatternScanRow[] }) {
  if (scans.length === 0) return <p className="text-sm text-ink-muted">No scans yet.</p>;
  return (
    <Table label="Pattern scans">
      <thead>
        <tr>
          <Th>Scan</Th>
          <Th>Status</Th>
          <Th numeric>Rules tested</Th>
          <Th numeric>Finalists</Th>
          <Th numeric>Verified</Th>
          <Th>Queued</Th>
        </tr>
      </thead>
      <tbody>
        {scans.map((s) => (
          <tr key={s.id}>
            <Td>
              <Link
                href={`/research/patterns/scans/${s.id}`}
                className="text-accent hover:underline"
              >
                {s.summary}
              </Link>
            </Td>
            <Td>
              <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
            </Td>
            <TdNumeric>{n(s.candidatesTested)}</TdNumeric>
            <TdNumeric>{n(s.finalists)}</TdNumeric>
            <TdNumeric>{n(s.verified)}</TdNumeric>
            <Td>{s.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
