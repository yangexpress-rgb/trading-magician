import { listOfferedPlans, loadEntitlement, loadUsage, withTenant } from '@tm/db';
import { LIMIT_LABELS } from '@tm/domain';
import { Badge, Card, Table, Td, Th } from '@tm/ui';
import type { Metadata } from 'next';
import { COMPARED_LIMITS, formatPrice, limitValue, usageRows } from '@/lib/billing-text';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Subscription and billing' };

export default async function BillingPage() {
  const tenant = await requireTenant();
  const { entitlement, usage, plans } = await withTenant(appDb(), tenant, async (tx) => ({
    entitlement: await loadEntitlement(tx),
    usage: await loadUsage(tx),
    plans: await listOfferedPlans(tx),
  }));
  const rows = usageRows(entitlement.limits, usage);
  return (
    <div className="max-w-3xl space-y-6">
      <Card aria-labelledby="billing-heading" className="space-y-3">
        <h2 id="billing-heading" className="text-lg font-semibold">
          Subscription and billing
        </h2>
        <p className="text-sm text-ink-muted">
          You are on the <strong className="text-ink">{entitlement.planName}</strong> plan. Every
          plan trades on paper only.
        </p>
        <Table label="What you use">
          <thead>
            <tr>
              <Th>Limit</Th>
              <Th className="text-right">Used</Th>
              <Th className="text-right">Allowed</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <Td>
                  {r.label}{' '}
                  {r.full ? (
                    <Badge tone="warn">{r.used > r.allowed ? 'Over the limit' : 'Full'}</Badge>
                  ) : null}
                </Td>
                <Td className="text-right tabular-nums">{r.used}</Td>
                <Td className="text-right tabular-nums">{r.allowed}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {plans.length > 0 ? (
        <Card aria-labelledby="plans-heading" className="space-y-3">
          <h2 id="plans-heading" className="text-lg font-semibold">
            Plans
          </h2>
          <Table label="Plans compared">
            <thead>
              <tr>
                <Th>
                  <span className="sr-only">Limit</span>
                </Th>
                {plans.map((p) => (
                  <Th key={p.code} className="text-right">
                    {p.name}
                    {p.code === entitlement.planCode ? (
                      <span className="ml-2 normal-case">
                        <Badge tone="info">Your plan</Badge>
                      </span>
                    ) : null}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <Td>Price</Td>
                {plans.map((p) => (
                  <Td key={p.code} className="text-right font-medium">
                    {formatPrice(p.priceMinor, p.currency, p.interval)}
                  </Td>
                ))}
              </tr>
              {COMPARED_LIMITS.map((key) => (
                <tr key={key}>
                  <Td>{LIMIT_LABELS[key]}</Td>
                  {plans.map((p) => (
                    <Td key={p.code} className="text-right tabular-nums">
                      {limitValue(p.limits, key)}
                    </Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}
