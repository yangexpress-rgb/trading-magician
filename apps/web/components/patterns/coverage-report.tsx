import type { FactorCoverageReport } from '@tm/db';
import { FACTOR_CATALOGUE_V1, FACTOR_CATEGORY_LABELS, MIN_CROSS_SECTION } from '@tm/domain';
import { Card, Table, Td, TdNumeric, Th } from '@tm/ui';

const dash = (v: string | null) => v ?? '—';
const count = (n: number) => n.toLocaleString('en-US');
const size = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;

/**
 * The factor store's coverage report (pattern brief §3, §13): per category
 * and factor, the first day any instrument had a value, and the first day
 * enough did for quintile atoms to form. Scans never reach further back than
 * a category's coverage.
 */
export function CoverageReport({ report }: { report: FactorCoverageReport }) {
  const spec = new Map(FACTOR_CATALOGUE_V1.map((f) => [f.id, f]));
  return (
    <div className="space-y-6">
      <Card>
        <section aria-labelledby="coverage-heading" className="space-y-4">
          <header className="space-y-1">
            <h2 id="coverage-heading" className="text-lg font-semibold">
              Factor data coverage
            </h2>
            <p className="text-sm text-ink-muted">
              {report.rows === 0
                ? 'No factor snapshots yet: the backfill has not started.'
                : `${count(report.rows)} snapshot rows for ${count(report.instruments)} instruments over ${count(report.days)} trading days, ${dash(report.first)} to ${dash(report.last)} (${size(report.tableBytes)} on disk).`}{' '}
              Universes are today&rsquo;s stock-group members, so earlier years leave out companies
              that have since left them (survivorship bias).
            </p>
          </header>
          <Table label="Coverage by factor category">
            <thead>
              <tr>
                <Th>Category</Th>
                <Th>Factors with data</Th>
                <Th>First day with any value</Th>
                <Th>First day with {MIN_CROSS_SECTION}+ values</Th>
              </tr>
            </thead>
            <tbody>
              {report.categories.map((c) => (
                <tr key={c.category}>
                  <Td>{FACTOR_CATEGORY_LABELS[c.category]}</Td>
                  <TdNumeric>
                    {c.factorsWithData} of {c.factors}
                  </TdNumeric>
                  <Td>{dash(c.firstAny)}</Td>
                  <Td>{dash(c.firstCross)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      </Card>
      <Card>
        <section aria-labelledby="factor-heading" className="space-y-4">
          <h2 id="factor-heading" className="text-lg font-semibold">
            By factor
          </h2>
          <Table label="Coverage by factor">
            <thead>
              <tr>
                <Th>Factor</Th>
                <Th>Atoms</Th>
                <Th>First value</Th>
                <Th>First {MIN_CROSS_SECTION}+ day</Th>
                <Th>Last value</Th>
                <Th>Values</Th>
              </tr>
            </thead>
            <tbody>
              {report.factors.map((l) => {
                const f = spec.get(l.factor);
                return (
                  <tr key={l.factor}>
                    <Td>
                      <span className="font-medium">{f?.label ?? l.factor}</span>
                      <span className="block text-xs text-ink-muted">{f?.definition}</span>
                    </Td>
                    <Td>
                      {(f?.modes ?? [])
                        .map((m) => (m === 'cross' ? 'Quintiles' : 'Own history'))
                        .join(', ')}
                    </Td>
                    <Td>{dash(l.firstAny)}</Td>
                    <Td>{dash(l.firstCross)}</Td>
                    <Td>{dash(l.last)}</Td>
                    <TdNumeric>{count(l.known)}</TdNumeric>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </section>
      </Card>
    </div>
  );
}
