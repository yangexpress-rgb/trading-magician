import type { Database } from './client';
import { DEMO_INSTRUMENTS, DEMO_VENUE, demoDataEnabled } from './demo';
import { instruments } from './schema';

/**
 * Inserts the generic demo instruments, only when demo data is on (tests;
 * ADR 0039). Run with the owner connection. Idempotent. Returns whether it seeded.
 */
export async function seedReferenceData(
  db: Database,
  options: { demo?: boolean } = {},
): Promise<boolean> {
  if (!(options.demo ?? demoDataEnabled())) return false;
  await db
    .insert(instruments)
    .values(
      DEMO_INSTRUMENTS.map((i) => ({
        assetClass: i.assetClass,
        symbol: i.symbol,
        venue: DEMO_VENUE,
        currency: 'USD',
        displayName: i.displayName,
        tickSize: '0.01',
        isDemo: true,
      })),
    )
    .onConflictDoNothing();
  return true;
}
