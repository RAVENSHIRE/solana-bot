/**
 * Polls the local desk from a dedicated worker. Browsers throttle timers of hidden tabs to about once a minute,
 * which let the LIVE heartbeat lapse (LIVE stops after 12 s without one) and delayed Auto-Confirm signatures.
 * Worker timers are not throttled that way; each result is posted to the page, which handles it immediately.
 */
export interface PollConfig { sessionId: string | null; capability: string | null; intervalMs: number }
export type PollResult = { ok: true; body: unknown } | { ok: false; status: number | null; message: string };

const scope = self as unknown as { onmessage: ((e: MessageEvent<PollConfig>) => void) | null; postMessage(result: PollResult): void };
let config: PollConfig | null = null, timer: ReturnType<typeof setTimeout> | undefined, generation = 0;

async function poll(run: number): Promise<void> {
  const c = config;
  if (!c || run !== generation) return;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const r = await fetch('/api/trading', { cache: 'no-store', signal: controller.signal,
      headers: c.sessionId && c.capability ? { 'X-Local-Capability': c.capability, 'X-Wallet-Session': c.sessionId } : undefined });
    const body = await r.json() as { message?: string };
    if (run === generation) scope.postMessage(r.ok ? { ok: true, body } : { ok: false, status: r.status, message: body.message ?? 'Trading status unavailable' });
  } catch (error) {
    if (run === generation) scope.postMessage({ ok: false, status: null, message: error instanceof Error ? error.message : 'Local service unavailable' });
  } finally {
    clearTimeout(timeout);
    if (run === generation) timer = setTimeout(() => void poll(run), c.intervalMs);
  }
}

scope.onmessage = e => { config = e.data; clearTimeout(timer); generation++; void poll(generation); };
