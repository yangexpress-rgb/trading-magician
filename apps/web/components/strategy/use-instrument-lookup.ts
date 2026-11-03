'use client';

import { ApiError, type InstrumentLookupDto, type InstrumentOptionDto } from '@tm/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';

const POLL_MS = 700;
const GIVE_UP_MS = 45_000;

/**
 * Finds a US stock or ETF through the person's data feed (ADR 0017, 0029):
 * by ticker, or by company name, in which case the closest listings come
 * back as candidates to pick from. The worker answers; this polls.
 */
export function useInstrumentLookup(onFound: (instrument: InstrumentOptionDto) => void) {
  const [lookup, setLookup] = useState<InstrumentLookupDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(0);
  const found = useRef(onFound);
  found.current = onFound;
  useEffect(() => () => clearTimeout(timer.current), []);

  const find = useCallback(async (text: string) => {
    clearTimeout(timer.current);
    const mine = ++latest.current;
    setError(null);
    try {
      const started = await apiClient.instruments.lookup({ symbol: text });
      if (mine !== latest.current) return;
      setLookup(started);
      const deadline = Date.now() + GIVE_UP_MS;
      const poll = (current: InstrumentLookupDto) => {
        if (mine !== latest.current) return;
        if (current.status !== 'pending') {
          if (current.status === 'found' && current.instrument) found.current(current.instrument);
          return;
        }
        if (Date.now() > deadline) {
          setError('The search is taking longer than expected. Try again in a minute.');
          setLookup(null);
          return;
        }
        timer.current = setTimeout(() => {
          apiClient.instruments.getLookup(current.id).then(
            (next) => {
              if (mine !== latest.current) return;
              setLookup(next);
              poll(next);
            },
            () => setError('Could not check the search. Try again.'),
          );
        }, POLL_MS);
      };
      poll(started);
    } catch (err) {
      if (mine === latest.current) {
        setError(err instanceof ApiError ? err.message : 'Could not start the search.');
      }
    }
  }, []);

  const reset = useCallback(() => {
    clearTimeout(timer.current);
    latest.current++;
    setLookup(null);
    setError(null);
  }, []);

  return { lookup, error, find, reset, pending: lookup?.status === 'pending' };
}
