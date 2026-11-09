'use client';

import { ApiError, type StrategyDetailDto } from '@tm/contracts';
import { cx } from '@tm/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { apiClient } from '@/lib/api-client';
import { useRowVersion } from './row-version';

/** Same limit as the Rename dialog and the API. */
const MAX_NAME = 120;
/** How long a single click on a name link waits for a second click (N190). */
const DOUBLE_CLICK_MS = 250;
const HINT = 'Double-click to rename';

const message = (e: unknown) =>
  e instanceof ApiError
    ? (e.body.issues?.[0]?.message ?? e.message)
    : 'Could not rename. Check your connection and try again.';

interface RenameOptions {
  strategyId: string;
  name: string;
  rowVersion: number;
  onRenamed?: (detail: StrategyDetailDto) => void;
}

/**
 * Inline rename (N190): Enter or leaving the field saves, Esc cancels. Only the
 * name changes: the strategy's number, rules and versions stay as they are.
 */
function useInlineRename({ strategyId, name, rowVersion, onRenamed }: RenameOptions) {
  const router = useRouter();
  const [shown, setShown] = useState(name);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // Set once Enter or Esc has handled the edit, so the blur that follows does nothing.
  const done = useRef(false);

  useEffect(() => setShown(name), [name]);

  function start() {
    done.current = false;
    setDraft(shown);
    setError(undefined);
    setEditing(true);
  }

  function cancel() {
    done.current = true;
    setEditing(false);
    setError(undefined);
  }

  async function save() {
    if (pending) return;
    const next = draft.trim();
    if (next === shown) {
      cancel();
      return;
    }
    if (!next) {
      setError('A strategy needs a name.');
      return;
    }
    done.current = true;
    setPending(true);
    setError(undefined);
    try {
      const saved = await apiClient.strategies.update(strategyId, { rowVersion, name: next });
      setShown(saved.name);
      setEditing(false);
      onRenamed?.(saved);
      router.refresh();
    } catch (e) {
      done.current = false;
      setError(message(e));
    } finally {
      setPending(false);
    }
  }

  const input = editing ? (
    <span className="inline-flex flex-col">
      <input
        aria-label="Strategy name"
        aria-invalid={error ? true : undefined}
        className="min-w-[16rem] rounded border border-line bg-surface px-2 py-0.5 [font:inherit]"
        value={draft}
        maxLength={MAX_NAME}
        autoFocus
        disabled={pending}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => {
          if (!done.current) void save();
        }}
      />
      {error && (
        <span role="alert" className="mt-1 text-xs font-normal text-danger">
          {error}
        </span>
      )}
    </span>
  ) : null;

  return { shown, editing, start, input };
}

/** The strategy page's title; double-click (or F2) to rename it (N190). */
export function StrategyNameHeading({
  strategyId,
  name,
  initialRowVersion,
}: {
  strategyId: string;
  name: string;
  initialRowVersion: number;
}) {
  const [rowVersion, setRowVersion] = useRowVersion(initialRowVersion);
  const { shown, editing, start, input } = useInlineRename({
    strategyId,
    name,
    rowVersion,
    onRenamed: (saved) => setRowVersion(saved.rowVersion),
  });
  if (editing) return input;
  return (
    <span
      // Focusable so F2 can rename it from the keyboard.
      tabIndex={0}
      title={HINT}
      aria-description={`${HINT}, or press F2`}
      className="cursor-text rounded hover:bg-surface-2"
      onDoubleClick={start}
      onKeyDown={(e) => {
        if (e.key === 'F2') {
          e.preventDefault();
          start();
        }
      }}
    >
      {shown}
    </span>
  );
}

/**
 * A link that opens on a click and does something else on a double-click
 * (N190). A plain click waits a moment for a second click; keyboard,
 * Cmd/Ctrl-click and middle-click open it at once, as before.
 */
export function useClickOrDoubleClick(href: string, onDouble: () => void) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    onClick(e: MouseEvent<HTMLAnchorElement>) {
      if (e.detail === 0 || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      e.preventDefault();
      clearTimeout(timer.current);
      if (e.detail === 1) timer.current = setTimeout(() => router.push(href), DOUBLE_CLICK_MS);
    },
    onDoubleClick(e: MouseEvent<HTMLAnchorElement>) {
      e.preventDefault();
      clearTimeout(timer.current);
      onDouble();
    },
    onKeyDown(e: KeyboardEvent<HTMLAnchorElement>) {
      if (e.key === 'F2') {
        e.preventDefault();
        onDouble();
      }
    },
  };
}

/** A strategy's name in the Strategy Lab list: a click opens it, a double-click renames it (N190). */
export function StrategyNameLink({
  strategyId,
  name,
  rowVersion,
  href,
  className,
}: {
  strategyId: string;
  name: string;
  rowVersion: number;
  href: string;
  className?: string;
}) {
  const { shown, editing, start, input } = useInlineRename({ strategyId, name, rowVersion });
  const handlers = useClickOrDoubleClick(href, start);
  if (editing) return input;
  return (
    <Link href={href} title={HINT} className={cx(className)} {...handlers}>
      {shown}
    </Link>
  );
}
