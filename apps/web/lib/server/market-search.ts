import { loadRouting, sharedFeedsInUse, type Transaction } from '@tm/db';
import { isProviderId, providerCoversVenue, PROVIDERS } from '@tm/domain';

/**
 * Whether the person has a real price feed that can search every US stock,
 * such as Alpaca (ADR 0029); without one of their own, the admin's shared
 * ones search for them (N237).
 */
export async function hasMarketSearch(tx: Transaction): Promise<boolean> {
  return [
    ...(await loadRouting(tx)).feeds.values(),
    ...(await sharedFeedsInUse(tx, 'prices')).map((f) => ({ ...f, isActive: true })),
  ].some(
    (f) =>
      f.isActive &&
      providerCoversVenue(f.provider, 'US') &&
      isProviderId(f.provider) &&
      (PROVIDERS[f.provider].assetClasses as readonly string[]).includes('stock'),
  );
}
