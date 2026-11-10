import type {
  BacktestFill,
  BacktestOrder,
  ConditionBar,
  CycleDetail,
  PhaseConditionReport,
  SelectionRound,
  SelectionRow,
} from '@tm/backtest';
import type { BacktestRunDto, BacktestTradeDto } from '@tm/contracts';
import { comparisonsOf } from '@/lib/backtest-explain';
import { tradeDirection, type TradeDirection } from '@/lib/backtest-text';

/**
 * Back test results by cycle (N157–N166, ADR 0061): everything one cycle did,
 * gathered from the run's condition reports, orders, fills and trade rows, so
 * the cycle card reads without the rest of the page. Older runs that predate
 * the cycle records (N166) fall back to matching by time and to the fills.
 */

type Result = NonNullable<BacktestRunDto['result']>;

export type CycleStatus = 'closed' | 'open' | 'aborted' | 'pending';

export const CYCLE_STATUS: Record<CycleStatus, { label: string; tone: 'ok' | 'info' | 'warn' }> = {
  closed: { label: 'Closed', tone: 'ok' },
  open: { label: 'Open at end of test', tone: 'info' },
  aborted: { label: 'Entry not filled', tone: 'warn' },
  pending: { label: 'Entry pending at end of test', tone: 'info' },
};

/** One instrument of a cycle: its Entry legs against its Exit legs. */
export interface LegRow {
  instrumentId: string;
  symbol: string;
  entryLabels: string[];
  exitLabels: string[];
  /** Signed: negative for a short. */
  quantity: string | null;
  entryPrice: string | null;
  exitPrice: string | null;
  grossPnl: string | null;
  costs: string | null;
  netPnl: string | null;
}

export interface CycleView {
  cycle: number;
  status: CycleStatus;
  trade: BacktestTradeDto | null;
  symbols: string[];
  direction: TradeDirection;
  entryOrders: BacktestOrder[];
  /** Exit legs, then any flatten after a failed leg. */
  exitOrders: BacktestOrder[];
  entry: {
    report: PhaseConditionReport | null;
    /** The bar that fired the Entry, or null when none was recorded. */
    bar: ConditionBar | null;
    /** When the Entry was decided (a bar close). */
    decidedAt: string | null;
  };
  exit: {
    report: PhaseConditionReport | null;
    /** Every Exit check while this cycle was open, oldest first. */
    bars: ConditionBar[];
    /** The bar the Exit condition fired on, if it did. */
    bar: ConditionBar | null;
    decidedAt: string | null;
  };
  /** Selection strategies: the round that picked this cycle, and its rows. */
  round: { round: SelectionRound; rows: SelectionRow[] } | null;
  legs: LegRow[];
  detail: CycleDetail | null;
  /** Calendar days from the Entry fill to the Exit fill; null while open. */
  heldDays: number | null;
  exitReason: BacktestTradeDto['exitReason'] | null;
  /** Net P/L as a number for filtering and sorting; null when none. */
  net: number | null;
}

const BUYS = new Set(['buy', 'buy_to_cover']);
const DAY_MS = 86_400_000;

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const fixed = (n: number, dp = 2) => (Number.isFinite(n) ? n.toFixed(dp) : null);

/** Weighted average price and total quantity of filled orders. */
function filled(orders: readonly BacktestOrder[]): { qty: number; price: number | null } {
  let qty = 0;
  let cost = 0;
  for (const o of orders) {
    const q = Number(o.filledQuantity);
    if (!(q > 0) || o.averagePrice === null) continue;
    qty += q;
    cost += q * Number(o.averagePrice);
  }
  return { qty, price: qty > 0 ? cost / qty : null };
}

/**
 * One instrument's P/L from its fills, for runs without per-cycle detail:
 * cash in less cash out less commission; gross adds back commission and
 * slippage. Borrow costs aren't in the fills, so shorts may be a little off.
 */
function pnlFromFills(fills: readonly BacktestFill[], long: boolean) {
  let net = 0;
  let commission = 0;
  let slippage = 0;
  for (const f of fills) {
    const out = BUYS.has(f.side) || ((f.side === 'close' || f.side === 'reduce') && !long);
    const value = Number(f.quantity) * Number(f.price);
    net += out ? -value : value;
    commission += Number(f.commission);
    slippage += Number(f.slippage);
  }
  net -= commission;
  return { gross: net + commission + slippage, costs: commission + slippage, net };
}

function legRows(
  cycle: number,
  status: CycleStatus,
  entryOrders: BacktestOrder[],
  exitOrders: BacktestOrder[],
  fills: readonly BacktestFill[],
  detail: CycleDetail | null,
): LegRow[] {
  const ids = [...new Set([...entryOrders, ...exitOrders].map((o) => o.instrumentId))];
  return ids.map((id) => {
    const ins = entryOrders.filter((o) => o.instrumentId === id);
    const outs = exitOrders.filter((o) => o.instrumentId === id);
    const symbol = ins[0]?.symbol ?? outs[0]?.symbol ?? '?';
    const e = filled(ins);
    const x = filled(outs);
    const short = ins.some((o) => o.side === 'sell_short');
    const recorded = detail?.instruments.find((i) => i.instrumentId === id);
    let gross: string | null = recorded?.grossPnl ?? null;
    let costs: string | null = recorded?.costs ?? null;
    let net: string | null = recorded?.netPnl ?? null;
    if (!recorded && status === 'closed') {
      const p = pnlFromFills(
        fills.filter((f) => f.cycle === cycle && f.instrumentId === id),
        !short,
      );
      gross = fixed(p.gross);
      costs = fixed(p.costs);
      net = fixed(p.net);
    }
    return {
      instrumentId: id,
      symbol,
      entryLabels: ins.map((o) => o.legLabel),
      exitLabels: outs.map((o) =>
        o.phase === 'flatten' ? 'Close after a failed leg' : o.legLabel,
      ),
      quantity: e.qty > 0 ? String(short ? -e.qty : e.qty) : null,
      entryPrice: e.price === null ? null : fixed(e.price, 2),
      exitPrice: x.price === null ? null : fixed(x.price, 2),
      grossPnl: gross,
      costs,
      netPnl: net,
    };
  });
}

/** The Entry and Exit reports that hold a cycle's legs (entry groups, v1.2 item 8). */
function reportsFor(result: Result, legIds: readonly string[]) {
  const group = result.groupConditions?.find((g) => legIds.some((id) => g.legIds.includes(id)));
  if (group) return { entry: group.entry, exit: group.exit };
  return { entry: result.conditions?.entry ?? null, exit: result.conditions?.exit ?? null };
}

/** Every cycle of a run, cycle 1 first, including those whose Entry never filled. */
export function buildCycles(result: Result, trades: readonly BacktestTradeDto[]): CycleView[] {
  const orders = result.orders ?? [];
  const byCycle = new Map<number, BacktestOrder[]>();
  for (const o of orders) {
    const list = byCycle.get(o.cycle) ?? [];
    list.push(o);
    byCycle.set(o.cycle, list);
  }
  const tradeOf = new Map(trades.map((t) => [t.cycle, t]));
  const detailOf = new Map((result.cycles ?? []).map((d) => [d.cycle, d]));
  const numbers = [...new Set([...byCycle.keys(), ...tradeOf.keys()])].sort((a, b) => a - b);

  return numbers.map((n) => {
    const own = byCycle.get(n) ?? [];
    const trade = tradeOf.get(n) ?? null;
    const entryOrders = own.filter((o) => o.phase === 'entry');
    const exitOrders = own.filter((o) => o.phase !== 'entry');
    const status: CycleStatus = trade ? trade.status : 'pending';
    const reports = reportsFor(
      result,
      own.map((o) => o.legId),
    );
    const entryDecided = entryOrders.find((o) => o.decidedAt)?.decidedAt ?? null;
    const entryBar =
      reports.entry?.bars.find((b) => b.cycle === n) ??
      (entryDecided
        ? (reports.entry?.bars.find(
            (b) => b.time === entryDecided && b.cycle === undefined && b.outcome === 'fired',
          ) ?? null)
        : null);
    const exitBars = reports.exit?.bars.filter((b) => b.cycle === n) ?? [];
    const exitDecided =
      exitOrders.find((o) => o.phase === 'exit' && o.decidedAt)?.decidedAt ?? null;
    const symbols = [...new Set(own.map((o) => o.symbol))];
    const round = (() => {
      const rounds = result.selections?.rounds;
      if (!rounds || !entryDecided) return null;
      const r = rounds.find((x) => x.time === entryDecided);
      if (!r) return null;
      return { round: r, rows: r.rows.filter((row) => symbols.includes(row[0])) };
    })();
    const detail = detailOf.get(n) ?? null;
    const heldDays =
      trade?.status === 'closed' && trade.entryTime && trade.exitTime
        ? Math.round((Date.parse(trade.exitTime) - Date.parse(trade.entryTime)) / DAY_MS)
        : null;
    const legs = legRows(n, status, entryOrders, exitOrders, result.fills, detail);
    return {
      cycle: n,
      status,
      trade,
      symbols,
      direction: trade
        ? tradeDirection(trade)
        : entryOrders.some((o) => o.side === 'sell_short')
          ? 'short'
          : 'long',
      entryOrders,
      exitOrders,
      entry: { report: reports.entry, bar: entryBar, decidedAt: entryDecided },
      exit: {
        report: reports.exit,
        bars: exitBars,
        bar: [...exitBars].reverse().find((b) => b.outcome === 'fired') ?? null,
        decidedAt: exitDecided,
      },
      round,
      legs,
      detail,
      heldDays,
      exitReason: trade?.exitReason ?? (trade?.status === 'closed' ? 'condition' : null),
      net: trade && trade.status !== 'aborted' ? Number(trade.netPnl) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Filters and sorting (N161)

export type CycleFilter = 'all' | 'won' | 'lost' | 'unfinished';
export type CycleSort = 'cycle' | 'net' | 'return' | 'held';

export function matchesFilter(c: CycleView, f: CycleFilter): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'won':
      return c.status === 'closed' && (c.net ?? 0) > 0;
    case 'lost':
      return c.status === 'closed' && (c.net ?? 0) <= 0;
    case 'unfinished':
      return c.status !== 'closed';
  }
}

export function matchesSearch(c: CycleView, text: string): boolean {
  const q = text.trim().toUpperCase();
  return q === '' || c.symbols.some((s) => s.toUpperCase().includes(q));
}

/** Net P/L and return sort the biggest loss first; days held, the longest first. */
export function sortCycles(list: readonly CycleView[], by: CycleSort): CycleView[] {
  const out = [...list];
  const last = (v: number | null, dir: 1 | -1) => (v === null ? Infinity : v * dir);
  if (by === 'net') out.sort((a, b) => last(a.net, 1) - last(b.net, 1) || a.cycle - b.cycle);
  if (by === 'return') {
    const r = (c: CycleView) =>
      c.trade?.returnPct && c.status !== 'aborted' ? Number(c.trade.returnPct) : null;
    out.sort((a, b) => last(r(a), 1) - last(r(b), 1) || a.cycle - b.cycle);
  }
  if (by === 'held')
    out.sort((a, b) => last(a.heldDays, -1) - last(b.heldDays, -1) || a.cycle - b.cycle);
  return out;
}

export function cycleCounts(list: readonly CycleView[]) {
  const closed = list.filter((c) => c.status === 'closed');
  return {
    all: list.length,
    closed: closed.length,
    won: closed.filter((c) => (c.net ?? 0) > 0).length,
    lost: closed.filter((c) => (c.net ?? 0) <= 0).length,
    unfinished: list.length - closed.length,
    net: sum(list.map((c) => c.net ?? 0)),
  };
}

/** Entry firings that didn't open a cycle, counted by why (N163). */
export function skippedSignals(result: Result): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {};
  const reports = [result.conditions?.entry, ...(result.groupConditions ?? []).map((g) => g.entry)];
  for (const r of reports) {
    for (const b of r?.bars ?? []) {
      if (b.outcome === 'cycle_open' || b.outcome === 'daily_loss' || b.outcome === 'drawdown')
        out[b.outcome] = (out[b.outcome] ?? 0) + 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSV (N165): one row per instrument per cycle

function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function cyclesCsv(cycles: readonly CycleView[]): string {
  const header = [
    'cycle',
    'status',
    'instrument',
    'entry_legs',
    'quantity',
    'entry_decided',
    'entry_filled',
    'entry_price',
    'exit_legs',
    'exit_decided',
    'exit_filled',
    'exit_price',
    'exit_reason',
    'gross_pnl',
    'costs',
    'net_pnl',
  ];
  const lines = [header.join(',')];
  for (const c of cycles) {
    for (const l of c.legs) {
      const ended = (os: BacktestOrder[]) =>
        os.find((o) => o.instrumentId === l.instrumentId && o.outcome === 'filled')?.endedAt ??
        null;
      lines.push(
        [
          c.cycle,
          c.status,
          l.symbol,
          l.entryLabels.join(' + '),
          l.quantity,
          c.entry.decidedAt,
          ended(c.entryOrders),
          l.entryPrice,
          l.exitLabels.join(' + '),
          c.exit.decidedAt,
          ended(c.exitOrders),
          l.exitPrice,
          c.exitReason,
          l.grossPnl,
          l.costs,
          l.netPnl,
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Key data for each side of a cycle (N169): how the conditions, the timing and
// the execution played out up to and after the signal.

export interface ConditionKeyData {
  /** What the window covers, e.g. since the previous Entry signal. */
  since: string | null;
  checked: number;
  trueBars: number;
  unknownBars: number;
  firstTrue: string | null;
  /** The bar that fired, when one did. */
  firedAt: string | null;
  /** The checks in the window, oldest first, ending with the signal bar. */
  bars: ConditionBar[];
}

export interface ExecutionKeyData {
  label: string;
  symbol: string;
  side: BacktestOrder['side'];
  outcome: BacktestOrder['outcome'];
  /** The last close when it was sent, the price a fill is compared with. */
  reference: string | null;
  fillPrice: string | null;
  /** Fill against the reference, in %, signed so that positive is a worse price. */
  costPct: string | null;
  filled: string;
  quantity: string | null;
  barsWorking: number;
  bestPrice: string | null;
  commission: string;
  slippage: string;
}

export interface PhaseKeyData {
  conditions: ConditionKeyData | null;
  timing: {
    /** When the signal happened (bar close), the orders could first fill, and the last fill. */
    signalAt: string | null;
    activeFrom: string | null;
    filledAt: string | null;
    /** Calendar days from the signal to the last fill. */
    daysToFill: number | null;
    /** Most bars any leg worked before it ended. */
    barsWorking: number;
  };
  execution: ExecutionKeyData[];
}

function earliest(xs: (string | null)[]): string | null {
  const v = xs.filter((x): x is string => x !== null).sort();
  return v[0] ?? null;
}

function latest(xs: (string | null)[]): string | null {
  const v = xs.filter((x): x is string => x !== null).sort();
  return v.at(-1) ?? null;
}

function executionOf(
  orders: readonly BacktestOrder[],
  fills: readonly BacktestFill[],
  entryOrders: readonly BacktestOrder[],
): ExecutionKeyData[] {
  /** Close and reduce buy back a short and sell a long, by the instrument's Entry side. */
  const buys = (o: BacktestOrder) =>
    BUYS.has(o.side) ||
    ((o.side === 'close' || o.side === 'reduce') &&
      entryOrders.some((e) => e.instrumentId === o.instrumentId && e.side === 'sell_short'));
  return orders.map((o) => {
    const own = fills.filter(
      (f) => f.cycle === o.cycle && f.legId === o.legId && f.phase === o.phase,
    );
    const ref = o.referencePrice === null ? null : Number(o.referencePrice);
    const px = o.averagePrice === null ? null : Number(o.averagePrice);
    const buying = buys(o);
    const cost =
      ref && px !== null && ref > 0 ? ((buying ? px - ref : ref - px) / ref) * 100 : null;
    return {
      label: o.phase === 'flatten' ? 'Close after a failed leg' : o.legLabel,
      symbol: o.symbol,
      side: o.side,
      outcome: o.outcome,
      reference: o.referencePrice,
      fillPrice: o.averagePrice,
      costPct: cost === null ? null : cost.toFixed(2),
      filled: o.filledQuantity,
      quantity: o.quantity,
      barsWorking: o.barsWorking,
      bestPrice: o.bestPrice,
      commission: fixed(sum(own.map((f) => Number(f.commission)))) ?? '0.00',
      slippage: fixed(sum(own.map((f) => Number(f.slippage)))) ?? '0.00',
    };
  });
}

function timingOf(signalAt: string | null, orders: readonly BacktestOrder[]) {
  const filledAt = latest(orders.filter((o) => Number(o.filledQuantity) > 0).map((o) => o.endedAt));
  const start = signalAt ?? earliest(orders.map((o) => o.decidedAt));
  return {
    signalAt: start,
    activeFrom: earliest(orders.map((o) => o.activeFrom)),
    filledAt,
    daysToFill:
      start && filledAt ? Math.round((Date.parse(filledAt) - Date.parse(start)) / DAY_MS) : null,
    barsWorking: Math.max(0, ...orders.map((o) => o.barsWorking)),
  };
}

function summarize(bars: ConditionBar[], since: string | null, firedAt: string | null) {
  return {
    since,
    checked: bars.length,
    trueBars: bars.filter((b) => b.truth === true).length,
    unknownBars: bars.filter((b) => b.truth === null).length,
    firstTrue: bars.find((b) => b.truth === true)?.time ?? null,
    firedAt,
    bars,
  };
}

/**
 * The Entry side: the Entry checks since the previous Entry signal (or the
 * start of the test) up to this cycle's signal bar, the timing from signal
 * to fill, and each Entry order's fill against the last close.
 */
export function entryKeyData(
  c: CycleView,
  fills: readonly BacktestFill[],
  /**
   * Enter when read "this stock" (ADR 0073): the bar log can't say how it read
   * for this pick, so the conditions window is left out; the card shows the pick's own.
   */
  perCandidate = false,
): PhaseKeyData {
  const report = c.entry.report;
  const signal = c.entry.bar;
  let conditions: ConditionKeyData | null = null;
  if (report && signal && !perCandidate && comparisonsOf(report.condition).length > 0) {
    const all = report.bars;
    const end = all.indexOf(signal);
    let start = 0;
    for (let i = end - 1; i >= 0; i--) {
      const o = all[i]?.outcome;
      if (o === 'fired' || o === 'cycle_open') {
        start = i + 1;
        break;
      }
    }
    const since = start > 0 ? (all[start - 1]?.time ?? null) : null;
    conditions = summarize(all.slice(start, end + 1), since, signal.time);
  }
  return {
    conditions,
    timing: timingOf(signal?.time ?? c.entry.decidedAt, c.entryOrders),
    execution: executionOf(c.entryOrders, fills, c.entryOrders),
  };
}

/** The Exit side: the Exit checks while the cycle was open, then timing and execution. */
export function exitKeyData(c: CycleView, fills: readonly BacktestFill[]): PhaseKeyData {
  const bars = c.exit.bars;
  const firedAt = c.exit.bar?.time ?? null;
  const upTo = firedAt ? bars.filter((b) => b.time <= firedAt) : bars;
  return {
    conditions:
      // An empty Exit when has nothing to report: the exit rules decide (N218).
      c.exit.report && bars.length > 0 && comparisonsOf(c.exit.report.condition).length > 0
        ? summarize(upTo, c.trade?.entryTime ?? null, firedAt)
        : null,
    timing: timingOf(c.exit.decidedAt, c.exitOrders),
    execution: executionOf(c.exitOrders, fills, c.entryOrders),
  };
}
