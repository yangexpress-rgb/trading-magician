'use client';

import { apiClient } from './api-client';

/**
 * One server-sent event stream per browser tab, shared by everything on the
 * page that wants to know when orders, positions, incidents or notifications
 * may have changed (ADR 0013, ADR 0014).
 */

export type LiveState = 'connecting' | 'live' | 'reconnecting';
type Listener = { onChange: () => void; onState?: (state: LiveState) => void };

let source: EventSource | undefined;
let state: LiveState = 'connecting';
const listeners = new Set<Listener>();

function open() {
  source = new EventSource(apiClient.orders.streamUrl());
  const setState = (next: LiveState) => {
    state = next;
    for (const l of listeners) l.onState?.(next);
  };
  source.addEventListener('ready', () => {
    setState('live');
    for (const l of listeners) l.onChange();
  });
  source.addEventListener('change', () => {
    for (const l of listeners) l.onChange();
  });
  source.onerror = () => setState('reconnecting');
}

/** Subscribes to change notices; returns the unsubscribe function. */
export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener);
  listener.onState?.(state);
  if (!source) open();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && source) {
      source.close();
      source = undefined;
      state = 'connecting';
    }
  };
}
