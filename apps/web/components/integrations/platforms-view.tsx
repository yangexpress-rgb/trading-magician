'use client';

import {
  ApiError,
  type AccountDto,
  type AccountInUseDetails,
  type PlatformDto,
  type PlatformListDto,
} from '@tm/contracts';
import { formatDateTime, PROVIDER_IDS, PROVIDERS, type DisplayPreferences } from '@tm/domain';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  ModeBadge,
  SelectField,
  Table,
  Td,
  TextField,
  Th,
} from '@tm/ui';
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { ASSET_CLASS_LABELS, HEALTH_LABELS, providerName } from '@/lib/integration-text';
import { subscribeLive } from '@/lib/live-events';
import { CredentialFields } from './credential-fields';

/** Platforms that can be added: real brokers signed in with a paper key. */
const BROKER_PROVIDERS = PROVIDER_IDS.filter(
  (id) =>
    (PROVIDERS[id].offers as readonly string[]).includes('broker') &&
    PROVIDERS[id].credentialFields.length > 0,
);

const ORDER_TYPE_LABELS: Record<string, string> = {
  market: 'market',
  limit: 'limit',
  stop: 'stop',
  stop_limit: 'stop limit',
};

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function capabilityText(a: AccountDto): string {
  const c = a.capabilities;
  return [
    c.assetClasses.map((x) => ASSET_CLASS_LABELS[x] ?? x).join(' and '),
    `${c.orderTypes.map((o) => ORDER_TYPE_LABELS[o] ?? o).join(', ')} orders`,
    c.shortSelling ? 'short selling' : 'no short selling',
    c.extendedHours ? 'extended hours' : 'regular hours only',
    c.coverage === 'demo' ? 'demo instruments' : c.coverage === 'us' ? 'US listings' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

type TurnOff =
  | { kind: 'platform'; platform: PlatformDto; details: AccountInUseDetails }
  | { kind: 'account'; account: AccountDto; details: AccountInUseDetails };

/**
 * Settings › Trading platforms and accounts (§9.3, §9.4, §15.4). Each
 * platform with its health and its accounts: masked number, Paper mode,
 * what it can trade, routing on or off, default, and last sync. Connecting,
 * testing and account discovery happen in the worker; results arrive live.
 */
export function PlatformsView({ prefs }: { prefs: DisplayPreferences }) {
  const [data, setData] = useState<PlatformListDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [turningOff, setTurningOff] = useState<TurnOff | null>(null);
  const [removing, setRemoving] = useState<PlatformDto | null>(null);
  const [makingDefault, setMakingDefault] = useState<AccountDto | null>(null);
  const [renaming, setRenaming] = useState<AccountDto | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiClient.brokers.list());
      setError(null);
    } catch (e) {
      setError(message(e, 'Could not load trading platforms.'));
    }
  }, []);
  useEffect(() => {
    void load();
    return subscribeLive({ onChange: () => void load() });
  }, [load]);

  const when = (iso: string | null) =>
    iso
      ? formatDateTime(iso, prefs, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : 'never';

  async function act(fn: () => Promise<unknown>, fallback: string) {
    try {
      await fn();
      setError(null);
      await load();
      return true;
    } catch (e) {
      setError(message(e, fallback));
      return false;
    }
  }

  async function turnOffPlatform(platform: PlatformDto) {
    try {
      await apiClient.brokers.setActive(platform.id, { active: false });
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_state' && e.body.details) {
        setTurningOff({
          kind: 'platform',
          platform,
          details: e.body.details as AccountInUseDetails,
        });
      } else {
        setError(message(e, 'Could not turn the platform off.'));
      }
    }
  }

  async function turnOffAccount(account: AccountDto) {
    try {
      await apiClient.accounts.update(account.id, {
        rowVersion: account.rowVersion,
        active: false,
      });
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_state' && e.body.details) {
        setTurningOff({ kind: 'account', account, details: e.body.details as AccountInUseDetails });
      } else {
        setError(message(e, 'Could not turn routing off.'));
      }
    }
  }

  async function confirmTurnOff() {
    if (!turningOff) return;
    const ok =
      turningOff.kind === 'platform'
        ? await act(
            () =>
              apiClient.brokers.setActive(turningOff.platform.id, {
                active: false,
                pauseStrategies: true,
              }),
            'Could not turn the platform off.',
          )
        : await act(
            () =>
              apiClient.accounts.update(turningOff.account.id, {
                rowVersion: turningOff.account.rowVersion,
                active: false,
                pauseStrategies: true,
              }),
            'Could not turn routing off.',
          );
    if (ok) setTurningOff(null);
  }

  const currentDefault = data?.platforms.flatMap((p) => p.accounts).find((a) => a.isDefault);
  const turnOffNames = turningOff?.details.dependents.map((d) => d.strategyName).join(', ') ?? '';
  const turnOffTarget =
    turningOff?.kind === 'platform' ? turningOff.platform.name : turningOff?.account.nickname;

  return (
    <section aria-labelledby="platforms-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="platforms-heading" className="text-lg font-semibold">
          Trading platforms and accounts
        </h2>
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add a platform
        </Button>
      </div>
      <p className="text-sm text-ink-muted">
        This build trades on paper only. A platform connects with a paper API key, and its accounts
        are found for you. New strategies and new legs use a broker&rsquo;s paper account (such as
        Alpaca paper) when you have one, the default one first; otherwise the built-in paper
        account.
      </p>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="info">{notice}</Alert>}
      {!data && !error && <p className="text-sm">Loading platforms…</p>}
      {data && (
        <ul aria-label="Trading platforms" className="space-y-4">
          {data.platforms.map((p) => {
            const health = HEALTH_LABELS[p.health];
            return (
              <li
                key={p.id}
                aria-label={p.name}
                className="rounded-lg border border-line bg-surface p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 text-sm">
                    <p className="text-base font-semibold">{p.name}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">
                        {p.provider === 'demo' ? 'Built-in paper' : providerName(p.provider)}
                      </Badge>
                      <ModeBadge mode="paper" />
                      <Badge tone={p.isActive ? 'ok' : 'neutral'}>
                        {p.isActive ? 'On' : 'Off'}
                      </Badge>
                      <Badge tone={p.checking ? 'info' : health.tone}>
                        {p.checking ? 'Connecting…' : health.label}
                      </Badge>
                    </p>
                    <p className="mt-1 text-ink-muted">
                      {p.credential ? `Signs in with ${p.credential.label} · ` : ''}
                      last checked {when(p.lastCheckedAt)}
                    </p>
                    {p.lastError && !p.checking && (
                      <p className="mt-1 text-danger">Last check: {p.lastError}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {p.provider !== 'demo' && (
                      <Button
                        size="sm"
                        disabled={p.checking}
                        onClick={() =>
                          void act(() => apiClient.brokers.test(p.id), 'Could not start the test.')
                        }
                      >
                        Test {p.name}
                      </Button>
                    )}
                    {p.isActive ? (
                      <Button size="sm" onClick={() => void turnOffPlatform(p)}>
                        Turn off
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() =>
                          void act(
                            () => apiClient.brokers.setActive(p.id, { active: true }),
                            'Could not turn the platform on.',
                          )
                        }
                      >
                        Turn on
                      </Button>
                    )}
                    {p.provider !== 'demo' && (
                      <Button size="sm" variant="danger" onClick={() => setRemoving(p)}>
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
                {p.accounts.length === 0 ? (
                  <p className="mt-3 text-sm text-ink-muted">
                    {p.checking ? 'Looking for accounts…' : 'No accounts found yet.'}
                  </p>
                ) : (
                  <div className="mt-3">
                    <Table label={`${p.name} accounts`}>
                      <thead>
                        <tr>
                          <Th>Account</Th>
                          <Th>Number</Th>
                          <Th>Trades</Th>
                          <Th>Routing</Th>
                          <Th>Last sync</Th>
                          <Th>
                            <span className="sr-only">Actions</span>
                          </Th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.accounts.map((a) => (
                          <tr key={a.id}>
                            <Td className="font-medium">
                              {a.nickname}{' '}
                              {a.isDefault && (
                                <Badge tone="info" icon={false}>
                                  Default
                                </Badge>
                              )}
                              {a.usedBy.length > 0 && (
                                <span className="block text-xs font-normal text-ink-muted">
                                  Used by {a.usedBy.map((u) => u.strategyName).join(', ')}
                                </span>
                              )}
                            </Td>
                            <Td className="font-mono">{a.maskedExternalId}</Td>
                            <Td className="text-sm">{capabilityText(a)}</Td>
                            <Td>
                              <Badge tone={a.isActive && p.isActive ? 'ok' : 'neutral'}>
                                {a.isActive ? 'On' : 'Off'}
                              </Badge>
                            </Td>
                            <Td className="text-data">
                              {p.provider === 'demo' ? 'Built in' : when(a.lastSyncedAt)}
                            </Td>
                            <Td>
                              <div className="flex flex-wrap gap-2">
                                {!a.isDefault && a.isActive && p.isActive && (
                                  <Button
                                    size="sm"
                                    aria-label={`Make ${a.nickname} the default`}
                                    onClick={() => setMakingDefault(a)}
                                  >
                                    Make default
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  aria-label={`Rename ${a.nickname}`}
                                  onClick={() => setRenaming(a)}
                                >
                                  Rename
                                </Button>
                                {a.isActive ? (
                                  <Button
                                    size="sm"
                                    aria-label={`Turn off routing to ${a.nickname}`}
                                    onClick={() => void turnOffAccount(a)}
                                  >
                                    Turn off routing
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    aria-label={`Turn on routing to ${a.nickname}`}
                                    onClick={() =>
                                      void act(
                                        () =>
                                          apiClient.accounts.update(a.id, {
                                            rowVersion: a.rowVersion,
                                            active: true,
                                          }),
                                        'Could not turn routing on.',
                                      )
                                    }
                                  >
                                    Turn on routing
                                  </Button>
                                )}
                              </div>
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AddPlatformDialog
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          void load();
        }}
      />
      <Dialog
        open={turningOff !== null}
        onClose={() => setTurningOff(null)}
        title={`Turn off ${turnOffTarget ?? 'routing'}?`}
        description={`${turnOffNames} ${turningOff?.details.dependents.length === 1 ? 'trades' : 'trade'} through it and will be paused.`}
      >
        <div className="flex gap-2">
          <Button variant="danger" onClick={() => void confirmTurnOff()}>
            Pause and turn off
          </Button>
          <Button onClick={() => setTurningOff(null)}>Keep it on</Button>
        </div>
      </Dialog>
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name ?? 'platform'}?`}
        description="Its accounts are removed too. The stored API key stays under Stored API keys."
      >
        <div className="flex gap-2">
          <Button
            variant="danger"
            onClick={() =>
              removing &&
              void act(
                () => apiClient.brokers.remove(removing.id),
                'Could not remove the platform.',
              ).then((ok) => ok && setRemoving(null))
            }
          >
            Remove platform
          </Button>
          <Button onClick={() => setRemoving(null)}>Keep it</Button>
        </div>
      </Dialog>
      <MakeDefaultDialog
        account={makingDefault}
        previous={currentDefault}
        onClose={() => setMakingDefault(null)}
        onDone={(text) => {
          setMakingDefault(null);
          setNotice(text);
          void load();
        }}
      />
      <RenameDialog
        account={renaming}
        onClose={() => setRenaming(null)}
        onDone={() => {
          setRenaming(null);
          void load();
        }}
      />
    </section>
  );
}

function AddPlatformDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState<string>(BROKER_PROVIDERS[0] ?? 'alpaca');
  const [name, setName] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [keys, setKeys] = useState<{ id: string; label: string; provider: string }[]>([]);
  const [newKey, setNewKey] = useState<Record<string, string>>({});
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setCredentialId('');
    setNewKey({});
    setNewKeyLabel('');
    setError(null);
    apiClient.credentials.list().then(
      (r) => setKeys(r.credentials),
      () => setKeys([]),
    );
  }, [open]);

  const info = PROVIDERS[provider as keyof typeof PROVIDERS];
  const keysForProvider = keys.filter((k) => k.provider === provider);
  const addingKey = credentialId === 'new' || keysForProvider.length === 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      let keyId = credentialId;
      if (addingKey) {
        const created = await apiClient.credentials.create({
          provider,
          label: newKeyLabel || `${info.name} paper key`,
          fields: newKey,
        });
        setNewKey({});
        keyId = created.id;
      }
      await apiClient.brokers.create({ name, provider, credentialId: keyId });
      onSaved();
    } catch (err) {
      setError(message(err, 'Could not add the platform.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        setNewKey({});
        onClose();
      }}
      title="Add a trading platform"
      description="It connects with a paper API key as soon as you add it, and its accounts are found for you."
    >
      <form onSubmit={(e) => void save(e)} className="space-y-3" autoComplete="off">
        {error && <Alert>{error}</Alert>}
        <SelectField
          name="platform-provider"
          label="Platform"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setCredentialId('');
          }}
        >
          {BROKER_PROVIDERS.map((id) => (
            <option key={id} value={id}>
              {PROVIDERS[id].name}
            </option>
          ))}
        </SelectField>
        <TextField
          name="platform-name"
          label="Name"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {keysForProvider.length > 0 && (
          <SelectField
            name="platform-key"
            label="API key"
            value={credentialId}
            required
            onChange={(e) => setCredentialId(e.target.value)}
          >
            <option value="">Choose a stored key</option>
            {keysForProvider.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
            <option value="new">Add a new key…</option>
          </SelectField>
        )}
        {addingKey && (
          <>
            <TextField
              name="platform-key-label"
              label="Key name"
              maxLength={100}
              value={newKeyLabel}
              placeholder={`${info.name} paper key`}
              onChange={(e) => setNewKeyLabel(e.target.value)}
            />
            <CredentialFields
              provider={provider}
              idPrefix="platform-key"
              values={newKey}
              onChange={setNewKey}
            />
          </>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Adding…' : 'Add platform'}
          </Button>
          <Button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function MakeDefaultDialog({
  account,
  previous,
  onClose,
  onDone,
}: {
  account: AccountDto | null;
  previous: AccountDto | undefined;
  onClose: () => void;
  onDone: (notice: string | null) => void;
}) {
  const [migrate, setMigrate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMigrate(false);
    setError(null);
  }, [account?.id]);

  async function confirm() {
    if (!account) return;
    try {
      const r = await apiClient.accounts.update(account.id, {
        rowVersion: account.rowVersion,
        makeDefault: true,
        migrateStrategies: migrate,
      });
      onDone(
        migrate
          ? `${r.migrated} ${r.migrated === 1 ? 'strategy moved' : 'strategies moved'} to ${account.nickname}.${r.skipped > 0 ? ` ${r.skipped} running ${r.skipped === 1 ? 'strategy was' : 'strategies were'} left as they are.` : ''}`
          : null,
      );
    } catch (e) {
      setError(message(e, 'Could not change the default account.'));
    }
  }

  return (
    <Dialog
      open={account !== null}
      onClose={onClose}
      title={`Make ${account?.nickname ?? 'this account'} the default?`}
      description="New strategies will place their orders with it."
    >
      {error && <Alert>{error}</Alert>}
      {previous && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={migrate} onChange={(e) => setMigrate(e.target.checked)} />
          <span>
            Also move existing strategies from {previous.nickname}. Strategies that are running stay
            where they are.
          </span>
        </label>
      )}
      <div className="mt-4 flex gap-2">
        <Button variant="primary" onClick={() => void confirm()}>
          Make default
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Dialog>
  );
}

function RenameDialog({
  account,
  onClose,
  onDone,
}: {
  account: AccountDto | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setNickname(account?.nickname ?? '');
    setError(null);
  }, [account?.id, account?.nickname]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!account) return;
    try {
      await apiClient.accounts.update(account.id, { rowVersion: account.rowVersion, nickname });
      onDone();
    } catch (err) {
      setError(message(err, 'Could not rename the account.'));
    }
  }

  return (
    <Dialog
      open={account !== null}
      onClose={onClose}
      title={`Rename ${account?.nickname ?? 'account'}`}
    >
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <TextField
          name="account-nickname"
          label="Nickname"
          required
          maxLength={100}
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary">
            Save
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
