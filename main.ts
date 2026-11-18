// Trend-surf bot for the cbBTC 24h bars race (agent-fun/bars-replay/v1).
//
// Design: the dev window punishes busy bots — a round trip costs roughly
// 30 bps in fees, slippage and price impact, and one-minute noise is only
// ~7 bps, so this bot trades rarely and slowly. It stays in cash unless a
// slow regime filter says the market is in an uptrend (fast EMA above the
// slow EMA, price above the slow EMA) and the trailing two hours of bars
// have actually risen by more than the round trip costs. While holding, exits
// are wide on purpose: a hard stop well under cost, a trailing stop under
// the peak close once the trade is in profit, and a slow regime break.
// Micro exits on one-minute momentum were tried and chopped the account to
// pieces on the dev window, so they are gone. After any exit the bot waits
// out a cooldown before re-entering, so a range cannot bleed it through
// repeated round trips.
//
// Everything is a deterministic function of the bars seen so far: float64
// EMA arithmetic on closes, integer comparisons for the money ratios, no
// clock, no randomness, no files, no network.

import { BPS, runBars, type Bar, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** EMA spans in bars: fast trend line and slow regime line. */
const FAST_BARS = 30;
const SLOW_BARS = 120;
/** Momentum lookback in bars and the least gain over it that confirms an entry. */
const MOM_BARS = 120;
const MOM_MIN = 0.0035;
/** Share of equity one entry stakes, in bps (95%). */
const SIZE_BPS = 9500n;
/** Hard stop: sell when the position is worth 98.8% of its cost or less. */
const STOP_NUM = 9880n;
/** Take profit: sell when the position is worth 102.5% of its cost or more. */
const TP_NUM = 10250n;
/** The trailing stop arms once the peak close is 0.3% over the entry close... */
const TRAIL_ARM = 1.003;
/** ...and then sells when a close falls this far under that peak close. */
const TRAIL_DROP = 0.007;
/** Bars to sit out after an exit fill before a new entry is allowed. */
const COOLDOWN_BARS = 30;
/** No fresh entries once this many bars of the window have been seen. */
const LAST_ENTRY_BAR = 1405;
/** Slippage cap on every order, past the close the order was decided on. */
const MAX_SLIPPAGE_BPS = 60;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function newEma(span: number): Ema {
  return { span, warm: [], value: null };
}

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  }
}

const fast = newEma(FAST_BARS);
const slow = newEma(SLOW_BARS);
/** Every close seen, oldest first; only the momentum lookback is ever read back. */
const closes: number[] = [];
let barsSeen = 0;
/** Bars since the last exit fill; starts ready so the first entry is not blocked. */
let sinceExit = COOLDOWN_BARS;
/** Whether the previous batch held the position (to spot the exit fill). */
let wasHeld = false;
/** Highest close since the current position was first seen, and that first close. */
let peakClose = 0;
let entryClose = 0;

/** Trailing momentum over MOM_BARS bars, or null while history is too short. */
function momentum(): number | null {
  if (closes.length <= MOM_BARS) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - MOM_BARS];
  return now / then - 1;
}

await runBars({
  onBatch(state, batch) {
    const orders: (BuyInput | SellInput)[] = [];
    let fresh: Bar | null = null;
    for (const bar of batch.bars) {
      fresh = bar;
      const c = Number(bar.c);
      closes.push(c);
      stepEma(fast, c);
      stepEma(slow, c);
      barsSeen++;
      if (wasHeld) {
        if (c > peakClose) peakClose = c;
      }
    }
    if (state.warmingUp || fresh === null) return orders;

    const symbol = fresh.symbol;
    const held = state.positions.get(symbol);
    const mom = momentum();
    const closeNow = Number(fresh.c);

    if (held !== undefined) {
      // First batch that shows the position: anchor the trailing stop here.
      if (!wasHeld) {
        entryClose = closeNow;
        peakClose = entryClose;
      }
      wasHeld = true;
      const value = state.value(symbol, held.qty);
      const cost = held.cost;
      let exit = false;
      // Hard stop under cost (integer-exact comparison on quote units).
      if (value * 10000n <= cost * STOP_NUM) exit = true;
      // Take profit over cost.
      if (value * 10000n >= cost * TP_NUM) exit = true;
      // Trailing stop: armed in profit, fires on a close under the peak.
      if (!exit && entryClose > 0 && peakClose >= entryClose * TRAIL_ARM) {
        if (closeNow <= peakClose * (1 - TRAIL_DROP)) exit = true;
      }
      // Slow regime break: the fast line fell back under the slow line.
      if (!exit && fast.value !== null && slow.value !== null && fast.value < slow.value) exit = true;
      if (exit) {
        orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      return orders;
    }

    // Flat: notice the exit fill (the position vanished) and start cooldown.
    if (wasHeld) {
      wasHeld = false;
      sinceExit = 0;
      entryClose = 0;
      peakClose = 0;
    } else if (sinceExit < COOLDOWN_BARS) {
      sinceExit++;
    }

    // Entry: a slow, confirmed uptrend only — regime lines in order, the
    // price itself above the slow line, and two hours of real upward travel.
    const ready =
      fast.value !== null &&
      slow.value !== null &&
      fast.value > slow.value &&
      closeNow > slow.value &&
      mom !== null &&
      mom >= MOM_MIN &&
      sinceExit >= COOLDOWN_BARS &&
      barsSeen <= LAST_ENTRY_BAR;
    if (ready) {
      const { caps, fees } = state.hello;
      let slice = (state.equity * SIZE_BPS) / BPS;
      if (state.cash < slice) slice = state.cash;
      if (slice >= BigInt(fees.min_notional_quote_units) && caps.max_orders_per_bar > 0) {
        orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
    return orders;
  },
});
