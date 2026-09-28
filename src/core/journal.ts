import fs from 'node:fs';
import path from 'node:path';
import type { ExecMode, TradeRecord } from './types';
import type { Logger } from '../utils/logger';
import { errorMessage } from '../utils/errors';

const ACTION_COLOR: Record<string, string> = {
  BUY: '\x1b[32m',
  SELL: '\x1b[36m',
  LP_OPEN: '\x1b[34m',
  LP_CLOSE: '\x1b[34m',
  RENT_RECLAIM: '\x1b[35m',
  BUY_FAILED: '\x1b[31m',
  SELL_FAILED: '\x1b[31m',
  WRITE_OFF: '\x1b[31m',
};

/**
 * Strukturiertes Trade-Journal:
 *  1. Kompakte Terminal-Zeile (Timestamp, Modus, Strategie, Token, Aktion, Signal, Fees, Slippage, PnL)
 *  2. JSONL-Datei pro Tag: logs/trades-{MODE}-YYYY-MM-DD.jsonl (maschinenlesbar für Auswertungen)
 */
export class TradeJournal {
  private readonly log: Logger;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly mode: ExecMode,
    logger: Logger,
    private readonly color = true,
  ) {
    this.log = logger.child('journal');
    fs.mkdirSync(dir, { recursive: true });
  }

  private readonly listeners: Array<(r: TradeRecord) => void> = [];

  /** Registriert einen Empfänger für jeden neuen Eintrag (z. B. Dashboard-Telemetrie). */
  onRecord(fn: (r: TradeRecord) => void): void {
    this.listeners.push(fn);
  }

  record(r: Omit<TradeRecord, 'ts' | 'mode'>): void {
    const rec: TradeRecord = { ts: new Date().toISOString(), mode: this.mode, ...r };
    this.printLine(rec);
    for (const fn of this.listeners) {
      try {
        fn(rec);
      } catch (e) {
        this.log.warn('Journal-Listener fehlgeschlagen', { error: errorMessage(e) });
      }
    }
    const file = path.join(this.dir, `trades-${this.mode}-${rec.ts.slice(0, 10)}.jsonl`);
    const line = `${JSON.stringify(rec)}\n`;
    // Serialisiert schreiben, damit Zeilen nie verschachtelt werden
    this.queue = this.queue
      .then(() => fs.promises.appendFile(file, line, { encoding: 'utf8', mode: 0o600 }))
      .catch((e) => this.log.error('Journal-Schreibfehler', { file, error: errorMessage(e) }));
  }

  /** Wartet, bis alle ausstehenden Journal-Einträge geschrieben sind. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private printLine(r: TradeRecord): void {
    const tag = r.mode === 'SIMULATION' ? '[SIM] ' : '[LIVE]';
    const c = (code: string, s: string): string => (this.color ? `${code}${s}\x1b[0m` : s);
    const parts = [
      c('\x1b[2m', r.ts),
      c(r.mode === 'SIMULATION' ? '\x1b[33m' : '\x1b[41m\x1b[97m', tag),
      r.strategy.padEnd(15),
      `${r.symbol.slice(0, 12).padEnd(12)}`,
      c(ACTION_COLOR[r.action] ?? '', r.action.padEnd(12)),
      `in=${r.inAmount}`,
      `out=${r.outAmount}`,
      `fees=${r.feesSol} SOL`,
      r.priceImpactPct !== null ? `impact=${r.priceImpactPct.toFixed(3)}%` : null,
      r.slippageBps !== null ? `slip=${r.slippageBps}bps` : null,
      r.pnlSol !== null ? c(r.pnlSol.startsWith('-') ? '\x1b[31m' : '\x1b[32m', `pnl=${r.pnlSol} SOL (${r.pnlPct ?? 0}%)`) : null,
      `| ${r.signal}`,
      r.signature ? `| sig=${r.signature}` : null,
      r.note ? `| ${r.note}` : null,
    ].filter((p): p is string => p !== null);
    process.stdout.write(`${parts.join(' ')}\n`);
  }
}
