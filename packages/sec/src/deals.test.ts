import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  dealFilingHit,
  filingText,
  nameKey,
  parseDisplayName,
  parseMergerFiling,
  statusChanges,
  terminatesMerger,
} from './deals';
import type { EdgarFiling } from './earnings';

/**
 * The deal tracker's parser (free data feeds brief v1 §5.3). The fixtures in
 * testing/fixtures/events are stand-ins written in the standard 8-K wording;
 * the Kellanova one follows Mars's announced $83.50 cash offer (August 2024).
 */
const doc = (name: string) =>
  filingText(readFileSync(new URL(`./testing/fixtures/events/${name}`, import.meta.url), 'utf8'));

describe('parseMergerFiling', () => {
  it("finds a known announced cash deal from the target's 8-K", () => {
    const p = parseMergerFiling(doc('k-8k-merger.htm'));
    expect(p).toMatchObject({
      role: 'target',
      acquirerName: 'Mars, Incorporated',
      offerPrice: 83.5,
      consideration: 'cash',
      confidence: 'high',
    });
  });

  it('leaves an all-stock offer price null (O3) and never zero', () => {
    const p = parseMergerFiling(doc('stock-8k-merger.htm'));
    expect(p.role).toBe('target');
    expect(p.acquirerName).toBe('Capital One Financial Corporation');
    expect(p.consideration).toBe('stock');
    expect(p.offerPrice).toBeNull();
  });

  it("is low-confidence on the acquirer's 8-K and names the target", () => {
    const p = parseMergerFiling(doc('acquirer-8k-merger.htm'));
    expect(p.role).toBe('acquirer');
    expect(p.targetName).toBe('Small Target Inc.');
    expect(p.offerPrice).toBe(12.25);
    expect(p.confidence).toBe('low');
  });

  it('is low-confidence when the wording gives no price', () => {
    const p = parseMergerFiling(
      'The Company entered into an Agreement and Plan of Merger with Acme Corp. ("Parent"). Merger Sub will merge with and into the Company.',
    );
    expect(p.offerPrice).toBeNull();
    expect(p.consideration).toBe('unknown');
    expect(p.confidence).toBe('low');
    expect(p.notes).toContain('consideration not found');
  });

  it('is low-confidence with several cash amounts', () => {
    const p = parseMergerFiling(
      'with Acme Corp., a Delaware corporation ("Parent"). Merger Sub will merge with and into the Company. Each share will be converted into the right to receive $10.00 in cash; certain shares receive the right to receive $11.00 in cash.',
    );
    expect(p.offerPrice).toBeNull();
    expect(p.confidence).toBe('low');
  });

  it('reads a tender offer price', () => {
    const p = parseMergerFiling(
      'Parent Co., a Delaware corporation ("Parent"), commenced a tender offer to purchase all of the outstanding shares of the Company at a price of $35.00 per Share, net to the seller in cash.',
    );
    expect(p.offerPrice).toBe(35);
    expect(p.role).toBe('target');
  });
});

describe('EDGAR search hits', () => {
  it('parses display names', () => {
    expect(parseDisplayName('Kellanova  (K)  (CIK 0000055067)')).toEqual({
      name: 'Kellanova',
      tickers: ['K'],
      cik: '55067',
    });
    expect(
      parseDisplayName('Berkshire Hathaway Inc  (BRK-B, BRK-A)  (CIK 0001067983)').tickers,
    ).toEqual(['BRK.B', 'BRK.A']);
    expect(parseDisplayName('Private Holdco LLC  (CIK 0001999999)').tickers).toEqual([]);
  });

  it("builds the document's archive path", () => {
    const hit = dealFilingHit({
      _id: '0001193125-24-198765:d812345d8k.htm',
      _source: {
        ciks: ['0000055067'],
        display_names: ['Kellanova  (K)  (CIK 0000055067)'],
        file_date: '2024-08-14',
        form: '8-K',
        adsh: '0001193125-24-198765',
        items: ['1.01', '9.01'],
      },
    });
    expect(hit?.documentPath).toBe('/Archives/edgar/data/55067/000119312524198765/d812345d8k.htm');
    expect(hit?.filer.tickers).toEqual(['K']);
  });

  it('matches names without legal suffixes', () => {
    expect(nameKey('Small Target Inc.')).toBe(nameKey('SMALL TARGET, INC'));
  });
});

describe('deal status from later filings', () => {
  const f = (form: string, items: string[], at: string): EdgarFiling => ({
    accession: `${form}-${at}`,
    form,
    filingDate: at.slice(0, 10),
    acceptedAt: at,
    timeKnown: true,
    items,
    primaryDocument: 'x.htm',
    url: 'https://www.sec.gov/x',
  });
  it('goes pending on the proxy, closed on completion', () => {
    const changes = statusChanges(
      [
        f('8-K', ['1.01'], '2024-08-14T12:00:00.000Z'),
        f('DEFM14A', [], '2024-09-20T12:00:00.000Z'),
        f('8-K', ['2.01', '3.01', '5.01'], '2025-12-11T21:00:00.000Z'),
      ],
      '8-K-2024-08-14T12:00:00.000Z',
      '2024-08-14T12:00:00.000Z',
    );
    expect(changes.map((c) => c.status)).toEqual(['pending', 'closed']);
  });

  it('withdraws only on the termination of the merger agreement', () => {
    expect(terminatesMerger(doc('termination-8k.htm'))).toBe(true);
    expect(terminatesMerger('the Company terminated its revolving credit agreement')).toBe(false);
  });
});
