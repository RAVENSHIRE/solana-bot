export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'pretty' | 'json';
export type LogContext = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface LogOptions {
  level: LogLevel;
  format: LogFormat;
  color: boolean;
}

const options: LogOptions = { level: 'info', format: 'pretty', color: true };

export function configureLogger(o: Partial<LogOptions>): void {
  Object.assign(options, o);
}

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  scope: '\x1b[35m',
} as const;

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, jsonReplacer);
  } catch {
    return '"[unserialisierbar]"';
  }
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  if (v instanceof Error) return JSON.stringify(v.message);
  return safeStringify(v);
}

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly base: LogContext = {},
  ) {}

  child(scope: string, ctx: LogContext = {}): Logger {
    return new Logger(scope, { ...this.base, ...ctx });
  }

  debug(msg: string, ctx?: LogContext): void {
    this.write('debug', msg, ctx);
  }
  info(msg: string, ctx?: LogContext): void {
    this.write('info', msg, ctx);
  }
  warn(msg: string, ctx?: LogContext): void {
    this.write('warn', msg, ctx);
  }
  error(msg: string, ctx?: LogContext): void {
    this.write('error', msg, ctx);
  }

  isDebugEnabled(): boolean {
    return LEVELS[options.level] <= LEVELS.debug;
  }

  private write(level: LogLevel, msg: string, ctx?: LogContext): void {
    if (LEVELS[level] < LEVELS[options.level]) return;
    const ts = new Date().toISOString();
    const merged: LogContext = { ...this.base, ...(ctx ?? {}) };
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;

    if (options.format === 'json') {
      stream.write(`${safeStringify({ ts, level, scope: this.scope, msg, ...merged })}\n`);
      return;
    }

    const col = options.color;
    const paint = (code: string, s: string): string => (col ? `${code}${s}${C.reset}` : s);
    const kv = Object.entries(merged)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${formatValue(v)}`)
      .join(' ');
    const line =
      `${paint(C.dim, ts)} ${paint(C[level], level.toUpperCase().padEnd(5))} ` +
      `${paint(C.scope, `[${this.scope}]`)} ${msg}${kv ? ` ${paint(C.dim, kv)}` : ''}`;
    stream.write(`${line}\n`);
  }
}

export const rootLogger = new Logger('bot');
