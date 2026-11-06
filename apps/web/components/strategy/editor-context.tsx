'use client';

import type { SlotMode } from '@tm/domain';
import { createContext, useContext } from 'react';

export interface InstrumentOption {
  id: string;
  symbol: string;
  displayName: string;
  assetClass: string;
  venue: string;
}

export interface AccountOption {
  id: string;
  nickname: string;
  mode: 'paper' | 'live';
  isDefault: boolean;
}

export interface EditorContextValue {
  instruments: readonly InstrumentOption[];
  accounts: readonly AccountOption[];
  /** The user's display zone, the default for exact order times. */
  timeZone: string;
  baseCurrency: string;
  /** First problem reported at exactly this path in the definition, if any. */
  issueAt: (path: readonly (string | number)[]) => string | undefined;
  /** False when the strategy can't be edited, e.g. while actively executing. */
  editable: boolean;
  /**
   * Selection group or per-leg conditions (v1.2): instrument pickers then offer
   * "This instrument", the member or leg being evaluated.
   */
  slotMode: SlotMode;
  /** Asset classes of the instruments a Selection group can hold, for the metric picker. */
  universeClasses: readonly string[];
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditor must be used inside the strategy editor');
  return ctx;
}

export const pathKey = (path: readonly (string | number)[]) => path.join('.');
