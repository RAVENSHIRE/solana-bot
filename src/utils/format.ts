export function lamportsToSol(lamports: bigint, digits = 6): string {
  const neg = lamports < 0n;
  const abs = neg ? -lamports : lamports;
  const whole = abs / 1_000_000_000n;
  const frac = (abs % 1_000_000_000n).toString().padStart(9, '0').slice(0, digits);
  return `${neg ? '-' : ''}${whole.toString()}${digits > 0 ? `.${frac}` : ''}`;
}

export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol) || sol < 0) throw new Error(`Ungültiger SOL-Betrag: ${sol}`);
  return BigInt(Math.round(sol * 1e9));
}

export function formatTokenAmount(raw: bigint, decimals: number, maxFraction = 4): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(Math.max(0, decimals));
  const whole = abs / base;
  let frac = '';
  if (decimals > 0) {
    frac = (abs % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
  }
  return `${neg ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

/** Prozentuale Veränderung von `from` nach `to` (4 Nachkommastellen Präzision). */
export function pctChange(from: bigint, to: bigint): number {
  if (from === 0n) return 0;
  return Number(((to - from) * 1_000_000n) / from) / 10_000;
}

export function bpsOf(part: bigint, whole: bigint): number {
  if (whole === 0n) return 0;
  return Number((part * 10_000n) / whole);
}

/** Entfernt API-Keys/Pfade aus RPC-URLs für Logs. */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const hasSecret = u.search.length > 0 || u.pathname.length > 1;
    return `${u.protocol}//${u.host}${hasSecret ? '/***' : ''}`;
  } catch {
    return '***';
  }
}

export function shortAddr(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
