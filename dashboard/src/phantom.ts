import type { VersionedTransaction } from '@solana/web3.js';

export type PhantomKey = { toString(): string };
export type PhantomListener = (key?: PhantomKey | null) => void;
export interface PhantomProvider {
  isPhantom?: boolean;
  isConnected?: boolean;
  publicKey?: PhantomKey | null;
  connect(options?: { onlyIfTrusted: boolean }): Promise<{ publicKey: PhantomKey }>;
  disconnect(): Promise<void>;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
  on(event: string, callback: PhantomListener): void;
  removeListener(event: string, callback: PhantomListener): void;
}
export function phantomProvider():PhantomProvider|undefined {
  return (window as unknown as {phantom?:{solana?:PhantomProvider}}).phantom?.solana;
}
