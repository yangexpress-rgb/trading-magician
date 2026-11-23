'use client';

import {
  ApiError,
  type AccountDto,
  type AccountInUseDetails,
  type PlatformDto,
  type PlatformListDto,
} from '@tm/contracts';
import {
  formatDateTime,
  isMarketDataProvider,
  PROVIDER_IDS,
  PROVIDERS,
  providerDataTypes,
  type DisplayPreferences,
} from '@tm/domain';
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
export function PlatformsView({
  prefs,
  liveEnabled = false,
}: {
  prefs: DisplayPreferences;
  /** The server's live-trading flag (ADR 0109): off, only paper platforms can be added. */
  liveEnabled?: boolean;
}) {
  const [data, setData] = useState<PlatformListDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [turningOff, setTurningOff] = useState<TurnOff | null>(null);
  const [removing, setRemoving] = useState<PlatformDto | null>(null);
  const [makingDefault, setMakingDefault] = useState<AccountDto | null>(null);
  const [renaming, setRenaming] = useState<AccountDto | null>(null);
  const [limiting, setLimiting] = useState<AccountDto | null>(null);
  const [feeding, setFeeding] = useState<AccountDto | null>(null);
  const [killing, setKilling] = useState<AccountDto | null>(null);
  const [releasing, setReleasing] = useState<AccountDto | null>(null);
  const [piloting, setPiloting] = useState<AccountDto | null>(null);
  const [endingPilot, setEndingPilot] = useState<AccountDto | null>(null);

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
                          <Th>Account limits</Th>
                          <Th>Data feeds</Th>
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
                              {a.nickname} {a.mode === 'live' && <ModeBadge mode="live" />}{' '}
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
                            <Td className="text-sm">
                              <AccountLimitsText account={a} />
                              <LiveAccountText account={a} />
                            </Td>
                            <Td className="text-sm">
                              <AccountFeedsText account={a} />
                            </Td>
                            <Td className="text-content">
                              {p.provider === 'demo' ? 'Built in' : when(a.lastSyncedAt)}
                            </Td>
                            <Td>
                              <div className="flex flex-wrap gap-2">
                                {!a.isDefault && a.isActive && p.isActive && a.mode === 'paper' && (
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
                                <Button
                                  size="sm"
                                  aria-label={`Set limits for ${a.nickname}`}
                                  onClick={() => setLimiting(a)}
                                >
                                  Set limits
                                </Button>
                                {a.pilot && (
                                  <>
                                    <Button
                                      size="sm"
                                      aria-label={`Pilot caps for ${a.nickname}`}
                                      onClick={() => setPiloting(a)}
                                    >
                                      Pilot caps
                                    </Button>
                                    <Button
                                      size="sm"
                                      aria-label={`End pilot mode on ${a.nickname}`}
                                      onClick={() => setEndingPilot(a)}
                                    >
                                      End pilot mode
                                    </Button>
                                  </>
                                )}
                                <Button
                                  size="sm"
                                  aria-label={`Data feeds for ${a.nickname}`}
                                  onClick={() => setFeeding(a)}
                                >
                                  Data feeds
                                </Button>
                                {a.halt ? (
                                  <Button
                                    size="sm"
                                    aria-label={`Release the halt on ${a.nickname}`}
                                    onClick={() => setReleasing(a)}
                                  >
                                    Release halt
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="danger"
                                    aria-label={`Kill switch for ${a.nickname}`}
                                    onClick={() => setKilling(a)}
                                  >
                                    Kill switch
                                  </Button>
                                )}
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

      <PilotDialog
        account={piloting}
        onClose={() => setPiloting(null)}
        onDone={() => {
          setPiloting(null);
          void load();
        }}
      />
      <Dialog
        open={endingPilot !== null}
        onClose={() => setEndingPilot(null)}
        title={`End pilot mode on ${endingPilot?.nickname ?? 'this account'}?`}
        description={
          endingPilot?.pilot
            ? `Orders on this live account will no longer be held to ${dollars(endingPilot.pilot.maxOrder)} each and ${dollars(endingPilot.pilot.maxExposure)} in total. The account's own limits and each strategy's limits still apply. This trades real money.`
            : ''
        }
      >
        <div className="flex gap-2">
          <Button
            variant="danger"
            onClick={() =>
              endingPilot &&
              void (async () => {
                await act(
                  () => apiClient.accounts.pilot(endingPilot.id, { endPilot: true }),
                  'Could not end pilot mode.',
                );
                setEndingPilot(null);
              })()
            }
          >
            End pilot mode
          </Button>
          <Button onClick={() => setEndingPilot(null)}>Keep pilot mode</Button>
        </div>
      </Dialog>
      <AddPlatformDialog
        liveEnabled={liveEnabled}
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
      <FeedsDialog
        account={feeding}
        onClose={() => setFeeding(null)}
        onDone={() => {
          setFeeding(null);
          void load();
        }}
      />
      <LimitsDialog
        account={limiting}
        onClose={() => setLimiting(null)}
        onDone={() => {
          setLimiting(null);
          void load();
        }}
      />
      <Dialog
        open={killing !== null}
        onClose={() => setKilling(null)}
        title={`Engage the kill switch on ${killing?.nickname ?? 'this account'}?`}
        description="Every strategy run on this account pauses and its working orders are canceled. Positions stay open. Other accounts keep trading. Nothing resumes until you release the halt and resume each run."
      >
        <div className="flex gap-2">
          <Button
            variant="danger"
            onClick={() =>
              killing &&
              void (async () => {
                try {
                  const r = await apiClient.accounts.killSwitch(killing.id, { engaged: true });
                  setKilling(null);
                  setNotice(
                    `Kill switch engaged on ${killing.nickname}: ${r.paused} ${r.paused === 1 ? 'run' : 'runs'} paused, ${r.canceled} ${r.canceled === 1 ? 'order' : 'orders'} canceled.`,
                  );
                  setError(null);
                  await load();
                } catch (e) {
                  setError(message(e, 'Could not engage the kill switch.'));
                }
              })()
            }
          >
            Pause runs and cancel orders
          </Button>
          <Button onClick={() => setKilling(null)}>Keep trading</Button>
        </div>
      </Dialog>
      <Dialog
        open={releasing !== null}
        onClose={() => setReleasing(null)}
        title={`Release the halt on ${releasing?.nickname ?? 'this account'}?`}
        description="Runs on this account can then be started and resumed again. Paused runs stay paused until you resume each one."
      >
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={() =>
              releasing &&
              void act(
                () => apiClient.accounts.killSwitch(releasing.id, { engaged: false }),
                'Could not release the halt.',
              ).then((ok) => ok && setReleasing(null))
            }
          >
            Release halt
          </Button>
          <Button onClick={() => setReleasing(null)}>Keep it halted</Button>
        </div>
      </Dialog>
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
  liveEnabled,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  liveEnabled: boolean;
}) {
  const [provider, setProvider] = useState<string>(BROKER_PROVIDERS[0] ?? 'alpaca');
  const [environment, setEnvironment] = useState<'paper' | 'live'>('paper');
  const [acknowledged, setAcknowledged] = useState(false);
  const [name, setName] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [keys, setKeys] = useState<
    { id: string; label: string; provider: string; environment: 'paper' | 'live' }[]
  >([]);
  const [newKey, setNewKey] = useState<Record<string, string>>({});
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setCredentialId('');
    setEnvironment('paper');
    setAcknowledged(false);
    setNewKey({});
    setNewKeyLabel('');
    setError(null);
    apiClient.credentials.list().then(
      (r) => setKeys(r.credentials),
      () => setKeys([]),
    );
  }, [open]);

  const info = PROVIDERS[provider as keyof typeof PROVIDERS];
  // A live platform signs in with a live key only, a paper one with a paper key (ADR 0109).
  const keysForProvider = keys.filter(
    (k) => k.provider === provider && k.environment === environment,
  );
  const live = environment === 'live';
  const addingKey = credentialId === 'new' || keysForProvider.length === 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      let keyId = credentialId;
      if (addingKey) {
        const created = await apiClient.credentials.create({
          provider,
          label: newKeyLabel || `${info.name} ${environment} key`,
          fields: newKey,
          environment,
        });
        setNewKey({});
        keyId = created.id;
      }
      await apiClient.brokers.create({
        name,
        provider,
        credentialId: keyId,
        environment,
        ...(live ? { acknowledgeRealMoney: acknowledged } : {}),
      });
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
        {liveEnabled && (
          <SelectField
            name="platform-environment"
            label="Paper or live"
            value={environment}
            onChange={(e) => {
              setEnvironment(e.target.value as 'paper' | 'live');
              setCredentialId('');
              setAcknowledged(false);
            }}
          >
            <option value="paper">Paper (simulated orders, no real money)</option>
            <option value="live">LIVE (real money)</option>
          </SelectField>
        )}
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
              placeholder={`${info.name} ${environment} key`}
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
        {live && (
          <div className="rounded-md border border-danger/40 bg-danger-soft p-3 text-sm">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>
                I understand this platform trades <strong>real money</strong>. Its accounts start in
                pilot mode, capped at $500 per order and $2,500 in total, until I end pilot mode.
              </span>
            </label>
          </div>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy || (live && !acknowledged)}>
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

const dollars = (v: string) =>
  `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Typed dollars without "$" or thousands commas; blank means no limit. */
const amount = (v: string) => {
  const t = v.trim().replaceAll('$', '').replaceAll(',', '');
  return t === '' ? null : t;
};

/** The account's own limits and any halt in force, in words (ADR 0107). */
function AccountLimitsText({ account: a }: { account: AccountDto }) {
  const limits = [
    a.maxExposure ? `Exposure ${dollars(a.maxExposure)}` : null,
    a.dailyLossLimit ? `Daily loss ${dollars(a.dailyLossLimit)}` : null,
  ].filter(Boolean);
  return (
    <>
      <span className="text-content">
        {limits.length > 0 ? limits.join(' · ') : 'None (strategy limits only)'}
      </span>
      {a.halt && (
        <span className="mt-1 block">
          <Badge tone="danger">
            {a.halt.kind === 'kill_switch' ? 'HALTED: kill switch' : 'HALTED today: daily loss'}
          </Badge>
        </span>
      )}
    </>
  );
}

function LimitsDialog({
  account,
  onClose,
  onDone,
}: {
  account: AccountDto | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [exposure, setExposure] = useState('');
  const [loss, setLoss] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setExposure(account?.maxExposure ?? '');
    setLoss(account?.dailyLossLimit ?? '');
    setError(null);
  }, [account?.id, account?.maxExposure, account?.dailyLossLimit]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!account) return;
    try {
      await apiClient.accounts.update(account.id, {
        rowVersion: account.rowVersion,
        maxExposure: amount(exposure),
        dailyLossLimit: amount(loss),
      });
      onDone();
    } catch (err) {
      setError(message(err, 'Could not save the limits.'));
    }
  }

  return (
    <Dialog
      open={account !== null}
      onClose={onClose}
      title={`Limits for ${account?.nickname ?? 'account'}`}
      description="These apply to every strategy run on this account together, on top of each strategy's own limits. Leave a box empty for no account limit."
    >
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <TextField
          name="account-max-exposure"
          label="Maximum total exposure ($)"
          hint="Orders that would take the account's open positions and working entries past this are refused."
          inputMode="decimal"
          value={exposure}
          onChange={(e) => setExposure(e.target.value)}
        />
        <TextField
          name="account-daily-loss"
          label="Daily loss limit ($)"
          hint="When the account loses this much in one trading day, every run on it pauses for the rest of the day. Positions stay open."
          inputMode="decimal"
          value={loss}
          onChange={(e) => setLoss(e.target.value)}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary">
            Save limits
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AccountFeedsText({ account: a }: { account: AccountDto }) {
  if (a.feeds.length === 0) return <span className="text-content">Data routes</span>;
  const onFallback = a.feedNow !== null && a.feedNow.id !== a.feeds[0]?.id;
  return (
    <>
      <span className="text-content">{a.feeds.map((f) => f.name).join(' → ')}</span>
      {onFallback && (
        <span className="mt-1 block">
          <Badge tone="warn">Now pricing from the fallback feed {a.feedNow?.name}</Badge>
        </span>
      )}
    </>
  );
}

type FeedOption = { id: string; name: string };

/**
 * An account's own data feeds (ADR 0108): a primary and fallbacks in order,
 * and what its runs do when the feed pricing them stops.
 */
function FeedsDialog({
  account,
  onClose,
  onDone,
}: {
  account: AccountDto | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [chain, setChain] = useState<FeedOption[]>([]);
  const [available, setAvailable] = useState<FeedOption[]>([]);
  const [onFailure, setOnFailure] = useState<'fallback' | 'pause'>('fallback');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!account) return;
    setChain(account.feeds);
    setOnFailure(account.onFeedFailure ?? (account.mode === 'paper' ? 'fallback' : 'pause'));
    setError(null);
    apiClient.feeds
      .list()
      .then((list) =>
        setAvailable(
          list.feeds
            .filter(
              (f) =>
                isMarketDataProvider(f.provider) &&
                providerDataTypes(f.provider).includes('quotes'),
            )
            .map((f) => ({ id: f.id, name: f.name })),
        ),
      )
      .catch((err: unknown) => setError(message(err, 'Could not load your data feeds.')));
  }, [account]);

  const move = (i: number, by: -1 | 1) =>
    setChain((c) => {
      const next = [...c];
      const [item] = next.splice(i, 1);
      if (item) next.splice(i + by, 0, item);
      return next;
    });
  const left = available.filter((f) => !chain.some((c) => c.id === f.id));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!account) return;
    try {
      await apiClient.accounts.setFeeds(account.id, {
        feedIds: chain.map((f) => f.id),
        onFeedFailure: onFailure,
      });
      onDone();
    } catch (err) {
      setError(message(err, 'Could not save the data feeds.'));
    }
  }

  return (
    <Dialog
      open={account !== null}
      onClose={onClose}
      title={`Data feeds for ${account?.nickname ?? 'account'}`}
      description="Strategy runs on this account price from the first feed; the others are fallbacks, in order. With no feeds here, the account uses the data routes in Settings › Data feeds."
    >
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        {error && <Alert>{error}</Alert>}
        {chain.length === 0 ? (
          <p className="text-sm text-ink-muted">No feeds of its own: it uses the data routes.</p>
        ) : (
          <ol aria-label="Feeds in order" className="space-y-1">
            {chain.map((f, i) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-[10rem] text-content">
                  {i + 1}. {f.name}{' '}
                  <span className="text-ink-muted">{i === 0 ? '(primary)' : '(fallback)'}</span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  aria-label={`Move ${f.name} up`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  Up
                </Button>
                <Button
                  type="button"
                  size="sm"
                  aria-label={`Move ${f.name} down`}
                  disabled={i === chain.length - 1}
                  onClick={() => move(i, 1)}
                >
                  Down
                </Button>
                <Button
                  type="button"
                  size="sm"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setChain((c) => c.filter((x) => x.id !== f.id))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ol>
        )}
        {left.length > 0 && chain.length < 5 && (
          <SelectField
            name="account-add-feed"
            label="Add a feed"
            value=""
            onChange={(e) => {
              const feed = left.find((f) => f.id === e.target.value);
              if (feed) setChain((c) => [...c, feed]);
            }}
          >
            <option value="">Choose a price feed</option>
            {left.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </SelectField>
        )}
        <SelectField
          name="account-feed-failure"
          label="If the data feed stops"
          hint="Either way it is recorded as an incident and you are notified."
          value={onFailure}
          onChange={(e) => setOnFailure(e.target.value as 'fallback' | 'pause')}
        >
          <option value="fallback">Use the next fallback feed</option>
          <option value="pause">Pause this account’s runs</option>
        </SelectField>
        <div className="flex gap-2">
          <Button type="submit" variant="primary">
            Save feeds
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A live account's pilot mode and what the broker reports for day trades (ADR 0109). */
function LiveAccountText({ account: a }: { account: AccountDto }) {
  if (a.mode !== 'live') return null;
  const equity = a.broker.equity === null ? null : Number(a.broker.equity);
  return (
    <span className="mt-1 block text-xs text-content">
      {a.pilot
        ? `Pilot mode: ${dollars(a.pilot.maxOrder)} per order, ${dollars(a.pilot.maxExposure)} in total`
        : 'Pilot mode ended'}
      {a.broker.margin && (
        <span className="block">
          Day trades in the last 5 days: {a.broker.dayTrades ?? 'not reported yet'}
          {equity !== null && equity < 25_000 && ' (under $25,000: the broker allows 3)'}
        </span>
      )}
    </span>
  );
}

function PilotDialog({
  account,
  onClose,
  onDone,
}: {
  account: AccountDto | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [maxOrder, setMaxOrder] = useState('');
  const [maxExposure, setMaxExposure] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMaxOrder(account?.pilot?.maxOrder ?? '');
    setMaxExposure(account?.pilot?.maxExposure ?? '');
    setError(null);
  }, [account]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!account) return;
    try {
      await apiClient.accounts.pilot(account.id, {
        maxOrder: amount(maxOrder) ?? '',
        maxExposure: amount(maxExposure) ?? '',
      });
      onDone();
    } catch (err) {
      setError(message(err, 'Could not save the pilot caps.'));
    }
  }

  return (
    <Dialog
      open={account !== null}
      onClose={onClose}
      title={`Pilot caps for ${account?.nickname ?? 'account'}`}
      description="While this live account is in pilot mode, orders above these caps are refused. They can be raised up to $5,000 per order and $25,000 in total; to go past that, end pilot mode."
    >
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <TextField
          name="pilot-max-order"
          label="Most per order ($)"
          inputMode="decimal"
          required
          value={maxOrder}
          onChange={(e) => setMaxOrder(e.target.value)}
        />
        <TextField
          name="pilot-max-exposure"
          label="Most in total ($)"
          inputMode="decimal"
          required
          value={maxExposure}
          onChange={(e) => setMaxExposure(e.target.value)}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary">
            Save pilot caps
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
