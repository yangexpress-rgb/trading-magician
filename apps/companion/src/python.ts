import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The trainer is Python (ADR 0086). Until S3's installer bundles a Python
 * runtime, the companion makes its own virtual environment in its data folder
 * from the computer's Python 3.12+ (TM_COMPANION_PYTHON names another one),
 * installs the trainer's pinned requirements there once, and runs the trainer
 * from this repository's `apps/ml-trainer`.
 */

export const TRAINER_DIR = fileURLToPath(new URL('../../ml-trainer', import.meta.url));

export const venvDir = (home: string) => join(home, 'python');
const venvPython = (home: string) =>
  process.platform === 'win32'
    ? join(venvDir(home), 'Scripts', 'python.exe')
    : join(venvDir(home), 'bin', 'python');

export interface RunResult {
  code: number;
  /** The last lines the process wrote, for the log and status. */
  tail: string[];
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
    signal?: AbortSignal;
  },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const tail: string[] = [];
    const take = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        options.log?.(line);
        tail.push(line);
        if (tail.length > 20) tail.shift();
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, tail }));
  });
}

/** The virtual environment's Python, made (and the requirements installed) on first use. */
export async function ensurePython(home: string, log: (line: string) => void): Promise<string> {
  const python = venvPython(home);
  const marker = join(venvDir(home), '.tm-requirements-ok');
  if (existsSync(python) && existsSync(marker)) return python;
  const base =
    process.env.TM_COMPANION_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  log(`Setting up the trainer's Python environment with ${base} (first run only)…`);
  const made = await runProcess(base, ['-m', 'venv', venvDir(home)], { log });
  if (made.code !== 0) {
    throw new Error(
      `Could not make a Python environment with ${base}: ${made.tail.at(-1) ?? 'failed'}`,
    );
  }
  const installed = await runProcess(
    python,
    [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '-r',
      join(TRAINER_DIR, 'requirements.txt'),
    ],
    { log },
  );
  if (installed.code !== 0) {
    throw new Error(
      `Could not install the trainer's requirements: ${installed.tail.at(-1) ?? 'failed'}`,
    );
  }
  const { writeFile } = await import('node:fs/promises');
  await writeFile(marker, new Date().toISOString());
  return python;
}

/** Runs the ML trainer against the local store (the same command the cloud's cron runs). */
export async function runTrainer(options: {
  python: string;
  storeUrl: string;
  log: (line: string) => void;
  signal?: AbortSignal;
}): Promise<RunResult> {
  return runProcess(options.python, ['-m', 'trainer'], {
    cwd: TRAINER_DIR,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // Core and the Research Store are the same local database here.
      DATABASE_WORKER_URL: options.storeUrl,
      ML_TRAINER_ENABLED: 'on',
      PATTERN_MINER_ENABLED: 'off',
      GIT_SHA: 'companion',
    },
    log: options.log,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
