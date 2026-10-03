import { Connection, PublicKey, type ParsedInstruction, type PartiallyDecodedInstruction } from '@solana/web3.js';

/**
 * Who holds a Solana token: its 20 largest accounts, the wallet behind each, and where each wallet got its first SOL.
 * Wallets funded by the same source, or by each other, are one cluster (likely one actor); wallets funded by the
 * developer or by the developer's own funder are the team. A source with 1,000 transactions or more is an exchange or
 * a service that funds everyone, so it never links wallets.
 *
 * About 45 RPC calls per token. Read-only; never signs anything.
 */
export const HOLDERS = Object.freeze({ top: 20, busyTxs: 1_000, freshDays: 7, concurrency: 4 });
const SYSTEM = '11111111111111111111111111111111';

export interface HolderRpc {
  /** Total supply in token units. */
  supply(mint: string): Promise<number>;
  /** The largest token accounts and their balances in token units. */
  largest(mint: string): Promise<Array<{ account: string; amount: number }>>;
  /** The owner of each token account (null when unreadable). */
  owners(accounts: string[]): Promise<Array<string | null>>;
  /** The program owning each address: the System Program for a wallet, another program for a pool or vault (null: no account). */
  programs(addresses: string[]): Promise<Array<string | null>>;
  /** Up to `HOLDERS.busyTxs` signatures; the oldest is the wallet's first transaction when fewer came back. */
  history(wallet: string): Promise<{ count: number; oldest: { signature: string; at: number | null } | null }>;
  /** The address that sent SOL to (or created) `wallet` in this transaction. */
  funder(wallet: string, signature: string): Promise<string | null>;
}

export interface Holder {
  owner: string; pct: number; kind: 'wallet' | 'program';
  /** First transaction (ms) when the wallet has fewer than `busyTxs`; null for busy wallets and programs. */
  firstAt: number | null; busy: boolean; funder: string | null; cluster: number | null; team: boolean;
}
export interface HolderScan {
  mint: string; at: number; supply: number; dev: string | null; devFunder: string | null; holders: Holder[];
  /** Shares of the supply (%): the top 20, held by programs (pools, vaults, lockers), and by wallets. */
  topPct: number; programPct: number; walletPct: number;
  /** Held by wallets in a cluster of two or more; by the team; by wallets whose first transaction is under 7 days old. */
  clusterPct: number; teamPct: number; freshPct: number;
  largest: { funder: string | null; pct: number; wallets: number } | null;
  /** Funders shared by several top wallets but busy enough to be an exchange or service (not counted as clusters). */
  services: string[];
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); } }));
  return out;
}

export async function scanHolders(rpc: HolderRpc, mint: string, o: { dev?: string | null; now?: number } = {}): Promise<HolderScan> {
  const now = o.now ?? Date.now(), dev = o.dev ?? null;
  const [supply, largest] = await Promise.all([rpc.supply(mint), rpc.largest(mint)]);
  const top = largest.slice(0, HOLDERS.top);
  const owners = await rpc.owners(top.map(t => t.account));
  // Several token accounts of one owner are one holder.
  const byOwner = new Map<string, number>();
  top.forEach((t, i) => { const w = owners[i]; if (w) byOwner.set(w, (byOwner.get(w) ?? 0) + t.amount); });
  const ownerList = [...byOwner.keys()], programs = await rpc.programs(ownerList);
  const holders: Holder[] = ownerList.map((owner, i) => ({ owner, pct: supply > 0 ? byOwner.get(owner)! / supply * 100 : 0,
    kind: programs[i] && programs[i] !== SYSTEM ? 'program' : 'wallet', firstAt: null, busy: false, funder: null, cluster: null, team: false }));
  const origin = async (wallet: string) => {
    const h = await rpc.history(wallet);
    if (h.count >= HOLDERS.busyTxs || !h.oldest) return { busy: h.count >= HOLDERS.busyTxs, firstAt: null, funder: null };
    return { busy: false, firstAt: h.oldest.at, funder: await rpc.funder(wallet, h.oldest.signature) };
  };
  const wallets = holders.filter(h => h.kind === 'wallet');
  const found = await pool([...wallets.map(w => w.owner), ...(dev && !byOwner.has(dev) ? [dev] : [])], HOLDERS.concurrency, origin);
  wallets.forEach((w, i) => Object.assign(w, found[i]));
  const devFunder = dev ? (byOwner.has(dev) ? wallets.find(w => w.owner === dev)?.funder ?? null : found.at(-1)?.funder ?? null) : null;

  // A funder shared by several wallets links them, unless it is busy (an exchange hot wallet funds thousands).
  const shared = new Map<string, number>();
  for (const w of wallets) if (w.funder) shared.set(w.funder, (shared.get(w.funder) ?? 0) + 1);
  const candidates = [...shared].filter(([f, n]) => n >= 2 && !byOwner.has(f)).map(([f]) => f);
  const busy = await pool(candidates, HOLDERS.concurrency, async f => (await rpc.history(f)).count >= HOLDERS.busyTxs);
  const services = candidates.filter((_, i) => busy[i]);
  const parent = new Map<string, string>();
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  const join = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const w of wallets) if (w.funder && !services.includes(w.funder) && (shared.get(w.funder)! >= 2 || byOwner.has(w.funder))) join(w.owner, w.funder);
  const groups = new Map<string, Holder[]>();
  for (const w of wallets) { const r = find(w.owner); if (r !== w.owner || wallets.some(x => x !== w && find(x.owner) === r)) groups.set(r, [...(groups.get(r) ?? []), w]); }
  let id = 0, largestGroup: HolderScan['largest'] = null;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const c = id++, pct = members.reduce((a, m) => a + m.pct, 0);
    for (const m of members) m.cluster = c;
    const counts = new Map<string, number>();
    for (const m of members) if (m.funder) counts.set(m.funder, (counts.get(m.funder) ?? 0) + 1);
    const funder = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (!largestGroup || pct > largestGroup.pct) largestGroup = { funder, pct, wallets: members.length };
  }
  // The team: the developer, wallets it funded, wallets funded by its own funder, and anyone clustered with them.
  const devSet = new Set([dev, devFunder].filter((x): x is string => !!x && !services.includes(x)));
  const teamClusters = new Set(wallets.filter(w => devSet.has(w.owner) || (w.funder && devSet.has(w.funder))).map(w => w.cluster).filter((c): c is number => c !== null));
  for (const w of wallets) w.team = devSet.has(w.owner) || (!!w.funder && devSet.has(w.funder)) || (w.cluster !== null && teamClusters.has(w.cluster));

  const sum = (xs: Holder[]) => xs.reduce((a, h) => a + h.pct, 0);
  const freshSince = now - HOLDERS.freshDays * 86_400_000;
  return { mint, at: now, supply, dev, devFunder, holders: holders.sort((a, b) => b.pct - a.pct),
    topPct: sum(holders), programPct: sum(holders.filter(h => h.kind === 'program')), walletPct: sum(wallets),
    clusterPct: sum(wallets.filter(w => w.cluster !== null)), teamPct: sum(wallets.filter(w => w.team)),
    freshPct: sum(wallets.filter(w => w.firstAt !== null && w.firstAt >= freshSince)), largest: largestGroup, services };
}

type Ix = ParsedInstruction | PartiallyDecodedInstruction;
const transferTo = (ix: Ix, wallet: string): string | null => {
  if (!('parsed' in ix) || ix.program !== 'system') return null;
  const p = ix.parsed as { type?: string; info?: Record<string, string> };
  if ((p.type === 'transfer' || p.type === 'transferWithSeed') && p.info?.destination === wallet) return p.info.source ?? null;
  if ((p.type === 'createAccount' || p.type === 'createAccountWithSeed') && p.info?.newAccount === wallet) return p.info.source ?? null;
  return null;
};

/** The holder scan over a plain Solana RPC endpoint (Helius or any other). */
export function rpcHolders(connection: Connection): HolderRpc {
  const keys = (xs: string[]) => xs.map(x => new PublicKey(x));
  const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
  return {
    supply: async mint => (await connection.getTokenSupply(new PublicKey(mint))).value.uiAmount ?? 0,
    largest: async mint => (await connection.getTokenLargestAccounts(new PublicKey(mint))).value.map(a => ({ account: a.address.toBase58(), amount: a.uiAmount ?? 0 })),
    owners: async accounts => (await Promise.all(chunks(accounts, 100).map(c => connection.getMultipleParsedAccounts(keys(c))))).flatMap(r => r.value.map(a => {
      const data = a?.data as { parsed?: { info?: { owner?: string } } } | Buffer | undefined;
      return data && !Buffer.isBuffer(data) ? data.parsed?.info?.owner ?? null : null;
    })),
    programs: async addresses => (await Promise.all(chunks(addresses, 100).map(c => connection.getMultipleAccountsInfo(keys(c))))).flat().map(a => a?.owner.toBase58() ?? null),
    history: async wallet => {
      const sigs = await connection.getSignaturesForAddress(new PublicKey(wallet), { limit: HOLDERS.busyTxs });
      const last = sigs.at(-1);
      return { count: sigs.length, oldest: last ? { signature: last.signature, at: last.blockTime ? last.blockTime * 1000 : null } : null };
    },
    funder: async (wallet, signature) => {
      const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) return null;
      const all: Ix[] = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap(i => i.instructions)];
      for (const ix of all) { const f = transferTo(ix, wallet); if (f) return f; }
      return null;
    },
  };
}
