#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  loadGoldenSamples,
  printEvalSummaryToConsole,
  runFullEvaluationSuite,
} from '../../evals/runEvals.ts';
import { parsePlaywrightJsonReport } from '../extractor/stateExtractor.ts';
import { evaluateQualityGate } from '../gate/qualityGate.ts';
import { CascadeEngine } from '../models/cascadeEngine.ts';
import { generateHtmlDashboard } from '../reporter/htmlGenerator.ts';
import { generateMarkdownSummary } from '../reporter/markdownGenerator.ts';
import { CATEGORY_METADATA } from '../types.ts';

async function runDemo(outputDir: string): Promise<void> {
  console.log('\n🚀 Running playwright-system1-triage Demo (Laya-421M Local → Jev API Cascade)...');

  const samples = loadGoldenSamples();
  // Select a representative 8-failure CI run across standard + compound + adversarial scenarios
  const demoSampleIds = [
    'STD-01', // Product defect (premium calculation mismatch)
    'STD-03', // Broken locator (strict mode violation)
    'STD-05', // Flaky timing (cookie banner animation intercept)
    'STD-07', // Environment network (503 Service Unavailable)
    'STD-11', // Test code error (TypeError undefined property)
    'CMP-01', // Compound: Silent 502 Bad Gateway causing surface locator timeout (Escalates to Jev!)
    'CMP-03', // Compound: Expired 401 session redirecting to /login (Escalates to Jev!)
    'ADV-01', // Adversarial: Prompt injection inside DOM text attempting to fake flaky_timing
  ];

  const demoStates = samples
    .filter((s) => demoSampleIds.includes(s.id))
    .map((s) => s.state);

  const engine = new CascadeEngine({
    mode: 'cascade',
    confidenceThreshold: 0.78,
    marginThreshold: 0.28,
  });

  const decisions = await engine.classifyBatch(demoStates);
  const verdict = evaluateQualityGate(decisions, 42);
  const evalReport = await runFullEvaluationSuite();

  const resolvedOut = path.resolve(process.cwd(), outputDir);
  fs.mkdirSync(resolvedOut, { recursive: true });

  const htmlPath = path.join(resolvedOut, 'triage-dashboard.html');
  const mdPath = path.join(resolvedOut, 'triage-summary.md');
  const jsonPath = path.join(resolvedOut, 'triage-verdict.json');

  fs.writeFileSync(htmlPath, generateHtmlDashboard(verdict, decisions, evalReport), 'utf-8');
  fs.writeFileSync(mdPath, generateMarkdownSummary(verdict, decisions), 'utf-8');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ verdict, decisions, evalSummary: evalReport.cascade.classification }, null, 2),
    'utf-8'
  );

  console.log('\n┌────────────────────────────────────────────────────────────────────────────┐');
  console.log(`│ 🛑 CI Quality Gate Verdict: ${verdict.action.padEnd(46)} │`);
  console.log('└────────────────────────────────────────────────────────────────────────────┘');
  console.log(`  Headline         : ${verdict.headline}`);
  console.log(`  Rationale        : ${verdict.rationale}`);
  console.log(`  Total Latency    : ${verdict.totalLatencyMs.toFixed(2)} ms across ${decisions.length} failures`);
  console.log(`  Cascade Split    : ${decisions.filter((d) => !d.escalated).length} Laya-Local (~4.8ms) | ${decisions.filter((d) => d.escalated).length} Escalated to Jev API`);
  console.log(`  Total Batch Cost : $${verdict.totalCostUsd.toFixed(6)}\n`);

  console.log('  Per-Test System 1 Triage Breakdown:');
  for (const d of decisions) {
    const meta = CATEGORY_METADATA[d.winningCategory];
    const route = d.escalated ? '⚡ Laya→Jev' : '🟢 Laya-Local';
    console.log(
      `   [${d.testId}] ${meta.label.padEnd(21)} | Conf: ${(d.topConfidence * 100)
        .toFixed(1)
        .padStart(5)}% | Retryable: ${(d.retryableProbability * 100)
        .toFixed(0)
        .padStart(3)}% | Blocker: ${String(d.releaseBlockerScore).padStart(2)}/100 | ${route.padEnd(12)} | ${d.state.title}`
    );
  }

  console.log('\n  Generated Artifacts:');
  console.log(`   • Interactive HTML Dashboard : ${htmlPath}`);
  console.log(`   • GitHub Actions PR Summary  : ${mdPath}`);
  console.log(`   • Machine-Readable Verdict   : ${jsonPath}\n`);
}

async function runAnalyze(
  reportFile: string,
  outputDir: string,
  enforceGate = false
): Promise<void> {
  const resolvedReport = path.resolve(process.cwd(), reportFile);
  if (!fs.existsSync(resolvedReport)) {
    console.error(`Error: Playwright JSON report file not found at ${resolvedReport}`);
    process.exit(1);
  }

  const rawJson = JSON.parse(fs.readFileSync(resolvedReport, 'utf-8')) as Record<string, unknown>;
  const parsed = parsePlaywrightJsonReport(rawJson);

  const engine = new CascadeEngine({
    mode: 'cascade',
    confidenceThreshold: 0.78,
    marginThreshold: 0.28,
  });

  const decisions = await engine.classifyBatch(parsed.failedStates);
  const verdict = evaluateQualityGate(decisions, parsed.passedCount);

  const resolvedOut = path.resolve(process.cwd(), outputDir);
  fs.mkdirSync(resolvedOut, { recursive: true });

  const htmlPath = path.join(resolvedOut, 'triage-dashboard.html');
  const mdPath = path.join(resolvedOut, 'triage-summary.md');
  const jsonPath = path.join(resolvedOut, 'triage-verdict.json');

  fs.writeFileSync(htmlPath, generateHtmlDashboard(verdict, decisions), 'utf-8');
  fs.writeFileSync(mdPath, generateMarkdownSummary(verdict, decisions), 'utf-8');
  fs.writeFileSync(jsonPath, JSON.stringify({ verdict, decisions }, null, 2), 'utf-8');

  console.log(`\n✅ Analyzed ${parsed.failedStates.length} failed test(s) (${parsed.passedCount} passed).`);
  console.log(`   Verdict        : ${verdict.action} (exitCode=${verdict.exitCode}) — ${verdict.headline}`);
  console.log(`   HTML Dashboard : ${htmlPath}`);
  console.log(`   PR Summary MD  : ${mdPath}`);
  console.log(`   Verdict JSON   : ${jsonPath}\n`);

  if (enforceGate) {
    process.exitCode = verdict.exitCode;
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const enforceGate = rawArgs.includes('--enforce-gate');
  const args = rawArgs.filter((a) => a !== '--enforce-gate');
  const command = args[0] ?? 'demo';

  if (command === 'demo') {
    await runDemo(args[1] ?? 'dist-report');
    return;
  }

  if (command === 'eval') {
    const report = await runFullEvaluationSuite();
    printEvalSummaryToConsole(report);
    return;
  }

  if (command === 'analyze') {
    const targetReport = args[1] ?? 'tests/fixtures/sample-playwright-report.json';
    const outDir = args[2] ?? 'dist-report';
    await runAnalyze(targetReport, outDir, enforceGate);
    return;
  }

  console.log('Usage: pw-triage <demo | eval | analyze [report.json] [outputDir] [--enforce-gate]>');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
