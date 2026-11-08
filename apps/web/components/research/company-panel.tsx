'use client';

import { ApiError, type CompanyReportDto, type InstrumentOptionDto } from '@tm/contracts';
import { companyMetrics, SP500_SECTORS, type CompanyReport } from '@tm/domain';
import { Alert, Badge, Card, Table, Td, Th } from '@tm/ui';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import {
  formatCount,
  formatDay,
  formatFigure,
  formatLine,
  formatMonthDay,
  KEY_FIGURES,
  STATEMENT_LINES,
} from '@/lib/company-text';

const POLL_MS = 800;
const GIVE_UP_MS = 60_000;

/**
 * The company section of Quantitative Research (ADR 0031): profile, key
 * figures at the chart's last price, five fiscal years of reported
 * financials and recent filings, from the tenant's company data feed.
 */
export function CompanyPanel({
  instrument,
  price,
  companyFeed,
}: {
  instrument: InstrumentOptionDto;
  /** The chart's last price, for market cap and ratios. */
  price: number | null;
  /** The company data feed in use, by name; null when there is none. */
  companyFeed: string | null;
}) {
  const [result, setResult] = useState<CompanyReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const demo = instrument.venue === 'DEMO';
  const etf = instrument.assetClass === 'etf';
  const applies = !demo && !etf && companyFeed !== null;

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    clearTimeout(timer.current);
    setResult(null);
    setError(null);
    if (!applies) return;
    const mine = ++request.current;
    const stale = () => mine !== request.current;
    const deadline = Date.now() + GIVE_UP_MS;
    setLoading(true);
    const settle = (r: CompanyReportDto) => {
      if (stale()) return;
      if (r.status === 'pending') {
        if (Date.now() > deadline) {
          setLoading(false);
          setError('The company data is taking longer than expected. Try again in a minute.');
          return;
        }
        timer.current = setTimeout(() => {
          apiClient.research.getCompany(r.id).then(settle, () => {
            if (stale()) return;
            setLoading(false);
            setError('Could not check on the company data. Try again.');
          });
        }, POLL_MS);
        return;
      }
      setLoading(false);
      if (r.status === 'failed') setError(r.message ?? 'The company data could not be loaded.');
      else setResult(r);
    };
    apiClient.research.company({ symbol: instrument.symbol }).then(settle, (err: unknown) => {
      if (stale()) return;
      setLoading(false);
      setError(err instanceof ApiError ? err.message : 'Could not load the company data.');
    });
  }, [applies, instrument.symbol]);

  return (
    <Card>
      <section aria-labelledby="company-heading" className="space-y-4">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="company-heading" className="text-lg font-semibold">
            Company
          </h2>
          {result?.source && <Badge>{`Company data from ${result.source}`}</Badge>}
        </header>
        {demo ? (
          <p className="text-sm text-ink-muted">
            Demo instruments are invented, so they have no company filings. Pick a real US stock to
            see its financials.
          </p>
        ) : etf ? (
          <p className="text-sm text-ink-muted">
            ETFs and funds file no company financials, so there is nothing to show here.
          </p>
        ) : companyFeed === null ? (
          <div className="text-sm">
            <p>
              See this company’s revenue, earnings, balance sheet, profile and filings by adding a
              company data feed.
            </p>
            <p className="mt-1 text-ink-muted">
              SEC EDGAR is free and needs only a contact email:{' '}
              <Link href="/settings/data-feeds" className="underline">
                add it under Settings › Data feeds
              </Link>
              .
            </p>
          </div>
        ) : (
          <>
            <p role="status" aria-live="polite" className="text-sm text-ink-muted">
              {loading ? `Loading ${instrument.symbol} company data…` : ''}
            </p>
            {error && <Alert>{error}</Alert>}
            {result?.report && <CompanyReportView report={result.report} price={price} />}
          </>
        )}
      </section>
    </Card>
  );
}

function CompanyReportView({ report, price }: { report: CompanyReport; price: number | null }) {
  const metrics = useMemo(() => companyMetrics(report, price), [report, price]);
  const p = report.profile;
  const sector = SP500_SECTORS.get(report.symbol) ?? null;
  const latest = report.years.at(-1);
  const facts: [string, React.ReactNode][] = [
    ['Industry', p.industry],
    ['Sector', sector ? `${sector} (S&P 500)` : null],
    ['Headquarters', p.headquarters],
    ['Incorporated in', p.incorporatedIn],
    ['Fiscal year ends', formatMonthDay(p.fiscalYearEnd)],
    ['Listed on', p.exchanges.join(', ') || null],
    ['Filer category', p.filerCategory],
    [
      'Shares outstanding',
      report.sharesOutstanding
        ? `${formatCount(report.sharesOutstanding.value)} (${formatDay(report.sharesOutstanding.asOf)})`
        : null,
    ],
    ['Phone', p.phone],
    [
      'Website',
      p.website ? (
        <a href={p.website} target="_blank" rel="noopener noreferrer" className="underline">
          {p.website.replace(/^https?:\/\//, '')}
        </a>
      ) : null,
    ],
    [
      'SEC company number',
      report.cik ? (
        report.sourceUrl ? (
          <a
            href={report.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {report.cik}
          </a>
        ) : (
          report.cik
        )
      ) : null,
    ],
    [
      'Formerly',
      p.formerNames.length
        ? p.formerNames
            .map((n) => `${n.name}${n.until ? ` (until ${n.until.slice(0, 4)})` : ''}`)
            .join('; ')
        : null,
    ],
  ];

  return (
    <div className="space-y-6">
      <div>
        <p className="text-base font-semibold">{report.name}</p>
        <dl
          className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2"
          aria-label="Company profile"
        >
          {facts
            .filter(([, v]) => v !== null && v !== '')
            .map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="w-40 shrink-0 text-ink-muted">{k}</dt>
                <dd className="min-w-0 break-words text-content">{v}</dd>
              </div>
            ))}
        </dl>
      </div>

      {latest ? (
        <>
          <div>
            <h3 className="text-sm font-semibold">
              Key figures{' '}
              <span className="font-normal text-ink-muted">
                · fiscal {latest.fiscalYear}
                {price !== null ? ', at the last price' : ''}
              </span>
            </h3>
            <dl
              className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
              aria-label="Key figures"
            >
              {KEY_FIGURES.map((f) => (
                <div
                  key={f.key}
                  className="rounded-md border border-line bg-surface-2 px-3 py-2"
                  title={f.hint}
                >
                  <dt className="text-xs text-ink-muted">{f.label}</dt>
                  <dd className="text-base text-content-strong">
                    {formatFigure(metrics[f.key], f.format)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Annual financials</h3>
            <Table label={`${report.symbol} annual financials`}>
              <thead>
                <tr>
                  <Th>
                    <span className="sr-only">Line</span>
                  </Th>
                  {report.years.map((y) => (
                    <Th key={y.end} numeric>
                      <span title={`Year ended ${formatDay(y.end)}`}>FY{y.fiscalYear}</span>
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {STATEMENT_LINES.flatMap((g) => [
                  <tr key={g.group}>
                    <th
                      scope="rowgroup"
                      colSpan={report.years.length + 1}
                      className="border-b border-line px-3 pt-3 pb-1 text-left text-xs font-semibold text-ink-muted"
                    >
                      {g.group}
                    </th>
                  </tr>,
                  ...g.lines.map((l) => (
                    <tr key={l.key}>
                      <Td>{l.label}</Td>
                      {report.years.map((y) => (
                        <Td key={y.end} numeric>
                          {formatLine(y[l.key], l.format)}
                        </Td>
                      ))}
                    </tr>
                  )),
                ])}
              </tbody>
            </Table>
            <p className="text-xs text-ink-muted">
              As reported in each year’s annual report (10-K), in {report.currency}; the latest
              filing wins when a year was restated. A dash means the filings don’t report that line
              under a standard name.
            </p>
          </div>
        </>
      ) : (
        <p className="text-sm text-ink-muted">
          No annual financials have been filed in a form the feed can read yet. Foreign companies
          that file 20-F reports and new listings often have none.
        </p>
      )}

      {report.filings.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Recent filings</h3>
          <ul className="space-y-1 text-sm" aria-label="Recent filings">
            {report.filings.map((f) => (
              <li key={f.url} className="flex flex-wrap gap-x-3">
                <a
                  href={f.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-20 font-medium underline"
                >
                  {f.form}
                </a>
                <span className="tabular-nums">Filed {formatDay(f.filed)}</span>
                {f.period && <span className="text-ink-muted">for {formatDay(f.period)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
