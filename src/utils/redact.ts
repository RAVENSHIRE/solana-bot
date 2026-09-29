/** Redact known credential fields, URL userinfo/path/query and token-like assignments. */
export function redactText(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, value => {
    try { const url = new URL(value); return `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}/[redacted]`; } catch { return '[redacted-url]'; }
  }).replace(/((?:api[-_]?key|authorization|private[-_]?key|seed[-_]?phrase|secret|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
}
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]'; seen.add(value);
  if (Array.isArray(value)) { const out = value.map(v => redact(v, seen)); seen.delete(value); return out; }
  const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(?:.*api.?key|.*private.?key|.*seed.?phrase|authorization|secret|headers|swapTransaction|signingMaterial)$/i.test(k) ? '[redacted]' : redact(v, seen)]));
  seen.delete(value); return out;
}
