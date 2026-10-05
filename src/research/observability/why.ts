import type { ResearchEvent } from '../events/types';

/**
 * "Why did I not receive an alert?" — answered from the event store in one call. The pipeline is walked in order and
 * the first stage where the token was lost is the verdict:
 *
 *   SYSTEM_NOT_RUNNING → NEVER_OBSERVED → FILTERED → NO_SIGNAL → SIGNAL_WITHOUT_ALERT → SUPPRESSED_BY_CONFIG
 *   → SUPPRESSED_BY_LIMIT → NO_CHANNEL → DELIVERY_FAILED → DELIVERED
 *
 * Inputs are whatever was recorded: pipeline stage events and scan decisions (imported from the desk's event log),
 * signal evaluations (tape), AlertGenerated / AlertDelivered (alert evidence) and health snapshots.
 */

export type MissingAlertVerdict = 'SYSTEM_NOT_RUNNING' | 'NEVER_OBSERVED' | 'FILTERED' | 'NO_SIGNAL' | 'SIGNAL_WITHOUT_ALERT' |
  'SUPPRESSED_BY_CONFIG' | 'SUPPRESSED_BY_LIMIT' | 'NO_CHANNEL' | 'DELIVERY_FAILED' | 'DELIVERED';

export interface MissingAlertReport {
  token: string; window: { from: number; to: number };
  verdict: MissingAlertVerdict;
  explanation: string;
  firstObservedAt: number | null;
  system: { scans: number; longestGapMs: number | null; gaps: Array<{ from: number; to: number }> };
  reasons: Array<{ reason: string; count: number; first: number; last: number }>;
  timeline: Array<{ at: number; stage: string; detail: string }>;
}

const SCAN = (e: ResearchEvent) => e.event_type === 'PipelineStage' && e.payload.stage === 'SCANNING';
const text = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v));

export function explainMissingAlert(events: readonly ResearchEvent[], q: { token: string; from: number; to: number; maxScanGapMs?: number }): MissingAlertReport {
  const inWindow = events.filter(e => e.timestamp >= q.from && e.timestamp <= q.to).sort((a, b) => a.timestamp - b.timestamp);
  const mine = inWindow.filter(e => e.token === q.token);
  const scans = inWindow.filter(SCAN).map(e => e.timestamp);
  const maxGap = q.maxScanGapMs ?? 180_000, gaps: Array<{ from: number; to: number }> = [];
  const marks = [q.from, ...scans, q.to];
  for (let i = 1; i < marks.length; i++) if (marks[i]! - marks[i - 1]! > maxGap) gaps.push({ from: marks[i - 1]!, to: marks[i]! });
  const system = { scans: scans.length, longestGapMs: gaps.length ? Math.max(...gaps.map(g => g.to - g.from)) : scans.length ? 0 : null, gaps };
  const timeline = mine.map(e => ({ at: e.timestamp, stage: `${e.event_type}${e.payload.stage ? `:${text(e.payload.stage)}` : ''}`,
    detail: text(e.payload.message ?? e.payload.summary ?? e.payload.status ?? (e.event_type === 'AlertGenerated' ? (e.payload as { what_happened?: { title?: string } }).what_happened?.title : '')) }));
  const reasonsMap = new Map<string, { reason: string; count: number; first: number; last: number }>();
  const reason = (r: string, at: number) => { const x = reasonsMap.get(r); if (x) { x.count++; x.last = at; } else reasonsMap.set(r, { reason: r, count: 1, first: at, last: at }); };
  const report = (verdict: MissingAlertVerdict, explanation: string): MissingAlertReport =>
    ({ token: q.token, window: { from: q.from, to: q.to }, verdict, explanation, firstObservedAt: mine[0]?.timestamp ?? null, system,
      reasons: [...reasonsMap.values()].sort((a, b) => b.count - a.count), timeline });

  // Alerts first: if one was generated, the answer is about its delivery.
  const alerts = mine.filter(e => e.event_type === 'AlertGenerated');
  if (alerts.length) {
    const a = alerts[0]!, d = (a.payload.delivery ?? {}) as { decision?: string; selectedKinds?: string[]; channels?: string[] };
    const delivered = inWindow.filter(e => e.event_type === 'AlertDelivered' && e.payload.alert_id === a.payload.alert_id);
    if (d.decision === 'SUPPRESSED_BY_CONFIG')
      return report('SUPPRESSED_BY_CONFIG', `A ${text(a.payload.kind)} alert was generated at ${iso(a.timestamp)} but DESK_ALERTS selects only ${(d.selectedKinds ?? []).join(', ') || 'the default'}; it went to the dashboard and the event log only.`);
    if (d.decision === 'SUPPRESSED_BY_LIMIT')
      return report('SUPPRESSED_BY_LIMIT', `A ${text(a.payload.kind)} alert was generated at ${iso(a.timestamp)} but it was outside the phone's limit for its kind (OPEN: only breakouts within 2 minutes of launch, a few an hour); it went to the dashboard and the event log only.`);
    if (d.decision === 'NO_CHANNEL') return report('NO_CHANNEL', `An alert was generated at ${iso(a.timestamp)} but no phone channel is configured (DESK_NTFY_TOPIC or Telegram).`);
    const failed = delivered.find(e => e.payload.status === 'FAILED' || e.payload.status === 'PARTIAL');
    if (failed) return report('DELIVERY_FAILED', `The alert was sent at ${iso(a.timestamp)} and delivery ${text(failed.payload.status)}: ${text(failed.payload.results)}`);
    return report('DELIVERED', `An alert was generated at ${iso(a.timestamp)}${delivered.length ? ` and delivered (${text(delivered[0]!.payload.status)}) ${Math.round(((delivered[0]!.payload.latency_ms as number) ?? 0) / 1000)} s later` : ''}: ${text((a.payload as { what_happened?: { title?: string } }).what_happened?.title)}.`);
  }
  if (!scans.length && !mine.length) return report('SYSTEM_NOT_RUNNING', `No scan was recorded between ${iso(q.from)} and ${iso(q.to)}: the desk was not running or not recording.`);
  if (!mine.length) {
    const gap = gaps.length ? ` Scans were interrupted for ${Math.round(system.longestGapMs! / 60_000)} min.` : '';
    return report('NEVER_OBSERVED', `The desk ran (${scans.length} scans) but never saw this token in the window: discovery did not surface it.${gap}`);
  }
  for (const e of mine) {
    if (e.event_type === 'ScanDecision' && ['FILTERED', 'WATCHLIST', 'WAITING'].includes(text(e.payload.stage))) reason(`${text(e.payload.stage)}: ${text(e.payload.message)}`, e.timestamp);
    if (e.event_type === 'SignalEvaluated' && e.payload.signal === false) reason(`${text(e.payload.strategy)} no signal: ${text(e.payload.summary)}`, e.timestamp);
  }
  const signals = mine.filter(e => e.event_type === 'SignalEvaluated' && e.payload.signal === true);
  if (signals.length) {
    const s = signals[0]!;
    return report('SIGNAL_WITHOUT_ALERT', `${text(s.payload.strategy)} signalled at ${iso(s.timestamp)} (${text(s.payload.summary)}), but signals of that strategy do not generate phone alerts`
      + ' (alerts exist for golden, rug, open, launch and radar).');
  }
  const qualified = mine.find(e => e.event_type === 'ScanDecision' && e.payload.stage === 'QUALIFIED');
  if (qualified) return report('SIGNAL_WITHOUT_ALERT', `The token qualified at ${iso(qualified.timestamp)} (${text(qualified.payload.message)}), but qualification alone sends no alert.`);
  if (mine.some(e => e.event_type === 'SignalEvaluated')) return report('NO_SIGNAL', `Seen ${mine.length} times from ${iso(mine[0]!.timestamp)}; entry rules never all passed. Most frequent: ${[...reasonsMap.values()].sort((a, b) => b.count - a.count)[0]?.reason ?? '?'}.`);
  return report('FILTERED', `Seen from ${iso(mine[0]!.timestamp)} but filtered before any strategy signal. Most frequent: ${[...reasonsMap.values()].sort((a, b) => b.count - a.count)[0]?.reason ?? 'no recorded reason'}.`);
}

const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
