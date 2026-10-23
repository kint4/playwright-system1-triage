import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CascadeEngine } from '../src/models/cascadeEngine.ts';
import type { GoldenFailureSample, System1DecisionResult } from '../src/types.ts';
import {
  computeCalibrationMetrics,
  type CalibrationReport,
  type ThresholdSweepPoint,
} from './metrics/calibration.ts';
import {
  computeClassificationMetrics,
  type ClassificationSummary,
} from './metrics/classification.ts';

export interface ModelEvalResult {
  modeName: string;
  classification: ClassificationSummary;
  calibration: CalibrationReport;
  avgLatencyMs: number;
  totalCostUsd: number;
  escalationRate: number;
  predictions: System1DecisionResult[];
}

export interface FullEvalSuiteReport {
  timestamp: string;
  datasetSize: number;
  layaOnly: ModelEvalResult;
  jevOnly: ModelEvalResult;
  cascade: ModelEvalResult;
  thresholdSweep: ThresholdSweepPoint[];
  samples: GoldenFailureSample[];
}

export function loadGoldenSamples(): GoldenFailureSample[] {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const localDatasetPath = path.join(__dirname, 'dataset', 'golden_failures.json');
  const rootDatasetPath = path.resolve(__dirname, '../../evals/dataset/golden_failures.json');
  const datasetPath = fs.existsSync(localDatasetPath) ? localDatasetPath : rootDatasetPath;
  const raw = fs.readFileSync(datasetPath, 'utf-8');
  return JSON.parse(raw) as GoldenFailureSample[];
}

async function evaluateMode(
  modeName: string,
  engine: CascadeEngine,
  samples: GoldenFailureSample[]
): Promise<ModelEvalResult> {
  const states = samples.map((s) => s.state);
  const predictions = await engine.classifyBatch(states);
  const classification = computeClassificationMetrics(samples, predictions);
  const calibration = computeCalibrationMetrics(samples, predictions);

  const totalLatency = predictions.reduce((acc, p) => acc + p.latencyMs, 0);
  const totalCost = predictions.reduce((acc, p) => acc + p.estimatedCostUsd, 0);
  const escalatedCount = predictions.filter((p) => p.escalated).length;

  return {
    modeName,
    classification,
    calibration,
    avgLatencyMs: Number((totalLatency / (predictions.length || 1)).toFixed(2)),
    totalCostUsd: Number(totalCost.toFixed(6)),
    escalationRate: Number((escalatedCount / (predictions.length || 1)).toFixed(4)),
    predictions,
  };
}

export async function runFullEvaluationSuite(): Promise<FullEvalSuiteReport> {
  const samples = loadGoldenSamples();

  const layaOnly = await evaluateMode(
    'Laya-421M (Local Only)',
    new CascadeEngine({ mode: 'laya-only' }),
    samples
  );

  const jevOnly = await evaluateMode(
    'Jev (TypeSafe Cloud API Only)',
    new CascadeEngine({ mode: 'jev-only' }),
    samples
  );

  const cascade = await evaluateMode(
    'Laya → Jev Cascade (τ = 0.78)',
    new CascadeEngine({ mode: 'cascade', confidenceThreshold: 0.78, marginThreshold: 0.28 }),
    samples
  );

  const thresholds = [0.55, 0.65, 0.72, 0.78, 0.85, 0.92];
  const thresholdSweep: ThresholdSweepPoint[] = [];

  for (const t of thresholds) {
    const res = await evaluateMode(
      `Cascade τ=${t}`,
      new CascadeEngine({ mode: 'cascade', confidenceThreshold: t, marginThreshold: 0.25 }),
      samples
    );
    thresholdSweep.push({
      threshold: t,
      accuracy: res.classification.overallAccuracy,
      escalationRate: res.escalationRate,
      avgLatencyMs: res.avgLatencyMs,
      totalCostUsd: res.totalCostUsd,
    });
  }

  return {
    timestamp: new Date().toISOString(),
    datasetSize: samples.length,
    layaOnly,
    jevOnly,
    cascade,
    thresholdSweep,
    samples,
  };
}

function pct(val: number): string {
  return `${(val * 100).toFixed(1)}%`;
}

export function printEvalSummaryToConsole(report: FullEvalSuiteReport): void {
  console.log('\n================================================================================');
  console.log('  AI QA EVALUATION & CALIBRATION BENCHMARK: LAYA vs. JEV vs. CASCADE');
  console.log(`  Golden Dataset: ${report.datasetSize} Playwright Failures (12 Standard, 6 Compound, 2 Adversarial)`);
  console.log('================================================================================\n');

  console.log('1. HEAD-TO-HEAD MODEL COMPARISON');
  console.table([
    {
      Model: report.layaOnly.modeName,
      'Overall Acc': pct(report.layaOnly.classification.overallAccuracy),
      'Macro F1': pct(report.layaOnly.classification.macroF1),
      'Standard Slice': pct(report.layaOnly.classification.sliceAccuracy.standard),
      'Compound Slice': pct(report.layaOnly.classification.sliceAccuracy.compound),
      'Adversarial Slice': pct(report.layaOnly.classification.sliceAccuracy.adversarial),
      'ECE (Calibration)': report.layaOnly.calibration.ece.toFixed(4),
      'Avg Latency': `${report.layaOnly.avgLatencyMs} ms`,
      'Escalated %': pct(report.layaOnly.escalationRate),
    },
    {
      Model: report.jevOnly.modeName,
      'Overall Acc': pct(report.jevOnly.classification.overallAccuracy),
      'Macro F1': pct(report.jevOnly.classification.macroF1),
      'Standard Slice': pct(report.jevOnly.classification.sliceAccuracy.standard),
      'Compound Slice': pct(report.jevOnly.classification.sliceAccuracy.compound),
      'Adversarial Slice': pct(report.jevOnly.classification.sliceAccuracy.adversarial),
      'ECE (Calibration)': report.jevOnly.calibration.ece.toFixed(4),
      'Avg Latency': `${report.jevOnly.avgLatencyMs} ms`,
      'Escalated %': '100.0% (API)',
    },
    {
      Model: report.cascade.modeName,
      'Overall Acc': pct(report.cascade.classification.overallAccuracy),
      'Macro F1': pct(report.cascade.classification.macroF1),
      'Standard Slice': pct(report.cascade.classification.sliceAccuracy.standard),
      'Compound Slice': pct(report.cascade.classification.sliceAccuracy.compound),
      'Adversarial Slice': pct(report.cascade.classification.sliceAccuracy.adversarial),
      'ECE (Calibration)': report.cascade.calibration.ece.toFixed(4),
      'Avg Latency': `${report.cascade.avgLatencyMs} ms`,
      'Escalated %': pct(report.cascade.escalationRate),
    },
  ]);

  console.log('\n2. CONFIDENCE THRESHOLD (τ) SWEEP — FINDING THE OPTIMAL CASCADE GATE');
  console.table(
    report.thresholdSweep.map((pt) => ({
      'Threshold (τ)': pt.threshold.toFixed(2),
      Accuracy: pct(pt.accuracy),
      'Jev Escalation Rate': pct(pt.escalationRate),
      'Avg Latency': `${pt.avgLatencyMs} ms`,
      'Batch Cost (USD)': `$${pt.totalCostUsd.toFixed(6)}`,
    }))
  );

  console.log('\n3. PER-CATEGORY F1 BREAKDOWN (CASCADE τ = 0.78)');
  console.table(
    Object.values(report.cascade.classification.perCategory).map((c) => ({
      Category: c.category,
      Support: c.support,
      Precision: pct(c.precision),
      Recall: pct(c.recall),
      'F1 Score': pct(c.f1),
    }))
  );
}

// Execute if invoked directly via `node evals/runEvals.ts`
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runFullEvaluationSuite().then((report) => {
    printEvalSummaryToConsole(report);
  });
}
