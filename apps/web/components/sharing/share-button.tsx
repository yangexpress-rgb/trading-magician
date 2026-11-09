'use client';

import { ApiError, type ShareMemberDto, type ShareSourceDto } from '@tm/contracts';
import { Alert, Button, Dialog, TextField } from '@tm/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';

const NOTE_MAX = 500;

const message = (e: unknown, fallback: string) =>
  e instanceof ApiError ? (e.body.issues?.[0]?.message ?? e.message) : fallback;

/** One thing to share, with its label ("T00012-SD Golden cross"). */
export interface ShareItem {
  source: ShareSourceDto;
  label: string;
}

/**
 * Share a Library record or a Strategy Lab strategy with other members
 * (ADR 0056). People are added by exact member ID or email and confirmed by
 * name before sending; the admin can also pick from every member.
 */
export function ShareButton({
  source,
  label,
  isAdmin = false,
  variant = 'secondary',
  size = 'md',
}: {
  source: ShareSourceDto;
  /** "T00012-SD Golden cross", for the dialog's title. */
  label: string;
  isAdmin?: boolean;
  variant?: 'secondary' | 'ghost';
  size?: 'sm' | 'md';
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={variant}
        size={size}
        aria-label={`Share ${label}`}
        onClick={() => setOpen(true)}
      >
        Share
      </Button>
      <ShareDialog
        open={open}
        onClose={() => setOpen(false)}
        items={[{ source, label }]}
        isAdmin={isAdmin}
      />
    </>
  );
}

/**
 * The share dialog for one or several items (N125): each item goes to each
 * person, in one all-or-nothing send.
 */
export function ShareDialog({
  open,
  onClose,
  items,
  isAdmin = false,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  items: ShareItem[];
  isAdmin?: boolean;
  onSent?: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [people, setPeople] = useState<ShareMemberDto[]>([]);
  const [allMembers, setAllMembers] = useState(false);
  const [members, setMembers] = useState<ShareMemberDto[] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<number | null>(null);

  // A fresh form each time it opens.
  useEffect(() => {
    if (!open) return;
    setTyped('');
    setPeople([]);
    setAllMembers(false);
    setNote('');
    setError(undefined);
    setSent(null);
  }, [open]);

  useEffect(() => {
    if (!open || !isAdmin || members) return;
    apiClient.members.list().then(
      (r) => setMembers(r.items),
      () => setMembers([]),
    );
  }, [open, isAdmin, members]);

  function addPerson(m: ShareMemberDto) {
    setPeople((p) => (p.some((x) => x.memberCode === m.memberCode) ? p : [...p, m]));
  }

  async function add() {
    const q = typed.trim();
    if (!q) return;
    setError(undefined);
    setBusy(true);
    try {
      const { member } = await apiClient.members.lookup(q);
      if (!member) setError(`${q}: this member can’t receive shares.`);
      else {
        addPerson(member);
        setTyped('');
      }
    } catch (e) {
      setError(message(e, 'Could not look that up. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    setBusy(true);
    setError(undefined);
    try {
      const { items: shares } = await apiClient.shares.create({
        ...(items.length === 1 && items[0]
          ? { source: items[0].source }
          : { sources: items.map((i) => i.source) }),
        recipients: people.map((p) => p.memberCode),
        allMembers,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setSent(shares.length);
      onSent?.();
    } catch (e) {
      setError(message(e, 'Could not share it. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  const nobody = people.length === 0 && !allMembers;
  const lab = items[0]?.source.kind === 'lab';
  const many = items.length > 1;
  const plural = (n: number) =>
    lab ? (n === 1 ? 'strategy' : 'strategies') : n === 1 ? 'theory' : 'theories';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        many ? `Share ${items.length} ${plural(items.length)}` : `Share ${items[0]?.label ?? ''}`
      }
      description={
        lab
          ? `They get a copy of ${many ? 'each strategy' : 'this strategy'} as it is now, with its own new number, in their Strategy Lab. Your back tests, orders, accounts and run history are not sent.`
          : `They get a copy of ${many ? 'each theory' : 'this theory'} as it is now, with its own new number, in the Library. Nothing changes on your side.`
      }
    >
      {sent !== null ? (
        <div className="space-y-4">
          <Alert tone="ok">
            {many
              ? `Made ${sent} ${sent === 1 ? 'share' : 'shares'} (${items.length} ${plural(items.length)}, each to every person).`
              : `Shared with ${sent} ${sent === 1 ? 'person' : 'people'}.`}{' '}
            They’ll see {many ? 'them' : 'it'} in Sharing and can accept or decline.
          </Alert>
          <div className="flex justify-end gap-2">
            <Link href="/sharing?box=sent" className="self-center text-sm">
              See what you’ve shared
            </Link>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form action={send} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          {many && (
            <ul
              aria-label="Sharing these"
              className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border border-line p-2 text-sm"
            >
              {items.map((i) => (
                <li key={i.label}>{i.label}</li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextField
                label="Member ID or email"
                name="share-recipient"
                placeholder="U0007 or name@example.com"
                hint="Ask them for the member ID shown in their Settings."
                value={typed}
                maxLength={320}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void add();
                  }
                }}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={busy || !typed.trim()}
              onClick={() => void add()}
              className="mb-5"
            >
              Add
            </Button>
          </div>
          {isAdmin && (
            <fieldset className="space-y-2 rounded-md border border-line p-3">
              <legend className="px-1 text-sm font-medium">Members</legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allMembers}
                  onChange={(e) => setAllMembers(e.target.checked)}
                />
                All members{members ? ` (${members.length})` : ''}
              </label>
              {!allMembers && members && members.length > 0 && (
                <ul className="max-h-40 space-y-1 overflow-y-auto">
                  {members.map((m) => (
                    <li key={m.memberCode}>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={people.some((p) => p.memberCode === m.memberCode)}
                          onChange={(e) =>
                            e.target.checked
                              ? addPerson(m)
                              : setPeople((p) => p.filter((x) => x.memberCode !== m.memberCode))
                          }
                        />
                        {m.displayName}{' '}
                        <span className="font-mono text-ink-muted">({m.memberCode})</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          )}
          {people.length > 0 && !allMembers && (
            <ul aria-label="Sharing with" className="flex flex-wrap gap-2">
              {people.map((p) => (
                <li
                  key={p.memberCode}
                  className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1 text-sm"
                >
                  {p.displayName} <span className="font-mono text-ink-muted">({p.memberCode})</span>
                  <button
                    type="button"
                    aria-label={`Remove ${p.displayName}`}
                    className="text-ink-muted hover:text-ink"
                    onClick={() =>
                      setPeople((all) => all.filter((x) => x.memberCode !== p.memberCode))
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <label htmlFor="share-note" className="block text-sm font-semibold text-ink-muted">
              Note (optional)
            </label>
            <textarea
              id="share-note"
              name="share-note"
              rows={3}
              maxLength={NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || nobody}>
              {busy ? 'Sharing…' : 'Share'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
