import type { GoldenFailureSample, System1DecisionResult } from '../../src/types.ts';

export interface CalibrationBin {
  rangeLabel: string;
  minConf: number;
  maxConf: number;
  count: number;
  avgConfidence: number;
  empiricalAccuracy: number;
  calibrationGap: number;
}

export interface ThresholdSweepPoint {
  threshold: number;
  accuracy: number;
  escalationRate: number;
  avgLatencyMs: number;
  totalCostUsd: number;
}

export interface CalibrationReport {
  ece: number;
  brierScore: number;
  bins: CalibrationBin[];
}

/**
 * Computes Expected Calibration Error (ECE) and Multi-class Brier Score
 * to evaluate whether the System 1 model's reported probabilities are trustworthy for CI gating.
 */
export function computeCalibrationMetrics(
  samples: GoldenFailureSample[],
  predictions: System1DecisionResult[]
): CalibrationReport {
  const predMap = new Map<string, System1DecisionResult>();
  for (const p of predictions) {
    predMap.set(p.testId, p);
  }

  const binRanges: Array<{ label: string; min: number; max: number }> = [
    { label: '0.00 - 0.60 (Low / Ambiguous)', min: 0.0, max: 0.6 },
    { label: '0.60 - 0.78 (Borderline)', min: 0.6, max: 0.78 },
    { label: '0.78 - 0.88 (Confident)', min: 0.78, max: 0.88 },
    { label: '0.88 - 1.00 (High Confidence)', min: 0.88, max: 1.01 },
  ];

  const bins: CalibrationBin[] = [];
  let eceAccumulator = 0;
  let brierAccumulator = 0;
  const total = samples.length || 1;

  for (const b of binRanges) {
    const matching = samples.filter((s) => {
      const pred = predMap.get(s.id);
      if (!pred) return false;
      return pred.topConfidence >= b.min && pred.topConfidence < b.max;
    });

    if (matching.length === 0) {
      bins.push({
        rangeLabel: b.label,
        minConf: b.min,
        maxConf: Math.min(1, b.max),
        count: 0,
        avgConfidence: 0,
        empiricalAccuracy: 0,
        calibrationGap: 0,
      });
      continue;
    }

    let confSum = 0;
    let correct = 0;

    for (const s of matching) {
      const pred = predMap.get(s.id)!;
      confSum += pred.topConfidence;
      if (pred.winningCategory === s.expectedCategory) {
        correct++;
      }
    }

    const avgConfidence = Number((confSum / matching.length).toFixed(4));
    const empiricalAccuracy = Number((correct / matching.length).toFixed(4));
    const calibrationGap = Number(Math.abs(avgConfidence - empiricalAccuracy).toFixed(4));

    eceAccumulator += (matching.length / total) * calibrationGap;

    bins.push({
      rangeLabel: b.label,
      minConf: b.min,
      maxConf: Math.min(1, b.max),
      count: matching.length,
      avgConfidence,
      empiricalAccuracy,
      calibrationGap,
    });
  }

  for (const s of samples) {
    const pred = predMap.get(s.id);
    if (!pred) continue;
    const isCorrect = pred.winningCategory === s.expectedCategory ? 1 : 0;
    brierAccumulator += (pred.topConfidence - isCorrect) ** 2;
  }

  return {
    ece: Number(eceAccumulator.toFixed(4)),
    brierScore: Number((brierAccumulator / total).toFixed(4)),
    bins,
  };
}
