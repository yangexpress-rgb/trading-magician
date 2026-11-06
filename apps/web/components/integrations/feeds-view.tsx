'use client';

import {
  ApiError,
  type FeedDto,
  type FeedInUseDetails,
  type FeedListDto,
  type RouteDto,
} from '@tm/contracts';
import {
  formatDateTime,
  FUNDAMENTALS_PROVIDER_IDS,
  isFundamentalsProvider,
  MARKET_DATA_PROVIDER_IDS,
  PROVIDERS,
  type DisplayPreferences,
} from '@tm/domain';
import { Alert, Badge, Button, Dialog, SelectField, Table, Td, TextField, Th } from '@tm/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import {
  ASSET_CLASS_LABELS,
  DATA_TYPE_LABELS,
  ENTITLEMENT_LABELS,
  HEALTH_LABELS,
  providerName,
  venueLabel,
} from '@/lib/integration-text';
import { subscribeLive } from '@/lib/live-events';
import { CredentialFields } from './credential-fields';
import {
  configFromForm,
  CustomFeedFields,
  EMPTY_CUSTOM_FORM,
  formFromConfig,
  problemsOf,
  testKey,
  useCustomTest,
  type CustomFormState,
  type CustomKeyState,
} from './custom-feed-fields';

/** Price feeds are routed; company data feeds (ADR 0031) are not. */
type FeedKind = 'prices' | 'company';
const PROVIDERS_FOR: Record<FeedKind, readonly string[]> = {
  prices: MARKET_DATA_PROVIDER_IDS,
  company: FUNDAMENTALS_PROVIDER_IDS,
};
const kindOf = (provider: string): FeedKind =>
  isFundamentalsProvider(provider) ? 'company' : 'prices';

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/**
 * Settings › Data feeds (§9.2, §15.4): every price feed with its health, last
 * update, entitlement and routes; add, test, edit, turn on or off, remove.
 * Each price feed lists its routes underneath it (ADR 0038): they are made
 * when the feed is added and deleted with it. Then the company data feeds
 * (ADR 0031), which give company profiles and financials rather than prices.
 * Updates arrive live, so a test result appears on its own.
 */
export function FeedsView({
  prefs,
  demoData = false,
}: {
  prefs: DisplayPreferences;
  /** Whether the demo feed can be added; only the tests turn demo data on (ADR 0039). */
  demoData?: boolean;
}) {
  const [data, setData] = useState<FeedListDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<FeedKind | null>(null);
  const [editing, setEditing] = useState<FeedDto | null>(null);
  const [turningOff, setTurningOff] = useState<{ feed: FeedDto; details: FeedInUseDetails } | null>(
    null,
  );
  const [removing, setRemoving] = useState<FeedDto | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiClient.feeds.list());
      setError(null);
    } catch (e) {
      setError(message(e, 'Could not load data feeds.'));
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
    } catch (e) {
      setError(message(e, fallback));
    }
  }

  async function remove() {
    if (!removing) return;
    try {
      await apiClient.feeds.remove(removing.id);
      setRemoving(null);
      setRemoveError(null);
      await load();
    } catch (e) {
      setRemoveError(message(e, 'Could not remove the feed.'));
    }
  }

  async function turnOff(feed: FeedDto) {
    try {
      await apiClient.feeds.setActive(feed.id, { active: false });
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_state' && e.body.details) {
        setTurningOff({ feed, details: e.body.details as FeedInUseDetails });
      } else {
        setError(message(e, 'Could not turn the feed off.'));
      }
    }
  }

  const priceFeeds = data?.feeds.filter((f) => kindOf(f.provider) === 'prices') ?? [];
  const companyFeeds = data?.feeds.filter((f) => kindOf(f.provider) === 'company') ?? [];
  // Company pages and the screener use the oldest company data feed that is on.
  const companyInUse = companyFeeds.find((f) => f.isActive)?.id;

  const renderFeed = (f: FeedDto) => {
    const health = HEALTH_LABELS[f.health];
    const company = kindOf(f.provider) === 'company';
    return (
      <li key={f.id} aria-label={f.name} className="rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 text-sm">
            <p className="text-base font-semibold">{f.name}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{providerName(f.provider)}</Badge>
              {company && <Badge tone="info">Company data</Badge>}
              <Badge tone={f.isActive ? 'ok' : 'neutral'}>{f.isActive ? 'On' : 'Off'}</Badge>
              <Badge tone={f.checking ? 'info' : health.tone}>
                {f.checking ? 'Testing…' : health.label}
              </Badge>
              {company ? (
                <span>Updated as companies file</span>
              ) : (
                <>
                  <span>{f.isRealtime ? 'Real-time' : 'Delayed'}</span>
                  <span>· {ENTITLEMENT_LABELS[f.entitlement]}</span>
                </>
              )}
            </p>
            <p className="mt-1 text-ink-muted">
              {company
                ? 'Company profiles, five years of annual financials and recent filings for US-listed companies'
                : f.assetClasses.map((a) => ASSET_CLASS_LABELS[a] ?? a).join(', ')}
              {f.credential ? ` · ${company ? 'Uses' : 'Signs in with'} ${f.credential.label}` : ''}
            </p>
            {f.config && (
              <p className="mt-1 text-ink-muted">
                Daily bars and latest quotes from {new URL(f.config.baseUrl).hostname} · up to{' '}
                {f.config.limits.requestsPerMinute} requests a minute
                {f.config.limits.requestsPerDay !== null
                  ? ` and ${f.config.limits.requestsPerDay.toLocaleString('en-US')} a day`
                  : ''}
              </p>
            )}
            <p className="mt-1 text-ink-muted">
              Last update {when(f.lastSuccessAt)} · last checked {when(f.lastCheckedAt)}
            </p>
            {f.lastError && !f.checking && (
              <p className="mt-1 text-danger">Last check: {f.lastError}</p>
            )}
            {company && (
              <p className="mt-1">
                {f.id === companyInUse
                  ? 'In use for company pages in Quantitative Research and the screener’s company columns'
                  : f.isActive
                    ? 'Standing by: another company data feed is in use'
                    : 'Not in use while off'}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={f.checking}
              onClick={() =>
                void act(() => apiClient.feeds.test(f.id), 'Could not start the test.')
              }
            >
              Test {f.name}
            </Button>
            <Button size="sm" onClick={() => setEditing(f)}>
              Edit
            </Button>
            {f.isActive ? (
              <Button size="sm" onClick={() => void turnOff(f)}>
                Turn off
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() =>
                  void act(
                    () => apiClient.feeds.setActive(f.id, { active: true }),
                    'Could not turn the feed on.',
                  )
                }
              >
                Turn on
              </Button>
            )}
            <Button size="sm" variant="danger" onClick={() => setRemoving(f)}>
              Remove
            </Button>
          </div>
        </div>
        {!company && data && (
          <FeedRoutes
            feed={f}
            routes={data.routes}
            feeds={priceFeeds}
            when={when}
            onChanged={() => void load()}
          />
        )}
      </li>
    );
  };

  return (
    <div className="space-y-8">
      <section aria-labelledby="feeds-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="feeds-heading" className="text-lg font-semibold">
            Price feeds
          </h2>
          <Button variant="primary" onClick={() => setAdding('prices')}>
            Add a feed
          </Button>
        </div>
        <p className="text-sm text-ink-muted">
          Where prices come from. Each feed is checked every minute while it is on; Test checks it
          now. A feed gets its routes as soon as it is added, for bars and live prices of every
          asset class it covers, and they are deleted with it. Where another feed already has a
          route, the new feed becomes its backup: if the primary stops sending current prices, the
          backup takes over until the primary has been healthy for 5 minutes.
        </p>
        {error && <Alert>{error}</Alert>}
        {!data && !error && <p className="text-sm">Loading feeds…</p>}
        {data && (
          <ul aria-label="Price feeds" className="space-y-3">
            {priceFeeds.map((f) => renderFeed(f))}
          </ul>
        )}
      </section>

      <section aria-labelledby="company-feeds-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="company-feeds-heading" className="text-lg font-semibold">
            Company data feeds
          </h2>
          <Button onClick={() => setAdding('company')}>Add a company data feed</Button>
        </div>
        <p className="text-sm text-ink-muted">
          Where company financials come from: revenue, earnings, cash flow, balance sheet, profile
          and filings. They fill the company section in Quantitative Research and the screener’s
          market cap, P/E, revenue and earnings columns. They give no prices.
        </p>
        {data && companyFeeds.length === 0 && (
          <div className="rounded-lg border border-dashed border-line p-4 text-sm">
            <p className="font-medium">No company data feed yet</p>
            <p className="mt-1 text-ink-muted">
              Add SEC EDGAR: it is free and needs no sign-up, only a contact email the SEC asks apps
              to send with each request.
            </p>
          </div>
        )}
        {companyFeeds.length > 0 && (
          <ul aria-label="Company data feeds" className="space-y-3">
            {companyFeeds.map((f) => renderFeed(f))}
          </ul>
        )}
      </section>

      <FeedDialog
        open={adding !== null}
        kind={adding ?? 'prices'}
        feed={null}
        demoData={demoData}
        onClose={() => setAdding(null)}
        onSaved={() => {
          setAdding(null);
          void load();
        }}
      />
      <FeedDialog
        open={editing !== null}
        kind={editing ? kindOf(editing.provider) : 'prices'}
        feed={editing}
        demoData={demoData}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
      {data && (
        <TurnOffDialog
          state={turningOff}
          feeds={priceFeeds}
          onClose={() => setTurningOff(null)}
          onDone={() => {
            setTurningOff(null);
            void load();
          }}
        />
      )}
      <Dialog
        open={removing !== null}
        onClose={() => {
          setRemoving(null);
          setRemoveError(null);
        }}
        title={`Remove ${removing?.name ?? 'feed'}?`}
        description={
          removing && removing.routes.some((r) => r.role === 'primary')
            ? `Its ${removing.routes.filter((r) => r.role === 'primary').length === 1 ? 'route is' : `${removing.routes.filter((r) => r.role === 'primary').length} routes are`} deleted with it, and your other price feeds take over what they cover. A stored API key it used stays under Stored API keys.`
            : 'Its settings are deleted. A stored API key it used stays under Stored API keys.'
        }
      >
        {/* Shown in the dialog: a live refresh of the page clears the page-level error. */}
        {removeError && <Alert>{removeError}</Alert>}
        <div className="mt-2 flex gap-2">
          <Button variant="danger" disabled={!removing} onClick={() => void remove()}>
            Remove feed
          </Button>
          <Button
            onClick={() => {
              setRemoving(null);
              setRemoveError(null);
            }}
          >
            Keep it
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

const routeLabel = (r: { assetClass: string; dataType: RouteDto['dataType'] }) =>
  `${ASSET_CLASS_LABELS[r.assetClass] ?? r.assetClass} ${DATA_TYPE_LABELS[r.dataType].toLowerCase()}`;

/**
 * A price feed's routes, shown under it (ADR 0038): the routes it is the
 * primary for, each with a backup feed to pick, and the routes of other feeds
 * it backs up, which it can take over as the primary.
 */
function FeedRoutes({
  feed,
  routes,
  feeds,
  when,
  onChanged,
}: {
  feed: FeedDto;
  routes: RouteDto[];
  feeds: FeedDto[];
  when: (iso: string | null) => string;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const own = routes.filter((r) => r.primary.id === feed.id);
  const backing = routes.filter((r) => r.fallback?.id === feed.id);

  async function change(
    route: RouteDto,
    next: { primaryFeedId: string; fallbackFeedId: string | null },
  ) {
    try {
      await apiClient.routes.update(route.id, { rowVersion: route.rowVersion, ...next });
      setError(null);
      onChanged();
    } catch (e) {
      setError(message(e, 'Could not change the route.'));
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-3 text-sm">
      <h3 className="font-medium">Routes</h3>
      {error && <Alert>{error}</Alert>}
      {own.length === 0 ? (
        <p className="mt-1 text-ink-muted">
          {feed.isActive
            ? backing.length > 0
              ? 'No routes of its own: other feeds already get these prices first.'
              : 'No routes of its own yet.'
            : 'No routes while off.'}
        </p>
      ) : (
        <Table label={`Routes for ${feed.name}`}>
          <thead>
            <tr>
              <Th>Data</Th>
              <Th>Venue</Th>
              <Th>Backup feed</Th>
              <Th>Prices from</Th>
            </tr>
          </thead>
          <tbody>
            {own.map((r) => {
              const label = `${routeLabel(r)}, ${venueLabel(r.venue).toLowerCase()}`;
              const backups = feeds.filter(
                (f) =>
                  f.id !== feed.id &&
                  f.assetClasses.includes(r.assetClass) &&
                  (r.venue === 'DEMO') === (f.provider === 'demo'),
              );
              return (
                <tr key={r.id}>
                  <Td>{routeLabel(r)}</Td>
                  <Td>{venueLabel(r.venue)}</Td>
                  <Td>
                    <label className="sr-only" htmlFor={`fallback-${r.id}`}>
                      Backup feed for {label}
                    </label>
                    <select
                      id={`fallback-${r.id}`}
                      className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
                      value={r.fallback?.id ?? ''}
                      onChange={(e) =>
                        void change(r, {
                          primaryFeedId: feed.id,
                          fallbackFeedId: e.target.value || null,
                        })
                      }
                    >
                      <option value="">None</option>
                      {backups.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                          {f.isActive ? '' : ' (off)'}
                        </option>
                      ))}
                    </select>
                  </Td>
                  <Td>
                    {r.activeSource === 'fallback' ? (
                      <Badge tone="warn">
                        {r.fallback?.name ?? 'Backup'} since {when(r.switchedAt)}
                      </Badge>
                    ) : (
                      'This feed'
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {backing.length > 0 && (
        <ul aria-label={`${feed.name} backs up`} className="mt-2 space-y-1">
          {backing.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2">
              <span>
                Backup for {routeLabel(r)} ({venueLabel(r.venue).toLowerCase()}) from{' '}
                {r.primary.name}
                {r.activeSource === 'fallback' ? ', in use now' : ''}
              </span>
              <Button
                aria-label={`Make ${feed.name} primary for ${routeLabel(r)}`}
                size="sm"
                onClick={() =>
                  void change(r, { primaryFeedId: feed.id, fallbackFeedId: r.primary.id })
                }
              >
                Make primary
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FeedDialog({
  open,
  kind,
  feed,
  demoData,
  onClose,
  onSaved,
}: {
  open: boolean;
  kind: FeedKind;
  /** Null to add a new feed. */
  feed: FeedDto | null;
  demoData: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState<string>('alpaca');
  const choices = useMemo(
    () => PROVIDERS_FOR[kind].filter((id) => demoData || id !== 'demo'),
    [kind, demoData],
  );
  const [name, setName] = useState('');
  const [assetClasses, setAssetClasses] = useState<string[]>([]);
  const [credentialId, setCredentialId] = useState<string>('');
  const [keys, setKeys] = useState<{ id: string; label: string; provider: string }[]>([]);
  const [newKey, setNewKey] = useState<Record<string, string>>({});
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A custom REST feed (ADR 0041): its settings, its key, and the test it must pass.
  const [customForm, setCustomForm] = useState<CustomFormState>(EMPTY_CUSTOM_FORM);
  const [customKey, setCustomKey] = useState<CustomKeyState>({ credentialId: '', newKey: {} });
  const [createdKeyId, setCreatedKeyId] = useState<string | null>(null);
  const [testSymbol, setTestSymbol] = useState('SPY');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof CustomFormState, string>>>(
    {},
  );
  const [testError, setTestError] = useState<string | null>(null);
  const customTest = useCustomTest();

  useEffect(() => {
    if (!open) return;
    setCustomForm(feed?.config ? formFromConfig(feed.config) : EMPTY_CUSTOM_FORM);
    setCustomKey({ credentialId: feed?.config ? (feed.credential?.id ?? '') : '', newKey: {} });
    setCreatedKeyId(null);
    setTestSymbol(feed?.config?.testSymbol ?? 'SPY');
    setFieldErrors({});
    setTestError(null);
    customTest.reset();
    const p = feed?.provider ?? choices.find((id) => id !== 'demo') ?? choices[0] ?? 'alpaca';
    setProvider(p);
    // A company data feed is usually the only one of its kind, so it starts named after its provider.
    setName(feed?.name ?? (kind === 'company' ? PROVIDERS[p as keyof typeof PROVIDERS].name : ''));
    setAssetClasses(feed?.assetClasses ?? [...PROVIDERS[p as keyof typeof PROVIDERS].assetClasses]);
    setCredentialId(feed?.credential?.id ?? '');
    setNewKey({});
    setNewKeyLabel('');
    setError(null);
    apiClient.credentials.list().then(
      (r) => setKeys(r.credentials),
      () => setKeys([]),
    );
  }, [open, feed, choices]);

  const info = PROVIDERS[provider as keyof typeof PROVIDERS];
  const custom = provider === 'custom_rest';
  // A custom feed's key sits with its own settings.
  const needsKey = info.credentialFields.length > 0 && !custom;
  const customKeys = keys.filter((k) => k.provider === 'custom_rest');
  const customCredentialId =
    customForm.authType === 'none' || customKey.credentialId === 'new'
      ? null
      : customKey.credentialId || null;
  const currentTestKey = testKey(customForm, customCredentialId);
  const customUnchanged =
    !!feed?.config &&
    currentTestKey === testKey(formFromConfig(feed.config), feed.credential?.id ?? null);
  const customTested =
    customTest.test?.status === 'succeeded' && customTest.testedKey === currentTestKey;

  /** A typed key is sealed on the server before its first test, then cleared here. */
  async function ensureCustomKey(): Promise<string | null> {
    if (customForm.authType === 'none') return null;
    const typing = customKey.credentialId === 'new' || customKeys.length === 0;
    if (!typing) return customKey.credentialId || null;
    if (!customKey.newKey.apiKey?.trim()) throw new Error('Enter the API key or token first.');
    const created = await apiClient.credentials.create({
      provider: 'custom_rest',
      label: `${name.trim() || 'Custom feed'} key`,
      fields: customKey.newKey,
    });
    setCreatedKeyId(created.id);
    setKeys((cur) => [
      ...cur,
      { id: created.id, label: created.label, provider: created.provider },
    ]);
    setCustomKey({ credentialId: created.id, newKey: {} });
    return created.id;
  }

  async function runCustomTest() {
    setTestError(null);
    setFieldErrors({});
    try {
      const credentialId = await ensureCustomKey();
      await customTest.run(
        () =>
          apiClient.feeds.testCustom({
            config: configFromForm(customForm),
            credentialId,
            symbol: testSymbol || undefined,
          }),
        testKey(customForm, credentialId),
      );
    } catch (e) {
      setFieldErrors(problemsOf(e));
      setTestError(
        e instanceof ApiError || e instanceof Error ? e.message : 'Could not test the feed.',
      );
    }
  }

  function close() {
    // A key typed for a feed that was never saved is not kept.
    if (createdKeyId) void apiClient.credentials.remove(createdKeyId).catch(() => undefined);
    setNewKey({});
    setCustomKey({ credentialId: '', newKey: {} });
    onClose();
  }
  const keysForProvider = keys.filter((k) => k.provider === provider);
  const addingKey = needsKey && (credentialId === 'new' || keysForProvider.length === 0);
  const company = kind === 'company';
  const defaultKeyLabel = company ? `${info.name} contact` : `${info.name} paper key`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (custom) {
        if (!customTested && !customUnchanged) {
          setError('Test the feed first: it can be saved once a test of these settings passes.');
          return;
        }
        const body = {
          name,
          assetClasses,
          credentialId: customCredentialId,
          config: configFromForm(customForm),
          testId: customTested ? (customTest.test?.id ?? null) : null,
        };
        if (feed) await apiClient.feeds.update(feed.id, { rowVersion: feed.rowVersion, ...body });
        else await apiClient.feeds.create({ provider, ...body });
        setCreatedKeyId(null);
        setError(null);
        onSaved();
        return;
      }
      let keyId: string | null = needsKey ? credentialId || null : null;
      if (addingKey) {
        const created = await apiClient.credentials.create({
          provider,
          label: newKeyLabel || defaultKeyLabel,
          fields: newKey,
        });
        setNewKey({});
        keyId = created.id;
      }
      if (feed) {
        await apiClient.feeds.update(feed.id, {
          rowVersion: feed.rowVersion,
          name,
          assetClasses,
          ...(needsKey ? { credentialId: keyId } : {}),
        });
      } else {
        await apiClient.feeds.create({ name, provider, assetClasses, credentialId: keyId });
      }
      setError(null);
      onSaved();
    } catch (err) {
      setFieldErrors(problemsOf(err));
      setError(message(err, 'Could not save the feed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      size={custom ? 'lg' : 'md'}
      onClose={close}
      title={feed ? `Edit ${feed.name}` : company ? 'Add a company data feed' : 'Add a data feed'}
      description={
        feed
          ? undefined
          : company
            ? 'Company profiles and reported financials from public filings. It is tested as soon as you save it.'
            : custom
              ? 'Any JSON price API, described here: no code change per provider. Test it with a symbol before saving; the app fetches it on the server, never from your browser.'
              : 'It is tested as soon as you save it.'
      }
    >
      <form onSubmit={(e) => void save(e)} className="space-y-3" autoComplete="off">
        {error && <Alert>{error}</Alert>}
        {!feed && (
          <SelectField
            name="feed-provider"
            label="Provider"
            value={provider}
            onChange={(e) => {
              const p = e.target.value as keyof typeof PROVIDERS;
              setProvider(p);
              setAssetClasses([...PROVIDERS[p].assetClasses]);
              setCredentialId('');
              customTest.reset();
            }}
          >
            {choices.map((id) => (
              <option key={id} value={id}>
                {PROVIDERS[id as keyof typeof PROVIDERS].name}
                {isFundamentalsProvider(id) && PROVIDERS[id].id === 'sec'
                  ? ' (free, US filings)'
                  : ''}
              </option>
            ))}
          </SelectField>
        )}
        <TextField
          name="feed-name"
          label="Name"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {!company && (
          <fieldset>
            <legend className="text-sm font-medium">Asset classes</legend>
            <div className="mt-1 flex gap-4">
              {info.assetClasses.map((a) => (
                <label key={a} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={assetClasses.includes(a)}
                    onChange={(e) =>
                      setAssetClasses((cur) =>
                        e.target.checked ? [...cur, a] : cur.filter((x) => x !== a),
                      )
                    }
                  />
                  {ASSET_CLASS_LABELS[a] ?? a}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {needsKey && keysForProvider.length > 0 && (
          <SelectField
            name="feed-key"
            label={company ? 'Contact' : 'API key'}
            value={credentialId}
            required
            onChange={(e) => setCredentialId(e.target.value)}
          >
            <option value="">{company ? 'Choose a stored contact' : 'Choose a stored key'}</option>
            {keysForProvider.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
            <option value="new">{company ? 'Add a new contact…' : 'Add a new key…'}</option>
          </SelectField>
        )}
        {custom && (
          <CustomFeedFields
            form={customForm}
            onChange={setCustomForm}
            keys={customKeys}
            keyState={customKey}
            onKeyState={setCustomKey}
            errors={fieldErrors}
            test={customTest.test}
            testing={customTest.testing}
            testError={testError}
            onTest={() => void runCustomTest()}
            testSymbol={testSymbol}
            onTestSymbol={setTestSymbol}
          />
        )}
        {addingKey && (
          <>
            <TextField
              name="feed-key-label"
              label={company ? 'Saved as' : 'Key name'}
              maxLength={100}
              value={newKeyLabel}
              placeholder={defaultKeyLabel}
              onChange={(e) => setNewKeyLabel(e.target.value)}
            />
            <CredentialFields
              provider={provider}
              idPrefix="feed-key"
              values={newKey}
              onChange={setNewKey}
            />
          </>
        )}
        {custom && !customTested && !customUnchanged && (
          <p className="text-sm text-ink-muted">
            {customTest.test?.status === 'succeeded'
              ? 'The settings changed since the last test. Test again to save.'
              : 'A custom feed can be saved once a test passes.'}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || (custom && !customTested && !customUnchanged)}
          >
            {busy ? 'Saving…' : feed ? 'Save changes' : 'Add feed'}
          </Button>
          <Button type="button" onClick={close} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TurnOffDialog({
  state,
  feeds,
  onClose,
  onDone,
}: {
  state: { feed: FeedDto; details: FeedInUseDetails } | null;
  feeds: FeedDto[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [choice, setChoice] = useState<'replace' | 'pause'>('replace');
  const [replacement, setReplacement] = useState('');
  const [error, setError] = useState<string | null>(null);
  const candidates = state
    ? feeds.filter(
        (f) =>
          f.id !== state.feed.id &&
          f.isActive &&
          // Any feed that covers the same instruments: demo for demo, real for real.
          (f.provider === 'demo') === (state.feed.provider === 'demo') &&
          state.feed.routes.every((r) => f.assetClasses.includes(r.assetClass)),
      )
    : [];

  useEffect(() => {
    setChoice(candidates.length > 0 ? 'replace' : 'pause');
    setReplacement(candidates[0]?.id ?? '');
    setError(null);
    // Reset when a new feed is chosen.
  }, [state?.feed.id]);

  async function confirm() {
    if (!state) return;
    try {
      await apiClient.feeds.setActive(
        state.feed.id,
        choice === 'replace'
          ? { active: false, replacementFeedId: replacement }
          : { active: false, pauseStrategies: true },
      );
      onDone();
    } catch (e) {
      setError(message(e, 'Could not turn the feed off.'));
    }
  }

  const names = state?.details.dependents.map((d) => d.strategyName).join(', ') ?? '';
  return (
    <Dialog
      open={state !== null}
      onClose={onClose}
      title={`Turn off ${state?.feed.name ?? 'feed'}?`}
      description={`${names} ${state?.details.dependents.length === 1 ? 'gets' : 'get'} prices from it.`}
    >
      {error && <Alert>{error}</Alert>}
      <fieldset className="space-y-2 text-sm">
        <legend className="sr-only">What should happen to them</legend>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="turn-off-choice"
            checked={choice === 'replace'}
            disabled={candidates.length === 0}
            onChange={() => setChoice('replace')}
          />
          <span>
            Move its routes to another feed
            {candidates.length === 0 && ' (no other suitable feed is on)'}
          </span>
        </label>
        {choice === 'replace' && candidates.length > 0 && (
          <SelectField
            name="replacement-feed"
            label="Replacement feed"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          >
            {candidates.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </SelectField>
        )}
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="turn-off-choice"
            checked={choice === 'pause'}
            onChange={() => setChoice('pause')}
          />
          <span>Pause {names}</span>
        </label>
      </fieldset>
      <div className="mt-4 flex gap-2">
        <Button variant="danger" onClick={() => void confirm()}>
          Turn off
        </Button>
        <Button onClick={onClose}>Keep it on</Button>
      </div>
    </Dialog>
  );
}
