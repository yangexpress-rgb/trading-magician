import { DEFAULT_BACKTEST_INPUTS, type BacktestMetrics } from '@tm/backtest';
import type { BacktestRunSummaryDto } from '@tm/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunHistory, type BacktestsState } from './backtest';

function run(id: string, netReturnPct: string | null): BacktestRunSummaryDto {
  return {
    id,
    strategyId: 's1',
    versionId: 'v1',
    versionNo: 1,
    definitionHash: 'h',
    status: netReturnPct === null ? 'failed' : 'completed',
    inputs: { ...DEFAULT_BACKTEST_INPUTS, from: '2025-01-02', to: '2025-12-31' },
    dataSource: 'test',
    engineVersion: null,
    dataVersions: [],
    metrics: netReturnPct === null ? null : ({ netReturnPct } as unknown as BacktestMetrics),
    error: null,
    cancelRequested: false,
    createdAt: '2026-11-08T15:00:00Z',
    startedAt: null,
    finishedAt: null,
  };
}

function render(runs: BacktestRunSummaryDto[]): string {
  const state = {
    runs,
    loadError: null,
    selected: null,
    active: undefined,
    select: () => {},
    start: async () => {},
    cancel: async () => {},
  } satisfies BacktestsState;
  return renderToStaticMarkup(createElement(RunHistory, { state }));
}

describe('back test runs table (content and interface, N128)', () => {
  it('sets Net return right-aligned with tabular figures, its unit in the header (O102)', () => {
    const html = render([run('r1', '24.93')]);
    expect(html).toMatch(/<th scope="col" class="[^"]*text-right[^"]*">Net return %<\/th>/);
    const cell = html.match(/<td class="([^"]*)">\+24\.93<\/td>/);
    expect(cell, html).not.toBeNull();
    expect(cell![1]!.split(' ')).toEqual(expect.arrayContaining(['text-right', 'text-content']));
  });

  it('keeps text columns left-aligned content and shows a missing return as a dash', () => {
    const html = render([run('r2', null)]);
    expect(html).toMatch(/<th scope="col" class="[^"]*text-left[^"]*">Run<\/th>/);
    const dash = html.match(/<td class="([^"]*)">—<\/td>/);
    expect(dash, html).not.toBeNull();
    expect(dash![1]!.split(' ')).toEqual(expect.arrayContaining(['text-right', 'text-content']));
    // The Run column: content, not right-aligned.
    const first = html.match(/<tbody><tr[^>]*><td class="([^"]*)">/);
    expect(first![1]!.split(' ')).toContain('text-content');
    expect(first![1]!.split(' ')).not.toContain('text-right');
  });
});
