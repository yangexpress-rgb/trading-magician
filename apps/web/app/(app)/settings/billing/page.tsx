import { getSubscription, listOfferedPlans, loadEntitlement, loadUsage, withTenant } from '@tm/db';
import { formatDateTime, LIMIT_LABELS } from '@tm/domain';
import { Alert, Badge, Card, Table, Td, Th } from '@tm/ui';
import type { Metadata } from 'next';
import { BillingActions } from '@/components/billing-actions';
import {
  COMPARED_LIMITS,
  formatPrice,
  limitValue,
  subscriptionNote,
  usageRows,
} from '@/lib/billing-text';
import { billingProvider } from '@/lib/server/billing';
import { appDb } from '@/lib/server/db';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Subscription and billing' };

const PAYING = new Set(['active', 'trialing', 'past_due']);

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { checkout } = await searchParams;
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  const { entitlement, usage, plans, subscription } = await withTenant(
    appDb(),
    tenant,
    async (tx) => ({
      entitlement: await loadEntitlement(tx),
      usage: await loadUsage(tx),
      plans: await listOfferedPlans(tx),
      subscription: await getSubscription(tx),
    }),
  );
  const rows = usageRows(entitlement.limits, usage);
  const paying = subscription.status !== null && PAYING.has(subscription.status);
  const available = billingProvider() !== undefined;
  const current = plans.find((p) => p.code === entitlement.planCode);
  const upgrades =
    available && !paying ? plans.filter((p) => p.priceMinor > (current?.priceMinor ?? 0)) : [];
  const note = subscriptionNote({
    planName: subscription.planName,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    periodEnd: subscription.currentPeriodEnd
      ? formatDateTime(
          subscription.currentPeriodEnd,
          { timeZone: profile.timezone, locale: profile.locale },
          { dateStyle: 'medium' },
        )
      : null,
    graceEnd: subscription.graceEndsAt
      ? formatDateTime(
          subscription.graceEndsAt,
          { timeZone: profile.timezone, locale: profile.locale },
          { dateStyle: 'medium' },
        )
      : null,
    defaultPlanName: plans.find((p) => p.isDefault)?.name ?? 'Free',
  });
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
        {checkout === 'done' && (
          <p role="status" className="text-sm text-ok">
            Thanks. Your plan changes as soon as the payment is confirmed.
          </p>
        )}
        {checkout === 'canceled' && (
          <p role="status" className="text-sm text-ink-muted">
            Checkout was cancelled. Nothing was charged.
          </p>
        )}
        {note &&
          (note.warn ? (
            <Alert>{note.text}</Alert>
          ) : (
            <p className="text-sm text-ink-muted">{note.text}</p>
          ))}
        {(upgrades.length > 0 || (available && subscription.customerId)) && (
          <BillingActions
            upgrades={upgrades.map((p) => ({ code: p.code, name: p.name }))}
            canManage={available && subscription.customerId !== null}
          />
        )}
        {!available && (
          <p className="text-sm text-ink-muted">
            Paying for a plan is not set up on this server yet.
          </p>
        )}
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
