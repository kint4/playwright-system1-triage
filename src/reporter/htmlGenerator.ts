import type { FullEvalSuiteReport } from '../../evals/runEvals.ts';
import {
  CATEGORY_METADATA,
  FAILURE_CATEGORIES,
  type FailureCategory,
  type QualityGateVerdict,
  type System1DecisionResult,
} from '../types.ts';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function summarizeErrorOneLine(rawError: string): string {
  const firstMeaningful = rawError
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstMeaningful) return 'Test failed without an error message.';
  return firstMeaningful.length > 125
    ? `${firstMeaningful.slice(0, 122)}...`
    : firstMeaningful;
}

function explainDecisionPlainly(d: System1DecisionResult): string {
  const codes = d.state.httpStatusCodes;
  const has5xx = codes.some((c) => c >= 500 || c === 429);
  const has401 = codes.some((c) => c === 401 || c === 403);

  switch (d.winningCategory) {
    case 'product_defect':
      return 'The page loaded and the test ran, but the rendered UI value did not match expected business logic.';
    case 'broken_locator':
      return 'Playwright could not uniquely resolve the target DOM selector (renamed, removed, or matched multiple elements).';
    case 'flaky_timing':
      return 'A transient UI race condition, animation overlay, or DOM detachment interrupted the interaction.';
    case 'environment_network':
      return has5xx
        ? `Upstream service returned HTTP ${codes.filter((c) => c >= 500 || c === 429).join(', ')}, causing the UI step to fail.`
        : 'An upstream network timeout or staging connectivity failure prevented the page from responding.';
    case 'auth_or_data':
      return has401
        ? `Request failed with HTTP ${codes.filter((c) => c === 401 || c === 403).join(', ')}. Session token or seeded test account is invalid.`
        : 'Session state expired or required seed data was missing before the assertion could complete.';
    case 'test_code_error':
      return 'The test script or fixture threw a runtime JavaScript exception before reaching the browser check.';
  }
}

export function generateHtmlDashboard(
  verdict: QualityGateVerdict,
  decisions: System1DecisionResult[],
  evalReport?: FullEvalSuiteReport
): string {
  const gateThemes: Record<
    QualityGateVerdict['action'],
    {
      pill: string;
      accent: string;
      softBg: string;
      border: string;
      humanSummary: string;
    }
  > = {
    PASS: {
      pill: 'Ready to Merge',
      accent: '#10b981',
      softBg: 'rgba(16, 185, 129, 0.07)',
      border: 'rgba(16, 185, 129, 0.28)',
      humanSummary: 'Every Playwright check passed. No action required.',
    },
    BLOCK_MERGE: {
      pill: 'Do Not Merge',
      accent: '#f43f5e',
      softBg: 'rgba(244, 63, 94, 0.07)',
      border: 'rgba(244, 63, 94, 0.28)',
      humanSummary:
        'At least one failure looks like a real product regression in the application. Re-running CI will not fix it.',
    },
    AUTO_RETRY_TRANSIENT: {
      pill: 'Safe to Auto-Retry',
      accent: '#a78bfa',
      softBg: 'rgba(167, 139, 250, 0.07)',
      border: 'rgba(167, 139, 250, 0.28)',
      humanSummary:
        'All failures are temporary timing races or upstream network blips. Safe to re-run failed specs automatically.',
    },
    ESCALATE_AMBIGUOUS: {
      pill: 'Needs QA Review',
      accent: '#f59e0b',
      softBg: 'rgba(245, 158, 11, 0.07)',
      border: 'rgba(245, 158, 11, 0.28)',
      humanSummary:
        'No clear product bugs were found, but broken selectors, auth fixtures, or test script errors need maintenance.',
    },
  };

  const theme = gateThemes[verdict.action];

  // Action buckets for human workload summary
  const appBugsCount = verdict.releaseBlockers.length;
  const retrySafeCount = decisions.filter(
    (d) =>
      d.retryableProbability >= 0.7 ||
      d.winningCategory === 'flaky_timing' ||
      d.winningCategory === 'environment_network'
  ).length;
  const qaMaintCount = decisions.filter(
    (d) =>
      d.winningCategory === 'broken_locator' ||
      d.winningCategory === 'auth_or_data' ||
      d.winningCategory === 'test_code_error'
  ).length;

  // Stacked composition segments across failed categories
  const totalFailed = Math.max(1, decisions.length);
  const compositionSegments = FAILURE_CATEGORIES.filter(
    (cat) => (verdict.countsByCategory[cat] ?? 0) > 0
  )
    .map((cat) => {
      const count = verdict.countsByCategory[cat] ?? 0;
      const pct = (count / totalFailed) * 100;
      const meta = CATEGORY_METADATA[cat];
      return `<div class="comp-seg" style="width:${pct.toFixed(1)}%; background:${meta.badgeColor}" title="${escapeHtml(meta.label)}: ${count}"></div>`;
    })
    .join('');

  const categoryFilterButtons = FAILURE_CATEGORIES.map((cat) => {
    const meta = CATEGORY_METADATA[cat];
    const count = verdict.countsByCategory[cat] ?? 0;
    if (count === 0) return '';
    return `<button class="filter-chip" data-cat="${cat}" onclick="filterCards('${cat}')">
      <span class="chip-dot" style="background:${meta.badgeColor}"></span>
      <span>${escapeHtml(meta.label)}</span>
      <span class="chip-num">${count}</span>
    </button>`;
  })
    .filter(Boolean)
    .join('\n');

  const cardsHtml = decisions
    .map((d, idx) => {
      const meta = CATEGORY_METADATA[d.winningCategory];
      const sortedProbs = [...FAILURE_CATEGORIES].sort(
        (a, b) => (d.probabilities[b] ?? 0) - (d.probabilities[a] ?? 0)
      );

      const probBars = sortedProbs
        .map((cat: FailureCategory) => {
          const catMeta = CATEGORY_METADATA[cat];
          const p = (d.probabilities[cat] ?? 0) * 100;
          const isWinner = cat === d.winningCategory;
          return `<div class="prob-row ${isWinner ? 'winner' : ''}">
            <div class="prob-label">
              <span class="chip-dot" style="background:${catMeta.badgeColor}"></span>
              ${escapeHtml(catMeta.label)}
            </div>
            <div class="prob-track">
              <div class="prob-fill" style="width:${Math.max(1.5, p).toFixed(1)}%; background:${isWinner ? catMeta.badgeColor : '#3f3f46'}"></div>
            </div>
            <div class="prob-val">${p.toFixed(1)}%</div>
          </div>`;
        })
        .join('');

      const retryPct = Math.round(d.retryableProbability * 100);
      const retryLabel =
        retryPct >= 70
          ? `Likely passes on retry (${retryPct}%)`
          : retryPct >= 40
            ? `Uncertain retry (${retryPct}%)`
            : `Will fail again if retried (${retryPct}%)`;
      const retryClass =
        retryPct >= 70 ? 'pill-good' : retryPct >= 40 ? 'pill-warn' : 'pill-neutral';

      const blockerLabel =
        d.releaseBlockerScore >= 70
          ? `Blocks release (${d.releaseBlockerScore}/100)`
          : `Non-blocking (${d.releaseBlockerScore}/100)`;
      const blockerClass = d.releaseBlockerScore >= 70 ? 'pill-danger' : 'pill-neutral';

      const routeLabel = d.escalated
        ? `Escalated to Jev API · ${d.latencyMs}ms`
        : `Local Laya · ${d.latencyMs}ms`;

      const escalationStory = d.escalated
        ? `<div class="cascade-note">
            <span class="cascade-icon">↗</span>
            <div>
              <strong>Why this escalated to Jev Cloud API:</strong> Local Laya was uncertain (${escapeHtml(
                CATEGORY_METADATA[d.layaInitialCategory ?? d.winningCategory].label
              )} at ${((d.layaInitialConfidence ?? 0) * 100).toFixed(0)}%) because surface UI symptoms conflicted with background logs. Jev resolved it as <strong>${escapeHtml(meta.label)}</strong> (${(d.topConfidence * 100).toFixed(0)}% confidence).
            </div>
          </div>`
        : '';

      const httpBadges =
        d.state.httpStatusCodes.length > 0
          ? d.state.httpStatusCodes
              .map((code) => `<span class="code-pill http-err">HTTP ${code}</span>`)
              .join('')
          : '';

      return `<article class="triage-card" data-category="${d.winningCategory}">
        <div class="card-top">
          <div class="card-top-left">
            <span class="category-tag" style="color:${meta.badgeColor}; border-color:${meta.badgeColor}44; background:${meta.badgeColor}12">
              <span class="chip-dot" style="background:${meta.badgeColor}"></span>
              ${escapeHtml(meta.label)}
            </span>
            <span class="conf-label">${(d.topConfidence * 100).toFixed(0)}% confidence</span>
            ${httpBadges}
          </div>
          <div class="card-top-right">
            <span class="signal-pill ${retryClass}">${retryLabel}</span>
            <span class="signal-pill ${blockerClass}">${blockerLabel}</span>
          </div>
        </div>

        <h3 class="spec-title">${escapeHtml(d.state.title)}</h3>
        <div class="spec-meta">
          <span class="mono">${escapeHtml(d.state.file)}</span>
          <span>·</span>
          <span>${escapeHtml(d.state.projectName ?? 'chromium')}</span>
          <span>·</span>
          <span>${(d.state.durationMs / 1000).toFixed(1)}s</span>
          <span>·</span>
          <span class="mono">${routeLabel}</span>
        </div>

        <p class="plain-diagnosis">${escapeHtml(explainDecisionPlainly(d))}</p>

        <div class="error-snippet mono">${escapeHtml(summarizeErrorOneLine(d.state.errorMessage))}</div>

        ${escalationStory}

        <div class="card-footer">
          <div class="next-step">
            <span class="step-label">Next step</span>
            <span>${escapeHtml(meta.recommendedAction)}</span>
          </div>
          <button class="drawer-btn" onclick="toggleDrawer('drawer-${idx}', this)">
            <span>Details &amp; Model Scores</span>
            <span class="chevron">↓</span>
          </button>
        </div>

        <div id="drawer-${idx}" class="card-drawer" style="display:none">
          <div class="drawer-grid">
            <div class="drawer-col">
              <div class="drawer-heading">Model Probability Breakdown (6 Classes)</div>
              <div class="prob-list">${probBars}</div>
              <div class="drawer-footnote">
                Top-2 Margin: <strong>${(d.margin * 100).toFixed(1)}%</strong> (Runner-up: ${escapeHtml(
                  CATEGORY_METADATA[d.secondBestCategory].label
                )})
              </div>
            </div>
            <div class="drawer-col">
              <div class="drawer-heading">Playwright Error &amp; Telemetry</div>
              ${
                d.state.consoleErrors.length > 0
                  ? `<div class="log-label">Console / Network Logs</div><pre class="log-pre">${escapeHtml(
                      d.state.consoleErrors.join('\n')
                    )}</pre>`
                  : ''
              }
              <div class="log-label">Failure Trace</div>
              <pre class="log-pre">${escapeHtml(d.state.errorMessage)}\n\n${escapeHtml(
                d.state.stackTrace
              )}</pre>
            </div>
          </div>
        </div>
      </article>`;
    })
    .join('\n');

  const evalTabHtml = evalReport
    ? `
    <section id="tab-eval" class="tab-panel" style="display:none">
      <div class="editorial-intro">
        <div class="eyebrow">Benchmark &amp; Calibration</div>
        <h2 class="editorial-title">Why pair a local model with a cloud model?</h2>
        <p class="editorial-lead">
          We tested three setups across <strong>${evalReport.datasetSize} curated Playwright failures</strong>:
          12 standard single-cause errors, 6 compound failures (where a hidden API 502/401 caused a UI timeout),
          and 2 prompt-injection attacks.
        </p>
      </div>

      <div class="benchmark-trio">
        ${[
          {
            data: evalReport.layaOnly,
            tag: 'Fastest · $0 Cost',
            story:
              'Runs locally in ~5ms. Perfect on single-signal failures (100%), but gets confused when a silent backend 502 masks as a UI timeout (33%).',
            featured: false,
          },
          {
            data: evalReport.jevOnly,
            tag: 'Highest Accuracy · Cloud API',
            story:
              'Connects cross-field HTTP and console logs to solve 100% of standard, compound, and adversarial failures, at the cost of network latency.',
            featured: false,
          },
          {
            data: evalReport.cascade,
            tag: 'Recommended Default (τ = 0.78)',
            story:
              'Resolves 75% of clear failures locally via Laya and escalates only uncertain cases (25%) to Jev—cutting latency 4× while keeping 95% accuracy.',
            featured: true,
          },
        ]
          .map(
            ({ data: m, tag, story, featured }) => `
          <div class="bench-card ${featured ? 'featured' : ''}">
            <div class="bench-tag">${escapeHtml(tag)}</div>
            <h3 class="bench-name">${escapeHtml(m.modeName)}</h3>
            <div class="bench-hero">
              <span class="bench-number">${(m.classification.overallAccuracy * 100).toFixed(0)}%</span>
              <span class="bench-unit">overall accuracy</span>
            </div>
            <p class="bench-story">${escapeHtml(story)}</p>
            <div class="bench-metrics">
              <div class="bm-row"><span>Standard failures (12)</span><strong class="mono">${(m.classification.sliceAccuracy.standard * 100).toFixed(0)}%</strong></div>
              <div class="bm-row"><span>Compound failures (6)</span><strong class="mono">${(m.classification.sliceAccuracy.compound * 100).toFixed(0)}%</strong></div>
              <div class="bm-row"><span>Adversarial injections (2)</span><strong class="mono">${(m.classification.sliceAccuracy.adversarial * 100).toFixed(0)}%</strong></div>
              <div class="bm-row"><span>Calibration error (ECE ↓)</span><strong class="mono">${m.calibration.ece.toFixed(4)}</strong></div>
              <div class="bm-row"><span>Average latency</span><strong class="mono">${m.avgLatencyMs} ms</strong></div>
              <div class="bm-row"><span>Cloud API calls</span><strong class="mono">${(m.escalationRate * 100).toFixed(0)}%</strong></div>
            </div>
          </div>`
          )
          .join('')}
      </div>

      <div class="eval-split">
        <div class="panel-card">
          <div class="eyebrow">Tuning the Gate</div>
          <h3>How the confidence threshold (τ) controls cost vs. accuracy</h3>
          <p class="panel-sub">
            When Laya's top probability falls below <code>τ</code>, the failure escalates to Jev. Raising <code>τ</code> catches more compound bugs but makes more cloud calls.
          </p>
          <table class="clean-table">
            <thead>
              <tr>
                <th>Threshold</th>
                <th>Accuracy</th>
                <th>Sent to Jev</th>
                <th>Avg Latency</th>
              </tr>
            </thead>
            <tbody>
              ${evalReport.thresholdSweep
                .map(
                  (pt) => `<tr class="${pt.threshold === 0.78 ? 'highlight-row' : ''}">
                    <td class="mono">τ = ${pt.threshold.toFixed(2)} ${pt.threshold === 0.78 ? '<span class="inline-badge">Sweet spot</span>' : ''}</td>
                    <td><strong>${(pt.accuracy * 100).toFixed(0)}%</strong></td>
                    <td>
                      <div class="mini-bar-wrap">
                        <div class="mini-bar" style="width:${(pt.escalationRate * 100).toFixed(0)}%"></div>
                        <span class="mono">${(pt.escalationRate * 100).toFixed(0)}%</span>
                      </div>
                    </td>
                    <td class="mono">${pt.avgLatencyMs} ms</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>

        <div class="panel-card">
          <div class="eyebrow">Trusting the Numbers</div>
          <h3>Can CI trust the model's confidence score?</h3>
          <p class="panel-sub">
            Calibration measures whether "90% confidence" actually means the model is right 90% of the time. Lower gap = safer automation (Cascade ECE: <code class="mono">${evalReport.cascade.calibration.ece.toFixed(4)}</code>).
          </p>
          <table class="clean-table">
            <thead>
              <tr>
                <th>Confidence Range</th>
                <th>Tests</th>
                <th>Model Confidence</th>
                <th>Actual Accuracy</th>
              </tr>
            </thead>
            <tbody>
              ${evalReport.cascade.calibration.bins
                .filter((b) => b.count > 0)
                .map(
                  (b) => `<tr>
                    <td class="mono">${escapeHtml(b.rangeLabel)}</td>
                    <td class="mono">${b.count}</td>
                    <td class="mono">${(b.avgConfidence * 100).toFixed(1)}%</td>
                    <td><strong>${(b.empiricalAccuracy * 100).toFixed(1)}%</strong></td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Playwright Triage Report — ${escapeHtml(verdict.action)}</title>
  <style>
    :root {
      --bg: #09090b;
      --surface: #121215;
      --surface-elevated: #18181c;
      --border: rgba(255, 255, 255, 0.08);
      --border-strong: rgba(255, 255, 255, 0.15);
      --text: #fafafa;
      --text-secondary: #a1a1aa;
      --text-muted: #71717a;
      --sans: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI", sans-serif;
      --serif: "Instrument Serif", "Newsreader", "Iowan Old Style", Georgia, serif;
      --mono: "SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background-color: var(--bg);
      background-image: radial-gradient(ellipse 80% 50% at 50% -20%, ${theme.softBg}, transparent);
      color: var(--text);
      font-family: var(--sans);
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }

    .shell {
      max-width: 1040px;
      margin: 0 auto;
      padding: 44px 24px 88px;
    }

    /* Top bar */
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 40px;
    }

    .brand {
      display: flex;
      align-items: baseline;
      gap: 12px;
    }

    .brand-mark {
      font-size: 0.95rem;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--text);
    }

    .brand-sub {
      font-size: 0.82rem;
      color: var(--text-muted);
    }

    .tabs {
      display: inline-flex;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 3px;
    }

    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      padding: 7px 16px;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .tab-btn.active {
      background: var(--surface-elevated);
      color: var(--text);
      box-shadow: 0 1px 2px rgba(0,0,0,0.4);
    }

    /* Hero Verdict Section */
    .hero {
      border: 1px solid ${theme.border};
      background: linear-gradient(180deg, ${theme.softBg} 0%, rgba(18, 18, 21, 0.6) 100%);
      border-radius: 16px;
      padding: 32px;
      margin-bottom: 28px;
    }

    .verdict-eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 0.76rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: ${theme.accent};
      margin-bottom: 12px;
    }

    .verdict-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: ${theme.accent};
      box-shadow: 0 0 10px ${theme.accent};
    }

    .verdict-headline {
      margin: 0 0 10px;
      font-size: 1.85rem;
      font-weight: 600;
      letter-spacing: -0.025em;
      line-height: 1.2;
    }

    .verdict-explain {
      margin: 0 0 28px;
      color: var(--text-secondary);
      font-size: 0.98rem;
      max-width: 720px;
    }

    /* Workload Summary Grid */
    .workload-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      padding-top: 22px;
      border-top: 1px solid var(--border);
    }

    @media (max-width: 760px) {
      .workload-grid { grid-template-columns: repeat(2, 1fr); }
    }

    .stat-cell {
      padding: 4px 0;
    }

    .stat-label {
      font-size: 0.76rem;
      color: var(--text-muted);
      margin-bottom: 4px;
    }

    .stat-val {
      font-size: 1.35rem;
      font-weight: 600;
      letter-spacing: -0.02em;
    }

    .stat-note {
      font-size: 0.76rem;
      color: var(--text-secondary);
      margin-top: 2px;
    }

    /* Composition bar */
    .comp-wrap {
      margin-bottom: 28px;
    }

    .comp-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.78rem;
      color: var(--text-muted);
      margin-bottom: 8px;
    }

    .comp-bar {
      display: flex;
      height: 6px;
      border-radius: 999px;
      overflow: hidden;
      background: var(--surface);
      gap: 2px;
    }

    .comp-seg {
      height: 100%;
      border-radius: 999px;
    }

    /* Filter chips */
    .filter-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 20px;
    }

    .filter-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 6px 13px;
      border-radius: 999px;
      font-size: 0.8rem;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .filter-chip:hover {
      border-color: var(--border-strong);
      color: var(--text);
    }

    .filter-chip.active {
      background: var(--text);
      color: var(--bg);
      border-color: var(--text);
      font-weight: 500;
    }

    .filter-chip.active .chip-num {
      color: var(--bg);
      opacity: 0.7;
    }

    .chip-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }

    .chip-num {
      font-family: var(--mono);
      font-size: 0.74rem;
      color: var(--text-muted);
    }

    /* Failure Cards */
    .triage-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 24px;
      margin-bottom: 14px;
      transition: border-color 0.15s ease;
    }

    .triage-card:hover {
      border-color: var(--border-strong);
    }

    .card-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 12px;
    }

    .card-top-left, .card-top-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .category-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 0.76rem;
      font-weight: 600;
      border: 1px solid transparent;
    }

    .conf-label {
      font-size: 0.78rem;
      color: var(--text-muted);
      font-family: var(--mono);
    }

    .code-pill {
      font-family: var(--mono);
      font-size: 0.72rem;
      padding: 2px 8px;
      border-radius: 6px;
    }

    .http-err {
      background: rgba(244, 63, 94, 0.12);
      color: #fda4af;
      border: 1px solid rgba(244, 63, 94, 0.25);
    }

    .signal-pill {
      font-size: 0.75rem;
      padding: 3px 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      color: var(--text-secondary);
    }

    .pill-good {
      color: #6ee7b7;
      border-color: rgba(16, 185, 129, 0.28);
      background: rgba(16, 185, 129, 0.08);
    }

    .pill-warn {
      color: #fcd34d;
      border-color: rgba(245, 158, 11, 0.28);
      background: rgba(245, 158, 11, 0.08);
    }

    .pill-danger {
      color: #fda4af;
      border-color: rgba(244, 63, 94, 0.3);
      background: rgba(244, 63, 94, 0.1);
    }

    .spec-title {
      margin: 0 0 4px;
      font-size: 1.08rem;
      font-weight: 600;
      letter-spacing: -0.01em;
    }

    .spec-meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      font-size: 0.78rem;
      color: var(--text-muted);
      margin-bottom: 14px;
    }

    .mono {
      font-family: var(--mono);
    }

    .plain-diagnosis {
      margin: 0 0 12px;
      color: #e4e4e7;
      font-size: 0.92rem;
    }

    .error-snippet {
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px 12px;
      font-size: 0.78rem;
      color: var(--text-secondary);
      overflow-x: auto;
      white-space: nowrap;
      margin-bottom: 14px;
    }

    .cascade-note {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      background: rgba(56, 189, 248, 0.06);
      border: 1px solid rgba(56, 189, 248, 0.2);
      border-radius: 10px;
      padding: 10px 14px;
      font-size: 0.82rem;
      color: #bae6fd;
      margin-bottom: 14px;
    }

    .cascade-icon {
      font-family: var(--mono);
      font-weight: 700;
      color: #38bdf8;
    }

    .card-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }

    .next-step {
      font-size: 0.84rem;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .step-label {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 2px 7px;
      border-radius: 4px;
      background: var(--surface-elevated);
      color: var(--text-muted);
      font-weight: 600;
    }

    .drawer-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 5px 12px;
      border-radius: 8px;
      font-size: 0.78rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }

    .drawer-btn:hover {
      border-color: var(--border-strong);
      color: var(--text);
    }

    .card-drawer {
      margin-top: 18px;
      padding-top: 18px;
      border-top: 1px dashed var(--border);
    }

    .drawer-grid {
      display: grid;
      grid-template-columns: 1fr 1.3fr;
      gap: 24px;
    }

    @media (max-width: 820px) {
      .drawer-grid { grid-template-columns: 1fr; }
    }

    .drawer-heading {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      margin-bottom: 12px;
      font-weight: 600;
    }

    .prob-row {
      display: grid;
      grid-template-columns: 155px 1fr 48px;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
      font-size: 0.8rem;
      color: var(--text-secondary);
    }

    .prob-row.winner {
      color: var(--text);
      font-weight: 500;
    }

    .prob-label {
      display: flex;
      align-items: center;
      gap: 7px;
    }

    .prob-track {
      height: 6px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 999px;
      overflow: hidden;
    }

    .prob-fill {
      height: 100%;
      border-radius: 999px;
    }

    .prob-val {
      text-align: right;
      font-family: var(--mono);
      font-size: 0.76rem;
    }

    .drawer-footnote {
      margin-top: 12px;
      font-size: 0.78rem;
      color: var(--text-muted);
    }

    .log-label {
      font-size: 0.74rem;
      color: var(--text-muted);
      margin: 8px 0 4px;
    }

    .log-pre {
      margin: 0 0 10px;
      padding: 12px;
      background: #050507;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-family: var(--mono);
      font-size: 0.76rem;
      color: #d4d4d8;
      overflow-x: auto;
      line-height: 1.45;
    }

    /* Tab 2: Editorial Benchmark */
    .editorial-intro {
      margin-bottom: 32px;
    }

    .eyebrow {
      font-size: 0.74rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
      margin-bottom: 6px;
      font-weight: 600;
    }

    .editorial-title {
      font-family: var(--serif);
      font-weight: 400;
      font-size: 2.2rem;
      margin: 0 0 10px;
      letter-spacing: -0.01em;
    }

    .editorial-lead {
      margin: 0;
      color: var(--text-secondary);
      font-size: 0.96rem;
      max-width: 680px;
    }

    .benchmark-trio {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }

    @media (max-width: 860px) {
      .benchmark-trio { grid-template-columns: 1fr; }
    }

    .bench-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 24px;
      display: flex;
      flex-direction: column;
    }

    .bench-card.featured {
      border-color: rgba(250, 250, 250, 0.35);
      background: linear-gradient(180deg, rgba(255,255,255,0.04) 0%, var(--surface) 100%);
    }

    .bench-tag {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    .bench-name {
      margin: 0 0 16px;
      font-size: 1rem;
      font-weight: 600;
    }

    .bench-hero {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 12px;
    }

    .bench-number {
      font-family: var(--serif);
      font-size: 3rem;
      line-height: 1;
    }

    .bench-unit {
      font-size: 0.82rem;
      color: var(--text-muted);
    }

    .bench-story {
      font-size: 0.84rem;
      color: var(--text-secondary);
      margin: 0 0 20px;
      flex-grow: 1;
    }

    .bench-metrics {
      border-top: 1px solid var(--border);
      padding-top: 12px;
    }

    .bm-row {
      display: flex;
      justify-content: space-between;
      font-size: 0.8rem;
      padding: 5px 0;
      color: var(--text-secondary);
    }

    .bm-row strong {
      color: var(--text);
    }

    .eval-split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    @media (max-width: 860px) {
      .eval-split { grid-template-columns: 1fr; }
    }

    .panel-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 24px;
    }

    .panel-card h3 {
      margin: 0 0 8px;
      font-size: 1.05rem;
      font-weight: 600;
    }

    .panel-sub {
      margin: 0 0 18px;
      font-size: 0.84rem;
      color: var(--text-secondary);
    }

    .clean-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82rem;
    }

    .clean-table th, .clean-table td {
      padding: 10px 8px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }

    .clean-table th {
      color: var(--text-muted);
      font-weight: 500;
      font-size: 0.76rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .highlight-row {
      background: rgba(255, 255, 255, 0.04);
    }

    .inline-badge {
      font-family: var(--sans);
      font-size: 0.68rem;
      background: var(--text);
      color: var(--bg);
      padding: 1px 6px;
      border-radius: 999px;
      margin-left: 6px;
      font-weight: 600;
    }

    .mini-bar-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .mini-bar {
      height: 5px;
      background: #a1a1aa;
      border-radius: 999px;
      max-width: 80px;
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">playwright-system1-triage</span>
        <span class="brand-sub">Laya Local → Jev Cloud Cascade</span>
      </div>
      <nav class="tabs">
        <button class="tab-btn active" onclick="switchTab('triage', this)">Triage Report (${decisions.length})</button>
        ${evalReport ? `<button class="tab-btn" onclick="switchTab('eval', this)">Model Benchmark</button>` : ''}
      </nav>
    </header>

    <main id="tab-triage" class="tab-panel">
      <section class="hero">
        <div class="verdict-eyebrow">
          <span class="verdict-dot"></span>
          <span>${escapeHtml(theme.pill)} · Exit Code ${verdict.exitCode}</span>
        </div>
        <h1 class="verdict-headline">${escapeHtml(verdict.headline)}</h1>
        <p class="verdict-explain">${escapeHtml(theme.humanSummary)} ${escapeHtml(verdict.rationale)}</p>

        <div class="workload-grid">
          <div class="stat-cell">
            <div class="stat-label">App Bugs (Stop Merge)</div>
            <div class="stat-val" style="color:${appBugsCount > 0 ? '#fda4af' : 'var(--text)'}">${appBugsCount}</div>
            <div class="stat-note">Needs developer fix</div>
          </div>
          <div class="stat-cell">
            <div class="stat-label">Transient (Safe to Retry)</div>
            <div class="stat-val" style="color:${retrySafeCount > 0 ? '#6ee7b7' : 'var(--text)'}">${retrySafeCount}</div>
            <div class="stat-note">Flaky timing or 5xx network</div>
          </div>
          <div class="stat-cell">
            <div class="stat-label">Test &amp; Auth Maintenance</div>
            <div class="stat-val">${qaMaintCount}</div>
            <div class="stat-note">Locators, seed data, scripts</div>
          </div>
          <div class="stat-cell">
            <div class="stat-label">Cascade Efficiency</div>
            <div class="stat-val mono">${decisions.filter((d) => !d.escalated).length}/${decisions.length} local</div>
            <div class="stat-note">${verdict.totalLatencyMs.toFixed(0)}ms total · $${verdict.totalCostUsd.toFixed(5)}</div>
          </div>
        </div>
      </section>

      <div class="comp-wrap">
        <div class="comp-header">
          <span>Failure Breakdown (${decisions.length} failed, ${verdict.totalPassed} passed)</span>
          <span>Click a category below to filter</span>
        </div>
        <div class="comp-bar">${compositionSegments}</div>
      </div>

      <div class="filter-row">
        <button class="filter-chip active" data-cat="all" onclick="filterCards('all')">
          <span>All Failures</span>
          <span class="chip-num">${decisions.length}</span>
        </button>
        ${categoryFilterButtons}
      </div>

      <div id="cards-container">
        ${cardsHtml}
      </div>
    </main>

    ${evalTabHtml}
  </div>

  <script>
    function filterCards(cat) {
      document.querySelectorAll('.filter-chip').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-cat') === cat);
      });
      document.querySelectorAll('.triage-card').forEach(card => {
        card.style.display = (cat === 'all' || card.getAttribute('data-category') === cat) ? 'block' : 'none';
      });
    }

    function toggleDrawer(id, btn) {
      const el = document.getElementById(id);
      if (!el) return;
      const isHidden = el.style.display === 'none';
      el.style.display = isHidden ? 'block' : 'none';
      const chev = btn.querySelector('.chevron');
      if (chev) chev.textContent = isHidden ? '↑' : '↓';
    }

    function switchTab(tab, btn) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-triage').style.display = tab === 'triage' ? 'block' : 'none';
      const evalEl = document.getElementById('tab-eval');
      if (evalEl) evalEl.style.display = tab === 'eval' ? 'block' : 'none';
    }
  </script>
</body>
</html>`;
}
