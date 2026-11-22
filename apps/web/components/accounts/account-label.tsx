import { cx } from '@tm/ui';

/**
 * An account's environment in words (N309): PAPER or LIVE, never colour alone. Live
 * accounts can't exist yet (the live gate is Phase 7 P3), but every label is ready for one.
 */
export const ENVIRONMENT_TEXT: Record<'paper' | 'live', string> = { paper: 'PAPER', live: 'LIVE' };

/** "Alpaca paper ••••4BD4 · PAPER": an account in a select or a sentence (N309). */
export function accountText(name: string, mode: 'paper' | 'live'): string {
  return `${name} · ${ENVIRONMENT_TEXT[mode]}`;
}

/** An account's name with its PAPER or LIVE tag, for table cells and lists (N309). */
export function AccountLabel({
  name,
  mode,
  className,
}: {
  name: string;
  mode: 'paper' | 'live';
  className?: string;
}) {
  return (
    <span className={cx('inline-flex flex-wrap items-baseline gap-x-1.5', className)}>
      <span>{name}</span>
      <span
        className={cx(
          'rounded border px-1 text-[0.65rem] font-semibold tracking-wide whitespace-nowrap',
          mode === 'live'
            ? 'border-danger/50 bg-danger-soft text-danger'
            : 'border-paper/40 bg-paper-soft text-paper',
        )}
      >
        {ENVIRONMENT_TEXT[mode]}
      </span>
    </span>
  );
}

/** Accounts grouped for a picker (§7 of the Phase 7 brief): paper first, live in their own group. */
export function groupAccounts<T extends { mode: 'paper' | 'live'; nickname: string }>(
  accounts: readonly T[],
): { paper: T[]; live: T[] } {
  const byName = (a: T, b: T) => a.nickname.localeCompare(b.nickname);
  return {
    paper: accounts.filter((a) => a.mode === 'paper').sort(byName),
    live: accounts.filter((a) => a.mode === 'live').sort(byName),
  };
}
