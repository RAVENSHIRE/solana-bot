import type { ObserverHealth } from './pump-stream';
import type { NotifyHealth } from './watch';

/**
 * The dashboard's health strip: is the research observer alive, and is the phone still receiving? Built on the server
 * so the page only renders it. `bad` lines are shown as warnings.
 */
export interface HealthLine { label: string; text: string; bad: boolean }
export const HEALTH = Object.freeze({ observerStaleMs: 60_000 });

const ago = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 120 ? `${s} s ago` : s < 7_200 ? `${Math.round(s / 60)} min ago` : `${(s / 3_600).toFixed(1)} h ago`;
};
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;

function phoneLine(label: string, h: NotifyHealth | null, channels: number, now: number): HealthLine {
  if (!channels || !h) return { label, text: 'no phone channel configured (DESK_NTFY_TOPIC / Telegram)', bad: false };
  if (!h.sent) return { label, text: 'nothing sent since start', bad: false };
  // Bad while the latest outcome is a failure: a delivery after the last failure clears it.
  const failing = h.lastFailureAt !== null && (h.lastOkAt === null || h.lastFailureAt > h.lastOkAt);
  return { label, bad: failing,
    text: `${h.delivered}/${h.sent} delivered · last ok ${h.lastOkAt !== null ? ago(h.lastOkAt, now) : 'never'}${h.failed ? ` · ${h.failed} failed, last ${h.lastError} ${ago(h.lastFailureAt!, now)}` : ''}` };
}

export function healthLines(o: { observer: ObserverHealth | null; streamOff: boolean; phone: NotifyHealth | null; channels: number }, now: number): HealthLine[] {
  const out: HealthLine[] = [];
  const obs = o.observer;
  if (o.streamOff) out.push({ label: 'Research observer', text: 'not used (DESK_PUMP_STREAM=off)', bad: false });
  else if (!obs?.seenAt) out.push({ label: 'Research observer', text: 'not answering on 127.0.0.1 since the desk started: no research calls, launches from the RPC', bad: true });
  else {
    const stale = now - obs.seenAt > HEALTH.observerStaleMs, r = obs.report;
    const ledger = r && typeof r.ledger === 'object' && r.ledger ? r.ledger as Record<string, unknown> : null, errors = num(ledger?.writeErrors) ?? 0;
    const started = num(r?.startedAt);
    out.push({ label: 'Research observer', bad: stale || !obs.streamHealthy || errors > 0,
      text: `last answer ${ago(obs.seenAt, now)}${stale ? ' — DOWN?' : ''} · launch stream ${obs.streamHealthy ? 'live' : 'DOWN'}${started ? ` · up ${((now - started) / 3_600_000).toFixed(1)} h` : ''}${errors ? ` · ${errors} ledger write errors` : ''}${ledger?.lowDisk ? ' · LOW DISK' : ''}` });
    const p = r?.phone as NotifyHealth | null | undefined;
    if (r) out.push(phoneLine('Observer phone (calls, INFO)', p ?? null, p ? 1 : 0, now));
  }
  out.push(phoneLine('Desk phone (alerts, watch)', o.phone, o.channels, now));
  return out;
}
