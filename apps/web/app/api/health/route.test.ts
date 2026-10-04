import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('GET /api/health', () => {
  it('reports ok and that live trading is off', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'web', liveTrading: false });
  });
});
