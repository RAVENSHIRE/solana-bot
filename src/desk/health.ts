import type { ObserverHealth } from './pump-stream';
import type { NotifyHealth } from './watch';

/**
 * The dashboard's health strip: is the research observer alive, and is the phone still receiving? Built on the server
 * so the page only renders it. `bad` lines are shown as warnings.
 */
export interface HealthLine { label: string; text: string; bad: boolean }
export const HEALTH = Object.freeze({ observerStaleMs: 60_000, qualifyStaleMs: 13 * 3_600_000 });

const ago = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 120 ? `${s} s ago` : s < 7_200 ? `${Math.round(s / 60)} min ago` : `${(s / 3_600).toFixed(1)} h ago`;
};
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;

function phoneLine(label: string, h: NotifyHealth | null, channels: number, now: number): HealthLine {
  if (!channels || !h) return { label, text: 'no phone channel configured (DESK_NTFY_TOPIC / Telegram)', bad: false };
  if (!h.sent) return { label, text: 'nothing sent since start', bad: false };
  // Bad while any channel's latest attempt failed (ntfy delivering does not hide a Telegram that always refuses). An
  // older observer without `failing`: bad while the latest outcome is a failure.
  const failing = h.failing ?? (h.lastFailureAt !== null && (h.lastOkAt === null || h.lastFailureAt > h.lastOkAt) ? ['phone'] : []);
  return { label, bad: failing.length > 0,
    text: `${h.delivered}/${h.sent} delivered · last ok ${h.lastOkAt !== null ? ago(h.lastOkAt, now) : 'never'}` +
      `${failing.length ? ` · FAILING: ${failing.join(', ')}` : ''}${h.lastFailureAt !== null ? ` · last error ${h.lastError} ${ago(h.lastFailureAt, now)}` : ''}` };
}

export function healthLines(o: { observer: ObserverHealth | null; streamOff: boolean; phone: NotifyHealth | null; channels: number }, now: number): HealthLine[] {
  const out: HealthLine[] = [];
  const obs = o.observer;
  if (o.streamOff) out.push({ label: 'Research observer', text: 'not used (DESK_PUMP_STREAM=off)', bad: false });
  else if (!obs?.seenAt) out.push({ label: 'Research observer', text: 'not answering on 127.0.0.1 since the desk started: no research calls, launches from the RPC', bad: true });
  else {
    // A stale observer's last report is not shown: its uptime and counters would read as current.
    const stale = now - obs.seenAt > HEALTH.observerStaleMs, r = stale ? null : obs.report;
    const ledger = r && typeof r.ledger === 'object' && r.ledger ? r.ledger as Record<string, unknown> : null, errors = num(ledger?.writeErrors) ?? 0;
    const started = num(r?.startedAt);
    out.push({ label: 'Research observer', bad: stale || !obs.streamHealthy || errors > 0,
      text: `last answer ${ago(obs.seenAt, now)}${stale ? ' — DOWN?' : ''} · launch stream ${obs.streamHealthy ? 'live' : 'DOWN'}${started ? ` · up ${((now - started) / 3_600_000).toFixed(1)} h` : ''}${errors ? ` · ${errors} ledger write errors` : ''}${ledger?.lowDisk ? ' · LOW DISK' : ''}` });
    const p = r?.phone as NotifyHealth | null | undefined;
    if (r) out.push(phoneLine('Observer phone (calls, INFO)', p ?? null, p ? 1 : 0, now));
    const q = r && typeof r.qualification === 'object' && r.qualification ? r.qualification as Record<string, unknown> : null;
    if (q) {
      const okAt = num(q.okAt), failedAt = num(q.failedAt);
      // The observer requalifies every 6 h: no success for 13 h, or a failure after the last success, is a warning.
      const bad = (failedAt !== null && (okAt === null || failedAt > okAt)) || okAt === null || now - okAt > HEALTH.qualifyStaleMs;
      out.push({ label: 'Qualification (every 6 h)', bad,
        text: `last ok ${okAt !== null ? ago(okAt, now) : 'not since the observer started'}${failedAt !== null ? ` · last failure ${ago(failedAt, now)}: ${String(q.error ?? '')}` : ''}` });
    }
  }
  out.push(phoneLine('Desk phone (alerts, watch)', o.phone, o.channels, now));
  return out;
}
