/**
 * Known cases: tokens the owner or earlier sessions singled out after the fact (winners, misses, clones, rugs). They
 * are research evidence and hypothesis generators, nothing more. Several desk rules were written from one of them
 * (OPEN from FIX6900, GOLDEN from 66hK2, LAUNCH from Meme Industries) and did not hold up in TEST.
 *
 * Rule: a known case never counts towards deciding whether a rule works. Experiments exclude every token matching a
 * case below by default, and `knownCaseDependence` (backtest/analysis) reports how much a result leans on them.
 * Where only a shortened address was recorded, the case matches by its prefix (and suffix when known).
 */

export type CaseRole = 'WINNER' | 'MISSED' | 'CLONE' | 'ORIGINAL' | 'RUG' | 'INSPIRED_RULE' | 'IMPERSONATOR' | 'COPYCAT' | 'UNKNOWN';
export interface KnownCase {
  label: string;
  /** Full mint when recorded. */
  mint: string | null;
  /** Shortened address as recorded in the docs ("7cYaQc…"), when the full mint is not in the repository. */
  prefix?: string; suffix?: string;
  role: CaseRole;
  source: string;
  note: string;
}

export const KNOWN_CASES: readonly KnownCase[] = Object.freeze([
  { label: 'GAwhcph…9S9H', mint: 'GAwhcphCqCv5bKHmCiN4VDdNWfbXJL4npmkc8L3Q9S9H', role: 'WINNER', source: 'owner, 2 Oct',
    note: 'An interesting detection named by the owner. No point-in-time data for it is in the repository.' },
  { label: 'WW', mint: null, role: 'WINNER', source: 'owner, 2 Oct', note: 'Named by the owner; its mint is not recorded in the repository: add it here.' },
  { label: 'AGENCY', mint: null, role: 'WINNER', source: 'docs/RESEARCH.md; engine skip log (0ca2054)',
    note: 'The project\'s own X account posted the CA about 2 minutes after launch; MIGRATION2 flagged it entry-ready twice. Mint not recorded: add it here.' },
  { label: '7cYaQc…', mint: null, prefix: '7cYaQc', role: 'MISSED', source: 'docs/DESK.md, 2 Oct',
    note: 'Graduated at ~$45K, dipped to $32K, broke out to $81K, ran to $932K; filtered by the 5m buy/sell ratio (0.96–1.27).' },
  { label: 'SI', mint: '7Wh6rxVWUBFCNCWCz7nLaV7z3SDr2M6rFTjjWP6aE8p1', role: 'MISSED', source: 'docs/HANDOFF-ASTRA.md', note: 'Seen at $396K after peaking at $447K; CRASH stopped out −15 %.' },
  { label: 'SIF (clone)', mint: 'F4sTBdunw23aCMuTMJE7scem1VWwcoptL6iwaGeZt3Fe', role: 'CLONE', source: 'docs/HANDOFF-ASTRA.md', note: 'The desk traded the clone.' },
  { label: 'SIF (original, PONS)', mint: 'DhVcpV6UdtMKATyQm8E6CvpJmy91HdPibe9s7uzkwYuN', role: 'ORIGINAL', source: 'docs/HANDOFF-ASTRA.md', note: 'Earlier, larger, with a website.' },
  { label: 'Solana GM (clone of BSC GM)', mint: '4Kou9tGyJ83cvLjzHU1Vs2W1e31gTytGDBNxvQcigFpS', role: 'WINNER', source: 'docs/HANDOFF-ASTRA.md',
    note: 'Paper +110 % in 75 s; later +727 % with two −55 % minutes.' },
  { label: 'FIX6900', mint: null, prefix: '6bQ4', suffix: 'SmvC', role: 'INSPIRED_RULE', source: 'docs/DESK.md', note: 'Inspired OPEN; OPEN lost on all 7 TEST trades.' },
  { label: 'BULLISHCAT (66hK2)', mint: null, prefix: '66hK2', role: 'INSPIRED_RULE', source: 'docs/DESK.md', note: 'Inspired GOLDEN POCKET; −33 % per trade with realistic stops.' },
  { label: 'Meme Industries', mint: null, prefix: 'FFrRBPP9', suffix: 'pump', role: 'INSPIRED_RULE', source: 'docs/DESK.md', note: 'Inspired LAUNCH (@glabuz entry).' },
  { label: 'Potato', mint: null, prefix: 'GicwGn7X', role: 'RUG', source: 'docs/DESK.md', note: 'Insiders sold into migration, X account deleted.' },
  { label: 'ETF', mint: null, prefix: '5EvrB7', suffix: 'pump', role: 'RUG', source: 'docs/DESK.md', note: 'Best LAUNCH trade, then −84 % after graduation.' },
  { label: 'STASH impersonator', mint: null, prefix: 'Fx5E1', suffix: 'HQyJ', role: 'IMPERSONATOR', source: 'docs/DESK.md', note: 'Copied the real project\'s X and site.' },
  { label: 'FIX6900 copycat', mint: null, prefix: '3jxu74', suffix: 'cPVk', role: 'COPYCAT', source: 'docs/DESK.md', note: 'Alerted 8 minutes after the real FIX6900 graduated.' },
]);

export function matchesKnownCase(mint: string, cases: readonly KnownCase[] = KNOWN_CASES): KnownCase | null {
  for (const c of cases) {
    if (c.mint && c.mint === mint) return c;
    if (!c.mint && c.prefix && mint.startsWith(c.prefix) && (!c.suffix || mint.endsWith(c.suffix))) return c;
  }
  return null;
}

/** The tokens of a dataset that are known cases: pass them to experiments as `knownCases`. */
export function knownCaseTokens(tokens: Iterable<string>, cases: readonly KnownCase[] = KNOWN_CASES): string[] {
  return [...new Set([...tokens].filter(t => matchesKnownCase(t, cases)))].sort();
}
