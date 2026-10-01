import test from 'node:test';
import assert from 'node:assert/strict';
import { XFeed, XFEED, postMints } from '../src/desk/xfeed';
import { LaunchReviewer, REVIEW_MODEL, reviewPoints, reviewPrompt, type ReviewInput } from '../src/desk/review';

const MEME = 'FFrRBPP9yWtSqnKjXXM9C77MBdLztfdgSnRE858zpump';
const NOW = Date.parse('2026-10-01T16:10:00Z');

test('X feed: off without a token; reads recent posts with their authors, extracts the CAs, continues after the newest post', async () => {
  assert.deepEqual(await new XFeed(null).poll(NOW), []);
  assert.equal(new XFeed(null).status().lastError, 'X_BEARER_TOKEN not set in .env');
  const urls: string[] = [], headers: Array<Record<string, string>> = [];
  const body = { data: [
      { id: '2105691378000761235', text: 'Meme Industries is live\n\nca: ' + MEME, author_id: 'u1', created_at: '2026-10-01T16:08:41.000Z', public_metrics: { like_count: 41, impression_count: 21_711 } },
      { id: '2', text: 'gm frens, no coin here', author_id: 'u2', created_at: '2026-10-01T16:09:00.000Z', public_metrics: { like_count: 1, impression_count: 10 } },
      { id: '3', text: 'aping this https://t.co/x', author_id: 'u2', created_at: '2026-10-01T16:09:30.000Z', entities: { urls: [{ expanded_url: `https://pump.fun/coin/${MEME}` }] } }],
    includes: { users: [{ id: 'u1', username: 'MemeInds', created_at: '2026-09-25T09:38:10.000Z', public_metrics: { followers_count: 770 } },
      { id: 'u2', username: 'caller', public_metrics: { followers_count: 12_000 } }] }, meta: { newest_id: '3' } };
  const fetcher = (async (url: string, init: RequestInit) => { urls.push(url); headers.push(init.headers as Record<string, string>); return new Response(JSON.stringify(body)); }) as unknown as typeof fetch;
  const feed = new XFeed('tok', fetcher);
  const out = await feed.poll(NOW);
  assert.deepEqual(out.map(s => [s.handle, s.mint, s.followers, s.views]), [['MemeInds', MEME, 770, 21_711], ['caller', MEME, 12_000, null]]);
  assert.equal(out[0]!.accountCreatedAt, Date.parse('2026-09-25T09:38:10.000Z')); assert.equal(out[0]!.postAt, Date.parse('2026-10-01T16:08:41.000Z'));
  assert.equal(headers[0]!.Authorization, 'Bearer tok'); assert.match(urls[0]!, /^https:\/\/api\.x\.com\/2\/tweets\/search\/recent\?query=/);
  assert.deepEqual(await feed.poll(NOW + 5_000), [], 'polled at most every 30 s');
  await feed.poll(NOW + XFEED.pollMs); assert.match(urls[1]!, /since_id=3/);
  assert.deepEqual(feed.status().signals, 4);
});

test('X feed: a rate limit waits for the window to reset; a bad token is reported, never thrown', async () => {
  const reset = Math.floor((NOW + 600_000) / 1000);
  const limited = new XFeed('tok', (async () => new Response('', { status: 429, headers: { 'x-rate-limit-reset': String(reset) } })) as unknown as typeof fetch);
  assert.deepEqual(await limited.poll(NOW), []); assert.equal(limited.status().nextAllowedAt, reset * 1000);
  assert.deepEqual(await limited.poll(NOW + XFEED.pollMs), [], 'still waiting');
  const bad = new XFeed('tok', (async () => new Response('', { status: 403 })) as unknown as typeof fetch);
  await bad.poll(NOW); assert.equal(bad.status().lastError, 'X API HTTP 403 (token invalid or plan without search)');
  assert.deepEqual(postMints('new coin pump.fun/coin/' + MEME, []), [MEME]);
});

const input: ReviewInput = { mint: MEME, name: 'Meme Industries', symbol: 'MEME', description: 'Launch anything. Fund everything.', ageMin: 2,
  x: { handle: 'MemeInds', kind: 'ACCOUNT', followers: 770, createdAt: NOW - 6 * 86_400_000, bio: 'Launch anything.', posts: [{ text: 'we are live', views: 21_711, likes: 41, at: NOW - 60_000 }] },
  website: { url: 'https://onsolchain.lol/', title: 'Meme Industries', description: 'We make memes', text: 'Launch anything. Demo video. Roadmap.' },
  ca: '@MemeInds posted this CA', insiders: 'insiders hold 9.0%: dev 2.0% + 3 wallets in the creation slot' };

test('Claude review: one low-effort structured request with fallbacks; bounded per hour; a refusal or failure is no review', async () => {
  const calls: Array<Record<string, unknown>> = [];
  let reply: Record<string, unknown> = { stop_reason: 'end_turn', parsed_output: { verdict: 'STRONG', idea: 12, professionalism: 8, aiGenerated: 'UNLIKELY', scamSignals: [], summary: 'Real product, strong launch post.' } };
  const client = { beta: { messages: { parse: async (p: Record<string, unknown>) => { calls.push(p); return { model: REVIEW_MODEL, ...reply }; } } } } as never;
  const r = new LaunchReviewer('k', client, 2);
  const out = (await r.review(input, NOW))!;
  assert.equal(out.verdict, 'STRONG'); assert.equal(out.idea, 10, 'clamped to 0–10'); assert.equal(reviewPoints(out), 3);
  const p = calls[0]!;
  assert.equal(p.model, 'claude-opus-5-5'); assert.equal((p.output_config as { effort: string }).effort, 'low'); assert.ok((p.output_config as { format: unknown }).format);
  assert.equal(p.fallbacks, 'default'); assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.match((p.messages as Array<{ content: string }>)[0]!.content, /770 followers, account created 6 days ago[\s\S]*21711 views, 41 likes\] we are live/);
  reply = { stop_reason: 'refusal', parsed_output: null };
  assert.equal(await r.review(input, NOW), null);
  assert.equal(r.available(NOW), false, 'two requests per hour in this test'); assert.equal(await r.review(input, NOW), null); assert.equal(calls.length, 2);
  assert.equal(r.status(), 'Claude review: 1 done, 1 failed (refusal), 2/2 this hour');
  assert.equal(r.available(NOW + 3_600_001), true);
  const failing = new LaunchReviewer('k', { beta: { messages: { parse: async () => { throw new Error('offline'); } } } } as never);
  assert.equal(await failing.review(input, NOW), null);
  assert.match(reviewPrompt({ ...input, x: null, website: null }, NOW), /Website: none\nX: none$/);
});
