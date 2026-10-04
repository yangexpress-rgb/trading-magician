import type { Database } from './client';
import { DEMO_INSTRUMENTS, DEMO_VENUE } from './demo';
import { instruments } from './schema';

/** Inserts the generic demo instruments. Run with the owner connection. Idempotent. */
export async function seedReferenceData(db: Database): Promise<void> {
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
}
