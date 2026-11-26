#!/usr/bin/env -S npx tsx
import { createInterface } from 'node:readline/promises';
import { CompanionClient } from './api';
import { companionHome } from './paths';
import { COMPANION_VERSION, platformName, runCompanion } from './companion';
import { newConfig, readConfig, tokenHint, writeConfig } from './config';
import { connectRunningStore, startLocalStore } from './store';
import { jobStates } from './sync';

/**
 * The companion's command line, until S3's setup flow wraps it:
 *
 *   tm-companion pair --api https://… [--token tma_…]   (token read from stdin if left out)
 *   tm-companion run                                     (runs until stopped)
 *   tm-companion status
 *   tm-companion forget                                  (removes the local pairing only)
 *   tm-companion move-data                               (copies the cloud's research data here, then checks it)
 */

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);
const stamp = (line: string) => out(`${new Date().toISOString()} ${line}`);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readToken(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  if (process.stdin.isTTY) process.stderr.write('Paste the pairing token: ');
  for await (const line of rl) {
    rl.close();
    return line.trim();
  }
  return '';
}

async function pair(args: string[], home: string): Promise<number> {
  const apiBase = flag(args, 'api');
  if (!apiBase) {
    err('Usage: tm-companion pair --api https://your-trading-magician-site [--token tma_…]');
    return 2;
  }
  const token = flag(args, 'token') ?? (await readToken());
  if (!token.startsWith('tma_')) {
    err(
      'That is not a pairing token. Copy it from Settings › Local research storage › Pair a companion.',
    );
    return 2;
  }
  const config = newConfig({ apiBase, token }, await readConfig(home));
  const client = new CompanionClient({ apiBase: config.apiBase, token: config.token });
  const reply = await client.hello({ version: COMPANION_VERSION, platform: platformName() });
  await writeConfig(home, config);
  out(`Paired. Trading Magician saw this companion at ${reply.seenAt}.`);
  out(`Settings are in ${home}. Start it with: tm-companion run`);
  return 0;
}

async function run(home: string): Promise<number> {
  const config = await readConfig(home);
  if (!config) {
    err('Not paired yet. Run: tm-companion pair --api https://your-trading-magician-site');
    return 2;
  }
  const controller = new AbortController();
  const stop = () => {
    stamp('Stopping…');
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  stamp(`Companion ${COMPANION_VERSION} for ${config.apiBase} (token ${tokenHint(config.token)})`);
  const reason = await runCompanion({ home, config, signal: controller.signal, log: stamp });
  if (reason.kind === 'unpaired') {
    err(`${reason.message}`);
    return 3;
  }
  stamp('Stopped.');
  return 0;
}

async function status(home: string): Promise<number> {
  const config = await readConfig(home);
  if (!config) {
    out('Not paired.');
    return 0;
  }
  out(`Paired to ${config.apiBase} since ${config.pairedAt} (token ${tokenHint(config.token)}).`);
  out(`Data folder: ${home}`);
  const local = { home, port: config.pgPort, password: config.pgPassword };
  const store = (await connectRunningStore(local)) ?? (await startLocalStore(local));
  try {
    const [counts] = await store.sql<{ instruments: number; periods: number }[]>`
      select (select count(*)::int from companion.instrument) as instruments,
             (select count(*)::int from companion.membership_period) as periods`;
    out(
      `Reference data: ${counts?.instruments ?? 0} instruments, ${counts?.periods ?? 0} membership periods.`,
    );
    for (const s of await jobStates(store.sql)) {
      const last = s.okAt ? s.okAt.toISOString() : 'never';
      out(`  ${s.job}: last ok ${last}${s.error ? `; last error: ${s.error}` : ''}`);
    }
  } finally {
    await store.stop();
  }
  return 0;
}

async function moveData(home: string): Promise<number> {
  const config = await readConfig(home);
  if (!config) {
    err('Not paired yet. Run: tm-companion pair --api https://your-trading-magician-site');
    return 2;
  }
  const { CloudData } = await import('./cloud-data');
  const { moveResearchData } = await import('./data-move');
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const local = { home, port: config.pgPort, password: config.pgPassword };
  const store = (await connectRunningStore(local)) ?? (await startLocalStore(local));
  try {
    const client = new CompanionClient({ apiBase: config.apiBase, token: config.token });
    const result = await moveResearchData(store.sql, new CloudData(client), stamp);
    const report = join(home, `data-move-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(report, JSON.stringify(result, null, 2));
    for (const c of result.verify) out(`  ${c.table}: cloud ${c.cloudRows}, here ${c.localAfter}`);
    out(result.verified ? 'VERIFIED' : 'NOT VERIFIED: run move-data again');
    out(`Report: ${report}`);
    return result.verified ? 0 : 1;
  } finally {
    await store.stop();
  }
}

async function forget(home: string): Promise<number> {
  const { rm } = await import('node:fs/promises');
  const { configPath } = await import('./paths');
  await rm(configPath(home), { force: true });
  out('This computer no longer holds the pairing token. The local research data is kept.');
  out('Also unpair it in Trading Magician › Settings › Local research storage.');
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const home = companionHome();
  switch (command) {
    case 'pair':
      return pair(args, home);
    case 'run':
      return run(home);
    case 'status':
      return status(home);
    case 'forget':
      return forget(home);
    case 'move-data':
      return moveData(home);
    default:
      err('Usage: tm-companion <pair|run|status|forget|move-data>');
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    err(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
