'use client';

import type { SlotMode } from '@tm/domain';
import { createContext, useContext } from 'react';

export interface InstrumentOption {
  id: string;
  symbol: string;
  displayName: string;
  assetClass: string;
  venue: string;
  /** `indicator_only` for an index: conditions may read it, legs can't trade it (v1.2 item 5). */
  kind?: 'tradable' | 'indicator_only' | undefined;
}

/** An underlying in the options recording, with the as-of date of its latest signal. */
export interface OptionUnderlying {
  id: string;
  symbol: string;
  latestAsOf: string | null;
}

/** A model series the `ml.score` picker offers (ML brief v1 §8). */
export interface MlModelOption {
  modelKey: string;
  name: string;
  /** The latest active run's training end, or null before the first run. */
  latestTrainingEnd: string | null;
  /** The latest prediction date, or null. */
  latestPrediction: string | null;
}

export interface AccountOption {
  id: string;
  nickname: string;
  mode: 'paper' | 'live';
  /** The account new legs start on: a broker's paper account when there is one. */
  isDefault: boolean;
}

export interface EditorContextValue {
  instruments: readonly InstrumentOption[];
  /**
   * The instrument new conditions, values and legs start on (N273): the
   * stock or ETF in What to trade when it names one. Absent for a group or
   * before an asset is chosen; pickers then start on the first instrument.
   */
  defaultInstrumentId?: string | undefined;
  /**
   * Adds an instrument a picker just looked up (N190), so every picker offers
   * it. Absent where the editor can't look symbols up.
   */
  addInstrument?: ((instrument: InstrumentOption) => void) | undefined;
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
  /** Underlyings in the options recording (options brief v2 §6); none outside the editor page. */
  optionUnderlyings?: readonly OptionUnderlying[];
  /** Registered model series for `ml.score` (ML brief v1 §8); none outside the editor page. */
  mlModels?: readonly MlModelOption[];
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditor must be used inside the strategy editor');
  return ctx;
}

/** The instrument a new condition, value or leg starts on (N273). */
export const defaultInstrumentOf = (ctx: EditorContextValue): string =>
  ctx.defaultInstrumentId ?? ctx.instruments[0]?.id ?? '';

export const pathKey = (path: readonly (string | number)[]) => path.join('.');
