'use client';

import { createContext, useContext } from 'react';

export interface InstrumentOption {
  id: string;
  symbol: string;
  displayName: string;
  assetClass: string;
}

export interface EditorContextValue {
  instruments: readonly InstrumentOption[];
  /** First problem reported at exactly this path in the definition, if any. */
  issueAt: (path: readonly (string | number)[]) => string | undefined;
  /** False when the strategy can't be edited, e.g. while actively executing. */
  editable: boolean;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditor must be used inside the strategy editor');
  return ctx;
}

export const pathKey = (path: readonly (string | number)[]) => path.join('.');
