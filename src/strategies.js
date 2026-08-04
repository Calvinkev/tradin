/**
 * Trading strategy signals evaluated against live chart data.
 * Each strategy exposes:
 *   - name        : human-readable label
 *   - description : what it measures
 *   - check(data) : returns { signal, reason, confidence, levels? }
 *
 * `data` shape (supplied by TradingAIAgent.buildStrategyData):
 *   {
 *     price, open, high, low, close, volume,
 *     rsi, macd, macdSignal, macdHistogram,
 *     sma20, sma50, sma200, ema9, ema21,
 *     bbUpper, bbMiddle, bbLower, bbWidth,
 *     atr, vwap, stochK, stochD,
 *     pineLines, pineLabels           // raw arrays from MCP
 *   }
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Normalise RSI extreme into a 0-1 confidence score. */
function rsiConfidence(rsi) {
  if (rsi <= 20 || rsi >= 80) return 1.0;
  if (rsi <= 30 || rsi >= 70) return 0.8;
  if (rsi <= 40 || rsi >= 60) return 0.4;
  return 0.0;
}

// ─── Strategy definitions ─────────────────────────────────────────────────────

export const TradingStrategies = {

  // ── 1. RSI Mean Reversion ──────────────────────────────────────────────────
  rsiMeanReversion: {
    name: 'RSI Mean Reversion',
    description: 'Buy oversold (RSI < 30), sell overbought (RSI > 70).',
    check(data) {
      const rsi = data.rsi ?? 50;
      if (rsi < 20) return { signal: 'STRONG_BUY',  reason: `Extremely oversold  (RSI ${rsi.toFixed(1)})`,  confidence: 1.0 };
      if (rsi < 30) return { signal: 'BUY',          reason: `Oversold             (RSI ${rsi.toFixed(1)})`,  confidence: 0.8 };
      if (rsi > 80) return { signal: 'STRONG_SELL',  reason: `Extremely overbought (RSI ${rsi.toFixed(1)})`,  confidence: 1.0 };
      if (rsi > 70) return { signal: 'SELL',          reason: `Overbought           (RSI ${rsi.toFixed(1)})`,  confidence: 0.8 };
      return { signal: 'NEUTRAL', reason: `RSI neutral (${rsi.toFixed(1)})`, confidence: rsiConfidence(rsi) };
    }
  },

  // ── 2. MA Crossover (Golden / Death Cross) ─────────────────────────────────
  maCrossover: {
    name: 'MA Crossover',
    description: 'Golden cross (SMA50 > SMA200) = bullish; Death cross = bearish.',
    check(data) {
      const { sma50, sma200, price } = data;
      if (!sma50 || !sma200) return { signal: 'NEUTRAL', reason: 'MA data unavailable', confidence: 0 };

      if (sma50 > sma200 && price > sma50) {
        const margin = ((sma50 - sma200) / sma200 * 100).toFixed(2);
        return { signal: 'BUY', reason: `Golden cross — SMA50 ${margin}% above SMA200`, confidence: clamp(margin / 5, 0.3, 1.0) };
      }
      if (sma50 < sma200 && price < sma50) {
        const margin = ((sma200 - sma50) / sma200 * 100).toFixed(2);
        return { signal: 'SELL', reason: `Death cross — SMA50 ${margin}% below SMA200`, confidence: clamp(margin / 5, 0.3, 1.0) };
      }
      return { signal: 'NEUTRAL', reason: 'No definitive MA crossover', confidence: 0.2 };
    }
  },

  // ── 3. MACD Momentum ──────────────────────────────────────────────────────
  macdMomentum: {
    name: 'MACD Momentum',
    description: 'MACD line crosses signal line as momentum confirmation.',
    check(data) {
      const { macd, macdSignal, macdHistogram } = data;
      if (macd == null || macdSignal == null) return { signal: 'NEUTRAL', reason: 'MACD data unavailable', confidence: 0 };

      const hist = macdHistogram ?? (macd - macdSignal);
      if (macd > macdSignal && hist > 0) {
        return { signal: 'BUY',  reason: `MACD bullish crossover (histogram: ${hist.toFixed(4)})`, confidence: clamp(Math.abs(hist) * 10, 0.3, 1.0) };
      }
      if (macd < macdSignal && hist < 0) {
        return { signal: 'SELL', reason: `MACD bearish crossover (histogram: ${hist.toFixed(4)})`, confidence: clamp(Math.abs(hist) * 10, 0.3, 1.0) };
      }
      return { signal: 'NEUTRAL', reason: 'MACD convergence zone', confidence: 0.2 };
    }
  },

  // ── 4. Bollinger Band Squeeze ─────────────────────────────────────────────
  bollingerBand: {
    name: 'Bollinger Band',
    description: 'Price touching or outside bands, plus band width for squeeze detection.',
    check(data) {
      const { price, bbUpper, bbLower, bbMiddle, bbWidth } = data;
      if (!bbUpper || !bbLower) return { signal: 'NEUTRAL', reason: 'BB data unavailable', confidence: 0 };

      const bandRange = bbUpper - bbLower;
      const squeeze = bbWidth != null && bbWidth < 0.02;  // <2% width = squeeze

      if (price >= bbUpper) {
        return { signal: 'SELL', reason: `Price at upper band (${bbUpper.toFixed(2)})${squeeze ? ' — squeeze breakout' : ''}`, confidence: 0.75 };
      }
      if (price <= bbLower) {
        return { signal: 'BUY',  reason: `Price at lower band (${bbLower.toFixed(2)})${squeeze ? ' — squeeze breakout' : ''}`, confidence: 0.75 };
      }
      if (squeeze) {
        return { signal: 'WATCH', reason: 'BB squeeze — breakout imminent', confidence: 0.5 };
      }
      const midDist = ((price - bbMiddle) / (bandRange / 2) * 100).toFixed(1);
      return { signal: 'NEUTRAL', reason: `Price mid-band (${midDist}% from centre)`, confidence: 0.1 };
    }
  },

  // ── 5. VWAP Bias ──────────────────────────────────────────────────────────
  vwapBias: {
    name: 'VWAP Bias',
    description: 'Price relative to VWAP defines intraday directional bias.',
    check(data) {
      const { price, vwap } = data;
      if (!vwap) return { signal: 'NEUTRAL', reason: 'VWAP unavailable', confidence: 0 };

      const pct = ((price - vwap) / vwap * 100);
      if (pct > 0.5)  return { signal: 'BUY',  reason: `Price ${pct.toFixed(2)}% above VWAP — bullish bias`, confidence: clamp(pct / 2, 0.3, 1.0) };
      if (pct < -0.5) return { signal: 'SELL', reason: `Price ${Math.abs(pct).toFixed(2)}% below VWAP — bearish bias`, confidence: clamp(Math.abs(pct) / 2, 0.3, 1.0) };
      return { signal: 'NEUTRAL', reason: `Price at VWAP (${pct.toFixed(2)}%)`, confidence: 0.2 };
    }
  },

  // ── 6. EMA Trend Pullback ─────────────────────────────────────────────────
  emaTrendPullback: {
    name: 'EMA Trend Pullback',
    description: 'Price pulls back to EMA21 in direction of EMA9 trend.',
    check(data) {
      const { price, ema9, ema21 } = data;
      if (!ema9 || !ema21) return { signal: 'NEUTRAL', reason: 'EMA data unavailable', confidence: 0 };

      const trend = ema9 > ema21 ? 'UP' : 'DOWN';
      const nearEma21 = Math.abs(price - ema21) / ema21 < 0.003;  // within 0.3%

      if (trend === 'UP' && nearEma21) {
        return { signal: 'BUY', reason: `Pullback to EMA21 in uptrend (EMA9 ${ema9.toFixed(2)} > EMA21 ${ema21.toFixed(2)})`, confidence: 0.8 };
      }
      if (trend === 'DOWN' && nearEma21) {
        return { signal: 'SELL', reason: `Rally to EMA21 in downtrend (EMA9 ${ema9.toFixed(2)} < EMA21 ${ema21.toFixed(2)})`, confidence: 0.8 };
      }
      return { signal: trend === 'UP' ? 'BUY' : 'SELL', reason: `EMA trend ${trend} — no pullback yet`, confidence: 0.4 };
    }
  },

  // ── 7. Stochastic Oscillator ──────────────────────────────────────────────
  stochastic: {
    name: 'Stochastic Oscillator',
    description: '%K/%D crossover in oversold/overbought zones.',
    check(data) {
      const { stochK, stochD } = data;
      if (stochK == null || stochD == null) return { signal: 'NEUTRAL', reason: 'Stochastic data unavailable', confidence: 0 };

      if (stochK < 20 && stochK > stochD) return { signal: 'BUY',  reason: `Stoch bullish crossover in oversold  zone (%K ${stochK.toFixed(1)})`, confidence: 0.85 };
      if (stochK > 80 && stochK < stochD) return { signal: 'SELL', reason: `Stoch bearish crossover in overbought zone (%K ${stochK.toFixed(1)})`, confidence: 0.85 };
      if (stochK < 20) return { signal: 'WATCH', reason: `Stoch oversold  — waiting for crossover (%K ${stochK.toFixed(1)})`, confidence: 0.5 };
      if (stochK > 80) return { signal: 'WATCH', reason: `Stoch overbought — waiting for crossover (%K ${stochK.toFixed(1)})`, confidence: 0.5 };
      return { signal: 'NEUTRAL', reason: `Stoch neutral (%K ${stochK.toFixed(1)}, %D ${stochD.toFixed(1)})`, confidence: 0.1 };
    }
  },

  // ── 8. Pine Custom Levels ────────────────────────────────────────────────
  pineLevels: {
    name: 'Pine Custom Levels',
    description: 'Price proximity to key levels drawn by Pine indicators.',
    check(data) {
      const price = data.price;
      const lines = data.pineLines ?? [];
      if (!price || lines.length === 0) return { signal: 'NEUTRAL', reason: 'No Pine levels available', confidence: 0 };

      // Find the nearest level above and below
      const above = lines.filter(l => l.price > price).sort((a, b) => a.price - b.price)[0];
      const below = lines.filter(l => l.price < price).sort((a, b) => b.price - a.price)[0];

      const proxPct = 0.002;  // within 0.2% = "at the level"
      if (above && Math.abs(above.price - price) / price < proxPct) {
        return { signal: 'SELL', reason: `At key resistance ${above.price} (${above.label ?? 'Pine level'})`, confidence: 0.8 };
      }
      if (below && Math.abs(below.price - price) / price < proxPct) {
        return { signal: 'BUY', reason: `At key support ${below.price} (${below.label ?? 'Pine level'})`, confidence: 0.8 };
      }

      const aboveStr = above ? `next resistance ${above.price}` : 'no resistance above';
      const belowStr = below ? `support ${below.price}` : 'no support below';
      return { signal: 'NEUTRAL', reason: `Between levels — ${belowStr} / ${aboveStr}`, confidence: 0.2 };
    }
  }
};

// ─── Aggregator ───────────────────────────────────────────────────────────────

/**
 * Run all strategies against the data bundle and return a summary.
 * @param {object} data  - built by TradingAIAgent.buildStrategyData()
 * @returns {{ results, consensus, bullScore, bearScore }}
 */
export function runAllStrategies(data) {
  const results = [];
  let bullScore = 0;
  let bearScore = 0;
  let totalWeight = 0;

  for (const [key, strategy] of Object.entries(TradingStrategies)) {
    try {
      const out = strategy.check(data);
      results.push({ id: key, name: strategy.name, ...out });

      const w = out.confidence ?? 0.5;
      totalWeight += w;
      if (out.signal === 'BUY'  || out.signal === 'STRONG_BUY')  bullScore += w;
      if (out.signal === 'SELL' || out.signal === 'STRONG_SELL') bearScore += w;
    } catch (err) {
      results.push({ id: key, name: strategy.name, signal: 'ERROR', reason: err.message, confidence: 0 });
    }
  }

  const norm = totalWeight || 1;
  const bullPct = (bullScore / norm * 100).toFixed(1);
  const bearPct = (bearScore / norm * 100).toFixed(1);

  let consensus = 'NEUTRAL';
  if (bullScore / norm > 0.6) consensus = bullScore / norm > 0.8 ? 'STRONG_BUY'  : 'BUY';
  if (bearScore / norm > 0.6) consensus = bearScore / norm > 0.8 ? 'STRONG_SELL' : 'SELL';

  return { results, consensus, bullPct, bearPct };
}
