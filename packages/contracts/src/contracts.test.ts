import { describe, expect, it } from 'vitest';
import { createApiClient } from './client';
import { ApiError } from './errors';
import {
  createStrategyRequest,
  listStrategiesQuery,
  startStrategyRequest,
  updateStrategyRequest,
} from './strategies';

describe('request schemas', () => {
  it('trims names and removes duplicate tags', () => {
    expect(createStrategyRequest.parse({ name: '  Pairs  ', tags: ['a', 'a', 'b'] })).toEqual({
      name: 'Pairs',
      tags: ['a', 'b'],
    });
    expect(createStrategyRequest.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('requires a row version on updates and rejects unknown fields', () => {
    expect(updateStrategyRequest.safeParse({ name: 'x' }).success).toBe(false);
    expect(updateStrategyRequest.safeParse({ rowVersion: 1, owner: 'someone' }).success).toBe(
      false,
    );
    expect(
      updateStrategyRequest.safeParse({ rowVersion: 1, status: 'actively_executing' }).success,
    ).toBe(false);
  });

  it('only starts on paper, with explicit confirmation', () => {
    expect(
      startStrategyRequest.safeParse({ rowVersion: 1, mode: 'live', confirmed: true }).success,
    ).toBe(false);
    expect(
      startStrategyRequest.safeParse({ rowVersion: 1, mode: 'paper', confirmed: false }).success,
    ).toBe(false);
    expect(startStrategyRequest.parse({ rowVersion: 1, mode: 'paper', confirmed: true })).toEqual({
      rowVersion: 1,
      mode: 'paper',
      confirmed: true,
      acknowledgedWarnings: [],
    });
  });

  it('parses list queries with defaults and repeated statuses', () => {
    expect(listStrategiesQuery.parse({})).toEqual({
      archived: 'exclude',
      sort: 'updated',
      direction: 'desc',
      limit: 50,
      offset: 0,
    });
    expect(listStrategiesQuery.parse({ status: ['created', 'off'], limit: '10' })).toMatchObject({
      status: ['created', 'off'],
      limit: 10,
    });
    expect(listStrategiesQuery.parse({ status: 'off' }).status).toEqual(['off']);
    expect(listStrategiesQuery.safeParse({ updatedFrom: 'yesterday' }).success).toBe(false);
  });
});

describe('API client', () => {
  it('builds list URLs and sends JSON bodies', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const client = createApiClient({
      fetch: async (url, init) => {
        calls.push([String(url), init]);
        return Response.json({ items: [], total: 0 });
      },
    });
    await client.strategies.list({ q: 'a b', status: ['created', 'off'] });
    await client.strategies.update('id-1', { rowVersion: 3, name: 'N' });
    expect(calls[0]?.[0]).toBe('/api/v1/strategies?q=a+b&status=created&status=off');
    expect(calls[1]?.[0]).toBe('/api/v1/strategies/id-1');
    expect(calls[1]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ rowVersion: 3, name: 'N' }),
    });
  });

  it('raises the server error body as an ApiError', async () => {
    const client = createApiClient({
      fetch: async () =>
        Response.json(
          { error: { code: 'conflict', message: 'Changed elsewhere' } },
          { status: 409 },
        ),
    });
    const error = await client.strategies.get('x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'conflict', message: 'Changed elsewhere' });
  });

  it('falls back to a generic message when the body is not JSON', async () => {
    const client = createApiClient({ fetch: async () => new Response('oops', { status: 502 }) });
    await expect(client.strategies.get('x')).rejects.toMatchObject({ code: 'internal' });
  });
});
