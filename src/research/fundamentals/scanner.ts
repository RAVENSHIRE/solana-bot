/**
 * Token security scan before a coin reaches the phone or a strategy: GoPlus (every chain it covers) and, on Solana,
 * RugCheck. A scan lowers the chance of a rug; it does not rule one out (a liquidity pull or a coordinated dump needs
 * no contract trick).
 *
 * Field names follow the providers' public API docs. Parsing is deliberately tolerant: a field that is missing or has
 * an unexpected shape reads as unknown, never as safe. When no provider answers, the verdict is UNKNOWN, not PASS.
 * `research:fundamentals -- --token <address> --raw` prints the raw answers so the mapping can be checked by eye.
 */

export type Chain = 'solana' | 'ethereum' | 'bsc' | 'base' | 'arbitrum' | 'polygon' | 'avalanche' | 'optimism';
export const CHAINS: readonly Chain[] = Object.freeze(['solana', 'ethereum', 'bsc', 'base', 'arbitrum', 'polygon', 'avalanche', 'optimism']);

/** GoPlus chain ids for EVM token security (Solana has its own endpoint). */
export const GOPLUS_CHAIN_ID: Readonly<Record<Exclude<Chain, 'solana'>, string>> = Object.freeze({
  ethereum: '1', bsc: '56', base: '8453', arbitrum: '42161', polygon: '137', avalanche: '43114', optimism: '10',
});

export type Level = 'BLOCK' | 'WARN' | 'INFO';
export interface Finding { source: 'goplus' | 'rugcheck'; level: Level; code: string; detail: string }
export type SourceStatus = 'OK' | 'NOT_COVERED' | 'NOT_FOUND' | `ERROR: ${string}`;
export type Verdict = 'BLOCK' | 'WARN' | 'PASS' | 'UNKNOWN';
export interface ScanResult {
  chain: Chain; token: string; at: number; verdict: Verdict; findings: Finding[];
  sources: { goplus: SourceStatus; rugcheck: SourceStatus };
  raw: { goplus: unknown; rugcheck: unknown };
}

export const SCAN = Object.freeze({
  timeoutMs: 10_000,
  /** Sell (or transfer) tax: above this blocks, above `warnTaxPct` warns. */
  blockTaxPct: 10, warnTaxPct: 3,
  /** Same limits as the desk's CRASH holder gates. */
  maxLargestHolderPct: 15, maxTop10Pct: 50,
});

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** '1' / 1 / true → true, '0' / 0 / false → false, { status } → its status, anything else → null (unknown). */
export function flag(v: unknown): boolean | null {
  if (v === '1' || v === 1 || v === true) return true;
  if (v === '0' || v === 0 || v === false) return false;
  return isObj(v) && 'status' in v ? flag(v.status) : null;
}
/** A number that may arrive as a string ("0.05"); null when absent or unparsable. */
export function numeric(v: unknown): number | null {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
}
/** GoPlus reports taxes and holder shares as fractions (0.05 = 5 %). */
const pctOf = (v: unknown) => { const x = numeric(v); return x === null ? null : x * 100; };

/** GoPlus answers are keyed by address; EVM addresses come back lower-case. */
function goplusEntry(raw: unknown, token: string): Obj | null {
  const result = isObj(raw) && isObj(raw.result) ? raw.result : null;
  if (!result) return null;
  const hit = result[token] ?? result[token.toLowerCase()] ?? Object.entries(result).find(([k]) => k.toLowerCase() === token.toLowerCase())?.[1];
  return isObj(hit) ? hit : null;
}

function holderFindings(holders: unknown, source: Finding['source']): Finding[] {
  if (!Array.isArray(holders) || !holders.length) return [];
  const listed = holders.filter(isObj);
  // Shares should be fractions (0.05 = 5 %). If all listed holders add up to more than 1, they are already percents.
  const total = listed.reduce((a, h) => a + (numeric(h.percent) ?? 0), 0), scale = total > 1.0001 ? 1 : 100;
  // Contracts and locked balances (pools, lockers, burn addresses) are not wallets that can dump.
  const wallets = listed.filter(h => flag(h.is_contract) !== true && flag(h.is_locked) !== true)
    .map(h => numeric(h.percent)).filter((x): x is number => x !== null).map(x => x * scale).sort((a, b) => b - a);
  if (!wallets.length) return [];
  const out: Finding[] = [];
  const top = wallets[0]!, top10 = wallets.slice(0, 10).reduce((a, x) => a + x, 0);
  if (top > SCAN.maxLargestHolderPct) out.push({ source, level: 'WARN', code: 'LARGEST_HOLDER', detail: `largest wallet holds ${top.toFixed(1)} %` });
  if (top10 > SCAN.maxTop10Pct) out.push({ source, level: 'WARN', code: 'TOP10', detail: `top-10 wallets hold ${top10.toFixed(1)} %` });
  return out;
}

function taxFinding(code: string, label: string, v: unknown): Finding[] {
  const p = pctOf(v);
  if (p === null || p <= SCAN.warnTaxPct) return [];
  return [{ source: 'goplus', level: p > SCAN.blockTaxPct ? 'BLOCK' : 'WARN', code, detail: `${label} ${p.toFixed(1)} %` }];
}

/** GoPlus EVM token security → findings. */
export function goplusEvmFindings(e: Obj): Finding[] {
  const out: Finding[] = [];
  const hit = (key: string, level: Level, detail: string) => { if (flag(e[key]) === true) out.push({ source: 'goplus', level, code: key.toUpperCase(), detail }); };
  hit('is_honeypot', 'BLOCK', 'honeypot: buys work, sells do not');
  hit('cannot_sell_all', 'BLOCK', 'holders cannot sell their whole balance');
  hit('cannot_buy', 'BLOCK', 'the token cannot be bought');
  hit('transfer_pausable', 'BLOCK', 'the owner can pause transfers');
  hit('owner_change_balance', 'BLOCK', 'the owner can change balances');
  hit('hidden_owner', 'BLOCK', 'hidden owner');
  hit('can_take_back_ownership', 'BLOCK', 'ownership can be taken back after renouncing');
  hit('selfdestruct', 'BLOCK', 'the contract can self-destruct');
  hit('honeypot_with_same_creator', 'BLOCK', 'the creator deployed honeypots before');
  hit('is_mintable', 'WARN', 'new supply can be minted');
  hit('is_proxy', 'WARN', 'upgradeable proxy: the code can change');
  hit('slippage_modifiable', 'WARN', 'the owner can change the tax');
  hit('personal_slippage_modifiable', 'WARN', 'the owner can set a tax per wallet');
  hit('is_blacklisted', 'WARN', 'has a blacklist');
  hit('trading_cooldown', 'WARN', 'trading cooldown');
  hit('external_call', 'WARN', 'calls external contracts on transfer');
  if (flag(e.is_open_source) === false) out.push({ source: 'goplus', level: 'WARN', code: 'NOT_OPEN_SOURCE', detail: 'contract source not verified' });
  out.push(...taxFinding('SELL_TAX', 'sell tax', e.sell_tax), ...taxFinding('BUY_TAX', 'buy tax', e.buy_tax), ...holderFindings(e.holders, 'goplus'));
  if (flag(e.trust_list) === true) out.push({ source: 'goplus', level: 'INFO', code: 'TRUST_LIST', detail: 'on the GoPlus trust list' });
  return out;
}

/** GoPlus Solana token security → findings. */
export function goplusSolanaFindings(e: Obj): Finding[] {
  const out: Finding[] = [];
  const hit = (key: string, level: Level, detail: string) => { if (flag(e[key]) === true) out.push({ source: 'goplus', level, code: key.toUpperCase(), detail }); };
  hit('mintable', 'BLOCK', 'mint authority is live: supply can grow');
  hit('freezable', 'BLOCK', 'freeze authority is live: your tokens can be frozen');
  hit('balance_mutable_authority', 'BLOCK', 'an authority can change balances');
  hit('non_transferable', 'BLOCK', 'the token cannot be transferred');
  hit('closable', 'WARN', 'the mint can be closed');
  hit('transfer_fee_upgradable', 'WARN', 'the transfer fee can be raised');
  hit('transfer_hook_upgradable', 'WARN', 'the transfer hook can be changed');
  hit('default_account_state_upgradable', 'WARN', 'new accounts can be made frozen by default');
  if (Array.isArray(e.transfer_hook) && e.transfer_hook.length) out.push({ source: 'goplus', level: 'WARN', code: 'TRANSFER_HOOK', detail: 'runs a program on every transfer' });
  // The fee's unit is not pinned down in the docs, so any non-zero rate warns and shows the raw value.
  const fee = isObj(e.transfer_fee) ? (e.transfer_fee.current_fee_rate ?? e.transfer_fee.fee_rate) : e.transfer_fee;
  const feeRate = isObj(fee) ? numeric(fee.fee_rate) : numeric(fee);
  if (feeRate !== null && feeRate > 0) out.push({ source: 'goplus', level: 'WARN', code: 'TRANSFER_FEE', detail: `transfer fee (raw rate ${feeRate})` });
  hit('metadata_mutable', 'INFO', 'name and image can still change');
  if (flag(e.trusted_token) === true) out.push({ source: 'goplus', level: 'INFO', code: 'TRUSTED', detail: 'GoPlus lists it as trusted' });
  out.push(...holderFindings(e.holders, 'goplus'));
  return out;
}

/** RugCheck report summary (Solana) → findings. Its `danger` risks warn; live mint or freeze authority blocks. */
export function rugcheckFindings(r: Obj): Finding[] {
  const out: Finding[] = [];
  if (r.rugged === true) out.push({ source: 'rugcheck', level: 'BLOCK', code: 'RUGGED', detail: 'RugCheck marks it as rugged' });
  for (const risk of Array.isArray(r.risks) ? r.risks.filter(isObj) : []) {
    const name = typeof risk.name === 'string' ? risk.name : 'risk', level = typeof risk.level === 'string' ? risk.level.toLowerCase() : '';
    const authority = /mint authority|freeze authority/i.test(name);
    const mapped: Level | null = authority ? 'BLOCK' : level === 'danger' ? 'WARN' : level === 'warn' ? 'INFO' : null;
    if (!mapped) continue;
    const detail = [name, typeof risk.value === 'string' && risk.value ? `(${risk.value})` : ''].filter(Boolean).join(' ');
    out.push({ source: 'rugcheck', level: mapped, code: name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, ''), detail });
  }
  const score = numeric(r.score_normalised);
  if (score !== null) out.push({ source: 'rugcheck', level: 'INFO', code: 'SCORE', detail: `RugCheck risk score ${score} (higher is riskier)` });
  return out;
}

export function verdictOf(findings: readonly Finding[], sources: ScanResult['sources']): Verdict {
  if (findings.some(f => f.level === 'BLOCK')) return 'BLOCK';
  if (findings.some(f => f.level === 'WARN')) return 'WARN';
  return Object.values(sources).some(s => s === 'OK') ? 'PASS' : 'UNKNOWN';
}

export interface ScannerDeps { fetcher?: typeof fetch; now?: () => number; timeoutMs?: number }

async function getJson(url: string, d: ScannerDeps): Promise<{ status: number; body: unknown }> {
  const res = await (d.fetcher ?? fetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(d.timeoutMs ?? SCAN.timeoutMs) });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text.slice(0, 200); }
  return { status: res.status, body };
}
const failure = (e: unknown): SourceStatus => `ERROR: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`;

export async function scanToken(chain: Chain, token: string, d: ScannerDeps = {}): Promise<ScanResult> {
  const at = (d.now ?? Date.now)();
  const sources: ScanResult['sources'] = { goplus: 'NOT_COVERED', rugcheck: chain === 'solana' ? 'NOT_FOUND' : 'NOT_COVERED' };
  const raw: ScanResult['raw'] = { goplus: null, rugcheck: null };
  const findings: Finding[] = [];
  const goplusUrl = chain === 'solana'
    ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(token)}`
    : `https://api.gopluslabs.io/api/v1/token_security/${GOPLUS_CHAIN_ID[chain]}?contract_addresses=${encodeURIComponent(token)}`;
  const goplus = getJson(goplusUrl, d).then(({ status, body }) => {
    raw.goplus = body;
    const entry = status === 200 ? goplusEntry(body, token) : null;
    if (status !== 200) sources.goplus = `ERROR: HTTP ${status}`;
    else if (!entry) sources.goplus = 'NOT_FOUND';
    else { sources.goplus = 'OK'; findings.push(...(chain === 'solana' ? goplusSolanaFindings(entry) : goplusEvmFindings(entry))); }
  }).catch(e => { sources.goplus = failure(e); });
  const rugcheck = chain !== 'solana' ? Promise.resolve() : getJson(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(token)}/report/summary`, d).then(({ status, body }) => {
    raw.rugcheck = body;
    if (status === 404) sources.rugcheck = 'NOT_FOUND';
    else if (status !== 200 || !isObj(body)) sources.rugcheck = `ERROR: HTTP ${status}`;
    else { sources.rugcheck = 'OK'; findings.push(...rugcheckFindings(body)); }
  }).catch(e => { sources.rugcheck = failure(e); });
  await Promise.all([goplus, rugcheck]);
  const order: Record<Level, number> = { BLOCK: 0, WARN: 1, INFO: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return { chain, token, at, verdict: verdictOf(findings, sources), findings, sources, raw };
}
