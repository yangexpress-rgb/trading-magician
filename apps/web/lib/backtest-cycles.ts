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
