import type { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { ConnectionManager } from '../rpc/connection-manager';
import { TxExpiredError, TxFailedError, TxUnknownError, errorMessage } from '../utils/errors';
import { sleep } from '../utils/retry';
import type { Logger } from '../utils/logger';

export interface SenderOptions {
  /** Absolute Obergrenze für die Bestätigungsschleife. */
  confirmTimeoutMs: number;
  pollIntervalMs: number;
  rebroadcastIntervalMs: number;
}

/**
 * Sendet signierte Transaktionen und bestätigt sie per Polling.
 * Wichtig: Die Schleife endet erst, wenn der Blockhash sicher abgelaufen ist
 * (Transaktion kann danach nicht mehr landen) – verhindert "Geister-Käufe",
 * die nach einem voreiligen Timeout doch noch ausgeführt werden.
 */
export class TransactionSender {
  constructor(
    private readonly rpc: ConnectionManager,
    private readonly log: Logger,
    private readonly o: SenderOptions,
  ) {}

  async sendAndConfirm(tx: VersionedTransaction, lastValidBlockHeight: number): Promise<{ signature: string; slot: number }> {
    const sigBytes = tx.signatures[0];
    if (!sigBytes) throw new Error('Transaktion ist nicht signiert');
    const signature = bs58.encode(sigBytes);
    const raw = tx.serialize();
    const hardDeadline = Date.now() + this.o.confirmTimeoutMs;

    await this.rpc.broadcast(raw);
    this.log.debug('Transaktion gesendet', { signature });
    let lastBroadcast = Date.now();
    let consecutivePollErrors = 0;

    while (Date.now() < hardDeadline) {
      await sleep(this.o.pollIntervalMs);
      try {
        const res = await this.rpc.execute(
          'getSignatureStatuses',
          (c) => c.getSignatureStatuses([signature], { searchTransactionHistory: false }),
          { attempts: 2 },
        );
        consecutivePollErrors = 0;
        const status = res.value[0];
        if (status) {
          if (status.err) throw new TxFailedError(signature, JSON.stringify(status.err));
          if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
            return { signature, slot: status.slot };
          }
        }

        const height = await this.rpc.execute('getBlockHeight', (c) => c.getBlockHeight('confirmed'), { attempts: 2 });
        if (height > lastValidBlockHeight) {
          const final = await this.finalStatus(signature);
          if (final) return final;
          throw new TxExpiredError(signature);
        }

        if (Date.now() - lastBroadcast >= this.o.rebroadcastIntervalMs) {
          lastBroadcast = Date.now();
          await this.rpc.broadcast(raw).catch((e) => this.log.debug('Rebroadcast fehlgeschlagen', { error: errorMessage(e) }));
        }
      } catch (e) {
        if (e instanceof TxFailedError || e instanceof TxExpiredError) throw e;
        consecutivePollErrors++;
        this.log.warn('Bestätigungs-Polling gestört – versuche weiter', {
          signature,
          errors: consecutivePollErrors,
          error: errorMessage(e),
        });
      }
    }

    // Harte Deadline erreicht (z. B. RPC-Ausfall): letzter Versuch, dann "unbekannt".
    const final = await this.finalStatus(signature).catch(() => null);
    if (final) return final;
    throw new TxUnknownError(signature, 'Bestätigungs-Deadline überschritten');
  }

  private async finalStatus(signature: string): Promise<{ signature: string; slot: number } | null> {
    const res = await this.rpc.execute('getSignatureStatuses(history)', (c) =>
      c.getSignatureStatuses([signature], { searchTransactionHistory: true }),
    );
    const s = res.value[0];
    if (!s) return null;
    if (s.err) throw new TxFailedError(signature, JSON.stringify(s.err));
    if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return { signature, slot: s.slot };
    return null;
  }
}
