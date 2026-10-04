/** Produces unique node ids. Injected so tests and replays are deterministic. */
export type IdFactory = () => string;

export const randomId: IdFactory = () => crypto.randomUUID();

/** Deterministic ids for tests: n1, n2, ... */
export function sequentialIds(prefix = 'n'): IdFactory {
  let n = 0;
  return () => `${prefix}${++n}`;
}
