'use client';

import {
  ApiError,
  type ExecutionStatusDto,
  type OrderListDto,
  type OrderViewDto,
  type PositionDto,
} from '@tm/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';

export interface OrderFilters {
  view: OrderViewDto;
  strategyId?: string | undefined;
  runtimeId?: string | undefined;
  cycleId?: string | undefined;
  phase?: 'entry' | 'exit' | 'flatten' | undefined;
  instrumentId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** URL parameter for each filter, so a filtered view can be bookmarked and shared. */
export const FILTER_PARAMS = {
  view: 'view',
  strategyId: 'strategy',
  runtimeId: 'runtime',
  cycleId: 'cycle',
  phase: 'phase',
  instrumentId: 'asset',
  from: 'from',
  to: 'to',
} as const satisfies Record<keyof OrderFilters, string>;

export function filtersToSearch(f: OrderFilters, keep: URLSearchParams): string {
  const params = new URLSearchParams();
  for (const key of ['started']) {
    const v = keep.get(key);
    if (v) params.set(key, v);
  }
  for (const [key, param] of Object.entries(FILTER_PARAMS) as [keyof OrderFilters, string][]) {
    const value = f[key];
    if (value && !(key === 'view' && value === 'all')) params.set(param, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export type LiveState = 'connecting' | 'live' | 'reconnecting';

export interface OrdersData {
  list: OrderListDto | null;
  positions: PositionDto[] | null;
  status: ExecutionStatusDto | null;
  error: string | null;
  live: LiveState;
  /** Bumped on every refresh, so an open detail panel can re-read too. */
  version: number;
  refresh: () => void;
}

/** A backstop in case a change notice is missed. */
const FALLBACK_REFRESH_MS = 30_000;

/**
 * The Orders tab's data, kept current by server-sent events (§15.2): the
 * server says when something may have changed and the page re-reads it, so
 * nobody has to reload to see orders appear, fill or cancel.
 */
export function useOrders(filters: OrderFilters, timeZone: string): OrdersData {
  const [list, setList] = useState<OrderListDto | null>(null);
  const [positions, setPositions] = useState<PositionDto[] | null>(null);
  const [status, setStatus] = useState<ExecutionStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState>('connecting');
  const [version, setVersion] = useState(0);
  const latest = useRef(0);

  const key = JSON.stringify(filters);
  const load = useCallback(async () => {
    const ticket = ++latest.current;
    const f = JSON.parse(key) as OrderFilters;
    try {
      const [l, p, s] = await Promise.all([
        apiClient.orders.list({ ...f, tz: timeZone }),
        apiClient.positions.list(),
        apiClient.execution.status(),
      ]);
      if (ticket !== latest.current) return;
      setList(l);
      setPositions(p.positions);
      setStatus(s);
      setError(null);
      setVersion((v) => v + 1);
    } catch (e) {
      if (ticket !== latest.current) return;
      setError(e instanceof ApiError ? e.message : 'Could not load orders. Retrying…');
    }
  }, [key, timeZone]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const source = new EventSource(apiClient.orders.streamUrl());
    const onChange = () => void load();
    source.addEventListener('ready', () => {
      setLive('live');
      onChange();
    });
    source.addEventListener('change', onChange);
    source.onerror = () => setLive('reconnecting');
    const timer = setInterval(onChange, FALLBACK_REFRESH_MS);
    return () => {
      source.close();
      clearInterval(timer);
    };
  }, [load]);

  return { list, positions, status, error, live, version, refresh: () => void load() };
}
