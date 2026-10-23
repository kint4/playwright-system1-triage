import fs from 'node:fs';
import path from 'node:path';
import {
  cleanStackTrace,
  extractHttpStatusCodes,
  stripAnsi,
} from '../extractor/stateExtractor.ts';
import { evaluateQualityGate } from '../gate/qualityGate.ts';
import { CascadeEngine } from '../models/cascadeEngine.ts';
import {
  CATEGORY_METADATA,
  type CascadeConfig,
  type FailureState,
} from '../types.ts';
import { generateHtmlDashboard } from './htmlGenerator.ts';
import { generateMarkdownSummary } from './markdownGenerator.ts';

export interface System1ReporterOptions extends Partial<CascadeConfig> {
  outputDir?: string;
}

interface PwTestCase {
  id: string;
  title: string;
  timeout: number;
  titlePath(): string[];
  location?: { file: string; line: number; column: number };
}

interface PwTestResult {
  status: string;
  duration: number;
  retry: number;
  error?: { message?: string; stack?: string };
  stderr: Array<string | Buffer>;
  steps?: Array<{ title: string; error?: unknown }>;
}

/**
 * Native Playwright Custom Reporter that classifies failures in milliseconds
 * using the Laya (Local System 1) -> Jev (TypeSafe API) Confidence Cascade.
 */
export class System1TriageReporter {
  private readonly options: System1ReporterOptions;
  private readonly engine: CascadeEngine;
  private readonly failedStates: FailureState[] = [];
  private passedCount = 0;

  constructor(options?: System1ReporterOptions) {
    this.options = options ?? {};
    this.engine = new CascadeEngine(this.options);
  }

  onTestEnd(test: PwTestCase, result: PwTestResult): void {
    if (result.status === 'passed') {
      this.passedCount++;
      return;
    }

    if (result.status === 'failed' || result.status === 'timedOut') {
      const rawMsg = result.error?.message ?? 'Test failed without message';
      const rawStack = result.error?.stack ?? rawMsg;
      const cleanMsg = stripAnsi(rawMsg);
      const stderrText = (result.stderr ?? [])
        .map((chunk) => (typeof chunk === 'string' ? chunk : chunk.toString('utf-8')))
        .join('\n');

      const combined = `${cleanMsg}\n${rawStack}\n${stderrText}`;
      const httpCodes = extractHttpStatusCodes(combined);
      const failedStep = result.steps?.find((s) => Boolean(s.error))?.title;
      const titlePath = test.titlePath().filter(Boolean);

      this.failedStates.push({
        testId: test.id || titlePath.join('::'),
        title: titlePath.slice(1).join(' › ') || test.title,
        file: test.location?.file ? path.relative(process.cwd(), test.location.file) : 'unknown.spec.ts',
        projectName: titlePath[0] || 'chromium',
        errorMessage: cleanMsg,
        stackTrace: cleanStackTrace(rawStack),
        failedStep,
        httpStatusCodes: httpCodes,
        consoleErrors: stderrText ? stripAnsi(stderrText).split('\n').filter(Boolean).slice(0, 5) : [],
        durationMs: result.duration,
        timeoutMs: test.timeout || 30000,
        retryCount: result.retry,
      });
    }
  }

  async onEnd(): Promise<void> {
    const decisions = await this.engine.classifyBatch(this.failedStates);
    const verdict = evaluateQualityGate(decisions, this.passedCount);

    const outDir = path.resolve(process.cwd(), this.options.outputDir ?? 'dist-report');
    fs.mkdirSync(outDir, { recursive: true });

    const htmlPath = path.join(outDir, 'triage-dashboard.html');
    const mdPath = path.join(outDir, 'triage-summary.md');
    const jsonPath = path.join(outDir, 'triage-verdict.json');

    fs.writeFileSync(htmlPath, generateHtmlDashboard(verdict, decisions), 'utf-8');
    fs.writeFileSync(mdPath, generateMarkdownSummary(verdict, decisions), 'utf-8');
    fs.writeFileSync(jsonPath, JSON.stringify({ verdict, decisions }, null, 2), 'utf-8');

    console.log('\n┌──────────────────────────────────────────────────────────────────────────┐');
    console.log(`│ ⚡ System 1 Playwright Triage Verdict: ${verdict.action.padEnd(33)} │`);
    console.log('└──────────────────────────────────────────────────────────────────────────┘');
    console.log(`  Headline : ${verdict.headline}`);
    console.log(`  Latency  : ${verdict.totalLatencyMs.toFixed(2)} ms (${(verdict.escalationRate * 100).toFixed(0)}% escalated to Jev API)`);

    for (const d of decisions) {
      const meta = CATEGORY_METADATA[d.winningCategory];
      const tag = d.escalated ? 'Laya->Jev' : 'Laya-Local';
      console.log(
        `  • [${meta.label.padEnd(21)}] (conf ${(d.topConfidence * 100).toFixed(1)}%, retry ${(
          d.retryableProbability * 100
        ).toFixed(0)}%, ${tag}) — ${d.state.title}`
      );
    }

    console.log(`\n  📊 HTML Dashboard : ${htmlPath}`);
    console.log(`  📝 PR Summary MD  : ${mdPath}\n`);
  }
}

export default System1TriageReporter;
