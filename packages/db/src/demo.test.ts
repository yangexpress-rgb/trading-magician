import { describe, expect, it } from 'vitest';
import { demoDataEnabled } from './demo';

/** Design v1.2 item 10: demo data is test-only and can't be turned on in a deployment. */
describe('demoDataEnabled', () => {
  it('is off unless DEMO_DATA=on', () => {
    expect(demoDataEnabled({})).toBe(false);
    expect(demoDataEnabled({ DEMO_DATA: 'yes' })).toBe(false);
    expect(demoDataEnabled({ DEMO_DATA: 'on' })).toBe(true);
    expect(demoDataEnabled({ DEMO_DATA: 'on', APP_URL: 'http://localhost:3100' })).toBe(true);
    expect(demoDataEnabled({ DEMO_DATA: 'on', APP_URL: 'http://127.0.0.1:3000' })).toBe(true);
  });

  it('is ignored on Railway and on any app not served from this machine', () => {
    expect(demoDataEnabled({ DEMO_DATA: 'on', RAILWAY_ENVIRONMENT_NAME: 'staging' })).toBe(false);
    expect(demoDataEnabled({ DEMO_DATA: 'on', RAILWAY_PROJECT_ID: 'p' })).toBe(false);
    expect(
      demoDataEnabled({ DEMO_DATA: 'on', APP_URL: 'https://web-staging-737c.up.railway.app' }),
    ).toBe(false);
    expect(demoDataEnabled({ DEMO_DATA: 'on', APP_URL: 'not a url' })).toBe(false);
  });
});
