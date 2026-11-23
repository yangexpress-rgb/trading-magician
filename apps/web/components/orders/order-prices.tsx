'use client';

import type { OrderRowDto } from '@tm/contracts';
import { Td, Th } from '@tm/ui';
import { formatPrice } from '@/lib/order-text';

/**
 * Prices on every order table (N330): the fill price as Entry price on entry
 * legs and as Exit price on exit and close legs, then the instrument's latest
 * price.
 */
export function OrderPriceHeads() {
  return (
    <>
      <Th numeric>Entry price</Th>
      <Th numeric>Exit price</Th>
      <Th numeric>
        <span title="The instrument's latest price, kept fresh while Orders is open">
          Last price
        </span>
      </Th>
    </>
  );
}

const dash = <span className="text-ink-muted">—</span>;

export function OrderPriceCells({
  order: o,
  when,
}: {
  order: OrderRowDto;
  when: (iso: string | null) => string;
}) {
  const fill = o.averagePrice === null ? null : Number(o.averagePrice);
  const entry = o.phase === 'entry';
  return (
    <>
      <Td numeric sortValue={entry && fill !== null ? fill : ''} className="whitespace-nowrap">
        {entry && o.averagePrice !== null ? formatPrice(o.averagePrice) : dash}
      </Td>
      <Td numeric sortValue={!entry && fill !== null ? fill : ''} className="whitespace-nowrap">
        {!entry && o.averagePrice !== null ? formatPrice(o.averagePrice) : dash}
      </Td>
      <Td numeric sortValue={o.lastPrice ?? ''} className="whitespace-nowrap">
        {o.lastPrice === null ? (
          dash
        ) : (
          <span title={o.lastPriceAt ? `As of ${when(o.lastPriceAt)}` : undefined}>
            {formatPrice(String(o.lastPrice))}
          </span>
        )}
      </Td>
    </>
  );
}
