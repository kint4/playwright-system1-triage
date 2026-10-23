import {
  FAILURE_CATEGORIES,
  type FailureCategory,
  type GoldenFailureSample,
  type System1DecisionResult,
} from '../../src/types.ts';

export interface CategoryMetrics {
  category: FailureCategory;
  support: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface ClassificationSummary {
  totalSamples: number;
  correctCount: number;
  overallAccuracy: number;
  macroF1: number;
  retryableAccuracy: number;
  releaseBlockerAccuracy: number;
  sliceAccuracy: {
    standard: number;
    compound: number;
    adversarial: number;
  };
  perCategory: Record<FailureCategory, CategoryMetrics>;
  confusionMatrix: Record<FailureCategory, Record<FailureCategory, number>>;
}

export function computeClassificationMetrics(
  samples: GoldenFailureSample[],
  predictions: System1DecisionResult[]
): ClassificationSummary {
  const predMap = new Map<string, System1DecisionResult>();
  for (const p of predictions) {
    predMap.set(p.testId, p);
  }

  const confusionMatrix = {} as Record<FailureCategory, Record<FailureCategory, number>>;
  for (const actual of FAILURE_CATEGORIES) {
    confusionMatrix[actual] = {} as Record<FailureCategory, number>;
    for (const pred of FAILURE_CATEGORIES) {
      confusionMatrix[actual][pred] = 0;
    }
  }

  let correctCount = 0;
  let retryableCorrect = 0;
  let blockerCorrect = 0;

  const sliceTotals: Record<'standard' | 'compound' | 'adversarial', { total: number; correct: number }> = {
    standard: { total: 0, correct: 0 },
    compound: { total: 0, correct: 0 },
    adversarial: { total: 0, correct: 0 },
  };

  for (const sample of samples) {
    const pred = predMap.get(sample.id);
    if (!pred) continue;

    confusionMatrix[sample.expectedCategory][pred.winningCategory]++;
    sliceTotals[sample.slice].total++;

    if (pred.winningCategory === sample.expectedCategory) {
      correctCount++;
      sliceTotals[sample.slice].correct++;
    }

    const predRetryable = pred.retryableProbability >= 0.5;
    if (predRetryable === sample.expectedRetryable) {
      retryableCorrect++;
    }

    const predBlocker = pred.releaseBlockerScore >= 65;
    if (predBlocker === sample.expectedReleaseBlocker) {
      blockerCorrect++;
    }
  }

  const perCategory = {} as Record<FailureCategory, CategoryMetrics>;
  let f1Sum = 0;

  for (const cat of FAILURE_CATEGORIES) {
    const tp = confusionMatrix[cat][cat];
    let fp = 0;
    let fn = 0;
    for (const other of FAILURE_CATEGORIES) {
      if (other !== cat) {
        fp += confusionMatrix[other][cat];
        fn += confusionMatrix[cat][other];
      }
    }
    const support = tp + fn;
    const precision = tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : 1;
    const recall = tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : 1;
    const f1 =
      precision + recall > 0
        ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4))
        : 0;

    perCategory[cat] = {
      category: cat,
      support,
      tp,
      fp,
      fn,
      precision,
      recall,
      f1,
    };
    f1Sum += f1;
  }

  const total = samples.length || 1;
  return {
    totalSamples: samples.length,
    correctCount,
    overallAccuracy: Number((correctCount / total).toFixed(4)),
    macroF1: Number((f1Sum / FAILURE_CATEGORIES.length).toFixed(4)),
    retryableAccuracy: Number((retryableCorrect / total).toFixed(4)),
    releaseBlockerAccuracy: Number((blockerCorrect / total).toFixed(4)),
    sliceAccuracy: {
      standard:
        sliceTotals.standard.total > 0
          ? Number((sliceTotals.standard.correct / sliceTotals.standard.total).toFixed(4))
          : 0,
      compound:
        sliceTotals.compound.total > 0
          ? Number((sliceTotals.compound.correct / sliceTotals.compound.total).toFixed(4))
          : 0,
      adversarial:
        sliceTotals.adversarial.total > 0
          ? Number((sliceTotals.adversarial.correct / sliceTotals.adversarial.total).toFixed(4))
          : 0,
    },
    perCategory,
    confusionMatrix,
  };
}
