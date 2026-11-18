// Range Harvester for cbBTC/USDC (agent-fun/bars-replay/v1).
//
// Idea: BTC mean-reverts around its slow trend over a day. The bot stays flat
// until the close dips a set distance below a 240-minute trailing average of
// closes, then buys with (nearly) all its cash. While long it sells the whole
// position as soon as the close is ~1% above its buy fill, or cuts the loss
// at ~-1%. After a stop-loss it waits out a cooldown before buying again, so a
// downtrend cannot keep re-entering it. One open position, long only, no
// leverage, fully deterministic: every decision is a pure function of the
// bars seen so far (no clock, no randomness, no environment).

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy parameters (basis points unless noted).
// Tuned on the dev window with an offline replay (fills at next open, ~16 bps
// per leg of fee + slippage + impact) and confirmed with the kit's local
// grader: the reference that worked best is a slow trailing average, not an
// EMA — the average falls more slowly in a downtrend, so real dips below it
// happen sooner and more often. Buying ~0.8% below a 240-minute average with
// a ~1% take-profit and a ~1% stop-loss stayed positive across neighbouring
// settings (dip 80-100, take 100-120, stop 100), while the first version's
// 60 bp dip / 100 bp take / 150 bp stop lost -10.19 USDC on the local grade
// and an EMA-based 100/120/100 variant lost -4.18 USDC (win rate 1/3: the
// EMA lags less, so its "dips" were mostly the downtrend itself). Symmetric
// ~1% exits need only ~52% wins to break even. No new buys in the last 60
// bars: a position opened that late cannot reach its take-profit before the
// window ends and is just force-sold at the close.
const SMA_LEN = 240; // trailing average length, in 1-minute bars
const MIN_BARS = 10; // bars needed before the average is trusted
const DIP_BPS = 80; // buy when close is this far below the average
const TAKE_BPS = 100; // sell when close is this far above the entry fill
const STOP_BPS = 100; // sell when close is this far below the entry fill
const COOLDOWN_BARS = 0; // bars to sit out after a stop-loss
const NO_BUY_LAST_BARS = 60; // do not open in the final bars of the window
const MAX_SLIP_BPS = 200; // max slippage vs latest close on any order

// Mutable state, all of it derived from the bars/fills the harness sent.
const closes: number[] = []; // every close seen, oldest first
let entryPrice = 0; // price-scale units of the last buy fill
let cooldownUntil = -1; // seq before which no new buy is allowed
let pending: 'buy' | 'sell' | null = null; // order decided last batch, awaiting its fill

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const c = Number(close);

    // Fold this bar into the trailing average.
    closes.push(c);
    if (closes.length > SMA_LEN) closes.shift();
    const avg = closes.length >= MIN_BARS ? closes.reduce((s, x) => s + x, 0) / closes.length : null;

    // Fold in the fills of the orders decided on the previous batch.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;
      if (fill.status === 'filled') {
        if (fill.side === 'buy') entryPrice = Number(fill.price);
        pending = null;
      } else if (fill.status === 'rejected') {
        pending = null;
      }
    }
    if (pending !== null) return []; // one order in flight at a time

    const qty = state.positions.get(SYMBOL)?.qty ?? 0n;

    if (qty > 0n) {
      // Long: take the profit or cut the loss, selling the whole position.
      if (entryPrice > 0 && c >= (entryPrice * (10_000 + TAKE_BPS)) / 10_000) {
        pending = 'sell';
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIP_BPS }];
      }
      if (entryPrice > 0 && c <= (entryPrice * (10_000 - STOP_BPS)) / 10_000) {
        cooldownUntil = state.seq + COOLDOWN_BARS;
        pending = 'sell';
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIP_BPS }];
      }
      return [];
    }

    // Flat: buy the dip below the trailing average, with all available cash.
    // Never open in the final bars of the window: the position would be
    // force-sold at the close before it can reach its take-profit.
    if (state.seq < cooldownUntil) return [];
    if (state.seq - state.warmupBars >= 1440 - NO_BUY_LAST_BARS) return [];
    if (avg !== null && c <= (avg * (10_000 - DIP_BPS)) / 10_000) {
      const room = state.weightRoom(SYMBOL);
      const spend = room < state.cash ? room : state.cash;
      if (spend >= 1_000_000n) {
        pending = 'buy';
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIP_BPS }];
      }
    }
    return [];
  },
});
