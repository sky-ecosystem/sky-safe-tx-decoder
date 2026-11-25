/**
 * Tests for the execution time read from a node. `fetch` is stubbed with the
 * live publicnode answers for execution transaction
 * 0x7db4b12ee758ce4ca099d4dabcf1a839f40953fe9d06ed5c39ef65248d265c8f
 * (Safe 0xf65475e74C1Ed6d004d5240b06E3088724dFDA5d, nonce 520), captured on
 * 2026-11-25.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchExecutionTime } from './execution-time.js';

const RPC = 'https://ethereum-rpc.publicnode.com';
const TX_HASH = '0x7db4b12ee758ce4ca099d4dabcf1a839f40953fe9d06ed5c39ef65248d265c8f';
const OTHER_TX_HASH = '0x3afdbbdfca4f869f5918b012b771f7cd6aa2dc63c80bf63169dc82502663e3b5';
const TX = { hash: TX_HASH, blockNumber: '0x1677594' };
const BLOCK = { number: '0x1677594', timestamp: '0x68eadcbf' };

function stubRpc(results: unknown[]) {
  const bodies: Array<{ method: string; params: unknown[] }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string));
      const result = results.shift();
      if (result instanceof Error) throw result;
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    })
  );
  return bodies;
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchExecutionTime', () => {
  it('reads the block number from the transaction, then the time from the block', async () => {
    const bodies = stubRpc([TX, BLOCK]);
    expect(await fetchExecutionTime(RPC, TX_HASH)).toBe('2025-10-11T22:39:59Z');
    expect(bodies.map((b) => [b.method, b.params])).toEqual([
      ['eth_getTransactionByHash', [TX_HASH]],
      ['eth_getBlockByNumber', ['0x1677594', false]],
    ]);
  });

  it('answers null when the node does not know the transaction', async () => {
    stubRpc([null]);
    expect(await fetchExecutionTime(RPC, TX_HASH)).toBeNull();
  });

  it('answers null for a transaction that is not in a block', async () => {
    stubRpc([{ hash: TX_HASH, blockNumber: null }]);
    expect(await fetchExecutionTime(RPC, TX_HASH)).toBeNull();
  });

  it('answers null for an answer about another transaction or another block', async () => {
    stubRpc([{ ...TX, hash: OTHER_TX_HASH }]);
    expect(await fetchExecutionTime(RPC, TX_HASH)).toBeNull();
    stubRpc([TX, { ...BLOCK, number: '0x1677595' }]);
    expect(await fetchExecutionTime(RPC, TX_HASH)).toBeNull();
  });

  it('answers null on a network failure or a malformed answer', async () => {
    stubRpc([new TypeError('Failed to fetch')]);
    expect(await fetchExecutionTime(RPC, TX_HASH)).toBeNull();
    stubRpc([TX, { ...BLOCK, timestamp: 'soon' }]);
    expect(await fetchExecutionTime(RPC, TX_HASH)).toBeNull();
  });

  it('does not call the node for a hash that is not 32 bytes of hex', async () => {
    const bodies = stubRpc([]);
    expect(await fetchExecutionTime(RPC, '0x7db4')).toBeNull();
    expect(bodies).toHaveLength(0);
  });
});
