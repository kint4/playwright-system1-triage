import {
  CATEGORY_METADATA,
  FAILURE_CATEGORIES,
  type FailureCategory,
  type FailureState,
  type System1QuestionBundle,
} from '../types.ts';

const ANSI_REGEX = /\u001b\[[0-9;]*m/g;
const MAX_ERROR_MESSAGE_LENGTH = 4000;

export function stripAnsi(input: string): string {
  const withoutAnsi = input.replace(ANSI_REGEX, '');
  const redacted = withoutAnsi
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}\b/gi, '$1[REDACTED_TOKEN]')
    .replace(/\b(sk-[A-Za-z0-9-_]{12,})\b/g, '[REDACTED_API_KEY]')
    .replace(/\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?)[^\s'"]{8,}/gi, '$1[REDACTED]');
  return redacted.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH)}... [truncated]`
    : redacted;
}

export function extractHttpStatusCodes(text: string): number[] {
  const found = new Set<number>();
  const patterns = [
    /\bHTTP\/(?:1\.1|2)\s+([45]\d{2})\b/gi,
    /\bstatus(?:\s+code)?[:=\s]+([45]\d{2})\b/gi,
    /\b([45]\d{2})\s+(?:Bad Gateway|Service Unavailable|Gateway Timeout|Internal Server Error|Unauthorized|Forbidden|Too Many Requests|Not Found)\b/gi,
  ];
  for (const regex of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const code = Number.parseInt(match[1], 10);
      if (code >= 400 && code <= 599) {
        found.add(code);
      }
    }
  }
  return Array.from(found);
}

export function cleanStackTrace(rawStack: string, maxLines = 8): string {
  const clean = stripAnsi(rawStack);
  const lines = clean
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.includes('node_modules/playwright-core') &&
        !line.includes('node:internal/')
    );
  return lines.slice(0, maxLines).join('\n');
}

export function buildSystem1Questions(): System1QuestionBundle {
  const criteria = {} as Record<FailureCategory, string>;
  for (const cat of FAILURE_CATEGORIES) {
    criteria[cat] = CATEGORY_METADATA[cat].system1Criteria;
  }

  return {
    root_cause: {
      type: 'choice',
      instructions:
        'Classify the true underlying root cause of this failed Playwright test. Prioritize upstream network/auth errors or test script syntax errors if they caused a downstream UI timeout.',
      criteria,
    },
    retryable: {
      type: 'noul',
      instructions:
        'Will re-running this test immediately in CI without changing application or test code likely succeed (transient flake/timing/network)?',
      criteria: {
        true: 'The failure is caused by a transient timing race, hydration lag, animation intercept, or temporary 5xx/429 upstream network glitch that can succeed on immediate retry.',
        false: 'The failure is a deterministic product bug, broken DOM selector, expired auth fixture, or test script syntax error that will fail again until code or data is fixed.',
      },
    },
    release_blocker: {
      type: 'score',
      instructions:
        'Rate how strongly this failure indicates a genuine product regression that must block production release.',
      criteria: [
        'Not a product regression (transient flake, test script bug, or environment/network outage)',
        'Unlikely product regression (probable locator drift or auth/test-data fixture issue)',
        'Ambiguous failure requiring human QA triage before release',
        'Probable product defect impacting an application workflow',
        'Definite functional regression or business-logic failure that must block merge',
      ],
      min: 0,
      max: 100,
    },
  };
}

export interface ParsedPlaywrightReport {
  totalTests: number;
  passedCount: number;
  failedStates: FailureState[];
}

/**
 * Parses a standard Playwright JSON report (`npx playwright test --reporter=json`)
 * into normalized `FailureState` objects ready for System 1 classification.
 */
export function parsePlaywrightJsonReport(reportJson: Record<string, unknown>): ParsedPlaywrightReport {
  const failedStates: FailureState[] = [];
  let totalTests = 0;
  let passedCount = 0;

  function walkSuite(suite: Record<string, unknown>, parentTitlePath: string[] = []): void {
    const suiteTitle = typeof suite.title === 'string' && suite.title ? [...parentTitlePath, suite.title] : parentTitlePath;
    const specs = Array.isArray(suite.specs) ? suite.specs : [];

    for (const spec of specs as Array<Record<string, unknown>>) {
      const specTitle = typeof spec.title === 'string' ? spec.title : 'Untitled test';
      const file = typeof spec.file === 'string' ? spec.file : (typeof suite.file === 'string' ? suite.file : 'unknown.spec.ts');
      const tests = Array.isArray(spec.tests) ? spec.tests : [];

      for (const testItem of tests as Array<Record<string, unknown>>) {
        totalTests++;
        const projectName = typeof testItem.projectName === 'string' ? testItem.projectName : 'chromium';
        const results = Array.isArray(testItem.results) ? (testItem.results as Array<Record<string, unknown>>) : [];
        const lastResult = results[results.length - 1] ?? {};
        const status = typeof lastResult.status === 'string' ? lastResult.status : (typeof testItem.status === 'string' ? testItem.status : 'unknown');

        if (status === 'passed' || status === 'expected') {
          passedCount++;
          continue;
        }

        if (status === 'failed' || status === 'timedOut' || status === 'unexpected') {
          const errorObj = (lastResult.error as Record<string, unknown>) ?? {};
          const rawMsg = typeof errorObj.message === 'string' ? errorObj.message : 'Test failed without error message';
          const rawStack = typeof errorObj.stack === 'string' ? errorObj.stack : rawMsg;
          const cleanMsg = stripAnsi(rawMsg);
          const stderrList = Array.isArray(lastResult.stderr)
            ? (lastResult.stderr as Array<Record<string, unknown>>).map((e) => String(e.text ?? '')).join('\n')
            : '';

          const combinedLog = `${cleanMsg}\n${rawStack}\n${stderrList}`;
          const httpCodes = extractHttpStatusCodes(combinedLog);

          failedStates.push({
            testId: String(spec.id ?? `${file}::${specTitle}`),
            title: [...suiteTitle, specTitle].filter(Boolean).join(' › '),
            file,
            projectName,
            errorMessage: cleanMsg,
            stackTrace: cleanStackTrace(rawStack),
            failedStep: typeof lastResult.failedStep === 'string' ? lastResult.failedStep : undefined,
            httpStatusCodes: httpCodes,
            consoleErrors: stderrList ? stderrList.split('\n').filter(Boolean).slice(0, 5) : [],
            durationMs: typeof lastResult.duration === 'number' ? lastResult.duration : 0,
            timeoutMs: typeof testItem.timeout === 'number' ? testItem.timeout : 30000,
            retryCount: Math.max(0, results.length - 1),
          });
        }
      }
    }

    const childSuites = Array.isArray(suite.suites) ? suite.suites : [];
    for (const child of childSuites as Array<Record<string, unknown>>) {
      walkSuite(child, suiteTitle);
    }
  }

  const rootSuites = Array.isArray(reportJson.suites) ? reportJson.suites : [];
  for (const s of rootSuites as Array<Record<string, unknown>>) {
    walkSuite(s, []);
  }

  return {
    totalTests,
    passedCount,
    failedStates,
  };
}
