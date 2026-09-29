import { PublicKey } from '@solana/web3.js';
import { parseMintAccount } from '../data/solana-rpc';
import { DataError, observation, type Observation } from '../data/core/data-types';
import type { ConnectionManager } from '../rpc/connection-manager';
import type { Logger } from '../utils/logger';
import { errorMessage } from '../utils/errors';

export interface TokenSafety {
  mint: string;
  status: 'verified' | 'rejected' | 'unavailable';
  meta: Observation;
  ok: boolean;
  decimals: number;
  isToken2022: boolean;
  hasMintAuthority: boolean;
  hasFreezeAuthority: boolean;
  reasons: string[];
  warnings: string[];
}

export interface SafetyOptions {
  /** Aktive Mint-Authority (unbegrenztes Nachprägen) als Ausschlussgrund werten. */
  rejectMintAuthority: boolean;
  fresh?: boolean;
}

/** Token-2022-Extensions, die einen Exit verhindern oder Werte abschöpfen können. */
const DANGEROUS_EXTENSIONS: Record<string, string> = {
  transferFeeConfig: 'Transfer-Fee (Steuer auf jeden Transfer)',
  transferHook: 'Transfer-Hook (beliebiger Code bei Transfers)',
  permanentDelegate: 'Permanent Delegate (Tokens können eingezogen werden)',
  nonTransferable: 'nicht übertragbar',
  defaultAccountState: 'Default Account State (Konten evtl. eingefroren)',
  pausableConfig: 'pausierbar',
  confidentialTransferMint: 'Confidential Transfers',
};

const CACHE_TTL_MS = 30 * 60_000;

/**
 * On-Chain-Sicherheitsprüfung eines Mints (Honeypot-/Rug-Schutz):
 * Freeze-Authority, Mint-Authority und gefährliche Token-2022-Extensions.
 */
export class TokenSafetyChecker {
  private readonly cache = new Map<string, { at: number; value: TokenSafety }>();

  constructor(
    private readonly rpc: ConnectionManager,
    private readonly log: Logger,
  ) {}

  async check(mint: string, o: SafetyOptions): Promise<TokenSafety> {
    const base = await this.inspect(mint, o.fresh ?? false);
    const reasons = [...base.reasons];
    const warnings = [...base.warnings];
    if (base.hasMintAuthority) {
      if (o.rejectMintAuthority) reasons.push('Mint-Authority aktiv (Nachprägen möglich)');
      else warnings.push('Mint-Authority aktiv');
    }
    return { ...base, reasons, warnings, ok: reasons.length === 0, status: reasons.length === 0 ? 'verified' : 'rejected' };
  }

  private async inspect(mint: string, fresh: boolean): Promise<TokenSafety> {
    const cached = this.cache.get(mint);
    if (!fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    const res = await this.rpc.execute('getParsedAccountInfo(mint)', (c) => c.getParsedAccountInfo(new PublicKey(mint)));
    const acc = res.value;
    const result: TokenSafety = {
      mint,
      status: 'rejected',
      meta: observation('solana-rpc', Date.now(), mint, null),
      ok: false,
      decimals: 0,
      isToken2022: false,
      hasMintAuthority: false,
      hasFreezeAuthority: false,
      reasons: [],
      warnings: [],
    };

    const info = parseMintAccount(acc);
    result.decimals = info.decimals;
    result.isToken2022 = info.isToken2022;
    result.hasMintAuthority = !!info.mintAuthority;
    result.hasFreezeAuthority = !!info.freezeAuthority;
    if (info.isInitialized === false) result.reasons.push('Mint nicht initialisiert');
    if (result.hasFreezeAuthority) result.reasons.push('Freeze-Authority aktiv (Konten können eingefroren werden)');

    for (const ext of info.extensions ?? []) {
      const name = ext.extension ?? '';
      const label = DANGEROUS_EXTENSIONS[name];
      if (!label) continue;
      if (name === 'transferFeeConfig') {
        const newer = ext.state?.newerTransferFee as { transferFeeBasisPoints?: number } | undefined;
        const older = ext.state?.olderTransferFee as { transferFeeBasisPoints?: number } | undefined;
        const fields = [newer?.transferFeeBasisPoints, older?.transferFeeBasisPoints];
        if (fields.some(n => n === undefined || !Number.isInteger(n) || n < 0 || n > 10_000)) { result.reasons.push('Transfer-Fee-Daten unvollständig'); continue; }
        const bps = Math.max(fields[0]!, fields[1]!);
        if (bps === 0) {
          result.warnings.push('Transfer-Fee-Extension (aktuell 0 bps)');
          continue;
        }
        result.reasons.push(`${label}: ${bps} bps`);
        continue;
      }
      if (name === 'transferHook') {
        const programId = ext.state?.programId;
        if (!programId) {
          result.warnings.push('Transfer-Hook-Extension ohne Programm');
          continue;
        }
      }
      if (name === 'defaultAccountState' && ext.state?.accountState === 'initialized') {
        continue;
      }
      result.reasons.push(label);
    }

    result.ok = result.reasons.length === 0;
    result.status = result.ok ? 'verified' : 'rejected';
    if (!result.ok) this.log.debug('Token-Sicherheitsprüfung negativ', { mint, reasons: result.reasons });
    return this.store(mint, result);
  }

  private store(mint: string, v: TokenSafety): TokenSafety {
    this.cache.set(mint, { at: Date.now(), value: v });
    if (this.cache.size > 5_000) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 1_000);
      for (const [k] of oldest) this.cache.delete(k);
    }
    return v;
  }

  /** Wie check(), aber wirft nie – Fehler gelten als "nicht sicher". */
  async safeCheck(mint: string, o: SafetyOptions): Promise<TokenSafety> {
    try {
      return await this.check(mint, o);
    } catch (e) {
      return {
        mint,
        status: e instanceof DataError && e.kind === 'on-chain-verification' ? 'rejected' : 'unavailable',
        meta: { ...observation('solana-rpc', Date.now(), mint, null), validation: e instanceof DataError && e.kind === 'on-chain-verification' ? 'valid' : 'unavailable' },
        ok: false,
        decimals: 0,
        isToken2022: false,
        hasMintAuthority: false,
        hasFreezeAuthority: false,
        reasons: [`Prüfung fehlgeschlagen: ${errorMessage(e)}`],
        warnings: [],
      };
    }
  }
}
