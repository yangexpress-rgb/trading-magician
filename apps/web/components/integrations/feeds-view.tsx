'use client';

import {
  ApiError,
  ROUTE_DATA_TYPES,
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
import { useCallback, useEffect, useState } from 'react';
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
 * Then the company data feeds (ADR 0031), which give company profiles and
 * financials rather than prices, and below them the routes that pick a
 * primary and fallback price feed for each kind of data. Updates arrive
 * live, so a test result appears on its own.
 */
export function FeedsView({ prefs }: { prefs: DisplayPreferences }) {
  const [data, setData] = useState<FeedListDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<FeedKind | null>(null);
  const [editing, setEditing] = useState<FeedDto | null>(null);
  const [turningOff, setTurningOff] = useState<{ feed: FeedDto; details: FeedInUseDetails } | null>(
    null,
  );
  const [removing, setRemoving] = useState<FeedDto | null>(null);
  const [addingRoute, setAddingRoute] = useState(false);

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
            <p className="mt-1 text-ink-muted">
              Last update {when(f.lastSuccessAt)} · last checked {when(f.lastCheckedAt)}
            </p>
            {f.lastError && !f.checking && (
              <p className="mt-1 text-danger">Last check: {f.lastError}</p>
            )}
            <p className="mt-1">
              {company
                ? f.id === companyInUse
                  ? 'In use for company pages in Quantitative Research and the screener’s company columns'
                  : f.isActive
                    ? 'Standing by: another company data feed is in use'
                    : 'Not in use while off'
                : f.routes.length === 0
                  ? 'Not used by any route'
                  : f.routes
                      .map(
                        (r) =>
                          `${r.role === 'primary' ? 'Primary' : 'Fallback'} for ${ASSET_CLASS_LABELS[r.assetClass] ?? r.assetClass} ${DATA_TYPE_LABELS[r.dataType].toLowerCase()} (${venueLabel(r.venue).toLowerCase()})${r.serving ? ', in use now' : ''}`,
                      )
                      .join('; ')}
            </p>
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
          now.
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

      {data && (
        <RoutesSection
          routes={data.routes}
          feeds={priceFeeds}
          when={when}
          onChanged={() => void load()}
          onAdd={() => setAddingRoute(true)}
        />
      )}

      <FeedDialog
        open={adding !== null}
        kind={adding ?? 'prices'}
        feed={null}
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
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name ?? 'feed'}?`}
        description={
          removing && removing.routes.length > 0
            ? 'Routes still use this feed. Point them at another feed first.'
            : 'Its settings are deleted. A stored API key it used stays under Stored API keys.'
        }
      >
        <div className="flex gap-2">
          <Button
            variant="danger"
            disabled={!removing || removing.routes.length > 0}
            onClick={() =>
              removing &&
              void act(
                () => apiClient.feeds.remove(removing.id),
                'Could not remove the feed.',
              ).then(() => setRemoving(null))
            }
          >
            Remove feed
          </Button>
          <Button onClick={() => setRemoving(null)}>Keep it</Button>
        </div>
      </Dialog>
      {data && (
        <RouteDialog
          open={addingRoute}
          feeds={priceFeeds}
          onClose={() => setAddingRoute(false)}
          onSaved={() => {
            setAddingRoute(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function RoutesSection({
  routes,
  feeds,
  when,
  onChanged,
  onAdd,
}: {
  routes: RouteDto[];
  feeds: FeedDto[];
  when: (iso: string | null) => string;
  onChanged: () => void;
  onAdd: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  async function change(
    route: RouteDto,
    patch: { primaryFeedId?: string; fallbackFeedId?: string | null },
  ) {
    try {
      await apiClient.routes.update(route.id, {
        rowVersion: route.rowVersion,
        primaryFeedId: patch.primaryFeedId ?? route.primary.id,
        fallbackFeedId:
          patch.fallbackFeedId === undefined ? (route.fallback?.id ?? null) : patch.fallbackFeedId,
      });
      setError(null);
      onChanged();
    } catch (e) {
      setError(message(e, 'Could not change the route.'));
    }
  }

  return (
    <section aria-labelledby="routes-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="routes-heading" className="text-lg font-semibold">
          Routes
        </h2>
        <Button onClick={onAdd}>Add a route</Button>
      </div>
      <p className="text-sm text-ink-muted">
        Each route sends one kind of data to a primary feed. If the primary stops sending current
        prices, the fallback takes over, and the primary takes back over once it has been healthy
        for 5 minutes.
      </p>
      {error && <Alert>{error}</Alert>}
      <Table label="Routes">
        <thead>
          <tr>
            <Th>Asset class</Th>
            <Th>Venue</Th>
            <Th>Data</Th>
            <Th>Primary</Th>
            <Th>Fallback</Th>
            <Th>Prices from</Th>
          </tr>
        </thead>
        <tbody>
          {routes.map((r) => {
            const label = `${ASSET_CLASS_LABELS[r.assetClass] ?? r.assetClass} ${DATA_TYPE_LABELS[r.dataType].toLowerCase()}, ${venueLabel(r.venue).toLowerCase()}`;
            const fits = feeds.filter((f) => f.assetClasses.includes(r.assetClass));
            return (
              <tr key={r.id}>
                <Td>{ASSET_CLASS_LABELS[r.assetClass] ?? r.assetClass}</Td>
                <Td>{venueLabel(r.venue)}</Td>
                <Td>{DATA_TYPE_LABELS[r.dataType]}</Td>
                <Td>
                  <label className="sr-only" htmlFor={`primary-${r.id}`}>
                    Primary feed for {label}
                  </label>
                  <select
                    id={`primary-${r.id}`}
                    className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
                    value={r.primary.id}
                    onChange={(e) => void change(r, { primaryFeedId: e.target.value })}
                  >
                    {fits.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                        {f.isActive ? '' : ' (off)'}
                      </option>
                    ))}
                  </select>
                </Td>
                <Td>
                  <label className="sr-only" htmlFor={`fallback-${r.id}`}>
                    Fallback feed for {label}
                  </label>
                  <select
                    id={`fallback-${r.id}`}
                    className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
                    value={r.fallback?.id ?? ''}
                    onChange={(e) => void change(r, { fallbackFeedId: e.target.value || null })}
                  >
                    <option value="">None</option>
                    {fits
                      .filter((f) => f.id !== r.primary.id)
                      .map((f) => (
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
                      {r.fallback?.name ?? 'Fallback'} since {when(r.switchedAt)}
                    </Badge>
                  ) : (
                    r.primary.name
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </section>
  );
}

function FeedDialog({
  open,
  kind,
  feed,
  onClose,
  onSaved,
}: {
  open: boolean;
  kind: FeedKind;
  /** Null to add a new feed. */
  feed: FeedDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState<string>('alpaca');
  const [name, setName] = useState('');
  const [assetClasses, setAssetClasses] = useState<string[]>([]);
  const [credentialId, setCredentialId] = useState<string>('');
  const [keys, setKeys] = useState<{ id: string; label: string; provider: string }[]>([]);
  const [newKey, setNewKey] = useState<Record<string, string>>({});
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const choices = PROVIDERS_FOR[kind];
    const p = feed?.provider ?? choices.find((id) => id !== 'demo') ?? choices[0] ?? 'demo';
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
  }, [open, feed, kind]);

  const info = PROVIDERS[provider as keyof typeof PROVIDERS];
  const needsKey = info.credentialFields.length > 0;
  const keysForProvider = keys.filter((k) => k.provider === provider);
  const addingKey = needsKey && (credentialId === 'new' || keysForProvider.length === 0);
  const company = kind === 'company';
  const defaultKeyLabel = company ? `${info.name} contact` : `${info.name} paper key`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
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
      setError(message(err, 'Could not save the feed.'));
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
      title={feed ? `Edit ${feed.name}` : company ? 'Add a company data feed' : 'Add a data feed'}
      description={
        feed
          ? undefined
          : company
            ? 'Company profiles and reported financials from public filings. It is tested as soon as you save it.'
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
            }}
          >
            {PROVIDERS_FOR[kind].map((id) => (
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
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : feed ? 'Save changes' : 'Add feed'}
          </Button>
          <Button type="button" onClick={onClose} disabled={busy}>
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
          f.provider === state.feed.provider &&
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

function RouteDialog({
  open,
  feeds,
  onClose,
  onSaved,
}: {
  open: boolean;
  feeds: FeedDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [assetClass, setAssetClass] = useState('stock');
  const [venue, setVenue] = useState<'any' | 'DEMO'>('any');
  const [dataType, setDataType] = useState<(typeof ROUTE_DATA_TYPES)[number]>('quotes');
  const [primary, setPrimary] = useState('');
  const [fallback, setFallback] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fits = feeds.filter(
    (f) => f.assetClasses.includes(assetClass) && (venue === 'DEMO') === (f.provider === 'demo'),
  );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiClient.routes.create({
        assetClass,
        venue: venue === 'any' ? null : venue,
        dataType,
        primaryFeedId: primary || fits[0]?.id || '',
        fallbackFeedId: fallback || null,
      });
      setError(null);
      onSaved();
    } catch (err) {
      setError(message(err, 'Could not add the route.'));
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add a route">
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <SelectField
          name="route-asset"
          label="Asset class"
          value={assetClass}
          onChange={(e) => setAssetClass(e.target.value)}
        >
          <option value="stock">Stocks</option>
          <option value="etf">ETFs</option>
        </SelectField>
        <SelectField
          name="route-venue"
          label="Venue"
          value={venue}
          onChange={(e) => setVenue(e.target.value as 'any' | 'DEMO')}
        >
          <option value="any">Any US venue</option>
          <option value="DEMO">Demo instruments</option>
        </SelectField>
        <SelectField
          name="route-data"
          label="Data"
          value={dataType}
          onChange={(e) => setDataType(e.target.value as (typeof ROUTE_DATA_TYPES)[number])}
        >
          {ROUTE_DATA_TYPES.map((d) => (
            <option key={d} value={d}>
              {DATA_TYPE_LABELS[d]}
            </option>
          ))}
        </SelectField>
        <SelectField
          name="route-primary"
          label="Primary feed"
          value={primary}
          onChange={(e) => setPrimary(e.target.value)}
        >
          {fits.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          name="route-fallback"
          label="Fallback feed"
          value={fallback}
          onChange={(e) => setFallback(e.target.value)}
        >
          <option value="">None</option>
          {fits
            .filter((f) => f.id !== (primary || fits[0]?.id))
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
        </SelectField>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={fits.length === 0}>
            Add route
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
