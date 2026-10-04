import { schema, withTenant } from '@tm/db';
import { Badge, ModeBadge, Table, Td, Th } from '@tm/ui';
import type { Metadata } from 'next';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Trading accounts' };

export default async function AccountsPage() {
  const tenant = await requireTenant();
  const accounts = await withTenant(appDb(), tenant, (tx) =>
    tx.select().from(schema.tradingAccounts),
  );
  return (
    <section aria-labelledby="accounts-heading" className="space-y-3">
      <h2 id="accounts-heading" className="text-lg font-semibold">
        Trading platforms and accounts
      </h2>
      <p className="text-sm text-ink-muted">
        This build supports paper trading only. Every account starts with a demo paper account.
      </p>
      <Table label="Trading accounts">
        <thead>
          <tr>
            <Th>Account</Th>
            <Th>Number</Th>
            <Th>Mode</Th>
            <Th>Currency</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id}>
              <Td className="font-medium">
                {a.nickname}{' '}
                {a.isDefault && (
                  <Badge tone="info" icon={false}>
                    Default
                  </Badge>
                )}
              </Td>
              <Td className="font-mono">{a.maskedExternalId}</Td>
              <Td>
                <ModeBadge mode={a.mode} />
              </Td>
              <Td>{a.currency}</Td>
              <Td>
                <Badge tone={a.isActive ? 'ok' : 'neutral'}>
                  {a.isActive ? 'Active' : 'Inactive'}
                </Badge>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}
