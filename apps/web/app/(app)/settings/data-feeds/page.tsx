import { schema, withTenant } from '@tm/db';
import { Badge, Table, Td, Th, type Tone } from '@tm/ui';
import type { Metadata } from 'next';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Data feeds' };

const UNKNOWN = { tone: 'neutral', label: 'Unknown' } as const;
const HEALTH: Record<string, { tone: Tone; label: string }> = {
  healthy: { tone: 'ok', label: 'Healthy' },
  degraded: { tone: 'warn', label: 'Degraded' },
  down: { tone: 'danger', label: 'Down' },
  unknown: { tone: 'neutral', label: 'Unknown' },
};

export default async function DataFeedsPage() {
  const tenant = await requireTenant();
  const feeds = await withTenant(appDb(), tenant, (tx) =>
    tx.select().from(schema.dataFeedConnections),
  );
  return (
    <section aria-labelledby="feeds-heading" className="space-y-3">
      <h2 id="feeds-heading" className="text-lg font-semibold">
        Data feeds
      </h2>
      <p className="text-sm text-ink-muted">
        Every account starts with a demo feed. Connecting your own providers comes in a later phase.
      </p>
      <Table label="Data feeds">
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Provider</Th>
            <Th>Asset classes</Th>
            <Th>Data</Th>
            <Th>Status</Th>
            <Th>Health</Th>
          </tr>
        </thead>
        <tbody>
          {feeds.map((f) => {
            const health = HEALTH[f.health] ?? UNKNOWN;
            return (
              <tr key={f.id}>
                <Td className="font-medium">{f.name}</Td>
                <Td>{f.provider}</Td>
                <Td>{f.assetClasses.join(', ')}</Td>
                <Td>{f.isRealtime ? 'Real-time' : 'Delayed'}</Td>
                <Td>
                  <Badge tone={f.isActive ? 'ok' : 'neutral'}>
                    {f.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </Td>
                <Td>
                  <Badge tone={health.tone}>{health.label}</Badge>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </section>
  );
}
