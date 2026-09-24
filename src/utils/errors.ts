export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly target: string,
    public readonly bodySnippet: string,
  ) {
    super(`${target} → HTTP ${status}${bodySnippet ? `: ${bodySnippet}` : ''}`);
    this.name = 'HttpError';
  }
}

/** Transienter Netzwerkfehler (Verbindungsabbruch, DNS, Timeout). */
export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

export class TimeoutError extends NetworkError {
  constructor(label: string, ms: number) {
    super(`${label}: Timeout nach ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/** Fehler, der niemals wiederholt werden darf (z. B. ungültige Parameter). */
export class NonRetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NonRetryableError';
  }
}

export class TxFailedError extends Error {
  constructor(
    public readonly signature: string,
    detail: string,
  ) {
    super(`Transaktion ${signature} on-chain fehlgeschlagen: ${detail}`);
    this.name = 'TxFailedError';
  }
}

/** Blockhash abgelaufen – Transaktion kann garantiert nicht mehr landen. */
export class TxExpiredError extends Error {
  constructor(public readonly signature: string) {
    super(`Transaktion ${signature} abgelaufen (Blockhash ungültig, nicht gelandet)`);
    this.name = 'TxExpiredError';
  }
}

/** Status nicht ermittelbar (z. B. RPC-Ausfall während der Bestätigung) – manuell prüfen! */
export class TxUnknownError extends Error {
  constructor(
    public readonly signature: string,
    detail: string,
  ) {
    super(`Status von Transaktion ${signature} unbekannt: ${detail}`);
    this.name = 'TxUnknownError';
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
