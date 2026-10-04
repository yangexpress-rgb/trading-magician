'use client';

import { ApiError, type CredentialDto, type CredentialListDto } from '@tm/contracts';
import {
  CREDENTIAL_PROVIDER_IDS,
  formatDateTime,
  PROVIDERS,
  type DisplayPreferences,
} from '@tm/domain';
import { Alert, Badge, Button, Dialog, SelectField, TextField } from '@tm/ui';
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { CredentialFields } from './credential-fields';

const providerName = (id: string) =>
  (PROVIDERS as Record<string, { name: string } | undefined>)[id]?.name ?? id;

/**
 * Stored API keys (§9.2–9.3, §16.1): what each is called, the masked end of
 * each value, and which connections use it. Values can be replaced or removed
 * but never shown again.
 */
export function CredentialsPanel({ prefs }: { prefs: DisplayPreferences }) {
  const [data, setData] = useState<CredentialListDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<CredentialDto | null>(null);
  const [removing, setRemoving] = useState<CredentialDto | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiClient.credentials.list());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load stored keys.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const when = (iso: string) =>
    formatDateTime(iso, prefs, { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">
        Keys are encrypted as soon as you save them and can never be shown again, here or anywhere
        else. Only the background service that talks to your provider can use them.
      </p>
      {error && <Alert>{error}</Alert>}
      {data && !data.storageReady && (
        <Alert tone="info">
          Secure key storage isn&apos;t set up on this server yet, so new keys can&apos;t be saved.
        </Alert>
      )}
      {data && data.credentials.length === 0 && <p className="text-sm">No stored keys yet.</p>}
      {data && data.credentials.length > 0 && (
        <ul
          aria-label="Stored API keys"
          className="divide-y divide-line rounded-md border border-line"
        >
          {data.credentials.map((c) => (
            <li key={c.id} aria-label={c.label} className="flex flex-wrap items-start gap-3 p-3">
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">
                  {c.label} <Badge tone="neutral">{providerName(c.provider)}</Badge>{' '}
                  <Badge tone="info">Paper</Badge>
                </p>
                <p className="mt-1 text-ink-muted">
                  {Object.entries(c.hint)
                    .map(([name, tail]) => `${fieldLabel(c.provider, name)} ${tail}`)
                    .join(' · ')}
                </p>
                <p className="mt-1 text-xs text-ink-muted">
                  Saved {when(c.createdAt)}
                  {c.rotatedAt ? `, replaced ${when(c.rotatedAt)}` : ''} ·{' '}
                  {c.usedBy.length > 0
                    ? `Used by ${c.usedBy.map((u) => u.name).join(', ')}`
                    : 'Not used yet'}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setReplacing(c)} disabled={!data.storageReady}>
                  Replace key
                </Button>
                <Button size="sm" variant="danger" onClick={() => setRemoving(c)}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {data?.storageReady && <Button onClick={() => setAdding(true)}>Add an API key</Button>}

      <AddKeyDialog
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          void load();
        }}
      />
      <ReplaceKeyDialog
        credential={replacing}
        onClose={() => setReplacing(null)}
        onSaved={() => {
          setReplacing(null);
          void load();
        }}
      />
      <RemoveKeyDialog
        credential={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          setRemoving(null);
          void load();
        }}
      />
    </div>
  );
}

function fieldLabel(provider: string, name: string) {
  const info = (
    PROVIDERS as Record<
      string,
      { credentialFields: readonly { name: string; label: string }[] } | undefined
    >
  )[provider];
  return info?.credentialFields.find((f) => f.name === name)?.label ?? name;
}

function AddKeyDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (c: CredentialDto) => void;
}) {
  const first = CREDENTIAL_PROVIDER_IDS[0] ?? 'alpaca';
  const [provider, setProvider] = useState<string>(first);
  const [label, setLabel] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setValues({});
    setLabel('');
    setError(null);
    onClose();
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const saved = await apiClient.credentials.create({ provider, label, fields: values });
      setValues({});
      setLabel('');
      setError(null);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the key.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add an API key"
      description="Use a paper trading key. It is encrypted when you save it and never shown again."
    >
      <form onSubmit={(e) => void save(e)} className="space-y-3" autoComplete="off">
        {error && <Alert>{error}</Alert>}
        <SelectField
          name="new-key-provider"
          label="Provider"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setValues({});
          }}
        >
          {CREDENTIAL_PROVIDER_IDS.map((id) => (
            <option key={id} value={id}>
              {PROVIDERS[id].name}
            </option>
          ))}
        </SelectField>
        <TextField
          name="new-key-label"
          label="Name"
          required
          maxLength={100}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          hint="Only for you, for example “Alpaca paper”."
        />
        <CredentialFields
          provider={provider}
          idPrefix="new-key"
          values={values}
          onChange={setValues}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save key'}
          </Button>
          <Button type="button" onClick={close} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ReplaceKeyDialog({
  credential,
  onClose,
  onSaved,
}: {
  credential: CredentialDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setValues({});
    setError(null);
    onClose();
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!credential) return;
    setBusy(true);
    try {
      await apiClient.credentials.rotate(credential.id, { fields: values });
      setValues({});
      setError(null);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not replace the key.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={credential !== null}
      onClose={close}
      title={`Replace ${credential?.label ?? 'key'}?`}
      description="Connections using it switch to the new value at once."
    >
      {credential && (
        <form onSubmit={(e) => void save(e)} className="space-y-3" autoComplete="off">
          {error && <Alert>{error}</Alert>}
          <CredentialFields
            provider={credential.provider}
            idPrefix="replace-key"
            values={values}
            onChange={setValues}
            hint={credential.hint}
          />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Replace key'}
            </Button>
            <Button type="button" onClick={close} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function RemoveKeyDialog({
  credential,
  onClose,
  onRemoved,
}: {
  credential: CredentialDto | null;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inUse = (credential?.usedBy.length ?? 0) > 0;

  async function remove() {
    if (!credential) return;
    setBusy(true);
    try {
      await apiClient.credentials.remove(credential.id);
      setError(null);
      onRemoved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove the key.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={credential !== null}
      onClose={() => {
        setError(null);
        onClose();
      }}
      title={`Remove ${credential?.label ?? 'key'}?`}
      description={
        inUse
          ? `It is used by ${credential?.usedBy.map((u) => u.name).join(', ')}. Remove it from those connections first.`
          : 'The encrypted value is deleted. This cannot be undone.'
      }
    >
      {error && <Alert>{error}</Alert>}
      <div className="flex gap-2">
        <Button variant="danger" onClick={() => void remove()} disabled={busy || inUse}>
          {busy ? 'Removing…' : 'Remove key'}
        </Button>
        <Button onClick={onClose} disabled={busy}>
          Keep it
        </Button>
      </div>
    </Dialog>
  );
}
