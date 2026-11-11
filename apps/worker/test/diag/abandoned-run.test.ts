/**
 * Reproduction of the abandoned Earnings breakout back tests (diagnosis
 * 2026-11-11). Off unless DIAG_BACKTEST=1, so CI never runs it. One
 * configuration per process, so memory readings start clean:
 *
 *   DIAG_BACKTEST=1 DIAG_MEMBERS=100 DIAG_MONTHS=12 DIAG_PRICE=5m DIAG_EARNINGS=1 \
 *   DIAG_RANKING=1 DIAG_OUT=/path/out.jsonl TEST_DATABASE_URL=… \
 *   pnpm --filter @tm/worker exec vitest run test/diag/abandoned-run.test.ts
 *
 * The strategy is the scenario in ../earnings-breakout-scenario.ts. The feed
 * has no network wait unless DIAG_LATENCY_MS is set. Runs too big for a back
 * test are refused up front (ADR 0081) and recorded as `refused`.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { getBacktest } from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { addDays } from '@tm/domain';
import { afterAll, describe, expect, it } from 'vitest';
import { processNextRun } from '../../src/backtests';
import { createScenario, syntheticFeed } from '../earnings-breakout-scenario';

const on = process.env.DIAG_BACKTEST === '1';
const MEMBERS = Number(process.env.DIAG_MEMBERS ?? 25);
const MONTHS = Number(process.env.DIAG_MONTHS ?? 1);
const PRICE = (process.env.DIAG_PRICE ?? '5m') as '5m' | '1d';
const EARNINGS = process.env.DIAG_EARNINGS !== '0';
const RANKING = process.env.DIAG_RANKING !== '0';
const LATENCY = Number(process.env.DIAG_LATENCY_MS ?? 0);
const OUT = process.env.DIAG_OUT;
const TO = '2026-11-07';
const FROM = MONTHS >= 12 ? '2025-11-08' : addDays(TO, -Math.round(MONTHS * 30.4));

let t: TestDatabase | undefined;

afterAll(async () => {
  await t?.drop();
});

describe.runIf(on)('abandoned back test reproduction', () => {
  it(`${MEMBERS} members, ${MONTHS} months, ${PRICE} Last/Low, earnings ${EARNINGS}, ranking ${RANKING}`, async () => {
    t = await createTestDatabase();
    const scenario = await createScenario(t, {
      members: MEMBERS,
      from: FROM,
      to: TO,
      price: PRICE,
      earnings: EARNINGS,
      ranking: RANKING,
    });
    const feed = syntheticFeed(LATENCY);
    const started = await scenario.start();
    if ('refused' in started) {
      const config = { members: MEMBERS, months: MONTHS, from: FROM, to: TO, price: PRICE };
      if (OUT)
        appendFileSync(OUT, `${JSON.stringify({ config, outcome: 'refused', ...started })}\n`);
      expect(started.refused).toMatch(/price bars/);
      return;
    }

    const lines: Record<string, unknown>[] = [];
    const capture = (level: string) => (obj: unknown, msg?: string) => {
      if (obj && typeof obj === 'object' && 'event' in obj) {
        lines.push({ level, msg, ...obj });
        // Streamed too, so a run that dies (out of memory) leaves its last stage behind.
        if (OUT) appendFileSync(`${OUT}.events`, `${JSON.stringify({ level, msg, ...obj })}\n`);
      }
    };
    const logger = { info: capture('info'), warn: capture('warn'), error: capture('error') };
    const profile = process.env.DIAG_PROFILE;
    const inspector = profile ? new Session() : undefined;
    if (inspector) {
      inspector.connect();
      await inspector.post('Profiler.enable');
      await inspector.post('Profiler.start');
    }
    const t0 = Date.now();
    const outcome = await processNextRun({
      db: t.app.db,
      provider: feed.provider,
      workerId: 'diag-worker',
      logger,
      heartbeatMs: 5000,
      resolveUniverse: async () => ({ ids: scenario.ids, warnings: [] }),
    });
    if (inspector && profile) {
      const { profile: cpu } = await inspector.post('Profiler.stop');
      writeFileSync(profile, JSON.stringify(cpu));
      inspector.disconnect();
    }
    const done = await scenario.asUser((tx) => getBacktest(tx, started.runId));
    const config = {
      members: MEMBERS,
      months: MONTHS,
      from: FROM,
      to: TO,
      price: PRICE,
      earnings: EARNINGS,
      ranking: RANKING,
    };
    const summary = {
      config,
      outcome,
      totalMs: Date.now() - t0,
      cycles: done.metrics?.cycles ?? null,
      stages: lines.filter((l) => l.event === 'backtest.stage'),
      heartbeats: lines.filter((l) => l.event === 'backtest.heartbeat').length,
      final: lines.find((l) => l.event === 'backtest.summary'),
      error: done.error,
    };
    if (OUT) appendFileSync(OUT, `${JSON.stringify(summary)}\n`);
    expect(outcome).toBe('completed');
  }, 3_600_000);
});
