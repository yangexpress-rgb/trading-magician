import { BarLoadError } from '@tm/backtest';
import { AlpacaRateLimitError } from '@tm/alpaca';
import { describe, expect, it } from 'vitest';
import { scrub, userMessage } from './backtests';

/** v1.2 review: a failed back test says why, without secrets. */
describe('back-test failure messages', () => {
  it('names the symbol and the feed’s reason', () => {
    expect(userMessage(new BarLoadError('MSFT', new AlpacaRateLimitError(1000)))).toBe(
      'Bars for MSFT could not be loaded: Alpaca is over its request limit for this key',
    );
  });

  it('gives an unexpected error’s kind and text, with addresses and tokens removed', () => {
    const e = new TypeError(
      'fetch failed for https://data.alpaca.markets/v2/stocks/bars?key=abc using PKABCDEFGHIJKLMNOPQRSTUVWX',
    );
    const message = userMessage(e);
    expect(message).toMatch(/^The back test could not be completed\. .* Reason: TypeError: /);
    expect(message).not.toMatch(/alpaca\.markets|PKABCDEFGHIJ/);
    expect(scrub('postgres://u:p@h/db failed')).toBe('[address] failed');
  });
});
