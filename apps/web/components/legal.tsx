import { Alert } from '@tm/ui';

/** Changed by hand when the placeholder terms or policy change (ADR 0026). */
export const LAST_UPDATED = '5 October 2026';

/**
 * The §16.4 risk notice. Shown on the terms and on first sign-in, and the same
 * words appear wherever the app has to say what it is not.
 */
export function RiskNotice() {
  return (
    <Alert>
      <strong>Paper trading only.</strong> Trading Magician places simulated orders against paper
      accounts. It never trades real money. Back tests and paper results are simulated, do not
      predict real results, and are not financial advice. Trading real markets can lose you money.
    </Alert>
  );
}
