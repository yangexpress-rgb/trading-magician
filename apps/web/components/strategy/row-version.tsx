'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

type RowVersionState = [number, (next: number) => void];

const RowVersionContext = createContext<RowVersionState | null>(null);

/**
 * The strategy page's one row version (N190): the header's inline rename and
 * the builder both save the same strategy row, so a rename must hand the new
 * row version to the builder, or its next save would see a conflict.
 */
export function RowVersionProvider({
  initial,
  children,
}: {
  initial: number;
  children: ReactNode;
}) {
  const state = useState(initial);
  return <RowVersionContext.Provider value={state}>{children}</RowVersionContext.Provider>;
}

/** The shared row version inside a RowVersionProvider, else a local one. */
export function useRowVersion(initial: number): RowVersionState {
  const shared = useContext(RowVersionContext);
  const local = useState(initial);
  return shared ?? local;
}
