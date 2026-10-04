import { schema, withTenant } from '@tm/db';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';
import { DeleteAccount } from './delete-account';
import { ProfileForm } from './profile-form';
import { SessionsPanel } from './sessions-panel';

export default async function SettingsPage() {
  const tenant = await requireTenant();
  const { profile, feeds, accounts } = await withTenant(appDb(), tenant, async (tx) => ({
    profile: (await tx.select().from(schema.profiles))[0],
    feeds: await tx.select().from(schema.dataFeedConnections),
    accounts: await tx.select().from(schema.tradingAccounts),
  }));
  if (!profile) throw new Error('Profile missing after provisioning');
  const timezones = ['UTC', ...Intl.supportedValuesOf('timeZone')];

  return (
    <main>
      <h1>Settings</h1>

      <section aria-labelledby="profile-heading">
        <h2 id="profile-heading">Profile</h2>
        <p className="muted">Signed in as {tenant.email}</p>
        <ProfileForm profile={profile} timezones={timezones} />
      </section>

      <section aria-labelledby="feeds-heading">
        <h2 id="feeds-heading">Data feeds</h2>
        <p className="muted">Adding your own feeds comes in a later phase.</p>
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Provider</th>
              <th scope="col">Assets</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {feeds.map((f) => (
              <tr key={f.id}>
                <td>{f.name}</td>
                <td>{f.provider}</td>
                <td>{f.assetClasses.join(', ')}</td>
                <td>
                  {f.isActive ? 'Active' : 'Inactive'} · {f.health}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="accounts-heading">
        <h2 id="accounts-heading">Trading accounts</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Number</th>
              <th scope="col">Mode</th>
              <th scope="col">Currency</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.nickname} {a.isDefault && <span className="badge">Default</span>}
                </td>
                <td>{a.maskedExternalId}</td>
                <td>
                  <span className="badge">{a.mode === 'paper' ? 'Paper' : 'Live'}</span>
                </td>
                <td>{a.currency}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">Active sessions</h2>
        <SessionsPanel currentSessionId={tenant.sessionId} timezone={profile.timezone} />
      </section>

      <section aria-labelledby="danger-heading">
        <h2 id="danger-heading">Delete account</h2>
        <DeleteAccount />
      </section>
    </main>
  );
}
