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

describe('back test runs table (data text role, N127)', () => {
  it('sets the Net return column right-aligned with tabular figures, header included', () => {
    const html = render([run('r1', '24.93')]);
    expect(html).toMatch(/<th scope="col" class="[^"]*text-right[^"]*">Net return<\/th>/);
    const cell = html.match(/<td class="([^"]*)">\+24\.93%<\/td>/);
    expect(cell, html).not.toBeNull();
    expect(cell![1]!.split(' ')).toEqual(expect.arrayContaining(['text-right', 'text-data']));
  });

  it('keeps text columns left-aligned and shows a missing return as a dash', () => {
    const html = render([run('r2', null)]);
    expect(html).toMatch(/<th scope="col" class="[^"]*text-left[^"]*">Run<\/th>/);
    expect(html).toMatch(/<td class="[^"]*text-right text-data[^"]*">—<\/td>/);
  });
});
