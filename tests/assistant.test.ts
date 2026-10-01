import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { ASSISTANT_MODEL, StrategyAssistant, parseChat } from '../src/desk/assistant';
import { RUNNER_PRESET, parseRuleSpec } from '../src/desk/custom';
import { historyText, swapOf, type WalletHistory } from '../src/desk/wallet-history';
import { SOL_MINT } from '../src/core/types';

const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();

function fakeClaude(reply: { stop_reason: string; parsed_output: unknown }) {
  const calls: Array<Record<string, unknown>> = [];
  const client = { beta: { messages: { parse: async (params: Record<string, unknown>) => { calls.push(params); return { model: ASSISTANT_MODEL, ...reply }; } } } };
  return { calls, client: client as never };
}
const proposal = { ...parseRuleSpec(RUNNER_PRESET), id: 'MY_RUNNER', label: 'My runner' };

test('assistant: one structured request to Claude with fallbacks; a valid proposal comes back as a checked spec', async () => {
  const { calls, client } = fakeClaude({ stop_reason: 'end_turn', parsed_output: { reply: 'Here is a strategy.', strategy: proposal } });
  const assistant = new StrategyAssistant('test-key', client);
  const r = await assistant.ask({ messages: [{ role: 'user', content: 'I buy coins with >1000 holders' }], strategies: [parseRuleSpec(RUNNER_PRESET)], walletHistory: 'Wallet X — 3 swaps' });
  assert.equal(r.reply, 'Here is a strategy.'); assert.equal(r.strategy!.id, 'MY_RUNNER'); assert.equal(r.specError, null);
  const p = calls[0]!;
  assert.equal(p.model, 'claude-opus-5-5'); assert.equal(p.fallbacks, 'default'); assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal((p.output_config as { effort: string }).effort, 'medium'); assert.ok((p.output_config as { format: unknown }).format, 'structured output');
  const first = (p.messages as Array<{ content: string }>)[0]!.content;
  assert.match(first, /current custom strategies \(JSON\)/); assert.match(first, /Wallet X — 3 swaps/); assert.match(first, /---\n\nI buy coins with >1000 holders$/);
  assert.match(String(p.system), /Holder count above 1,000/);
});

test('assistant: an invalid proposal is reported, a refusal or a cut-off answer never yields a strategy', async () => {
  const bad = new StrategyAssistant('k', fakeClaude({ stop_reason: 'end_turn', parsed_output: { reply: 'x', strategy: { ...proposal, id: 'CRASH' } } }).client);
  const r = await bad.ask({ messages: [{ role: 'user', content: 'go' }], strategies: [] });
  assert.equal(r.strategy, null); assert.match(r.specError!, /^id: FAIR, CRASH, LAUNCH and OPEN are built in/);
  for (const stop of ['refusal', 'max_tokens']) {
    const a = new StrategyAssistant('k', fakeClaude({ stop_reason: stop, parsed_output: { reply: 'x', strategy: proposal } }).client);
    const out = await a.ask({ messages: [{ role: 'user', content: 'go' }], strategies: [] });
    assert.equal(out.strategy, null); assert.equal(out.stopReason, stop);
  }
});

test('chat history from the browser: starts and ends with the user, alternates, bounded', () => {
  assert.equal(parseChat([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]).length, 3);
  for (const bad of [[], [{ role: 'assistant', content: 'a' }], [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }],
    [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], [{ role: 'system', content: 'a' }], [{ role: 'user', content: 'x'.repeat(6_001) }], 'hi'])
    assert.throws(() => parseChat(bad), /INVALID_CHAT/);
});

test('wallet history: buys and sells against SOL or WSOL are swaps; transfers are not', () => {
  const wallet = key(41), mint = key(42), bal = (m: string, amount: string, decimals = 6, owner = wallet) => ({ mint: m, owner, accountIndex: 1, uiTokenAmount: { amount, decimals } });
  const tx = (pre: number, post: number, preT: unknown[], postT: unknown[]) => ({ blockTime: 1_790_000_000, transaction: { message: { accountKeys: [wallet, key(43)] } },
    meta: { err: null, fee: 5000, preBalances: [pre, 0], postBalances: [post, 0], preTokenBalances: preT as never, postTokenBalances: postT as never } });
  const buy = swapOf(tx(10e9, 9.5e9 - 5000, [], [bal(mint, '1000000000')]), wallet, 'S1', 200)!;
  assert.equal(buy.side, 'BUY'); assert.equal(buy.tokens, 1000); assert.equal(buy.valueUsd, 100); assert.equal(buy.priceUsd, 0.1); assert.equal(buy.at, 1_790_000_000_000);
  const sell = swapOf(tx(9.5e9, 9.5e9 - 5000, [bal(mint, '1000000000'), bal(SOL_MINT, '0', 9)], [bal(mint, '0'), bal(SOL_MINT, '2000000000', 9)]), wallet, 'S2', 200)!;
  assert.equal(sell.side, 'SELL'); assert.equal(sell.valueUsd, 400, 'WSOL received counts as SOL');
  assert.equal(swapOf(tx(10e9, 10e9 - 5000, [], [bal(mint, '5')]), wallet, 'S3', 200), null, 'an airdrop is not a buy');
  assert.equal(swapOf(tx(10e9, 10e9 - 5000 - 2_039_280, [], [bal(mint, '5')]), wallet, 'S5', 200), null, 'nor one whose account rent the wallet paid');
  assert.equal(swapOf(tx(10e9, 9e9, [], [bal(mint, '5', 6, key(44))]), wallet, 'S4', 200), null, 'tokens to another owner are not this wallet\'s');
  const h: WalletHistory = { wallet, scanned: 2, trades: 2, note: 'n', tokens: [{ mint, symbol: 'SI', boughtUsd: 100, soldUsd: 400, firstBuyMcapUsd: 300_000, lastSellMcapUsd: 6_000_000,
    nowMcapUsd: 5_000_000, stillHeld: false, trades: [{ ...buy, marketCapUsd: 300_000 }, { ...sell, marketCapUsd: 6_000_000 }] }] };
  assert.match(historyText(h), /SI \(.+\): bought \$100, sold \$400, realized \+\$300; first buy at \$300K, last sell at \$6\.00M, now \$5\.00M\n {2}2026-\d\d-\d\d \d\d:\d\d BUY \$100 at \$300K/);
});
