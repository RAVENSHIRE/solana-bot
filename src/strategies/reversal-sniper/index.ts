import { BaseStrategy, type ExitDecision, type StrategyContext } from '../base-strategy';
import { DexScreenerClient, type DexPair } from '../../data/dexscreener';
import { BASE58_ADDRESS_REGEX, QUOTE_MINTS, type Candle, type Position } from '../../core/types';
import { ema, last, mean, rsi } from '../../analysis/indicators';
import { analyzeSupport, bullishDivergence, type SupportAnalysis } from '../../analysis/support';
import { analyzeVolumeQuality, type VolumeQuality } from '../../analysis/wash-trading';
import { analyzeSmartMoney, type SmartMoneyAnalysis } from '../../analysis/smart-money';
import { errorMessage } from '../../utils/errors';
import { clamp, pctChange, round, shortAddr, solToLamports } from '../../utils/format';

interface Candidate {
  mint: string;
  pair: DexPair;
  sources: string[];
}

interface ScoreBreakdown {
  support: number;
  momentum: number;
  exhaustion: number;
  volume: number;
  accumulation: number;
}

interface Analysis {
  score: number;
  breakdown: ScoreBreakdown;
  drawdownPct: number;
  rsiNow: number;
  support: SupportAnalysis;
  volume: VolumeQuality;
  smart: SmartMoneyAnalysis;
  notes: string[];
}

type Rejection = { rejected: string };

const OHLCV_AGGREGATE_MIN = 5;
const OHLCV_LIMIT = 288; // 24 h in 5-Minuten-Kerzen
const MIN_CANDLES = 60;

/**
 * ReversalSniper – kauft Memecoins nach starkem Abverkauf, wenn mehrere unabhängige
 * Umkehr-Belege zusammenkommen:
 *   1. Bodenbildung: mehrfach getestete Support-Zone, höhere Tiefs, kein "fallendes Messer"
 *   2. Momentum-Wende: RSI dreht aus überverkauft, bullische Divergenz, EMA9-Reclaim
 *   3. Verkäufer-Erschöpfung: sinkendes Verkaufsvolumen, Kapitulations-Dochte
 *   4. Volumenqualität: echtes vs. Wash-Trading-Volumen (Einzel-Trade-Analyse)
 *   5. Akkumulation: Cluster unabhängiger Wallets / bekannter Smart-Money-Wallets
 * Einstieg nur ab RS_MIN_SCORE und nach On-Chain-Sicherheitsprüfung des Mints.
 */
export class ReversalSniperStrategy extends BaseStrategy {
  readonly name = 'ReversalSniper';
  readonly enabled: boolean;
  readonly scanIntervalMs: number;
  readonly manageIntervalMs: number;

  private readonly evaluatedAt = new Map<string, number>();
  private readonly lastPriceUsd = new Map<string, number>();
  private readonly knownWallets: ReadonlySet<string>;

  constructor(ctx: StrategyContext) {
    super(ctx);
    const c = ctx.cfg.rs;
    this.enabled = c.enabled;
    this.scanIntervalMs = c.scanIntervalMs;
    this.manageIntervalMs = c.manageIntervalMs;
    this.knownWallets = new Set(c.smartMoneyWallets);
  }

  private get c() {
    return this.ctx.cfg.rs;
  }

  // ======================================================================= Scan

  async scan(): Promise<void> {
    const { portfolio, risk, cfg } = this.ctx;
    if (risk.isHalted()) return;
    if (portfolio.positions().length >= cfg.risk.maxOpenPositions) {
      this.log.debug('Max. offene Positionen erreicht – Scan übersprungen');
      return;
    }

    const candidates = await this.discover();
    this.pruneEvaluated();
    const shortlisted = candidates
      .map((c) => ({ c, why: this.prefilter(c.pair) }))
      .filter((x): x is { c: Candidate; why: null } => x.why === null)
      .map((x) => x.c)
      .filter((c) => !this.evaluatedAt.has(c.mint) && !portfolio.hasOpenPosition(c.mint) && !portfolio.isCoolingDown(c.mint))
      // stärkster Abverkauf mit ordentlicher Liquidität zuerst
      .sort((a, b) => (a.pair.priceChange?.h24 ?? 0) - (b.pair.priceChange?.h24 ?? 0))
      .slice(0, this.c.maxAnalysesPerScan);

    this.log.info(`Scan: ${candidates.length} Tokens entdeckt, ${shortlisted.length} zur Tiefenanalyse`);

    for (const cand of shortlisted) {
      this.evaluatedAt.set(cand.mint, Date.now());
      const symbol = cand.pair.baseToken.symbol || shortAddr(cand.mint);
      let result: Analysis | Rejection;
      try {
        result = await this.analyze(cand);
      } catch (e) {
        this.log.warn(`Analyse ${symbol} fehlgeschlagen`, { error: errorMessage(e) });
        continue;
      }
      if ('rejected' in result) {
        this.log.info(`✗ ${symbol}: ${result.rejected}`);
        continue;
      }
      const b = result.breakdown;
      const summary = `score=${result.score} [S${b.support} M${b.momentum} E${b.exhaustion} V${b.volume} A${b.accumulation}] dd=${result.drawdownPct}% rsi=${round(result.rsiNow, 1)}`;
      if (result.score < this.c.minScore) {
        this.log.info(`✗ ${symbol}: ${summary} < ${this.c.minScore}`, { notes: result.notes });
        continue;
      }
      this.log.info(`✓ Umkehr-Signal ${symbol}: ${summary}`, {
        notes: result.notes,
        organic: result.volume.organicScore,
        washRatio: result.volume.washRatio,
        accumulators: result.smart.accumulatorCount,
        knownSmart: result.smart.knownSmartBuyers,
      });
      await this.enter(cand, symbol, result, summary);
      if (portfolio.positions().length >= cfg.risk.maxOpenPositions) break;
    }
  }

  private async discover(): Promise<Candidate[]> {
    const { dex, gecko } = this.ctx;
    const sources: Array<[string, Promise<string[]>]> = [
      ['boosts', dex.getLatestBoostedTokens()],
      ['topBoosts', dex.getTopBoostedTokens()],
      ['profiles', dex.getLatestProfiles()],
      [
        'geckoTrending',
        gecko.getTrendingPools(1).then((pools) => pools.filter((p) => QUOTE_MINTS.has(p.quoteTokenMint)).map((p) => p.baseTokenMint)),
      ],
      ['watchlist', Promise.resolve(this.c.watchlist)],
    ];
    const settled = await Promise.allSettled(sources.map(([, p]) => p));
    const bySource = new Map<string, string[]>();
    settled.forEach((r, i) => {
      const name = sources[i]![0];
      if (r.status === 'fulfilled') {
        for (const mint of r.value) {
          if (!BASE58_ADDRESS_REGEX.test(mint) || QUOTE_MINTS.has(mint)) continue;
          const list = bySource.get(mint) ?? [];
          list.push(name);
          bySource.set(mint, list);
        }
      } else {
        this.log.debug(`Discovery-Quelle ${name} fehlgeschlagen`, { error: errorMessage(r.reason) });
      }
    });
    if (bySource.size === 0) return [];

    const pairs = await dex.getPairsForTokens([...bySource.keys()]);
    const best = DexScreenerClient.bestPairPerToken(pairs);
    return [...best.entries()].map(([mint, pair]) => ({ mint, pair, sources: bySource.get(mint) ?? [] }));
  }

  /** Günstige Vorfilter auf DexScreener-Daten (keine weiteren API-Calls). null = bestanden. */
  private prefilter(p: DexPair): string | null {
    const c = this.c;
    const liq = p.liquidity?.usd ?? 0;
    if (liq < c.minLiquidityUsd) return 'Liquidität';
    const mcap = p.marketCap ?? p.fdv ?? 0;
    if (mcap < c.minMcapUsd || mcap > c.maxMcapUsd) return 'Marktkapitalisierung';
    if (!p.pairCreatedAt || Date.now() - p.pairCreatedAt < c.minPairAgeHours * 3_600_000) return 'Pair zu jung';
    const h24 = p.priceChange?.h24 ?? 0;
    const h6 = p.priceChange?.h6 ?? 0;
    const m5 = p.priceChange?.m5 ?? 0;
    if (!(h24 <= -c.minH24DropPct || h6 <= -10)) return 'kein Abwärtstrend';
    if (m5 <= -4) return 'akuter Abverkauf';
    const tx = p.txns?.h1;
    if (!tx || tx.buys + tx.sells < 20) return 'zu wenig Aktivität';
    return null;
  }

  // ======================================================================= Tiefenanalyse

  private async analyze(cand: Candidate): Promise<Analysis | Rejection> {
    const c = this.c;
    const candles = await this.ctx.gecko.getOhlcv(cand.pair.pairAddress, 'minute', OHLCV_AGGREGATE_MIN, OHLCV_LIMIT);
    if (candles.length < MIN_CANDLES) return { rejected: `zu wenig Kursdaten (${candles.length} Kerzen)` };

    const closes = candles.map((k) => k.c);
    const current = closes[closes.length - 1]!;
    const high = Math.max(...candles.map((k) => k.h));
    const drawdownPct = round(((high - current) / high) * 100, 1);
    if (drawdownPct < c.minDrawdownPct) return { rejected: `Drawdown ${drawdownPct}% < ${c.minDrawdownPct}%` };

    const support = analyzeSupport(candles, c.supportTolerancePct);
    if (support.fallingKnife) return { rejected: `fallendes Messer (neues Tief in den letzten Kerzen, dd=${drawdownPct}%)` };

    const notes: string[] = [];
    const rsiV = rsi(closes, 14);
    const rsiNow = last(rsiV);
    const breakdown: ScoreBreakdown = {
      support: this.scoreSupport(support, notes),
      momentum: this.scoreMomentum(candles, closes, rsiV, support, notes),
      exhaustion: this.scoreExhaustion(candles, notes),
      volume: 0,
      accumulation: 0,
    };

    // Frühabbruch: ohne Chart-Basis lohnt sich der teure Trade-Abruf nicht
    const chartScore = breakdown.support + breakdown.momentum + breakdown.exhaustion;
    if (chartScore + 45 < c.minScore) {
      return { rejected: `Chartstruktur schwach (${chartScore}/55)` };
    }

    const trades = await this.ctx.gecko.getTrades(cand.pair.pairAddress, 0);
    const volume = analyzeVolumeQuality(trades);
    if (volume.tradeCount < 10) return { rejected: 'zu wenige Einzel-Trades für Volumenanalyse' };
    if (volume.washRatio > c.maxWashRatio) {
      return { rejected: `Wash-Trading ${Math.round(volume.washRatio * 100)}% > ${Math.round(c.maxWashRatio * 100)}% (${volume.flags.join(', ')})` };
    }
    breakdown.volume = round((volume.organicScore / 100) * 20, 1);
    if (volume.flags.length > 0) notes.push(...volume.flags);

    const smart = analyzeSmartMoney(trades, {
      minAccumulationUsd: c.minAccumulationUsd,
      knownWallets: this.knownWallets,
      excludeWallets: volume.washWallets,
    });
    breakdown.accumulation = round((smart.clusterScore / 100) * 25, 1);
    if (smart.accumulatorCount > 0) notes.push(`${smart.accumulatorCount} Akkumulatoren ($${smart.accumulatedUsd})`);
    if (smart.knownSmartBuyers > 0) notes.push(`${smart.knownSmartBuyers} Smart-Money-Käufer`);
    if (smart.knownSmartSellers > 0) notes.push(`${smart.knownSmartSellers} Smart-Money-Verkäufer`);

    const score = round(
      breakdown.support + breakdown.momentum + breakdown.exhaustion + breakdown.volume + breakdown.accumulation,
      1,
    );
    return { score, breakdown, drawdownPct, rsiNow, support, volume, smart, notes };
  }

  /** Max. 25 Punkte */
  private scoreSupport(s: SupportAnalysis, notes: string[]): number {
    let score = 0;
    const n = s.nearest;
    if (n) {
      if (n.touches >= 2) score += 12;
      if (n.touches >= 3) score += 5;
      if (s.distancePct !== null && s.distancePct >= -this.c.supportTolerancePct && s.distancePct <= 6) score += 5;
      notes.push(`Support ${n.price.toPrecision(4)}$ ×${n.touches} (Abstand ${s.distancePct === null ? '-' : round(s.distancePct, 1)}%)`);
    }
    if (s.higherLow) {
      score += 3;
      notes.push('höheres Tief');
    }
    return Math.min(25, score);
  }

  /** Max. 20 Punkte */
  private scoreMomentum(candles: Candle[], closes: number[], rsiV: number[], s: SupportAnalysis, notes: string[]): number {
    let score = 0;
    const rsiNow = last(rsiV);
    const recentRsi = rsiV.slice(-12).filter((v) => !Number.isNaN(v));
    const rsiMin = recentRsi.length > 0 ? Math.min(...recentRsi) : NaN;
    if (!Number.isNaN(rsiMin) && rsiMin < 30 && rsiNow > rsiMin + 5 && rsiNow < 60) {
      score += 8;
      notes.push(`RSI dreht (${round(rsiMin, 0)}→${round(rsiNow, 0)})`);
    }
    if (bullishDivergence(candles, rsiV, s.pivotIndices)) {
      score += 6;
      notes.push('bullische RSI-Divergenz');
    }
    const e9 = ema(closes, 9);
    const n = closes.length;
    const aboveNow = closes[n - 1]! > last(e9);
    const belowRecently = [2, 3, 4].some((k) => {
      const cl = closes[n - k];
      const ev = e9[n - k];
      return cl !== undefined && ev !== undefined && !Number.isNaN(ev) && cl <= ev;
    });
    if (aboveNow && belowRecently) {
      score += 6;
      notes.push('EMA9-Reclaim');
    } else if (aboveNow && last(e9) > last(e9, 3)) {
      score += 3;
    }
    return Math.min(20, score);
  }

  /** Max. 10 Punkte: nachlassender Verkaufsdruck und Kapitulations-Dochte. */
  private scoreExhaustion(candles: Candle[], notes: string[]): number {
    let score = 0;
    const red = (arr: Candle[]): number[] => arr.filter((k) => k.c < k.o).map((k) => k.v);
    const recentRed = red(candles.slice(-12));
    const earlierRed = red(candles.slice(-48, -12));
    if (earlierRed.length >= 5) {
      const ratio = recentRed.length === 0 ? 0 : mean(recentRed) / Math.max(1e-9, mean(earlierRed));
      if (ratio < 0.6) {
        score += 5;
        notes.push(`Verkaufsvolumen −${Math.round((1 - ratio) * 100)}%`);
      }
    }
    const hammer = candles.slice(-6).some((k) => {
      const body = Math.abs(k.c - k.o);
      const lowerWick = Math.min(k.o, k.c) - k.l;
      const range = k.h - k.l;
      return range > 0 && lowerWick >= Math.max(body * 2, range * 0.5);
    });
    if (hammer) {
      score += 5;
      notes.push('Kapitulations-Docht');
    }
    return clamp(score, 0, 10);
  }

  // ======================================================================= Einstieg

  private async enter(cand: Candidate, symbol: string, a: Analysis, summary: string): Promise<void> {
    const c = this.c;
    const safety = await this.ctx.safety.safeCheck(cand.mint, { rejectMintAuthority: true });
    if (!safety.ok) {
      this.log.info(`✗ ${symbol}: Sicherheitsprüfung – ${safety.reasons.join('; ')}`);
      this.ctx.portfolio.setCooldown(cand.mint, 24 * 3_600_000);
      return;
    }

    // Dynamischer Stop knapp unter dem Support (min. 5 %, max. RS_STOP_LOSS_PCT)
    let stopLossPct = c.stopLossPct;
    const sup = a.support.nearest;
    if (sup && a.support.currentPrice > 0) {
      const distToSupport = ((a.support.currentPrice - sup.price) / a.support.currentPrice) * 100;
      stopLossPct = clamp(round(distToSupport + c.supportTolerancePct + 2, 1), 5, c.stopLossPct);
    }

    const priceUsd = Number(cand.pair.priceUsd ?? NaN);
    await this.openPosition({
      mint: cand.mint,
      symbol,
      decimals: safety.decimals,
      pairAddress: cand.pair.pairAddress,
      sizeLamports: solToLamports(c.tradeSizeSol),
      slippageBps: this.ctx.cfg.execution.defaultSlippageBps,
      exitRules: {
        takeProfitPct: c.takeProfitPct,
        stopLossPct,
        trailingActivationPct: c.trailingActivationPct,
        trailingStopPct: c.trailingStopPct,
        maxHoldMs: c.maxHoldMin * 60_000,
      },
      signal: `REVERSAL ${summary} via=${cand.sources.join('+')}`,
      entryPriceUsd: Number.isFinite(priceUsd) ? priceUsd : null,
      tags: {
        score: a.score,
        supportPriceUsd: sup ? sup.price : 0,
        supportTouches: sup ? sup.touches : 0,
        dex: cand.pair.dexId,
      },
    });
  }

  // ======================================================================= Verwaltung

  override async manage(): Promise<void> {
    const own = this.ctx.portfolio.positionsFor(this.name);
    if (own.length === 0) return;
    // Aktuelle USD-Preise (ein Batch-Call) für den Support-Bruch-Exit
    try {
      const pairs = await this.ctx.dex.getPairsForTokens(own.map((p) => p.mint));
      for (const [mint, pair] of DexScreenerClient.bestPairPerToken(pairs)) {
        const px = Number(pair.priceUsd ?? NaN);
        if (Number.isFinite(px) && px > 0) this.lastPriceUsd.set(mint, px);
      }
    } catch (e) {
      this.log.debug('Preis-Update fehlgeschlagen', { error: errorMessage(e) });
    }
    await this.manageOpenPositions();
  }

  /** Zusatz-Exit: Support-Zone per Schlusskurs deutlich unterschritten → These ungültig. */
  protected override async customExit(pos: Position, value: bigint): Promise<ExitDecision | null> {
    const support = typeof pos.tags.supportPriceUsd === 'number' ? pos.tags.supportPriceUsd : 0;
    const px = this.lastPriceUsd.get(pos.mint);
    if (support <= 0 || px === undefined) return null;
    const breakLevel = support * (1 - (this.c.supportTolerancePct * 1.5) / 100);
    if (px < breakLevel) {
      const pnlPct = pctChange(pos.costLamports, value);
      return { reason: `SUPPORT_BROKEN(${px.toPrecision(4)} < ${breakLevel.toPrecision(4)})`, pnlPct, emergency: true };
    }
    return null;
  }

  override async shutdown(): Promise<void> {
    this.evaluatedAt.clear();
    await super.shutdown();
  }

  private pruneEvaluated(): void {
    const ttl = this.c.reevaluateAfterMin * 60_000;
    const now = Date.now();
    for (const [mint, at] of this.evaluatedAt) if (now - at > ttl) this.evaluatedAt.delete(mint);
    for (const mint of this.lastPriceUsd.keys()) {
      if (!this.ctx.portfolio.hasOpenPosition(mint)) this.lastPriceUsd.delete(mint);
    }
  }
}
