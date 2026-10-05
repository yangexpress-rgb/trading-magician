import type { Metadata } from 'next';
import { LAST_UPDATED, RiskNotice } from '@/components/legal';

export const metadata: Metadata = { title: 'Terms of Service' };

export default function TermsPage() {
  return (
    <>
      <h1 className="text-xl font-semibold">Terms of Service</h1>
      <p className="text-xs text-ink-muted">Placeholder, last updated {LAST_UPDATED}.</p>
      <RiskNotice />
      <p>
        These terms are a placeholder for the invite-only test of Trading Magician and have not been
        reviewed by a lawyer. They will be replaced before anyone is charged or before the app can
        place real orders. Ask the people who invited you if anything here matters to you.
      </p>
      <h2 className="pt-2 text-base font-semibold">What the app does</h2>
      <p>
        Trading Magician lets you describe a trading strategy, test it against historical or
        generated price data, and run it against a paper trading account that places simulated
        orders. It never trades real money, and it has no way to reach a live trading account.
      </p>
      <h2 className="pt-2 text-base font-semibold">What it is not</h2>
      <p>
        Nothing in the app is financial, investment, tax or legal advice, and nothing in it is a
        recommendation to buy or sell anything. Results from back tests and paper trading are
        simulated. They do not predict real results, and they leave out costs and conditions a real
        market would impose.
      </p>
      <h2 className="pt-2 text-base font-semibold">Your account</h2>
      <p>
        Keep your password to yourself and do not share your account. Do not try to get at other
        people&rsquo;s data, work around the limits of your plan, or use the app to break the law or
        a broker&rsquo;s or data provider&rsquo;s own terms. Any provider keys you store are yours;
        use paper-trading keys only. We may suspend an account that puts the service or other
        people&rsquo;s data at risk.
      </p>
      <h2 className="pt-2 text-base font-semibold">Availability and changes</h2>
      <p>
        This is an early test. The app may be unavailable, may lose queued work, and may change or
        remove features. Paid plans are billed through Stripe in test mode during the invite-only
        test, so no real payment is taken. You can cancel at any time, and you can delete your
        account from Settings; deleted accounts are purged after 30 days, while records we must keep
        for audit are stripped of personal details.
      </p>
      <h2 className="pt-2 text-base font-semibold">No warranty, no liability</h2>
      <p>
        The app is provided as it is, without warranties of any kind. To the extent the law allows,
        the people running this test are not liable for any loss arising from your use of it,
        including decisions you make based on anything it shows you.
      </p>
    </>
  );
}
