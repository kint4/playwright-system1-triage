export const FAILURE_CATEGORIES = [
  'product_defect',
  'broken_locator',
  'flaky_timing',
  'environment_network',
  'auth_or_data',
  'test_code_error',
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export interface CategoryMetadata {
  id: FailureCategory;
  label: string;
  badgeColor: string;
  description: string;
  system1Criteria: string;
  recommendedAction: string;
}

export const CATEGORY_METADATA: Record<FailureCategory, CategoryMetadata> = {
  product_defect: {
    id: 'product_defect',
    label: 'Product Defect',
    badgeColor: '#ef4444',
    description: 'Functional regression or business logic assertion mismatch in the application under test.',
    system1Criteria:
      'Assertion error where expected business value, text, calculation, or UI state mismatches actual rendered value (e.g. expect(received).toBe(expected), wrong price, missing validation banner).',
    recommendedAction: 'Block PR merge and file defect against application change.',
  },
  broken_locator: {
    id: 'broken_locator',
    label: 'Broken Locator',
    badgeColor: '#f59e0b',
    description: 'DOM selector changed, strict mode found multiple elements, or target element no longer exists.',
    system1Criteria:
      'Playwright strict mode violation (resolved to N elements), invalid selector syntax, or waiting for a specific getByTestId/getByRole locator that was renamed or removed from DOM.',
    recommendedAction: 'Update Page Object / Playwright locator to match current accessibility tree.',
  },
  flaky_timing: {
    id: 'flaky_timing',
    label: 'Flaky / Timing',
    badgeColor: '#8b5cf6',
    description: 'Transient race condition, hydration lag, animation intercept, or element detachment.',
    system1Criteria:
      'Test timeout exceeded while waiting for element stability, pointer event intercepted by overlay/animation, element detached from DOM during hydration, or transient navigation race.',
    recommendedAction: 'Safe to auto-retry in CI; replace hard waits with web-first assertions.',
  },
  environment_network: {
    id: 'environment_network',
    label: 'Environment / Network',
    badgeColor: '#06b6d4',
    description: 'Upstream API 5xx/429 error, gateway timeout, DNS failure, or local/staging server down.',
    system1Criteria:
      'HTTP 500/502/503/504/429 responses, net::ERR_CONNECTION_REFUSED, ECONNRESET, GraphQL upstream timeout, or third-party service unavailability.',
    recommendedAction: 'Check staging health or mock unstable upstream dependency; retry pipeline once healthy.',
  },
  auth_or_data: {
    id: 'auth_or_data',
    label: 'Auth / Test Data',
    badgeColor: '#ec4899',
    description: 'Expired session token, 401/403 unauthorized error, or missing/corrupted database seed state.',
    system1Criteria:
      'HTTP 401 Unauthorized or 403 Forbidden, redirected unexpectedly to /login, expired JWT/storageState, or missing seeded test account/record.',
    recommendedAction: 'Refresh global setup auth state or re-seed test environment fixtures.',
  },
  test_code_error: {
    id: 'test_code_error',
    label: 'Test Script Error',
    badgeColor: '#64748b',
    description: 'Bug inside the Playwright test code or fixture setup itself (TypeError, ReferenceError).',
    system1Criteria:
      'Uncaught TypeError, ReferenceError, SyntaxError, null property access in spec/fixture file, or invalid Playwright API invocation before reaching browser assertion.',
    recommendedAction: 'Fix bug in the test specification or helper fixture.',
  },
};

export interface FailureState {
  testId: string;
  title: string;
  file: string;
  projectName?: string;
  errorMessage: string;
  stackTrace: string;
  failedStep?: string;
  httpStatusCodes: number[];
  consoleErrors: string[];
  durationMs: number;
  timeoutMs: number;
  retryCount: number;
}

export interface System1ChoicePrimitive {
  type: 'choice';
  instructions: string;
  criteria: Record<FailureCategory, string>;
}

export interface System1NoulPrimitive {
  type: 'noul';
  instructions: string;
  criteria?: {
    true: string;
    false: string;
  };
}

export interface System1ScorePrimitive {
  type: 'score';
  instructions: string;
  criteria: string[];
  min?: number;
  max?: number;
}

export interface System1QuestionBundle {
  root_cause: System1ChoicePrimitive;
  retryable: System1NoulPrimitive;
  release_blocker: System1ScorePrimitive;
}

export interface System1RawOutput {
  probabilities: Record<FailureCategory, number>;
  retryableProbability: number;
  releaseBlockerScore: number;
  latencyMs: number;
  estimatedCostUsd: number;
  providerName: 'laya-local' | 'jev-api';
}

export interface System1DecisionResult {
  testId: string;
  state: FailureState;
  winningCategory: FailureCategory;
  probabilities: Record<FailureCategory, number>;
  topConfidence: number;
  secondBestCategory: FailureCategory;
  margin: number;
  retryableProbability: number;
  releaseBlockerScore: number;
  modelUsed: 'laya-local' | 'jev-api' | 'laya->jev-cascade';
  layaInitialCategory?: FailureCategory;
  layaInitialConfidence?: number;
  escalated: boolean;
  escalationReason?: string;
  latencyMs: number;
  estimatedCostUsd: number;
}

export type GateAction =
  | 'PASS'
  | 'BLOCK_MERGE'
  | 'AUTO_RETRY_TRANSIENT'
  | 'ESCALATE_AMBIGUOUS';

export interface QualityGateVerdict {
  action: GateAction;
  headline: string;
  rationale: string;
  exitCode: number;
  totalFailed: number;
  totalPassed: number;
  countsByCategory: Record<FailureCategory, number>;
  releaseBlockers: System1DecisionResult[];
  retryCandidates: System1DecisionResult[];
  ambiguousFailures: System1DecisionResult[];
  totalLatencyMs: number;
  totalCostUsd: number;
  escalationRate: number;
}

export interface CascadeConfig {
  mode: 'cascade' | 'laya-only' | 'jev-only';
  confidenceThreshold: number;
  marginThreshold: number;
  layaBaseUrl?: string;
  typesafeApiKey?: string;
  typesafeBaseUrl?: string;
}

export interface GoldenFailureSample {
  id: string;
  slice: 'standard' | 'compound' | 'adversarial';
  description: string;
  expectedCategory: FailureCategory;
  expectedRetryable: boolean;
  expectedReleaseBlocker: boolean;
  state: FailureState;
}
