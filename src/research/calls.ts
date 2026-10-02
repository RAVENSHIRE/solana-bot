import { features, type LaunchFacts } from './dataset';
import { simulate, DIRECT_DEFAULTS, type DirectOptions } from './direct';
import { GROUPS, describeExit } from './rules';
import type { Qualification, RuleEvidence } from './qualify';
import type { ResearchLedger } from './ledger';

/**
 * Live calls from the research layer. At each rule's decision time the observer's facts about a launch go through the
 * same feature code as the look-back; a match of a QUALIFIED rule goes to the phone, a match of any other candidate rule
 * is recorded as a shadow call (never sent). After the rule's hold, each signal is judged with the same simulation as
 * the look-back, so the live record and the backtest measure the same thing. Those results feed the next qualification:
 * a rule whose live calls lose money stops calling.
 */
export const CALLS = Object.freeze({
  /** A decision is evaluated only this soon after its time: a late call would quote a stale price. */
  maxLateMs: 5_000,
  /** Results are judged this long after the hold ends (the last minute candle must close). */
  judgeAfterMs: 90_000,
  maxOpen: 50_000,
});
export interface CallDeps {
  ledger: ResearchLedger;
  now?: () => number;
  /** The phone (ntfy/Telegram); null: nothing is sent. */
  notify?: ((title: string, body: string) => Promise<void>) | null;
  solUsd?: () => number | null;
  costs?: Omit<DirectOptions, 'delayS'>;
  link?: (mint: string) => string;
  log?: (line: string) => void;
}
interface Signal { l: LaunchFacts; rule: RuleEvidence; qualified: boolean; decisionAt: number }

const usdK = (usd: number) => usd >= 1e6 ? `$${(usd / 1e6).toFixed(2)}M` : `$${(usd / 1e3).toFixed(1)}K`;

export class CallEngine {
  private q: Qualification | null = null;
  private readonly done = new Map<string, Set<number>>();
  private open: Signal[] = [];
  stats = { calls: 0, shadows: 0, late: 0, judged: 0, notFilled: 0 };
  constructor(private readonly d: CallDeps) {}

  private get now(): number { return (this.d.now ?? Date.now)(); }

  /** A new qualification (the rule set and its evidence); recorded so the dataset knows which rules were live when. */
  setQualification(q: Qualification | null): void {
    this.q = q;
    const live = q?.rules.filter(r => r.qualified).map(r => r.id) ?? [];
    this.d.ledger.put(['QUAL', this.now, { generatedAt: q?.generatedAt ?? null, qualified: live, candidates: q?.rules.length ?? 0, data: q?.data ?? null }]);
    this.d.log?.(`qualification ${q ? new Date(q.generatedAt).toISOString().slice(0, 16) : 'none'}: ${live.length} qualified rule(s) of ${q?.rules.length ?? 0}${live.length ? ` — ${live.join(', ')}` : ''}`);
  }
  qualification(): Qualification | null { return this.q; }
  /** Mints with a signal still waiting for its result: the observer keeps their trades. */
  holding(mint: string): boolean { return this.open.some(s => s.l.mint === mint); }

  tick(launches: Iterable<LaunchFacts>): void {
    const q = this.q, now = this.now;
    if (q) {
      const delays = [...new Set(q.rules.map(r => r.delayS))];
      for (const l of launches) {
        if (l.mayhem) continue;
        const done = this.done.get(l.mint) ?? new Set<number>();
        for (const delayS of delays) {
          const at = l.createdObs + delayS * 1000;
          if (done.has(delayS) || now < at) continue;
          done.add(delayS); this.done.set(l.mint, done);
          if (now - at > CALLS.maxLateMs) { this.stats.late++; continue; }
          this.evaluate(l, delayS, q, at);
        }
      }
      for (const [mint, set] of this.done) if (set.size >= delays.length && !this.holding(mint)) this.done.delete(mint);
    }
    this.judge(now);
  }

  private evaluate(l: LaunchFacts, delayS: number, q: Qualification, at: number): void {
    l.trades.sort((a, b) => a.slot - b.slot || a.obs - b.obs);
    const f = features(l, delayS, { creatorLaunches: 0, creatorGraduations: 0 }, []);
    if (f.mcapSol === null) return;
    for (const rule of q.rules.filter(r => r.delayS === delayS && GROUPS[r.group].test(f))) {
      const qualified = rule.qualified, sent = qualified && !!this.d.notify;
      if (qualified) this.stats.calls++; else this.stats.shadows++;
      this.d.ledger.put(['SIG', this.now, { $m: l.mint }, rule.id, qualified ? 1 : 0, Math.round(f.mcapSol * 1000) / 1000, sent ? 1 : 0,
        { b: f.buyers, top1: f.top1, eff: f.effectiveBuyers, v60: f.velocity60, p: f.progress, dev: f.devBuySol, devSold: f.devSold, x: f.hasX, site: f.hasSite }]);
      if (this.open.length < CALLS.maxOpen) this.open.push({ l, rule, qualified, decisionAt: at });
      if (sent) void this.d.notify!(...this.message(l, rule, f.mcapSol)).catch(() => undefined);
    }
  }

  /** The phone message: what to buy, at what price, the exit plan, and the evidence behind the rule. */
  message(l: LaunchFacts, rule: RuleEvidence, mcapSol: number): [string, string] {
    const sol = this.d.solUsd?.() ?? null, x = rule.exit, v = rule.validation;
    const mc = (m: number) => sol ? `${usdK(m * sol)} (${m.toFixed(0)} SOL)` : `${m.toFixed(0)} SOL`;
    const title = `CALL ${l.symbol ?? l.mint.slice(0, 6)}: +${x.tpPct}% target`;
    const body = [
      `Buy now at ${mc(mcapSol)} market cap, ${rule.delayS} s after launch.`,
      `Sell at ${mc(mcapSol * (1 + x.tpPct / 100))} (+${x.tpPct}%)${x.slPct !== null ? `, stop ${mc(mcapSol * (1 - x.slPct / 100))} (−${x.slPct}%)` : ''}, after ${x.maxHoldMin} min at the latest.`,
      `Rule: ${rule.groupLabel} · ${describeExit(x)}. On ${v.n} launches it was not tuned on: ${v.meanPct >= 0 ? '+' : ''}${v.meanPct.toFixed(1)}% average after costs, target hit ${v.tpPct.toFixed(0)}%.`,
      this.d.link ? this.d.link(l.mint) : `https://pump.fun/coin/${l.mint}`,
    ].join('\n');
    return [title, body];
  }

  private judge(now: number): void {
    const costs = this.d.costs ?? DIRECT_DEFAULTS, keep: Signal[] = [];
    for (const s of this.open) {
      const endsAt = s.decisionAt + costs.latencyMs + s.rule.exit.maxHoldMin * 60_000;
      if (now < endsAt + CALLS.judgeAfterMs) { keep.push(s); continue; }
      const r = simulate(s.l, s.rule.exit, { ...costs, delayS: s.rule.delayS }, now);
      if (!r) { this.stats.notFilled++; continue; }
      this.stats.judged++;
      this.d.ledger.put(['RES', now, { $m: s.l.mint }, s.rule.id, s.qualified ? 1 : 0, Math.round(r.netPct * 100) / 100, r.reason,
        Math.round(r.entryMcap * 1000) / 1000, Math.round(r.exitMcap * 1000) / 1000, Math.round(r.peakPct * 10) / 10]);
    }
    this.open = keep;
  }
}
