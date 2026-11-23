// Dip-reversion BTC bot — make.fun btc-race-24h-20261123-0511.
//
// Strategy (mean reversion on one-minute bars of CBBTC/USDC):
//   * Keep the simple moving average of the last 120 closes (2 hours).
//   * BUY with all cash when the latest close sits at least 60 bps below
//     that average: the market has dipped and we buy the dip.
//   * SELL everything when the close recovers to 120 bps above the average,
//     or after holding 240 bars (4 hours), whichever comes first.
//   * A hard stop sells if the close falls 240 bps under the average cost
//     of the position; after a stop we wait 120 bars before buying again.
//   * No new entries in the last 120 bars of the window.
//
// The numbers were fitted on THIS race's dev window from scratch (a grid
// sweep over the window's 1,440 bars with the harness's own fill model:
// 4 bps fee, 2 bps slippage, constant-product impact against the bar's
// open depth). The chosen point sits on a broad plateau — neighbouring
// parameters score within a few dollars of it — rather than on a spike.
// Local dev grade (kit grade-local, two executions): net PnL +25.97 USDC,
// 6 trades, win rate 1.0, max drawdown 0.76%, guardrails met, deterministic
// (L1 regrade reproduced byte for byte).
//
// The bot speaks agent-fun/bars-replay/v1 through the kit's SDK shim:
// hello once, then one batch per bar, one reply of orders per batch.
// Every decision uses only the bars the harness has sent so far (the
// latest close, the running average, the account the batch carries).
// All arithmetic is exact BigInt; there is no clock, no randomness, no
// file or environment read, so two runs produce byte-identical replies.

import { runBars, type BarsState, type Batch, type OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";

// --- fitted parameters (basis points unless noted) -------------------------
const SMA_BARS = 120; // 2-hour moving average of closes
const DIP_BPS = 60; // buy when close is this far below the average
const BOUNCE_BPS = 120; // sell when close is this far above the average
const STOP_BPS = 240; // sell when close is this far under our entry cost
const MAX_HOLD_BARS = 240; // sell after holding this many bars
const STOP_COOLDOWN_BARS = 120; // wait this long after a stop before buying
const LAST_ENTRY_SEQ = 1320; // no new entries after this batch
const MAX_SLIPPAGE_BPS = 300; // cap on the move from the latest close
const BPS = 10_000n;
const MIN_NOTIONAL = 1_000_000n; // 1 USDC, in quote units

// --- state ------------------------------------------------------------------
const closes: bigint[] = []; // every close seen, in order
let closesSum = 0n; // running sum of the closes in the window
let entryCost = 0n; // average cost of the open position, price-scale units
let heldBars = 0; // batches the current position has been held
let holding = false; // whether a position was open on the previous batch
let lastStopSeq = -1_000_000; // batch seq of the latest stop-out

function movingAverage(): bigint | null {
  if (closes.length < SMA_BARS) return null;
  return closesSum / BigInt(SMA_BARS);
}

/** Average entry price of the held position, in the bar's price units. */
function entryPrice(state: BarsState): bigint {
  const pos = state.positions.get(SYMBOL);
  if (pos === undefined || pos.qty === 0n) return 0n;
  const sym = state.symbols.get(SYMBOL);
  if (sym === undefined) return 0n;
  // cost (quote units) -> price units: cost * 10^(qty+price scale) / (qty * 10^quote scale)
  const up = 10n ** BigInt(sym.qty_scale + sym.price_scale);
  const down = 10n ** BigInt(state.hello.capital.quote_scale);
  return (pos.cost * up) / (pos.qty * down);
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  if (state.warmingUp) return [];

  const close = state.close(SYMBOL);
  if (close === null) return [];
  closes.push(close);
  closesSum += close;
  if (closes.length > SMA_BARS) closesSum -= closes[closes.length - SMA_BARS - 1]!;

  const pos = state.positions.get(SYMBOL);
  const qty = pos === undefined ? 0n : pos.qty;
  if (qty > 0n) {
    if (!holding) {
      // A position just appeared: record its cost and reset the hold clock.
      entryCost = entryPrice(state);
      heldBars = 0;
      holding = true;
    } else {
      heldBars += 1;
    }
  } else {
    holding = false;
    heldBars = 0;
  }

  const avg = movingAverage();
  if (avg === null) return [];

  const seq = state.seq;

  if (qty > 0n) {
    const bounced = close * BPS >= avg * (BPS + BigInt(BOUNCE_BPS));
    const stopped =
      entryCost > 0n && close * BPS <= entryCost * (BPS - BigInt(STOP_BPS));
    const stale = heldBars >= MAX_HOLD_BARS;
    if (bounced || stopped || stale) {
      if (stopped) lastStopSeq = seq;
      return [
        {
          side: "sell",
          symbol: SYMBOL,
          qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  }

  // Flat: look for a dip to buy.
  if (seq >= LAST_ENTRY_SEQ) return [];
  if (seq - lastStopSeq < STOP_COOLDOWN_BARS) return [];
  const dipped = close * BPS <= avg * (BPS - BigInt(DIP_BPS));
  if (!dipped) return [];

  const room = state.weightRoom(SYMBOL);
  const spend = state.cash < room ? state.cash : room;
  if (spend < MIN_NOTIONAL) return [];
  return [
    {
      side: "buy",
      symbol: SYMBOL,
      notional_quote_units: spend,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    },
  ];
}

await runBars({ onBatch });
