import {
  CATEGORY_METADATA,
  FAILURE_CATEGORIES,
  type QualityGateVerdict,
  type System1DecisionResult,
} from '../types.ts';

function sanitizeMarkdownCell(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/`/g, "'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

export function generateMarkdownSummary(
  verdict: QualityGateVerdict,
  decisions: System1DecisionResult[]
): string {
  const iconMap: Record<QualityGateVerdict['action'], string> = {
    PASS: '✅',
    BLOCK_MERGE: '🛑',
    AUTO_RETRY_TRANSIENT: '🔄',
    ESCALATE_AMBIGUOUS: '⚠️',
  };

  const lines: string[] = [];
  lines.push(`# ${iconMap[verdict.action]} System 1 Playwright Triage: \`${verdict.action}\``);
  lines.push('');
  lines.push(`> **${verdict.headline}**  `);
  lines.push(`> ${verdict.rationale}`);
  lines.push('');
  lines.push('### Telemetry & Cascade Efficiency');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| :--- | :--- |');
  lines.push(`| **Failed / Passed Specs** | \`${verdict.totalFailed} failed\` / \`${verdict.totalPassed} passed\` |`);
  lines.push(`| **Total Triage Latency** | \`${verdict.totalLatencyMs.toFixed(2)} ms\` |`);
  lines.push(`| **Jev API Escalation Rate** | \`${(verdict.escalationRate * 100).toFixed(1)}%\` (${decisions.filter((d) => !d.escalated).length}/${decisions.length} resolved locally by Laya-421M) |`);
  lines.push(`| **Estimated Triage Cost** | \`$${verdict.totalCostUsd.toFixed(6)}\` |`);
  lines.push(`| **CI Exit Code** | \`${verdict.exitCode}\` |`);
  lines.push('');

  if (decisions.length === 0) {
    return lines.join('\n');
  }

  lines.push('### Failure Distribution by System 1 Category');
  lines.push('');
  lines.push('| Category | Count | Recommended CI Action |');
  lines.push('| :--- | :---: | :--- |');
  for (const cat of FAILURE_CATEGORIES) {
    const count = verdict.countsByCategory[cat] ?? 0;
    if (count > 0) {
      const meta = CATEGORY_METADATA[cat];
      lines.push(`| **${meta.label}** (\`${cat}\`) | **${count}** | ${meta.recommendedAction} |`);
    }
  }
  lines.push('');

  lines.push('### Detailed Per-Test System 1 Decisions');
  lines.push('');
  lines.push('| Spec Title | Root Cause (`choice`) | Top Conf | Retryable (`noul`) | Blocker (`score`) | Engine Used |');
  lines.push('| :--- | :--- | :---: | :---: | :---: | :--- |');

  for (const d of decisions) {
    const meta = CATEGORY_METADATA[d.winningCategory];
    const engineBadge = d.escalated
      ? `⚡ \`Laya → Jev\` (${d.latencyMs}ms)`
      : `🟢 \`Laya Local\` (${d.latencyMs}ms)`;
    const safeTitle = sanitizeMarkdownCell(d.state.title);
    const safeFile = sanitizeMarkdownCell(d.state.file);
    lines.push(
      `| **${safeTitle}**<br><sub>\`${safeFile}\`</sub> | **${meta.label}** | \`${(
        d.topConfidence * 100
      ).toFixed(1)}%\` | \`${(d.retryableProbability * 100).toFixed(0)}%\` | \`${
        d.releaseBlockerScore
      }/100\` | ${engineBadge} |`
    );
  }
  lines.push('');

  return lines.join('\n');
}
