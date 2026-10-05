import type { ConnectionHealthDto } from '@tm/contracts';
import { PROVIDERS } from '@tm/domain';
import type { Tone } from '@tm/ui';

/** Words for Settings › Data feeds and accounts (§9.2–9.3). */

export const HEALTH_LABELS: Record<ConnectionHealthDto, { tone: Tone; label: string }> = {
  healthy: { tone: 'ok', label: 'Healthy' },
  degraded: { tone: 'warn', label: 'Degraded' },
  down: { tone: 'danger', label: 'Down' },
  unknown: { tone: 'neutral', label: 'Not checked yet' },
};

export const ENTITLEMENT_LABELS = {
  entitled: 'Entitled',
  not_entitled: 'Not entitled',
  unknown: 'Entitlement unknown',
} as const;

export const ASSET_CLASS_LABELS: Record<string, string> = {
  stock: 'Stocks',
  etf: 'ETFs',
  option: 'Options',
  future: 'Futures',
  forex: 'Forex',
  crypto: 'Crypto',
};

export const DATA_TYPE_LABELS = { quotes: 'Live prices', trades: 'Trades', bars: 'Bars' } as const;

export const venueLabel = (venue: string | null) =>
  venue === null ? 'Any US venue' : venue === 'DEMO' ? 'Demo instruments' : venue;

export const providerName = (id: string) =>
  (PROVIDERS as Record<string, { name: string } | undefined>)[id]?.name ?? id;
