import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Signed } from '@/components/signed';
import { formatSignedMoney } from './backtest-text';
import { signTone } from './sign-tone';

describe('gains green, losses red (N289)', () => {
  it('colours by sign and leaves zero and missing values alone', () => {
    expect(signTone('12.5')).toBe('text-ok');
    expect(signTone(-0.01)).toBe('text-danger');
    expect(signTone(0)).toBeUndefined();
    expect(signTone(null)).toBeUndefined();
    expect(signTone('—')).toBeUndefined();
  });

  it('keeps the minus sign on the same line as its figure', () => {
    const html = renderToStaticMarkup(
      <Signed value={-1032.08}>{formatSignedMoney(-1032.08)}</Signed>,
    );
    expect(html).toBe('<span class="whitespace-nowrap text-danger">−$1,032.08</span>');
  });
});
