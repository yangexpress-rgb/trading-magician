import { EQUITY_TOLERANCE, MARK_STALE_SEC, MIN_SHARPE_DAYS } from '@tm/domain';
import { Card, PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'How performance is calculated' };

/**
 * The calculation method behind the Performance tab (Design v1.0 §10.2;
 * ADRs 0019 to 0021), in plain words. Constants come from the code that uses them.
 */

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="py-2">
      <dt className="font-medium">{term}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function Part({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card aria-labelledby={id}>
      <h2 id={id} className="mb-2 text-lg font-semibold">
        {title}
      </h2>
      <dl className="divide-y divide-line">{children}</dl>
    </Card>
  );
}

export default function MethodologyPage() {
  return (
    <>
      <PageHeader
        title="How performance is calculated"
        description="Every figure on the Performance tab comes from fills the broker confirmed, valued the same way each time."
      />
      <p className="mb-4 text-sm">
        <Link href="/performance" className="underline">
          Back to Performance
        </Link>
      </p>
      <div className="space-y-4">
        <Part id="m-trades" title="Trades and profit">
          <Item term="Source">
            Only fills the broker confirmed count, never orders the app meant to place.
          </Item>
          <Item term="Matching sales to purchases">
            First in, first out, separately for each strategy run, account and instrument, so one
            strategy never closes another&apos;s holding. A sale with nothing held opens a short
            position.
          </Item>
          <Item term="One trade">
            One strategy cycle, from Entry to Exit with all its legs together. Each leg&apos;s part
            is shown inside it. A trade belongs to the day it closed, or the day it opened while it
            is still open.
          </Item>
          <Item term="Realized and unrealized">
            Realized is what closed holdings made or lost. Unrealized is what open holdings would
            make or lose at the latest price.
          </Item>
          <Item term="Gross and net">
            Fees are recorded per fill exactly as the broker reports them; paper fills carry none.
            Net is gross less fees.
          </Item>
          <Item term="Win rate, average gain and loss, profit factor">
            Over closed trades: the share that made money, the average of the winners and of the
            losers, and total gains divided by total losses.
          </Item>
        </Part>

        <Part id="m-valuation" title="Valuation and equity">
          <Item term="Prices">
            Open holdings are valued at the last price from your data feeds, through the same routes
            your strategies use. A price more than {MARK_STALE_SEC} seconds old is flagged as stale;
            after the market closes, the closing price is used.
          </Item>
          <Item term="When">
            Each account is valued every few minutes and kept as one figure per trading day. The
            first valuation after the 4:00 pm New York close is final for that day and is never
            changed.
          </Item>
          <Item term="Equity">
            Starting equity plus realized and unrealized profit, less fees already paid on what is
            still open. The demo account starts at $100,000, the same as an Alpaca paper account.
            Other accounts take their starting point from the broker the first time it reports
            equity.
          </Item>
          <Item term="Currency">
            All amounts are in US dollars, the currency of every supported account.
          </Item>
        </Part>

        <Part id="m-returns" title="Returns and risk">
          <Item term="Account return">
            Time-weighted: each day&apos;s return is chained to the next, so adding an account does
            not count as a gain.
          </Item>
          <Item term="Strategy return">
            Profit or loss in dollars, and as a share of the most capital the strategy had at work
            on any day (return on peak capital).
          </Item>
          <Item term="Drawdown">
            How far equity fell below its highest point so far. For a single strategy or asset, it
            is measured in dollars of profit or loss instead.
          </Item>
          <Item term="Sharpe ratio">
            The average daily return over its variability, scaled to 252 trading days a year, with
            no risk-free rate. It is not shown with fewer than {MIN_SHARPE_DAYS} trading days.
          </Item>
          <Item term="Exposure and turnover">
            Exposure is the value of everything held at the end of the range. Turnover is the value
            of everything bought and sold within it. Both are also shown as a share of equity.
          </Item>
        </Part>

        <Part id="m-broker" title="When the app and the broker disagree">
          <Item term="What is checked">
            At each close, the app compares what it holds with what the broker holds, and its equity
            with the broker&apos;s. Any difference in quantity, or equity more than $
            {EQUITY_TOLERANCE.toFixed(2)} apart, is flagged and you are notified.
          </Item>
          <Item term="Which figure counts">
            The broker&apos;s. Where it reports equity, the Performance tab shows the broker&apos;s
            figure, with the app&apos;s beside it.
          </Item>
          <Item term="Outside the app">
            Holdings bought or sold directly at the broker are not given to any strategy. They show
            as differences at the close, named as outside the app.
          </Item>
        </Part>
      </div>
    </>
  );
}
