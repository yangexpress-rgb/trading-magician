import Link from 'next/link';
import type { ReactNode } from 'react';

/** "S00001-SD Name": the strategy's own number with its name, for plain text (N246). */
export function strategyLabel(s: { strategyName: string; strategyNumber: string | null }) {
  return s.strategyNumber ? `${s.strategyNumber} ${s.strategyName}` : s.strategyName;
}

/**
 * A strategy as Orders shows it (N246): its S number (ADR 0066) before its name,
 * linked to the strategy. Strategies without a number show the name alone.
 */
export function StrategyRef({
  strategyId,
  strategyName,
  strategyNumber,
  href,
  className,
  children,
}: {
  strategyId: string;
  strategyName: string;
  strategyNumber: string | null;
  href?: string;
  className?: string;
  children?: ReactNode;
}) {
  const content = (
    <>
      {strategyNumber && (
        <>
          <span className="whitespace-nowrap font-mono text-xs">{strategyNumber}</span>{' '}
        </>
      )}
      <span>{strategyName}</span>
      {children}
    </>
  );
  if (!strategyId) return <span className={className}>{content}</span>;
  return (
    <Link href={href ?? `/strategy-lab/${strategyId}`} className={className ?? 'underline'}>
      {content}
    </Link>
  );
}
