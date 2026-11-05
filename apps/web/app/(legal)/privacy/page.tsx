import type { Metadata } from 'next';
import { LAST_UPDATED } from '@/components/legal';

export const metadata: Metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return (
    <>
      <h1 className="text-xl font-semibold">Privacy Policy</h1>
      <p className="text-xs text-ink-muted">Placeholder, last updated {LAST_UPDATED}.</p>
      <p>
        This policy is a placeholder for the invite-only test of Trading Magician and has not been
        reviewed by a lawyer. It describes what the app actually stores today.
      </p>
      <h2 className="pt-2 text-base font-semibold">What is stored</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>Your name, email address and a hash of your password, so you can sign in.</li>
        <li>Your preferences: time zone, number and date formats, notification choices.</li>
        <li>
          What you create in the app: strategies and their versions, back tests, paper orders and
          their timelines, performance records, notifications, and an audit trail of actions.
        </li>
        <li>
          Provider API keys you choose to save. They are encrypted before they are stored, are never
          shown again, and are never sent to your browser.
        </li>
        <li>
          Subscription state from Stripe: your customer and subscription ids, plan, status and
          period. Card details go to Stripe and never reach the app.
        </li>
        <li>
          Server logs and error reports, which carry the kind of request and the error, with keys,
          secrets, passwords and email addresses removed.
        </li>
      </ul>
      <h2 className="pt-2 text-base font-semibold">Who else sees it</h2>
      <p>
        Only the services the app needs: the host it runs on, its database and backups, Stripe for
        billing, the email provider that sends sign-up and password emails, Sentry for error
        reports, and any market data or broker provider whose key you saved, when the app calls it
        for you. Nothing is sold, and nothing is used for advertising.
      </p>
      <h2 className="pt-2 text-base font-semibold">How long</h2>
      <p>
        Your data stays while your account exists. When you delete your account it is purged after
        30 days; order and audit records that must be kept are stripped of personal details. Backups
        are kept for 30 days and then deleted.
      </p>
      <h2 className="pt-2 text-base font-semibold">Your choices</h2>
      <p>
        You can change your details and notification choices, remove a saved provider key, or delete
        your account, all from Settings. For anything else, ask the people who invited you.
      </p>
    </>
  );
}
