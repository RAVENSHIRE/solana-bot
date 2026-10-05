import { blindSpots, type Dataset, type Features, type Row } from './dataset';

/**
 * Cohort tables for the research report: each feature is binned on the discovery launches (the earlier 60 %), the
 * same bins are applied unchanged to the validation launches (the later 40 %), and each bin's outcome rates are shown
 * beside the base rate. Nothing is fitted; a feature only looks useful if it holds in both halves.
 */
export interface Outcome { n: number; win: number | null; reach2: number | null; reach5: number | null; grad: number | null; mfe60: number | null; mae15: number | null }
const median = (v: number[]) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const rate = (v: Array<boolean | null>) => { const k = v.filter((x): x is boolean => x !== null); return k.length ? k.filter(Boolean).length / k.length : null; };

export function outcome(rows: Row[]): Outcome {
  return { n: rows.length, win: rate(rows.map(r => r.y.twoBeforeHalf)), reach2: rate(rows.map(r => r.y.reached[2] ?? null)), reach5: rate(rows.map(r => r.y.reached[5] ?? null)),
    grad: rate(rows.map(r => r.y.graduated)),
    mfe60: median(rows.map(r => r.y.mfe[60]).filter((x): x is number => x != null)), mae15: median(rows.map(r => r.y.mae[15]).filter((x): x is number => x != null)) };
}

export type FeatureKey = keyof Omit<Features, 't'>;
export const NUMERIC: FeatureKey[] = ['progress', 'velocity60', 'acceleration', 'buyers', 'newBuyers30', 'buyerAcceleration', 'effectiveBuyers', 'top1', 'top5',
  'netSol', 'sellShare', 'devBuySol', 'descLen', 'metadataLinks', 'xFollowers', 'xAccountAgeH', 'creatorLaunches', 'creatorGraduations', 'chainBreaks'];
export const BOOLEAN: FeatureKey[] = ['devSold', 'hasX', 'hasSite', 'hasTelegram', 'xCaPost', 'mayhem', 'gapInWindow'];

export interface Bin { label: string; test: (f: Features) => boolean }
const value = (f: Features, k: FeatureKey) => f[k] as number | boolean | null;

/** Quintile bins from the discovery rows (fewer when values repeat); unknown values are their own bin. */
export function numericBins(k: FeatureKey, discovery: Row[]): Bin[] {
  const v = discovery.map(r => value(r.f, k)).filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  const bins: Bin[] = [];
  if (v.length >= 10) {
    const fmt = (x: number) => Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(3);
    const edges = [...new Map([0.2, 0.4, 0.6, 0.8].map(q => v[Math.floor(q * (v.length - 1))]!).map(e => [fmt(e), Number(fmt(e))] as const)).values()];
    let lo = -Infinity;
    for (const e of [...edges, Infinity]) {
      const a = lo, b = e;
      bins.push({ label: `${a === -Infinity ? '' : `>${fmt(a)} `}${b === Infinity ? '' : `≤${fmt(b)}`}`.trim() || 'all', test: f => { const x = value(f, k); return typeof x === 'number' && x > a && x <= b; } });
      lo = e;
    }
  }
  bins.push({ label: 'unknown', test: f => typeof value(f, k) !== 'number' });
  return bins;
}
export const booleanBins = (k: FeatureKey): Bin[] => [
  { label: 'yes', test: f => value(f, k) === true }, { label: 'no', test: f => value(f, k) === false }, { label: 'unknown', test: f => value(f, k) === null },
];

const pct = (x: number | null) => x === null ? '   –' : `${(x * 100).toFixed(0).padStart(3)}%`;
const mul = (x: number | null) => x === null ? '    –' : `${(1 + x).toFixed(2).padStart(5)}×`;
export const cell = (o: Outcome) => `n ${String(o.n).padStart(5)} · win ${pct(o.win)} · 2× ${pct(o.reach2)} · 5× ${pct(o.reach5)} · grad ${pct(o.grad)} · mfe1h ${mul(o.mfe60)} · mae15m ${mul(o.mae15)}`;

export interface CohortLine { label: string; d: Outcome; v: Outcome; liftD: number | null; liftV: number | null }
export function cohort(bins: Bin[], discovery: Row[], validation: Row[], baseD: Outcome, baseV: Outcome): CohortLine[] {
  return bins.map(b => {
    const d = outcome(discovery.filter(r => b.test(r.f))), v = outcome(validation.filter(r => b.test(r.f)));
    const lift = (o: Outcome, base: Outcome) => o.win !== null && base.win ? o.win / base.win : null;
    return { label: b.label, d, v, liftD: lift(d, baseD), liftV: lift(v, baseV) };
  }).filter(l => l.d.n + l.v.n > 0);
}

/** A bin that beats the base rate by `minLift` in both halves, with at least `minN` launches in each. */
export const consistent = (l: CohortLine, minLift = 1.5, minN = 30) => l.d.n >= minN && l.v.n >= minN && (l.liftD ?? 0) >= minLift && (l.liftV ?? 0) >= minLift;

export function coverage(ds: Dataset, all: Row[]): string[] {
  const launches = [...ds.launches.values()].filter(l => l.createdObs >= ds.first);
  const traded = launches.filter(l => l.trades.length).length, meta = launches.filter(l => l.meta).length, metaErr = launches.filter(l => l.metaError).length;
  const xAcc = all.filter(r => r.f.hasX).length, xRead = launches.filter(l => l.xReads.some(x => x.st === 'OK')).length;
  const caPosts = launches.filter(l => l.xPosts.some(p => p.mint)).length, sites = launches.filter(l => l.sites.length).length;
  const logGaps = ds.gaps.filter(g => g.source.startsWith('logs')).length, blind = blindSpots(ds).length;
  const hours = (ds.last - ds.first) / 3_600_000;
  const normal = all.filter(r => !r.f.mayhem && r.f.trades >= 2), clean = normal.filter(r => r.f.chainBreaks === 0).length;
  return [
    `${ds.files} files · ${new Date(ds.first).toISOString().slice(0, 16)} → ${new Date(ds.last).toISOString().slice(0, 16)} UTC (${hours.toFixed(1)} h) · ${launches.length} launches created in the window · ${ds.wallets} wallets`,
    `trades seen for ${traded} launches · metadata ${meta} read, ${metaErr} failed · own X account ${xAcc} (of the rows) · X read ${xRead} · own-account CA posts ${caPosts} · websites read ${sites}`,
    `trade-feed disconnects ${logGaps} (${(logGaps / Math.max(hours, 0.01)).toFixed(1)}/h), ${blind} with no other feed connected or an observer restart · rows with such a blind spot in their window ${all.filter(r => r.f.gapInWindow).length} of ${all.length}`,
    `trade chain intact (no missing trade detected) for ${normal.length ? (clean / normal.length * 100).toFixed(1) : '–'} % of ${normal.length} normal launches with ≥ 2 trades · mayhem-mode rows ${all.filter(r => r.f.mayhem).length}`,
  ];
}
