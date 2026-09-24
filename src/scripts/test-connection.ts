/**
 * Isoliertes Verbindungstest-Skript (sendet KEINE Transaktionen).
 *   npm run test:connection
 *
 * Prüft pro RPC-Endpoint: Version, Slot-Latenz (min/avg/p95), Blockhash-Latenz, Blockhöhe,
 * Node-Verzögerung, Priority-Fee-Niveau und das SOL-Guthaben der Wallet.
 * Zusätzlich: Jupiter-Test-Quote (0,01 SOL → USDC) inkl. API-Key-Prüfung.
 * Exit-Code 0 = alles ok, 1 = mindestens ein kritischer Test fehlgeschlagen.
 */
import 'dotenv/config';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { parseSecretKey } from '../utils/wallet';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const color = process.stdout.isTTY && process.env.LOG_COLOR !== 'false';
const c = (code: string, s: string): string => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const ok = (s: string): void => console.log(`  ${c('32', '✔')} ${s}`);
const fail = (s: string): void => console.log(`  ${c('31', '✘')} ${s}`);
const info = (s: string): void => console.log(`  ${c('36', 'ℹ')} ${s}`);
const warn = (s: string): void => console.log(`  ${c('33', '!')} ${s}`);

function mask(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.length > 1 || u.search ? '/***' : ''}`;
  } catch {
    return '***';
  }
}

async function timed<T>(fn: () => Promise<T>, timeoutMs = 15_000): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`Timeout nach ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return { value, ms: Math.round(performance.now() - start) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function resolveWallet(): PublicKey | null {
  const secret = process.env.WALLET_PRIVATE_KEY;
  if (secret && secret.trim()) {
    try {
      const kp = parseSecretKey(secret);
      const expected = process.env.WALLET_PUBLIC_KEY?.trim();
      if (expected && expected !== kp.publicKey.toBase58()) {
        fail(`WALLET_PUBLIC_KEY passt NICHT zum Private Key (abgeleitet: ${kp.publicKey.toBase58()})`);
        return null;
      }
      ok(`Private Key gültig → Adresse ${kp.publicKey.toBase58()}`);
      return kp.publicKey;
    } catch (e) {
      fail(`Private Key ungültig: ${msg(e)}`);
      return null;
    }
  }
  const pub = process.env.WALLET_PUBLIC_KEY?.trim();
  if (pub) {
    try {
      warn('Kein WALLET_PRIVATE_KEY gesetzt – nutze WALLET_PUBLIC_KEY (nur Lesezugriff)');
      return new PublicKey(pub);
    } catch {
      fail('WALLET_PUBLIC_KEY ist keine gültige Adresse');
    }
  }
  fail('Weder WALLET_PRIVATE_KEY noch WALLET_PUBLIC_KEY gesetzt');
  return null;
}

async function testEndpoint(url: string, wallet: PublicKey | null): Promise<boolean> {
  console.log(`\n${c('1', `RPC ${mask(url)}`)}`);
  const conn = new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true });
  let healthy = true;

  try {
    const { value, ms } = await timed(() => conn.getVersion());
    ok(`getVersion: solana-core ${value['solana-core']} (${ms} ms)`);
  } catch (e) {
    fail(`getVersion: ${msg(e)}`);
    return false;
  }

  const samples: number[] = [];
  let lastSlot = 0;
  for (let i = 0; i < 5; i++) {
    try {
      const { value, ms } = await timed(() => conn.getSlot('confirmed'));
      samples.push(ms);
      lastSlot = value;
    } catch (e) {
      warn(`getSlot #${i + 1}: ${msg(e)}`);
    }
  }
  if (samples.length === 0) {
    fail('getSlot: keine erfolgreiche Antwort');
    healthy = false;
  } else {
    const sorted = [...samples].sort((a, b) => a - b);
    const avg = Math.round(samples.reduce((s, v) => s + v, 0) / samples.length);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
    const line = `Latenz getSlot: min ${sorted[0]} ms | avg ${avg} ms | p95 ${p95} ms (${samples.length}/5) – Slot ${lastSlot}`;
    if (avg > 800) warn(`${line} → hoch; für Trading < 300 ms empfohlen`);
    else ok(line);
  }

  try {
    const { value, ms } = await timed(() => conn.getLatestBlockhash('confirmed'));
    ok(`getLatestBlockhash: ${ms} ms (lastValidBlockHeight ${value.lastValidBlockHeight})`);
  } catch (e) {
    fail(`getLatestBlockhash: ${msg(e)}`);
    healthy = false;
  }

  try {
    const { value, ms } = await timed(() => conn.getBlockHeight('confirmed'));
    ok(`getBlockHeight: ${value} (${ms} ms)`);
  } catch (e) {
    warn(`getBlockHeight: ${msg(e)}`);
  }

  if (lastSlot > 0) {
    try {
      const { value } = await timed(() => conn.getBlockTime(lastSlot));
      if (value) {
        const lagS = Math.round(Date.now() / 1000 - value);
        const t = `Node-Verzögerung (Blockzeit vs. Systemzeit): ~${lagS} s`;
        if (lagS > 30) warn(`${t} → Node hängt hinterher oder Systemuhr falsch (timedatectl prüfen)`);
        else ok(t);
      }
    } catch (e) {
      info(`getBlockTime nicht verfügbar: ${msg(e)}`);
    }
  }

  try {
    const { value } = await timed(() => conn.getRecentPrioritizationFees());
    const fees = value.map((f) => f.prioritizationFee).filter((v) => v > 0).sort((a, b) => a - b);
    const median = fees.length > 0 ? fees[Math.floor(fees.length / 2)]! : 0;
    const estLamports = Math.ceil((median * 300_000) / 1_000_000);
    ok(`Priority-Fee Median: ${median} µLamports/CU (≈ ${estLamports} Lamports pro Swap à 300k CU)`);
  } catch (e) {
    warn(`getRecentPrioritizationFees: ${msg(e)}`);
  }

  if (wallet) {
    try {
      const { value, ms } = await timed(() => conn.getBalance(wallet, 'confirmed'));
      const sol = value / LAMPORTS_PER_SOL;
      const line = `SOL-Guthaben ${wallet.toBase58()}: ${sol.toFixed(6)} SOL (${ms} ms)`;
      if (value === 0) warn(`${line} → Wallet leer`);
      else ok(line);
    } catch (e) {
      fail(`getBalance: ${msg(e)}`);
      healthy = false;
    }
  }
  return healthy;
}

async function testJupiter(): Promise<boolean> {
  const base = (process.env.JUPITER_API_BASE?.trim() || 'https://api.jup.ag/swap/v1').replace(/\/+$/, '');
  const key = process.env.JUPITER_API_KEY?.trim();
  console.log(`\n${c('1', `Jupiter ${base}`)}`);
  if (/api\.jup\.ag/.test(base) && !key) {
    fail('JUPITER_API_KEY fehlt (kostenlos unter https://portal.jup.ag)');
    return false;
  }
  const url = `${base}/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=10000000&slippageBps=50&restrictIntermediateTokens=true`;
  try {
    const { value, ms } = await timed(async () => {
      const res = await fetch(url, { headers: key ? { 'x-api-key': key } : {} });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      return JSON.parse(body) as { outAmount?: string; routePlan?: Array<{ swapInfo?: { label?: string } }> };
    });
    if (!value.outAmount) throw new Error('Antwort ohne outAmount');
    const usdc = Number(value.outAmount) / 1e6;
    const route = (value.routePlan ?? []).map((r) => r.swapInfo?.label ?? '?').join('→');
    ok(`Quote 0,01 SOL → ${usdc.toFixed(4)} USDC (≈ ${(usdc * 100).toFixed(2)} $/SOL) via ${route} (${ms} ms)`);
    return true;
  } catch (e) {
    fail(`Jupiter-Quote: ${msg(e)}`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log(c('1', '\n=== Solana-Bot Verbindungstest ===\n'));
  const endpoints = (process.env.RPC_ENDPOINTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (endpoints.length === 0) {
    fail('RPC_ENDPOINTS ist leer (.env prüfen)');
    process.exit(1);
  }
  const sim = !['false', '0', 'no', 'off'].includes((process.env.SIMULATION_MODE ?? 'true').toLowerCase());
  info(`Modus laut .env: ${sim ? 'SIMULATION (Dry-Run)' : c('31', 'LIVE')}`);

  const wallet = resolveWallet();
  let anyHealthy = false;
  for (const url of endpoints) {
    const healthy = await testEndpoint(url, wallet).catch((e) => {
      fail(`Unerwarteter Fehler: ${msg(e)}`);
      return false;
    });
    anyHealthy ||= healthy;
  }
  const jupOk = await testJupiter();

  console.log('');
  const allOk = anyHealthy && jupOk && wallet !== null;
  if (allOk) ok(c('1', 'Alle kritischen Tests bestanden – der Bot kann gestartet werden.'));
  else fail(c('1', 'Mindestens ein kritischer Test ist fehlgeschlagen – siehe oben.'));
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  fail(`Abbruch: ${msg(e)}`);
  process.exit(1);
});
