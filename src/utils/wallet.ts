import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Logger } from './logger';

/**
 * Parst einen Secret Key.
 * - Phantom-Export ("Private Key anzeigen"): base58-String (64 Bytes)
 * - Solana-CLI-Format: JSON-Array mit 64 Zahlen
 * - 32-Byte-Seed wird ebenfalls akzeptiert
 */
export function parseSecretKey(secret: string): Keypair {
  const trimmed = secret.trim().replace(/^["']|["']$/g, '');
  let bytes: Uint8Array;

  if (trimmed.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(trimmed);
    } catch {
      throw new Error('WALLET_PRIVATE_KEY: JSON-Array konnte nicht geparst werden');
    }
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error('WALLET_PRIVATE_KEY: JSON-Array muss aus Bytes (0–255) bestehen');
    }
    bytes = Uint8Array.from(arr as number[]);
  } else {
    try {
      bytes = bs58.decode(trimmed);
    } catch {
      throw new Error('WALLET_PRIVATE_KEY: kein gültiger base58-String');
    }
  }

  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`WALLET_PRIVATE_KEY: ungültige Länge ${bytes.length} Bytes (erwartet 64 oder 32)`);
}

/**
 * Lädt die Wallet aus der Umgebung und entfernt den Key danach aus process.env,
 * damit er nicht versehentlich in Child-Prozesse, Crash-Dumps oder Logs gelangt.
 */
export function loadWalletFromEnv(): Keypair {
  const secret = process.env.WALLET_PRIVATE_KEY;
  if (!secret) throw new Error('WALLET_PRIVATE_KEY ist nicht gesetzt');
  const keypair = parseSecretKey(secret);
  delete process.env.WALLET_PRIVATE_KEY;

  const expected = process.env.WALLET_PUBLIC_KEY?.trim();
  if (expected && expected !== keypair.publicKey.toBase58()) {
    throw new Error(
      `WALLET_PUBLIC_KEY (${expected}) passt nicht zum Private Key (abgeleitet: ${keypair.publicKey.toBase58()})`,
    );
  }
  return keypair;
}

/** Warnt, wenn die .env-Datei für Gruppe/Andere lesbar ist. */
export function checkEnvFilePermissions(logger: Logger, envPath = path.resolve(process.cwd(), '.env')): void {
  if (process.platform === 'win32') return;
  try {
    const st = fs.statSync(envPath);
    if ((st.mode & 0o077) !== 0) {
      logger.warn(
        `.env ist für Gruppe/Andere lesbar (Modus ${(st.mode & 0o777).toString(8)}). Dringend empfohlen: chmod 600 .env`,
      );
    }
  } catch {
    // Keine .env-Datei vorhanden (Variablen kommen z. B. aus PM2/systemd) – nichts zu prüfen.
  }
}
