import { randomBytes } from 'node:crypto';
import { BaseStrategy, inFlightMints, type StrategyContext } from '../base-strategy';
import type { GeckoPool } from '../../data/geckoterminal';
import type { RaydiumPool } from '../../data/raydium';
import { JupiterClient } from '../../execution/jupiter-client';
import { BASE_FEE_LAMPORTS, QUOTE_MINTS, SOL_MINT, type LpPaperPosition } from '../../core/types';
import { errorMessage } from '../../utils/errors';
import { lamportsToSol, round, shortAddr, solToLamports } from '../../utils/format';

const YEAR_MS = 365 * 24 * 3_600_000;
const LP_MAX_MISSED_UPDATES = 10;

interface ArbProbe {
  pool: GeckoPool;
  symbol: string;
  decimals: number;
  velocity: number;
  edgeLamports: bigint;
  edgeBps: number;
  route: string;
}

/**
 * SuckUpTheRent – delta-neutraler Fee-/Volume-Harvester. Drei unabhängige Sub-Module:
 *
 * (a) Roundtrip-Mikroarbitrage (echte Trades im LIVE-Modus):
 *     High-Velocity-Pools (Volumen/Liquidität) werden per Jupiter in beide Richtungen gequotet.
 *     Nur wenn SOL→Token→SOL nach ALLEN Kosten (2× Basis- + Priority-Fee, ATA-Close-Fee)
 *     ≥ SUTR_ARB_MIN_EDGE_BPS abwirft, wird Leg 1 gekauft und Leg 2 sofort verkauft.
 *     Haltezeit = Sekunden → minimales Richtungsrisiko (hartes Max-Hold 90 s, Stop 3 %).
 *     Hinweis: Die beiden Legs sind NICHT atomar; der Spread kann zwischen den Legs verschwinden.
 *
 * (b) LP-Fee-Simulation (immer Paper, auch im LIVE-Modus):
 *     Simuliert Liquiditätsbereitstellung in Raydium-Standard-Pools (x·y=k) mit echten Fee-APRs
 *     und Preisen: Fee-Ertrag, Impermanent Loss und die delta-neutral gehedgte PnL
 *     (LP + statischer Short der Token-Seite → PnL = Fees − V·(√r−1)²/2).
 *
 * (c) Rent-Reclaimer: Schließt leere Token-Konten der Wallet und holt je ~0,002 SOL Rent zurück
 *     (LIVE: echte Close-Transaktionen; SIMULATION: nur Bericht).
 */
export class SuckUpTheRentStrategy extends BaseStrategy {
  readonly name = 'SuckUpTheRent';
  readonly enabled: boolean;
  readonly scanIntervalMs: number;
  readonly manageIntervalMs: number;

  private lastLpTick = 0;
  private lastRentTick = 0;
  private lastRentReportCount = -1;
  private probeStats = { probes: 0, bestEdgeBps: -Infinity, executed: 0 };

  constructor(ctx: StrategyContext) {
    super(ctx);
    const c = ctx.cfg.sutr;
    this.enabled = c.enabled;
    this.scanIntervalMs = c.scanIntervalMs;
    this.manageIntervalMs = c.manageIntervalMs;
  }

  private get c() {
    return this.ctx.cfg.sutr;
  }

  override async init(): Promise<void> {
    await super.init();
    const lp = this.ctx.portfolio.lpPositions(this.name);
    if (lp.length > 0) this.log.info(`${lp.length} LP-Paper-Position(en) übernommen`);
    this.log.info('Sub-Module', {
      arb: this.c.arbEnabled,
      lpSimulation: this.c.lpSimEnabled,
      rentReclaim: this.c.rentReclaimEnabled,
    });
  }

  async scan(): Promise<void> {
    const now = Date.now();
    if (this.c.arbEnabled) await this.guard('arb', () => this.arbTick());
    if (this.c.lpSimEnabled && now - this.lastLpTick >= this.c.lpScanIntervalMs) {
      this.lastLpTick = now;
      await this.guard('lp-sim', () => this.lpTick());
    }
    if (this.c.rentReclaimEnabled && now - this.lastRentTick >= this.c.rentReclaimIntervalMs) {
      this.lastRentTick = now;
      await this.guard('rent-reclaim', () => this.rentTick());
    }
  }

  /** Isoliert Sub-Module: ein Fehler in einem Modul blockiert die anderen nicht. */
  private async guard(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.log.warn(`Sub-Modul ${name} fehlgeschlagen`, { error: errorMessage(e) });
    }
  }

  // ======================================================================= (a) Roundtrip-Arbitrage

  private async arbTick(): Promise<void> {
    const { gecko, portfolio, risk } = this.ctx;
    if (risk.isHalted()) return;
    if (portfolio.positionsFor(this.name).length > 0) return; // ein Roundtrip gleichzeitig

    const [trending, fresh] = await Promise.allSettled([gecko.getTrendingPools(1), gecko.getNewPools(1)]);
    const pools = new Map<string, GeckoPool>();
    for (const r of [trending, fresh]) {
      if (r.status === 'fulfilled') for (const p of r.value) pools.set(p.address, p);
    }

    const now = Date.now();
    const candidates = [...pools.values()]
      .filter((p) => p.quoteTokenMint === SOL_MINT || QUOTE_MINTS.has(p.quoteTokenMint))
      .filter((p) => !QUOTE_MINTS.has(p.baseTokenMint) && p.baseTokenMint.length > 0)
      .filter((p) => p.reserveUsd >= this.c.minLiquidityUsd)
      .filter((p) => p.createdAt === null || now - p.createdAt >= this.c.minPoolAgeMin * 60_000)
      .map((p) => ({ pool: p, velocity: p.reserveUsd > 0 ? p.volumeUsd.h1 / p.reserveUsd : 0 }))
      .filter((x) => x.velocity >= this.c.minVelocity)
      .filter((x) => !portfolio.hasOpenPosition(x.pool.baseTokenMint) && !portfolio.isCoolingDown(x.pool.baseTokenMint))
      .sort((a, b) => b.velocity - a.velocity)
      .slice(0, this.c.arbMaxProbes);

    if (candidates.length === 0) {
      this.log.debug('Arb: keine High-Velocity-Pools über den Schwellen');
      return;
    }

    let best: ArbProbe | null = null;
    for (const { pool, velocity } of candidates) {
      const probe = await this.probe(pool, velocity);
      if (probe && (!best || probe.edgeBps > best.edgeBps)) best = probe;
    }
    if (!best) return;

    this.log.info(
      `Arb: bester Roundtrip ${best.symbol} edge=${best.edgeBps} bps (${lamportsToSol(best.edgeLamports)} SOL) ` +
        `velocity=${round(best.velocity, 2)}/h route=${best.route}`,
      { probesTotal: this.probeStats.probes, bestEverBps: this.probeStats.bestEdgeBps, executed: this.probeStats.executed },
    );
    if (best.edgeBps < this.c.arbMinEdgeBps) return;

    await this.executeRoundtrip(best);
  }

  private async probe(pool: GeckoPool, velocity: number): Promise<ArbProbe | null> {
    const { jupiter, safety, executor } = this.ctx;
    const mint = pool.baseTokenMint;
    const symbol = pool.name.split('/')[0]?.trim() || shortAddr(mint);
    const check = await safety.safeCheck(mint, { rejectMintAuthority: false });
    if (!check.ok) {
      this.log.debug(`Arb: ${symbol} übersprungen – ${check.reasons.join('; ')}`);
      this.ctx.portfolio.setCooldown(mint, 6 * 3_600_000);
      return null;
    }
    const size = solToLamports(this.c.arbSizeSol);
    const slippageBps = Math.min(this.ctx.cfg.execution.defaultSlippageBps, 100);
    try {
      const q1 = await jupiter.quote({ inputMint: SOL_MINT, outputMint: mint, amountRaw: size, slippageBps });
      const tokens = BigInt(q1.outAmount);
      if (tokens <= 0n) return null;
      const q2 = await jupiter.quote({ inputMint: mint, outputMint: SOL_MINT, amountRaw: tokens, slippageBps });
      const priority = await executor.estimatePriorityFeeLamports();
      // 2 Swaps + 1 ATA-Close (Rent kommt zurück, die Close-Tx kostet nur die Basis-Fee)
      const costs = 2n * (BASE_FEE_LAMPORTS + priority) + BASE_FEE_LAMPORTS;
      const edge = BigInt(q2.outAmount) - size - costs;
      const edgeBps = Number((edge * 10_000n) / size);
      this.probeStats.probes++;
      this.probeStats.bestEdgeBps = Math.max(this.probeStats.bestEdgeBps, edgeBps);
      this.log.debug(`Arb-Probe ${symbol}`, {
        edgeBps,
        grossBps: Number(((BigInt(q2.outAmount) - size) * 10_000n) / size),
        costsSol: lamportsToSol(costs),
        impact1: round(JupiterClient.priceImpactPct(q1), 3),
        impact2: round(JupiterClient.priceImpactPct(q2), 3),
      });
      return {
        pool,
        symbol,
        decimals: check.decimals,
        velocity,
        edgeLamports: edge,
        edgeBps,
        route: `${JupiterClient.routeLabel(q1)} ⇄ ${JupiterClient.routeLabel(q2)}`,
      };
    } catch (e) {
      this.log.debug(`Arb-Probe ${symbol} ohne Quote`, { error: errorMessage(e) });
      return null;
    }
  }

  private async executeRoundtrip(p: ArbProbe): Promise<void> {
    const mint = p.pool.baseTokenMint;
    const pos = await this.openPosition({
      mint,
      symbol: p.symbol,
      decimals: p.decimals,
      pairAddress: p.pool.address,
      sizeLamports: solToLamports(this.c.arbSizeSol),
      slippageBps: Math.min(this.ctx.cfg.execution.defaultSlippageBps, 100),
      maxPriceImpactPct: 1,
      exitRules: {
        takeProfitPct: 1_000,
        stopLossPct: 3,
        trailingActivationPct: 0,
        trailingStopPct: 0,
        maxHoldMs: 90_000,
      },
      signal: `ARB_LEG1 edge=${p.edgeBps}bps velocity=${round(p.velocity, 2)}/h`,
      entryPriceUsd: p.pool.priceUsd || null,
      tags: { arb: true, expectedEdgeBps: p.edgeBps },
    });
    if (!pos) return;
    this.probeStats.executed++;
    const trade = await this.closePosition(pos, `ARB_LEG2 (erwartet ${p.edgeBps} bps)`);
    if (trade) {
      this.log.info(`Arb-Roundtrip ${p.symbol} abgeschlossen`, {
        pnlSol: lamportsToSol(trade.pnlLamports),
        pnlPct: round(trade.pnlPct, 3),
        expectedBps: p.edgeBps,
        holdMs: trade.closedAt - trade.openedAt,
      });
    } else {
      this.log.warn(`Arb Leg 2 für ${p.symbol} fehlgeschlagen – Position wird von manage() (Max-Hold 90 s) geschlossen`);
    }
  }

  // ======================================================================= (b) LP-Fee-Simulation

  private async lpTick(): Promise<void> {
    await this.updateLpPositions();
    await this.openLpPositions();
  }

  private tokenPriceInSol(pool: RaydiumPool, tokenIsMintA: boolean): number {
    // Raydium: price = Menge mintB pro 1 mintA
    if (!(pool.price > 0)) return NaN;
    return tokenIsMintA ? pool.price : 1 / pool.price;
  }

  private async updateLpPositions(): Promise<void> {
    const { raydium, portfolio } = this.ctx;
    const open = portfolio.lpPositions(this.name);
    if (open.length === 0) return;
    const pools = await raydium.getPoolsByIds(open.map((l) => l.poolId));
    const byId = new Map(pools.map((p) => [p.id, p]));
    const now = Date.now();

    for (const lp of open) {
      const pool = byId.get(lp.poolId);
      const price = pool ? this.tokenPriceInSol(pool, lp.tokenIsMintA) : NaN;
      if (!pool || !Number.isFinite(price) || price <= 0) {
        const missed = lp.missedUpdates + 1;
        portfolio.updateLp(lp.id, { missedUpdates: missed });
        if (missed >= LP_MAX_MISSED_UPDATES) this.closeLp(lp, 'POOL_GONE');
        continue;
      }

      const dt = Math.max(0, now - lp.lastUpdateAt);
      const feeApr = pool.day.feeApr;
      const fees = lp.accruedFeesLamports + (lp.depositLamports * (feeApr / 100) * dt) / YEAR_MS;
      const r = price / lp.entryTokenPriceSol;
      const sqrtR = Math.sqrt(r);
      const V = lp.depositLamports;
      const unhedged = V * (sqrtR - 1) + fees;
      const deltaNeutral = fees - (V * (sqrtR - 1) ** 2) / 2;

      portfolio.updateLp(lp.id, {
        lastTokenPriceSol: price,
        feeAprPct: feeApr,
        accruedFeesLamports: fees,
        unhedgedPnlLamports: unhedged,
        deltaNeutralPnlLamports: deltaNeutral,
        lastUpdateAt: now,
        missedUpdates: 0,
      });
      const updated = portfolio.lpPositions(this.name).find((l) => l.id === lp.id);
      if (!updated) continue;

      if (now - lp.openedAt >= this.c.lpMaxHoldMin * 60_000) this.closeLp(updated, 'MAX_HOLD');
      else if (deltaNeutral <= -(V * this.c.lpMaxLossPct) / 100) this.closeLp(updated, 'IL_LIMIT');
      else if (feeApr < this.c.lpMinFeeApr / 2) this.closeLp(updated, 'FEE_APR_DROP');
      else {
        this.log.debug(`LP-Paper ${lp.pairName}`, {
          feesSol: round(fees / 1e9, 6),
          ilSol: round((-(V * (sqrtR - 1) ** 2) / 2) / 1e9, 6),
          deltaNeutralSol: round(deltaNeutral / 1e9, 6),
          priceMovePct: round((r - 1) * 100, 2),
        });
      }
    }
  }

  private async openLpPositions(): Promise<void> {
    const { raydium, portfolio, safety } = this.ctx;
    const open = portfolio.lpPositions(this.name);
    const slots = this.c.lpMaxPositions - open.length;
    if (slots <= 0) return;

    const pools = await raydium.listPools({ sortField: 'volume24h', pageSize: 100 });
    const taken = new Set(open.map((l) => l.poolId));
    const takenTokens = new Set(open.map((l) => l.tokenMint));
    const candidates = pools
      .filter((p) => p.type === 'Standard')
      .filter((p) => (p.mintA.address === SOL_MINT) !== (p.mintB.address === SOL_MINT))
      .map((p) => {
        const tokenIsMintA = p.mintB.address === SOL_MINT;
        const token = tokenIsMintA ? p.mintA : p.mintB;
        return { pool: p, tokenIsMintA, token };
      })
      .filter((x) => !QUOTE_MINTS.has(x.token.address))
      .filter((x) => !taken.has(x.pool.id) && !takenTokens.has(x.token.address))
      .filter((x) => x.pool.tvl >= this.c.lpMinTvlUsd && x.pool.day.feeApr >= this.c.lpMinFeeApr)
      // Fee-Ertrag relativ zur Volatilität (Preisspanne 24 h) → höheres Verhältnis = besseres Fee/IL-Profil
      .map((x) => {
        const d = x.pool.day;
        const rangePct = d.priceMin > 0 ? ((d.priceMax - d.priceMin) / d.priceMin) * 100 : 100;
        return { ...x, quality: d.feeApr / Math.max(1, rangePct) };
      })
      .sort((a, b) => b.quality - a.quality);

    let opened = 0;
    for (const x of candidates) {
      if (opened >= slots) break;
      const price = this.tokenPriceInSol(x.pool, x.tokenIsMintA);
      if (!Number.isFinite(price) || price <= 0) continue;
      const check = await safety.safeCheck(x.token.address, { rejectMintAuthority: false });
      if (!check.ok) continue;

      const pairName = `${x.token.symbol || shortAddr(x.token.address)}/SOL`;
      const lp: LpPaperPosition = {
        id: `LP-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
        strategy: this.name,
        poolId: x.pool.id,
        pairName,
        tokenMint: x.token.address,
        tokenIsMintA: x.tokenIsMintA,
        depositLamports: Number(solToLamports(this.c.lpSizeSol)),
        entryTokenPriceSol: price,
        lastTokenPriceSol: price,
        feeAprPct: x.pool.day.feeApr,
        accruedFeesLamports: 0,
        unhedgedPnlLamports: 0,
        deltaNeutralPnlLamports: 0,
        openedAt: Date.now(),
        lastUpdateAt: Date.now(),
        missedUpdates: 0,
      };
      portfolio.addLp(lp);
      opened++;
      this.ctx.journal.record({
        strategy: this.name,
        action: 'LP_OPEN',
        symbol: pairName,
        mint: x.token.address,
        signal: `LP-PAPER feeAPR=${round(x.pool.day.feeApr, 1)}% tvl=$${Math.round(x.pool.tvl)} fee=${x.pool.feeRate * 100}% quality=${round(x.quality, 2)}`,
        inAmount: `${this.c.lpSizeSol} SOL (50/50)`,
        outAmount: '-',
        feesSol: '0',
        priceImpactPct: null,
        slippageBps: null,
        signature: null,
        pnlSol: null,
        pnlPct: null,
        note: `pool=${x.pool.id} (Paper-Simulation, delta-neutral gehedgt)`,
      });
    }
  }

  private closeLp(lp: LpPaperPosition, reason: string): void {
    const closed = this.ctx.portfolio.closeLp(lp.id);
    if (!closed) return;
    const dn = BigInt(Math.round(closed.deltaNeutralPnlLamports));
    const pct = closed.depositLamports > 0 ? (closed.deltaNeutralPnlLamports / closed.depositLamports) * 100 : 0;
    this.ctx.journal.record({
      strategy: this.name,
      action: 'LP_CLOSE',
      symbol: closed.pairName,
      mint: closed.tokenMint,
      signal: `LP-PAPER ${reason}`,
      inAmount: `${lamportsToSol(BigInt(closed.depositLamports))} SOL`,
      outAmount: '-',
      feesSol: lamportsToSol(BigInt(Math.round(closed.accruedFeesLamports))),
      priceImpactPct: null,
      slippageBps: null,
      signature: null,
      pnlSol: lamportsToSol(dn),
      pnlPct: round(pct, 3),
      note:
        `unhedged=${lamportsToSol(BigInt(Math.round(closed.unhedgedPnlLamports)))} SOL ` +
        `priceMove=${round((closed.lastTokenPriceSol / closed.entryTokenPriceSol - 1) * 100, 2)}% ` +
        `hold=${Math.round((Date.now() - closed.openedAt) / 60_000)}min`,
    });
  }

  // ======================================================================= (c) Rent-Reclaimer

  private async rentTick(): Promise<void> {
    const { executor, portfolio } = this.ctx;
    const exclude = new Set<string>([...portfolio.positions().map((p) => p.mint), ...inFlightMints]);
    const res = await executor.reclaimEmptyAccounts(exclude);

    if (executor.mode === 'LIVE') {
      if (res.closed === 0) {
        if (res.found > 0) this.log.warn(`Rent-Reclaim: ${res.found} leere Konten gefunden, keines geschlossen`);
        return;
      }
      const net = res.reclaimedLamports - BASE_FEE_LAMPORTS * BigInt(res.signatures.length);
      portfolio.creditLamports(this.name, net);
      this.ctx.journal.record({
        strategy: this.name,
        action: 'RENT_RECLAIM',
        symbol: 'SOL',
        mint: SOL_MINT,
        signal: `${res.closed} leere Token-Konten geschlossen`,
        inAmount: '-',
        outAmount: `${lamportsToSol(res.reclaimedLamports)} SOL`,
        feesSol: lamportsToSol(BASE_FEE_LAMPORTS * BigInt(res.signatures.length)),
        priceImpactPct: null,
        slippageBps: null,
        signature: res.signatures[0] ?? null,
        pnlSol: lamportsToSol(net),
        pnlPct: null,
      });
      return;
    }

    // SIMULATION: nur berichten (bei Änderung), keine Transaktion
    if (res.found !== this.lastRentReportCount) {
      this.lastRentReportCount = res.found;
      if (res.found > 0) {
        this.log.info(
          `Rent-Reclaim (Simulation): ${res.found} leere Token-Konten in der echten Wallet – ` +
            `${lamportsToSol(res.reclaimableLamports)} SOL wären im LIVE-Modus rückholbar`,
        );
      } else {
        this.log.info('Rent-Reclaim: keine leeren Token-Konten gefunden');
      }
    }
  }

  override async shutdown(): Promise<void> {
    this.log.info('Arb-Statistik', {
      probes: this.probeStats.probes,
      bestEdgeBps: Number.isFinite(this.probeStats.bestEdgeBps) ? this.probeStats.bestEdgeBps : null,
      executed: this.probeStats.executed,
    });
    await super.shutdown();
  }
}
