import { buildSystem1Questions } from '../extractor/stateExtractor.ts';
import {
  FAILURE_CATEGORIES,
  type CascadeConfig,
  type FailureCategory,
  type FailureState,
  type System1DecisionResult,
  type System1RawOutput,
} from '../types.ts';
import { JevAdapter } from './jevAdapter.ts';
import { LayaAdapter } from './layaAdapter.ts';

function rankProbabilities(probabilities: Record<FailureCategory, number>): {
  winningCategory: FailureCategory;
  topConfidence: number;
  secondBestCategory: FailureCategory;
  margin: number;
} {
  const sorted = [...FAILURE_CATEGORIES].sort(
    (a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0)
  );
  const winningCategory = sorted[0];
  const secondBestCategory = sorted[1];
  const topConfidence = Number((probabilities[winningCategory] ?? 0).toFixed(4));
  const secondConfidence = Number((probabilities[secondBestCategory] ?? 0).toFixed(4));
  const margin = Number((topConfidence - secondConfidence).toFixed(4));

  return {
    winningCategory,
    topConfidence,
    secondBestCategory,
    margin,
  };
}

export class CascadeEngine {
  private readonly config: CascadeConfig;
  private readonly laya: LayaAdapter;
  private readonly jev: JevAdapter;
  private readonly questions = buildSystem1Questions();

  constructor(config?: Partial<CascadeConfig>) {
    this.config = {
      mode: config?.mode ?? 'cascade',
      confidenceThreshold: config?.confidenceThreshold ?? 0.78,
      marginThreshold: config?.marginThreshold ?? 0.28,
      layaBaseUrl: config?.layaBaseUrl,
      typesafeApiKey: config?.typesafeApiKey,
      typesafeBaseUrl: config?.typesafeBaseUrl,
    };
    this.laya = new LayaAdapter({ baseUrl: this.config.layaBaseUrl });
    this.jev = new JevAdapter({
      apiKey: this.config.typesafeApiKey,
      baseUrl: this.config.typesafeBaseUrl,
    });
  }

  getConfig(): CascadeConfig {
    return { ...this.config };
  }

  async classifyFailure(state: FailureState): Promise<System1DecisionResult> {
    if (this.config.mode === 'jev-only') {
      const jevOut = await this.jev.evaluate(state, this.questions);
      return this.toDecisionResult(state, jevOut, {
        modelUsed: 'jev-api',
        escalated: false,
      });
    }

    const layaOut = await this.laya.evaluate(state, this.questions);
    const layaRanked = rankProbabilities(layaOut.probabilities);

    if (this.config.mode === 'laya-only') {
      return this.toDecisionResult(state, layaOut, {
        modelUsed: 'laya-local',
        escalated: false,
      });
    }

    // Confidence Cascade Gate: Check both top-1 probability and top-2 margin
    const lowTopConfidence = layaRanked.topConfidence < this.config.confidenceThreshold;
    const lowMargin = layaRanked.margin < this.config.marginThreshold;

    if (!lowTopConfidence && !lowMargin) {
      return this.toDecisionResult(state, layaOut, {
        modelUsed: 'laya-local',
        escalated: false,
      });
    }

    const reasons: string[] = [];
    if (lowTopConfidence) {
      reasons.push(
        `Laya P(${layaRanked.winningCategory})=${(layaRanked.topConfidence * 100).toFixed(1)}% < τ=${(
          this.config.confidenceThreshold * 100
        ).toFixed(0)}%`
      );
    }
    if (lowMargin) {
      reasons.push(
        `margin Δ=${(layaRanked.margin * 100).toFixed(1)}% (${layaRanked.winningCategory} vs ${
          layaRanked.secondBestCategory
        }) < ${(this.config.marginThreshold * 100).toFixed(0)}%`
      );
    }

    const jevOut = await this.jev.evaluate(state, this.questions);
    const combinedOutput: System1RawOutput = {
      ...jevOut,
      latencyMs: Number((layaOut.latencyMs + jevOut.latencyMs).toFixed(2)),
      estimatedCostUsd: Number((layaOut.estimatedCostUsd + jevOut.estimatedCostUsd).toFixed(6)),
    };

    return this.toDecisionResult(state, combinedOutput, {
      modelUsed: 'laya->jev-cascade',
      escalated: true,
      escalationReason: reasons.join('; '),
      layaInitialCategory: layaRanked.winningCategory,
      layaInitialConfidence: layaRanked.topConfidence,
    });
  }

  async classifyBatch(states: FailureState[]): Promise<System1DecisionResult[]> {
    const concurrency = 5;
    const results: System1DecisionResult[] = [];
    for (let i = 0; i < states.length; i += concurrency) {
      const chunk = states.slice(i, i + concurrency);
      const chunkResults = await Promise.all(chunk.map((st) => this.classifyFailure(st)));
      results.push(...chunkResults);
    }
    return results;
  }

  private toDecisionResult(
    state: FailureState,
    raw: System1RawOutput,
    meta: {
      modelUsed: 'laya-local' | 'jev-api' | 'laya->jev-cascade';
      escalated: boolean;
      escalationReason?: string;
      layaInitialCategory?: FailureCategory;
      layaInitialConfidence?: number;
    }
  ): System1DecisionResult {
    const ranked = rankProbabilities(raw.probabilities);
    return {
      testId: state.testId,
      state,
      winningCategory: ranked.winningCategory,
      probabilities: raw.probabilities,
      topConfidence: ranked.topConfidence,
      secondBestCategory: ranked.secondBestCategory,
      margin: ranked.margin,
      retryableProbability: raw.retryableProbability,
      releaseBlockerScore: raw.releaseBlockerScore,
      modelUsed: meta.modelUsed,
      layaInitialCategory: meta.layaInitialCategory,
      layaInitialConfidence: meta.layaInitialConfidence,
      escalated: meta.escalated,
      escalationReason: meta.escalationReason,
      latencyMs: raw.latencyMs,
      estimatedCostUsd: raw.estimatedCostUsd,
    };
  }
}
