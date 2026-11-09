import { formatDateTime, type DisplayPreferences } from '@tm/domain';
import { Badge } from '@tm/ui';
import Link from 'next/link';

export interface SharedByProps {
  sharedBy: {
    senderName: string | null;
    senderCode: string;
    senderIsAdmin: boolean;
    sourceNumber: string;
    acceptedAt: Date | string | null;
  } | null;
  /** The Library's copied-from number, for viewers who aren't party to the share. */
  copiedFrom?: string | null;
  prefs: DisplayPreferences;
}

/**
 * The provenance line on a received copy (ADR 0056): "Shared by Yong (U0001)
 * on 8 Nov 2026, from T00012-SD". It stays for good, even after edits.
 */
export function SharedBy({ sharedBy, copiedFrom, prefs }: SharedByProps) {
  if (!sharedBy) {
    if (!copiedFrom) return null;
    return (
      <p className="mt-2 text-sm text-ink-muted">
        Copied from <Link href={`/library/${copiedFrom}`}>{copiedFrom}</Link>
      </p>
    );
  }
  const who = `${sharedBy.senderName ?? 'a former member'} (${sharedBy.senderCode})`;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <Badge tone="info" icon={false}>
        Shared
      </Badge>
      <span>
        Shared by <strong>{who}</strong>
        {sharedBy.acceptedAt
          ? ` on ${formatDateTime(sharedBy.acceptedAt, prefs, { dateStyle: 'medium' })}`
          : ''}
        , from <Link href={`/library/${sharedBy.sourceNumber}`}>{sharedBy.sourceNumber}</Link>
      </span>
      {sharedBy.senderIsAdmin && (
        <Badge tone="warn" icon={false}>
          Admin
        </Badge>
      )}
    </p>
  );
}
