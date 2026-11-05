import postgres from 'postgres';

/**
 * Change notices for the Orders tab's live updates (ADR 0013). Triggers on the
 * execution tables call `pg_notify` with the owning user's id and nothing else,
 * so a notice carries no order data; listeners re-read through RLS.
 */
export const EXECUTION_CHANNEL = 'tm_execution';

export interface ExecutionListener {
  close(): Promise<void>;
}

/** One dedicated connection that calls `onChange(userId)` for every notice. */
export async function listenForExecutionChanges(
  url: string,
  onChange: (userId: string) => void,
): Promise<ExecutionListener> {
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  // postgres.js re-listens by itself after a dropped connection.
  await client.listen(EXECUTION_CHANNEL, (payload) => {
    if (/^[0-9a-f-]{36}$/i.test(payload)) onChange(payload);
  });
  return { close: () => client.end() };
}
