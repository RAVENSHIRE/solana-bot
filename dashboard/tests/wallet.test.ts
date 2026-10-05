import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,mkdir,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWalletReader } from '../server/wallet';

test('wallet endpoint setup only consumes public address/RPC fields; plan comes from the desk capital setting',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'wallet-monitor-'));
  try {
    await writeFile(path.join(dir,'.env'),'WALLET_PRIVATE_KEY=invalid-test-fixture\nWALLET_PUBLIC_KEY=11111111111111111111111111111111\n');
    await mkdir(path.join(dir,'data'));
    await writeFile(path.join(dir,'data/wallet-monitor.json'),JSON.stringify({plannedStartUsd:10}));
    // A stale local planning value (the old $10) never overrides the desk's configured capital.
    const reader=await createWalletReader(dir,5.45);
    assert.equal(reader.address,'11111111111111111111111111111111');assert.equal(reader.plannedStartUsd,5.45);
    await assert.rejects(reader.read('garbage'),/INVALID_ADDRESS/);
    await assert.rejects(reader.read(null),/RPC_NOT_CONFIGURED/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
