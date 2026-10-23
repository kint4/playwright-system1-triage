import {
  FAILURE_CATEGORIES,
  type FailureCategory,
  type QualityGateVerdict,
  type System1DecisionResult,
} from '../types.ts';

export function evaluateQualityGate(
  decisions: System1DecisionResult[],
  passedCount = 0
): QualityGateVerdict {
  const countsByCategory: Record<FailureCategory, number> = {
    product_defect: 0,
    broken_locator: 0,
    flaky_timing: 0,
    environment_network: 0,
    auth_or_data: 0,
    test_code_error: 0,
  };

  for (const d of decisions) {
    countsByCategory[d.winningCategory] = (countsByCategory[d.winningCategory] ?? 0) + 1;
  }

  const releaseBlockers = decisions.filter(
    (d) => d.winningCategory === 'product_defect' || d.releaseBlockerScore >= 70
  );
  const retryCandidates = decisions.filter((d) => d.retryableProbability >= 0.72);
  const ambiguousFailures = decisions.filter((d) => d.topConfidence < 0.70);

  const totalLatencyMs = Number(
    decisions.reduce((acc, d) => acc + d.latencyMs, 0).toFixed(2)
  );
  const totalCostUsd = Number(
    decisions.reduce((acc, d) => acc + d.estimatedCostUsd, 0).toFixed(6)
  );
  const escalatedCount = decisions.filter((d) => d.escalated).length;
  const escalationRate =
    decisions.length > 0 ? Number((escalatedCount / decisions.length).toFixed(4)) : 0;

  if (decisions.length === 0) {
    return {
      action: 'PASS',
      headline: 'PASS — All Playwright checks succeeded',
      rationale: `0 failed tests across ${passedCount} passing specs.`,
      exitCode: 0,
      totalFailed: 0,
      totalPassed: passedCount,
      countsByCategory,
      releaseBlockers: [],
      retryCandidates: [],
      ambiguousFailures: [],
      totalLatencyMs: 0,
      totalCostUsd: 0,
      escalationRate: 0,
    };
  }

  if (releaseBlockers.length > 0) {
    return {
      action: 'BLOCK_MERGE',
      headline: `BLOCK MERGE — ${releaseBlockers.length} high-severity Product Regression(s) detected`,
      rationale: `System 1 triage identified ${releaseBlockers.length} product defect(s) (max blocker score ${Math.max(
        ...releaseBlockers.map((r) => r.releaseBlockerScore)
      )}/100). Do not auto-retry; inspect application diff.`,
      exitCode: 1,
      totalFailed: decisions.length,
      totalPassed: passedCount,
      countsByCategory,
      releaseBlockers,
      retryCandidates,
      ambiguousFailures,
      totalLatencyMs,
      totalCostUsd,
      escalationRate,
    };
  }

  const allTransient = decisions.every(
    (d) =>
      (d.winningCategory === 'flaky_timing' || d.winningCategory === 'environment_network') &&
      d.retryableProbability >= 0.70
  );

  if (allTransient) {
    return {
      action: 'AUTO_RETRY_TRANSIENT',
      headline: `AUTO-RETRY SAFE — ${decisions.length} transient Flake / Environment failure(s), 0 Product Bugs`,
      rationale: `All ${decisions.length} failure(s) classified as transient timing or upstream network issues with avg retryability ${(
        (decisions.reduce((a, b) => a + b.retryableProbability, 0) / decisions.length) *
        100
      ).toFixed(1)}%.`,
      exitCode: 3,
      totalFailed: decisions.length,
      totalPassed: passedCount,
      countsByCategory,
      releaseBlockers,
      retryCandidates,
      ambiguousFailures,
      totalLatencyMs,
      totalCostUsd,
      escalationRate,
    };
  }

  const dominantCats = FAILURE_CATEGORIES.filter((c) => countsByCategory[c] > 0)
    .map((c) => `${countsByCategory[c]} ${c}`)
    .join(', ');

  return {
    action: 'ESCALATE_AMBIGUOUS',
    headline: `TRIAGE REQUIRED — ${decisions.length} non-product test/infra failure(s) (${dominantCats})`,
    rationale: `No direct product defects detected, but ${
      countsByCategory.broken_locator + countsByCategory.auth_or_data + countsByCategory.test_code_error
    } failure(s) require locator, auth fixture, or test script updates before retry.`,
    exitCode: 2,
    totalFailed: decisions.length,
    totalPassed: passedCount,
    countsByCategory,
    releaseBlockers,
    retryCandidates,
    ambiguousFailures,
    totalLatencyMs,
    totalCostUsd,
    escalationRate,
  };
}
