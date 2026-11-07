import { parseDefinition } from '@tm/domain';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { behaviour, decode } from './corpus-codec';
import { simulate, type SimulationInput } from './engine';

/**
 * Every fixture strategy the back-test suite ran before the Strategy Lab
 * simplification (main 5bc70be), with its exact inputs and data, recorded as
 * the stored (schema version 1) definition and the behaviour fingerprint of
 * its result. Each one is read through the schema migrations and back tested
 * again: it must decide, trade and report exactly as it did.
 */
interface Run {
  test: string;
  behaviour: string;
  input: Record<string, unknown> & { data: Record<string, unknown> };
}
interface Corpus {
  recordedAt: string;
  runs: Run[];
  blobs: Record<string, unknown>;
}

const corpus = JSON.parse(
  gunzipSync(readFileSync(new URL('./fixtures/corpus-v1.json.gz', import.meta.url))).toString(),
) as Corpus;

function rebuild(run: Run): SimulationInput {
  const data: Record<string, unknown> = { ...run.input.data };
  for (const key of ['series', 'fundamentals', 'options'])
    if (data[key])
      data[key] = {
        $m: (data[key] as { $refs: [string, string][] }).$refs.map(([k, h]) => [
          k,
          corpus.blobs[h],
        ]),
      };
  const input = decode({ ...run.input, data }) as SimulationInput;
  return { ...input, definition: parseDefinition(run.input.definition) };
}

/** Runs whose result changes on purpose, with the reason (see docs/adr). */
const EXPECTED_CHANGES: Record<number, string> = {};

describe('every recorded fixture strategy back tests as before (corpus)', () => {
  it.each(corpus.runs.map((r, i) => [i, r.test || '(module level)', r] as const))(
    '#%i %s',
    (i, _name, run) => {
      const r = simulate(rebuild(run));
      if (EXPECTED_CHANGES[i]) expect(behaviour(r)).not.toBe(run.behaviour);
      else expect(behaviour(r)).toBe(run.behaviour);
    },
  );
});
