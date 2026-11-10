'use client';

import { ApiError, type EarningsDto, type InstrumentOptionDto } from '@tm/contracts';
import { Alert, Badge, Table, Td, Th } from '@tm/ui';
import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { ResearchSection } from './research-section';

const eps = (v: number | null) => (v === null ? '—' : v.toFixed(2));
const signed = (v: number | null, digits = 2) =>
  v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
const pct = (v: number | null) => (v === null ? '—' : signed(v * 100, 1));

/**
 * Research › Earnings (free data feeds brief v1 §5; ADR 0058): the stock's
 * reported releases from its EDGAR 8-K filings, each with the time-series SUE
 * the Lab's earnings metrics read, and the next scheduled date when a
 * calendar feed is on.
 */
export function EarningsPanel({ instrument }: { instrument: InstrumentOptionDto }) {
  const [data, setData] = useState<EarningsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const applies = instrument.venue !== 'DEMO' && instrument.assetClass === 'stock';

  useEffect(() => {
    setData(null);
    setError(null);
    if (!applies) return;
    let live = true;
    apiClient.research
      .earnings(instrument.symbol)
      .then((d) => live && setData(d))
      .catch((e: unknown) => {
        if (live) setError(e instanceof ApiError ? e.message : 'Could not load earnings');
      });
    return () => {
      live = false;
    };
  }, [instrument.symbol, applies]);

  if (!applies) return null;
  const rebuild = data?.scan.find((s) => s.job === 'earnings_rebuild');
  return (
    <ResearchSection
      id="earnings"
      title="Earnings"
      extra={
        <>
          {data?.next && (
            <span className="text-sm">
              Next release <span className="text-content">{data.next.date}</span>
              {data.next.timeHint === 'bmo'
                ? ' before the open'
                : data.next.timeHint === 'amc'
                  ? ' after the close'
                  : ''}
            </span>
          )}
        </>
      }
    >
      {error && <Alert>{error}</Alert>}
      {data && data.releases.length === 0 && (
        <p className="text-sm text-ink-muted">
          No earnings releases recorded for {data.symbol} yet. Releases come from the company’s 8-K
          filings (Item 2.02) on SEC EDGAR, and only stocks in the recorded universe are followed.
        </p>
      )}
      {data && data.releases.length > 0 && (
        <div className="overflow-x-auto">
          <Table label={`${data.symbol} earnings releases`}>
            <thead>
              <tr>
                <Th>Announced</Th>
                <Th>Quarter ended</Th>
                <Th numeric>EPS $</Th>
                <Th numeric>Year-ago EPS $</Th>
                <Th numeric>SUE</Th>
                <Th numeric>Surprise %</Th>
                <Th>Filing</Th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {data.releases.map((r) => (
                <tr key={r.fiscalQuarterEnd}>
                  <Td>
                    {r.announcedDate}
                    {!r.timeKnown && <span className="text-ink-muted"> (time unknown)</span>}
                  </Td>
                  <Td>{r.fiscalQuarterEnd}</Td>
                  <Td numeric>{eps(r.reportedEps)}</Td>
                  <Td numeric>{eps(r.epsQMinus4)}</Td>
                  <Td numeric>
                    {signed(r.sue)}
                    {r.sueSource === 'rebuilt' && <span className="sr-only"> (rebuilt)</span>}
                  </Td>
                  <Td numeric>{pct(r.surprisePct)}</Td>
                  <Td>
                    <a href={r.filingUrl} className="underline" target="_blank" rel="noreferrer">
                      8-K
                    </a>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      {data && (
        <footer className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <Badge>Earnings from SEC EDGAR</Badge>
          <span>
            SUE is the change in EPS from a year earlier over the spread of the last eight such
            changes. EPS comes from the 10-Q or 10-K, so a new release shows it once that is filed.
          </span>
          {rebuild?.coveredFrom && <span>History from {rebuild.coveredFrom}.</span>}
          <span>
            {data.calendar === 'on'
              ? 'Scheduled dates from the earnings calendar feed.'
              : 'No calendar feed is on, so the next release date is not known (EDGAR-only mode).'}
          </span>
        </footer>
      )}
    </ResearchSection>
  );
}
