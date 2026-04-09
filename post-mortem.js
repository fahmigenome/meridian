/**
 * Post-Mortem Scoring Engine
 *
 * Automatically generates a detailed post-mortem report every time a position
 * is closed. Scores the position across 6 dimensions, derives lessons, and
 * produces a formatted report for Telegram.
 *
 * Dimensions:
 *   1. Entry Quality    (20%) — token health at deploy (organic, fee/TVL, holders)
 *   2. Range Selection  (25%) — % time spent in range
 *   3. Duration Mgmt    (15%) — was hold time optimal?
 *   4. Yield Capture    (20%) — fees earned vs deposit
 *   5. Exit Quality     (10%) — was exit clean (TP) or forced (OOR/SL)?
 *   6. Risk Management  (10%) — drawdown from peak
 */

import { log } from "./logger.js";
import { getTrackedPosition } from "./state.js";
import { getPoolMemory } from "./pool-memory.js";

// ─── Scoring Weights ────────────────────────────────────────────
const DIMENSIONS = {
  entry_quality:    { weight: 0.20, label: "Entry Quality" },
  range_selection:  { weight: 0.25, label: "Range Selection" },
  duration_mgmt:    { weight: 0.15, label: "Duration Mgmt" },
  yield_capture:    { weight: 0.20, label: "Yield Capture" },
  exit_quality:     { weight: 0.10, label: "Exit Quality" },
  risk_management:  { weight: 0.10, label: "Risk Management" },
};

// ─── Grade Scale ────────────────────────────────────────────────
function letterGrade(score) {
  if (score >= 9.0) return "A+";
  if (score >= 8.0) return "A";
  if (score >= 7.0) return "B+";
  if (score >= 6.0) return "B";
  if (score >= 5.0) return "C";
  if (score >= 4.0) return "D";
  return "F";
}

function gradeEmoji(grade) {
  if (grade.startsWith("A")) return "🏆";
  if (grade.startsWith("B")) return "👍";
  if (grade === "C")         return "😐";
  if (grade === "D")         return "⚠️";
  return "💀";
}

// ─── Helper: clamp to [0, 10] ───────────────────────────────────
function clamp10(val) {
  return Math.max(0, Math.min(10, val));
}

// ─── Dimension Scorers ──────────────────────────────────────────

function scoreEntryQuality(data) {
  const organic   = data.organic_score ?? 0;
  const feeTvl    = data.fee_tvl_ratio ?? 0;
  const volatility = data.volatility ?? 0;

  // organic: 60 → 0, 85+ → 10
  const organicScore = clamp10(((organic - 60) / 25) * 10);

  // fee_tvl_ratio: 0.05 → 0, 0.5+ → 10
  const feeTvlScore = clamp10(((feeTvl - 0.05) / 0.45) * 10);

  // volatility: sweet spot 1-5, penalize extremes
  let volScore = 7; // default neutral
  if (volatility >= 1 && volatility <= 5) volScore = 9;
  else if (volatility > 5 && volatility <= 10) volScore = 6;
  else if (volatility > 10) volScore = 3;
  else if (volatility > 0 && volatility < 1) volScore = 5;

  const score = (organicScore * 0.4 + feeTvlScore * 0.4 + volScore * 0.2);

  return {
    score: Math.round(score * 10) / 10,
    details: {
      organic: organic,
      organic_score: Math.round(organicScore * 10) / 10,
      fee_tvl: feeTvl,
      fee_tvl_score: Math.round(feeTvlScore * 10) / 10,
      volatility: volatility,
      volatility_score: volScore,
    },
  };
}

function scoreRangeSelection(data) {
  const minutesHeld = data.minutes_held ?? 0;
  const minutesInRange = data.minutes_in_range ?? 0;

  if (minutesHeld <= 0) return { score: 5, details: { efficiency_pct: 0 } };

  const efficiency = (minutesInRange / minutesHeld) * 100;

  // 20% → 0, 90%+ → 10
  const score = clamp10(((efficiency - 20) / 70) * 10);

  return {
    score: Math.round(score * 10) / 10,
    details: {
      efficiency_pct: Math.round(efficiency * 10) / 10,
      minutes_in_range: minutesInRange,
      minutes_held: minutesHeld,
    },
  };
}

function scoreDurationMgmt(data) {
  const minutesHeld = data.minutes_held ?? 0;
  const pnlPct = data.pnl_pct ?? 0;

  // Optimal hold: 30-240 minutes for memecoins
  // Too short (<10min) = paper hands, too long (>720min) = overstayed
  let score;
  if (minutesHeld < 5)         score = 2;
  else if (minutesHeld < 15)   score = 4;
  else if (minutesHeld < 30)   score = 6;
  else if (minutesHeld <= 240) score = 9; // sweet spot
  else if (minutesHeld <= 480) score = 7;
  else if (minutesHeld <= 720) score = 5;
  else                         score = 3;

  // Bonus: if profitable despite long hold, don't penalize
  if (pnlPct > 3 && minutesHeld > 240) score = Math.max(score, 7);
  // Penalty: if lost money on a very short hold, that's worse
  if (pnlPct < -5 && minutesHeld < 15) score = Math.min(score, 2);

  return {
    score: clamp10(score),
    details: {
      minutes_held: minutesHeld,
      optimal_range: "30-240 min",
    },
  };
}

function scoreYieldCapture(data) {
  const feesEarned = data.fees_earned_usd ?? 0;
  const initialValue = data.initial_value_usd ?? 0;

  if (initialValue <= 0) return { score: 0, details: { yield_pct: 0 } };

  const yieldPct = (feesEarned / initialValue) * 100;

  // 0.1% → 0, 3%+ → 10
  const score = clamp10(((yieldPct - 0.1) / 2.9) * 10);

  return {
    score: Math.round(score * 10) / 10,
    details: {
      fees_earned_usd: Math.round(feesEarned * 100) / 100,
      initial_value_usd: Math.round(initialValue * 100) / 100,
      yield_pct: Math.round(yieldPct * 100) / 100,
    },
  };
}

function scoreExitQuality(data) {
  const reason = String(data.close_reason || "").toLowerCase();
  const pnlPct = data.pnl_pct ?? 0;

  // Best exits: take profit, trailing TP, user instruction
  if (reason.includes("take profit") || reason.includes("trailing tp"))
    return { score: 10, details: { type: "take_profit", reason: data.close_reason } };

  if (reason.includes("instruction") || reason.includes("user"))
    return { score: 9, details: { type: "user_instruction", reason: data.close_reason } };

  // Neutral: agent decision with positive PnL
  if (reason.includes("agent decision") && pnlPct >= 0)
    return { score: 7, details: { type: "agent_positive", reason: data.close_reason } };

  // Bad: low yield close
  if (reason.includes("low yield") || reason.includes("yield"))
    return { score: 4, details: { type: "low_yield", reason: data.close_reason } };

  // Bad: out of range
  if (reason.includes("out of range") || reason.includes("oor"))
    return { score: 3, details: { type: "out_of_range", reason: data.close_reason } };

  // Worst: stop loss
  if (reason.includes("stop loss"))
    return { score: 1, details: { type: "stop_loss", reason: data.close_reason } };

  // Agent decision with negative PnL
  if (pnlPct < 0)
    return { score: 4, details: { type: "agent_negative", reason: data.close_reason } };

  return { score: 6, details: { type: "other", reason: data.close_reason } };
}

function scoreRiskManagement(data) {
  const peakPnlPct = data.peak_pnl_pct ?? 0;
  const finalPnlPct = data.pnl_pct ?? 0;

  // Drawdown from peak
  const drawdown = peakPnlPct > 0 ? peakPnlPct - finalPnlPct : 0;

  // 0% drawdown → 10, 20%+ drawdown → 0
  let score;
  if (drawdown <= 0)  score = 10;
  else if (drawdown <= 2)  score = 9;
  else if (drawdown <= 5)  score = 7;
  else if (drawdown <= 10) score = 5;
  else if (drawdown <= 20) score = 3;
  else                     score = 1;

  // If never reached positive territory, neutral score
  if (peakPnlPct <= 0) score = 5;

  // Bonus: if final PnL is positive regardless of drawdown
  if (finalPnlPct > 0 && score < 7) score = 7;

  return {
    score: clamp10(score),
    details: {
      peak_pnl_pct: Math.round(peakPnlPct * 100) / 100,
      final_pnl_pct: Math.round(finalPnlPct * 100) / 100,
      drawdown_pct: Math.round(drawdown * 100) / 100,
    },
  };
}

// ─── Main Scoring Function ──────────────────────────────────────

/**
 * Generate a full post-mortem report for a closed position.
 *
 * @param {Object} closeData - Data from the close_position result + tracked state
 * @param {string} closeData.position        - Position address
 * @param {string} closeData.pool            - Pool address
 * @param {string} closeData.pool_name       - Pool name (e.g. "milkers-SOL")
 * @param {number} closeData.pnl_usd        - Final PnL in USD
 * @param {number} closeData.pnl_pct        - Final PnL percentage
 * @param {number} closeData.fees_earned_usd - Total fees earned
 * @param {number} closeData.initial_value_usd - Value at deploy
 * @param {number} closeData.final_value_usd - Value at close
 * @param {number} closeData.minutes_held    - Total minutes held
 * @param {number} closeData.minutes_in_range - Minutes in range
 * @param {string} closeData.close_reason    - Why closed
 * @param {string} closeData.strategy        - Strategy used
 * @param {number} closeData.volatility      - Volatility at deploy
 * @param {number} closeData.fee_tvl_ratio   - Fee/TVL ratio at deploy
 * @param {number} closeData.organic_score   - Organic score at deploy
 * @param {number} closeData.peak_pnl_pct    - Peak PnL during lifetime
 * @param {Object} closeData.bin_range       - Bin range used
 * @param {number} closeData.bin_step        - Pool bin step
 * @param {number} closeData.amount_sol      - SOL deployed
 *
 * @returns {Object} { report, scores, grade, overallScore, lessons }
 */
export function generatePostMortem(closeData) {
  try {
    // Score each dimension
    const entry    = scoreEntryQuality(closeData);
    const range    = scoreRangeSelection(closeData);
    const duration = scoreDurationMgmt(closeData);
    const yield_   = scoreYieldCapture(closeData);
    const exit     = scoreExitQuality(closeData);
    const risk     = scoreRiskManagement(closeData);

    const scores = {
      entry_quality:   entry,
      range_selection: range,
      duration_mgmt:   duration,
      yield_capture:   yield_,
      exit_quality:    exit,
      risk_management: risk,
    };

    // Weighted average
    const overallScore =
      entry.score    * DIMENSIONS.entry_quality.weight +
      range.score    * DIMENSIONS.range_selection.weight +
      duration.score * DIMENSIONS.duration_mgmt.weight +
      yield_.score   * DIMENSIONS.yield_capture.weight +
      exit.score     * DIMENSIONS.exit_quality.weight +
      risk.score     * DIMENSIONS.risk_management.weight;

    const rounded = Math.round(overallScore * 100) / 100;
    const grade   = letterGrade(rounded);
    const emoji   = gradeEmoji(grade);

    // Derive lessons from scoring
    const lessons = derivePostMortemLessons(closeData, scores, rounded, grade);

    // Build formatted text report
    const report = formatReport(closeData, scores, rounded, grade, emoji, lessons);

    log("post_mortem", `${closeData.pool_name}: Grade ${grade} (${rounded}) | PnL ${closeData.pnl_pct?.toFixed(2)}%`);

    return {
      pool_name: closeData.pool_name,
      position: closeData.position,
      report,
      scores,
      grade,
      emoji,
      overallScore: rounded,
      lessons,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    log("post_mortem_error", `Failed to generate post-mortem: ${error.message}`);
    return null;
  }
}

// ─── Lesson Derivation ──────────────────────────────────────────

function derivePostMortemLessons(data, scores, overall, grade) {
  const lessons = [];
  const poolName = data.pool_name || "unknown";

  // ── Entry Quality lessons ─────────────────────────────────────
  if (scores.entry_quality.score >= 8 && data.pnl_pct > 0) {
    lessons.push({
      type: "GOOD",
      text: `High entry quality (organic=${data.organic_score}, fee_tvl=${data.fee_tvl_ratio}) correlated with profit for ${poolName}`,
      tags: ["entry", "screening", "post_mortem"],
    });
  }
  if (scores.entry_quality.score <= 4 && data.pnl_pct < 0) {
    lessons.push({
      type: "WARN",
      text: `Low entry quality led to loss on ${poolName} — organic=${data.organic_score}, fee_tvl=${data.fee_tvl_ratio}. Raise screening thresholds.`,
      tags: ["entry", "screening", "post_mortem"],
    });
  }

  // ── Range Selection lessons ───────────────────────────────────
  const rangeEff = scores.range_selection.details.efficiency_pct;
  if (rangeEff >= 90) {
    lessons.push({
      type: "GOOD",
      text: `Excellent range efficiency (${rangeEff}%) on ${poolName} with strategy=${data.strategy}, bins=${JSON.stringify(data.bin_range)}`,
      tags: ["range", "strategy", "post_mortem"],
    });
  }
  if (rangeEff <= 40 && data.minutes_held > 30) {
    lessons.push({
      type: "WARN",
      text: `Poor range efficiency (${rangeEff}%) on ${poolName} — consider wider bins or bid_ask strategy for volatility=${data.volatility}`,
      tags: ["range", "oor", "strategy", "post_mortem"],
    });
  }

  // ── Duration lessons ──────────────────────────────────────────
  if (data.minutes_held < 10 && data.pnl_pct < 0) {
    lessons.push({
      type: "WARN",
      text: `Paper-handed ${poolName} after only ${data.minutes_held}m with loss — patience needed. DLMM needs time to accumulate fees.`,
      tags: ["duration", "management", "post_mortem"],
    });
  }
  if (data.minutes_held > 480 && data.pnl_pct < -3) {
    lessons.push({
      type: "WARN",
      text: `Overstayed in ${poolName} (${data.minutes_held}m) with -${Math.abs(data.pnl_pct).toFixed(1)}% loss — should have exited earlier when yield dropped.`,
      tags: ["duration", "management", "post_mortem"],
    });
  }

  // ── Yield lessons ─────────────────────────────────────────────
  const yieldPct = scores.yield_capture.details.yield_pct;
  if (yieldPct >= 3) {
    lessons.push({
      type: "GOOD",
      text: `Strong yield capture (${yieldPct}%) on ${poolName} — pool fee generation was healthy throughout hold.`,
      tags: ["yield", "fees", "post_mortem"],
    });
  }
  if (yieldPct < 0.5 && data.minutes_held > 60) {
    lessons.push({
      type: "WARN",
      text: `Very low yield (${yieldPct}%) on ${poolName} despite ${data.minutes_held}m hold — fee/TVL may have collapsed post-deploy.`,
      tags: ["yield", "fees", "post_mortem"],
    });
  }

  // ── Exit quality lessons ──────────────────────────────────────
  if (scores.exit_quality.score <= 3) {
    const exitType = scores.exit_quality.details.type;
    if (exitType === "stop_loss") {
      lessons.push({
        type: "CRITICAL",
        text: `Stop loss hit on ${poolName} (${data.pnl_pct?.toFixed(1)}%) — entry conditions may have been too aggressive for volatility=${data.volatility}.`,
        tags: ["exit", "stop_loss", "risk", "post_mortem"],
      });
    }
    if (exitType === "out_of_range") {
      lessons.push({
        type: "WARN",
        text: `Forced OOR exit on ${poolName} — price moved beyond range. For bin_step=${data.bin_step} and vol=${data.volatility}, use wider bins.`,
        tags: ["exit", "oor", "range", "post_mortem"],
      });
    }
  }

  // ── Risk management lessons ───────────────────────────────────
  const drawdown = scores.risk_management.details.drawdown_pct;
  if (drawdown > 10 && data.pnl_pct < 0) {
    lessons.push({
      type: "WARN",
      text: `Large drawdown (${drawdown}% from peak) on ${poolName} — trailing TP should have triggered earlier. Check trailingDropPct config.`,
      tags: ["risk", "trailing_tp", "post_mortem"],
    });
  }

  // ── Overall grade lessons ─────────────────────────────────────
  if (grade === "A+" || grade === "A") {
    lessons.push({
      type: "GOOD",
      text: `[POST-MORTEM ${grade}] ${poolName}: PnL ${data.pnl_pct?.toFixed(1)}%, yield ${yieldPct}%, range ${rangeEff}% — excellent trade. Settings: strategy=${data.strategy}, vol=${data.volatility}, fee_tvl=${data.fee_tvl_ratio}.`,
      tags: ["post_mortem", "summary", "worked"],
    });
  }
  if (grade === "F" || grade === "D") {
    lessons.push({
      type: "CRITICAL",
      text: `[POST-MORTEM ${grade}] ${poolName}: PnL ${data.pnl_pct?.toFixed(1)}%, yield ${yieldPct}%, range ${rangeEff}% — poor trade. Avoid: vol=${data.volatility}, organic=${data.organic_score}, bin_step=${data.bin_step}.`,
      tags: ["post_mortem", "summary", "failed"],
    });
  }

  return lessons;
}

// ─── Report Formatter ───────────────────────────────────────────

function scoreBar(score) {
  const filled  = Math.round(score);
  const empty   = 10 - filled;
  return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, empty));
}

function formatReport(data, scores, overall, grade, emoji, lessons) {
  const sign = (data.pnl_usd ?? 0) >= 0 ? "+" : "";
  const pnlSign = (data.pnl_pct ?? 0) >= 0 ? "+" : "";
  const rangeEff = scores.range_selection.details.efficiency_pct;
  const yieldPct = scores.yield_capture.details.yield_pct;
  const feesUsd  = scores.yield_capture.details.fees_earned_usd;
  const minutesHeld = data.minutes_held ?? 0;
  const durationStr = minutesHeld >= 60
    ? `${Math.floor(minutesHeld / 60)}h ${minutesHeld % 60}m`
    : `${minutesHeld}m`;

  const lines = [
    `📊 POST-MORTEM: ${data.pool_name || "unknown"}`,
    ``,
    `📈 PnL: ${sign}$${(data.pnl_usd ?? 0).toFixed(2)} (${pnlSign}${(data.pnl_pct ?? 0).toFixed(2)}%)`,
    `⏱️ Duration: ${durationStr} | 💰 Fees: $${feesUsd}`,
    `🎯 Range: ${rangeEff}% in-range | 📐 Strategy: ${data.strategy || "?"}`,
    ``,
    `━━━ SCORING ━━━`,
  ];

  // Score bars
  for (const [key, dim] of Object.entries(DIMENSIONS)) {
    const s = scores[key];
    const label = dim.label.padEnd(16);
    lines.push(`${label} ${scoreBar(s.score)} ${s.score.toFixed(1)}`);
  }

  lines.push(``);
  lines.push(`${emoji} GRADE: ${grade} (${overall.toFixed(2)}/10)`);

  // Lessons
  if (lessons.length > 0) {
    lines.push(``);
    lines.push(`📝 TAKEAWAYS:`);
    for (const lesson of lessons.slice(0, 4)) {
      const icon = lesson.type === "GOOD" ? "✅" : lesson.type === "CRITICAL" ? "🚨" : "⚠️";
      lines.push(`${icon} ${lesson.text}`);
    }
  }

  return lines.join("\n");
}

// ─── Build Close Data from Tracked Position + Close Result ──────

/**
 * Merge tracked position state with close result to produce a complete
 * data object for post-mortem scoring.
 *
 * @param {string} positionAddress
 * @param {Object} closeResult - Result from close_position tool
 * @param {Object} perfData    - Performance data passed to recordPerformance
 * @returns {Object|null}
 */
export function buildPostMortemData(positionAddress, closeResult, perfData) {
  const tracked = getTrackedPosition(positionAddress);
  if (!tracked && !perfData) return null;

  return {
    position:         positionAddress,
    pool:             closeResult?.pool || tracked?.pool || perfData?.pool,
    pool_name:        closeResult?.pool_name || tracked?.pool_name || perfData?.pool_name || "unknown",
    pnl_usd:          closeResult?.pnl_usd ?? perfData?.pnl_usd ?? 0,
    pnl_pct:          closeResult?.pnl_pct ?? perfData?.pnl_pct ?? 0,
    fees_earned_usd:  perfData?.fees_earned_usd ?? tracked?.total_fees_claimed_usd ?? 0,
    initial_value_usd: perfData?.initial_value_usd ?? tracked?.initial_value_usd ?? 0,
    final_value_usd:  perfData?.final_value_usd ?? 0,
    minutes_held:     perfData?.minutes_held ?? 0,
    minutes_in_range: perfData?.minutes_in_range ?? 0,
    close_reason:     perfData?.close_reason || closeResult?.close_reason || "agent decision",
    strategy:         tracked?.strategy || perfData?.strategy || "unknown",
    volatility:       tracked?.volatility ?? perfData?.volatility ?? 0,
    fee_tvl_ratio:    tracked?.fee_tvl_ratio ?? perfData?.fee_tvl_ratio ?? 0,
    organic_score:    tracked?.organic_score ?? perfData?.organic_score ?? 0,
    peak_pnl_pct:     tracked?.peak_pnl_pct ?? 0,
    bin_range:        tracked?.bin_range || perfData?.bin_range || {},
    bin_step:         tracked?.bin_step ?? perfData?.bin_step ?? 0,
    amount_sol:       tracked?.amount_sol ?? perfData?.amount_sol ?? 0,
  };
}
