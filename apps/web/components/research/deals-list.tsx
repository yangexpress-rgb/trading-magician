'use client';

import { ApiError, type DealListDto } from '@tm/contracts';
import { Alert, Badge, Card, Table, Td, Th } from '@tm/ui';
import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';

const STATUS: Record<DealListDto['deals'][number]['status'], string> = {
  announced: 'Announced',
  pending: 'Pending',
  closed: 'Closed',
  withdrawn: 'Withdrawn',
};

const money = (v: number | null) => (v === null ? '—' : v.toFixed(2));
const spread = (v: number | null) =>
  v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(2)}`;

/**
 * Research › Deals (free data feeds brief v1 §4; ADR 0058). The spread is
 * shown only for a high-confidence cash deal with a known offer price and a
 * stored daily close (N151): never zero in place of unknown. A deal filed by
 * both its target and its acquirer is one row with both filings (N152).
 */
export function DealsList() {
  const [all, setAll] = useState(false);
  const [data, setData] = useState<DealListDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    apiClient.research
      .deals(all)
      .then((d) => live && setData(d))
      .catch((e: unknown) => {
        if (live) setError(e instanceof ApiError ? e.message : 'Could not load deals');
      });
    return () => {
      live = false;
    };
  }, [all]);

  const rebuild = data?.scan.find((s) => s.job === 'deals_rebuild');
  const daily = data?.scan.find((s) => s.job === 'deals_scan');
  return (
    <Card>
      <section aria-labelledby="deals-heading" className="space-y-4">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="deals-heading" className="text-lg font-semibold">
            Deals
          </h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            Include closed and withdrawn deals
          </label>
        </header>
        {error && <Alert>{error}</Alert>}
        {data && data.deals.length === 0 && (
          <p className="text-sm text-ink-muted">
            {rebuild?.coveredTo || daily?.coveredTo
              ? 'No deals found in the filings read so far.'
              : 'The tracker has not read EDGAR yet. It reads the merger filings each evening.'}
          </p>
        )}
        {data && data.deals.length > 0 && (
          <div className="overflow-x-auto">
            <Table label="Deals">
              <thead>
                <tr>
                  <Th>Deal</Th>
                  <Th>Target</Th>
                  <Th>Acquirer</Th>
                  <Th>Announced</Th>
                  <Th>Status</Th>
                  <Th>Paid in</Th>
                  <Th numeric>Offer $</Th>
                  <Th numeric>Close $</Th>
                  <Th numeric>Spread %</Th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {data.deals.map((d) => (
                  <tr key={d.dealId}>
                    <Td>
                      <a
                        href={d.sourceFilingUrl}
                        className="underline"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {d.dealId}
                      </a>
                      {/* The same deal's other filings, such as the acquirer's (N152). */}
                      {d.filings.slice(1).map((f, n) => (
                        <a
                          key={f.accession}
                          href={f.url}
                          className="ml-2 text-xs text-ink-muted underline"
                          target="_blank"
                          rel="noreferrer"
                          title={`Also filed ${f.filedDate}`}
                        >
                          filing {n + 2}
                        </a>
                      ))}
                    </Td>
                    <Td>
                      {d.targetSymbol ? `${d.targetSymbol} · ` : ''}
                      {d.targetName}
                    </Td>
                    <Td>{d.acquirerName ?? '—'}</Td>
                    <Td>{d.announcedDate}</Td>
                    <Td>{STATUS[d.status]}</Td>
                    <Td>
                      {d.consideration === 'unknown' ? '—' : d.consideration}
                      {d.confidence === 'low' && (
                        <span title={d.parseNote ?? undefined} className="text-ink-muted">
                          {' '}
                          (low confidence)
                        </span>
                      )}
                    </Td>
                    <Td numeric>{money(d.offerPrice)}</Td>
                    <Td numeric>
                      {money(d.close)}
                      {d.closeDate && <span className="sr-only"> on {d.closeDate}</span>}
                    </Td>
                    <Td numeric>{spread(d.spreadPct)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
        {data && (
          <footer className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <Badge>Deals from SEC EDGAR</Badge>
            <span>
              Spread is (offer − close) ÷ close, shown only for a cash offer read with high
              confidence. Close is the target&apos;s latest daily close from Alpaca, the close back
              tests use; a target without daily bars shows none.
            </span>
            {(rebuild?.coveredFrom ?? daily?.coveredFrom) && (
              <span>Filings read from {rebuild?.coveredFrom ?? daily?.coveredFrom}.</span>
            )}
          </footer>
        )}
      </section>
    </Card>
  );
}
