import { describe, it, expect, vi } from 'vitest';
import { resolveRequestedTransaction } from './requested-transaction.js';
import type { SafeApiMultisigTransaction } from '../types.js';

const SAFE = '0x3dE688267Cf099307aBdd85F64D8efe03D0b2b26';
const OTHER_SAFE = '0xf65475e74C1Ed6d004d5240b06E3088724dFDA5d';
const HASH_A = '0xb361e998b3b5c25c2c536f83ad558efdb2d24e1209a50b06d26c0a5e4aba4fda';
const HASH_B = '0x3afdbbdfca4f869f5918b012b771f7cd6aa2dc63c80bf63169dc82502663e3b5';
const HASH_C = '0x9425dfff62db0bc6483df249c93e8c6498970aee929ffe79d4019a1019d094c2';

function tx(safeTxHash: string, overrides: Partial<SafeApiMultisigTransaction> = {}): SafeApiMultisigTransaction {
  return { safe: SAFE, nonce: 24, safeTxHash, ...overrides } as SafeApiMultisigTransaction;
}

const NOT_FOUND = `Transaction ${HASH_C} was not found among the transactions at nonce 24 for Safe ${SAFE}. No other transaction is shown.`;

describe('resolveRequestedTransaction', () => {
  it('shows the first transaction when the link names no hash', async () => {
    const fetchByHash = vi.fn();
    const list = [tx(HASH_A), tx(HASH_B)];
    const result = await resolveRequestedTransaction({ safeAddress: SAFE, nonce: 24, safeTxHash: null, transactions: list, fetchByHash });
    expect(result).toEqual({ ok: true, transaction: list[0], transactions: list });
    expect(fetchByHash).not.toHaveBeenCalled();
  });

  it('shows the named transaction from the list, without a lookup', async () => {
    const fetchByHash = vi.fn();
    const list = [tx(HASH_A), tx(HASH_B)];
    const result = await resolveRequestedTransaction({ safeAddress: SAFE, nonce: 24, safeTxHash: HASH_B, transactions: list, fetchByHash });
    expect(result).toEqual({ ok: true, transaction: list[1], transactions: list });
    expect(fetchByHash).not.toHaveBeenCalled();
  });

  it('never shows another transaction at the nonce when the named hash is missing', async () => {
    // Before the fix the page fell back to the first transaction at the nonce
    // and showed its hash check as if it were the one asked for.
    const list = [tx(HASH_A), tx(HASH_B)];
    const result = await resolveRequestedTransaction({
      safeAddress: SAFE,
      nonce: 24,
      safeTxHash: HASH_C,
      transactions: list,
      fetchByHash: async () => null,
    });
    expect(result).toEqual({ ok: false, message: NOT_FOUND });
  });

  it('looks up a hash the list does not hold, and adds it to the list', async () => {
    const list = [tx(HASH_A)];
    const found = tx(HASH_C);
    const fetchByHash = vi.fn(async () => found);
    const result = await resolveRequestedTransaction({ safeAddress: SAFE, nonce: 24, safeTxHash: HASH_C, transactions: list, fetchByHash });
    expect(fetchByHash).toHaveBeenCalledWith(HASH_C);
    expect(result).toEqual({ ok: true, transaction: found, transactions: [list[0], found] });
  });

  it('rejects a lookup answer for another hash, another Safe or another nonce', async () => {
    for (const answer of [tx(HASH_A), tx(HASH_C, { safe: OTHER_SAFE }), tx(HASH_C, { nonce: 25 })]) {
      const result = await resolveRequestedTransaction({
        safeAddress: SAFE,
        nonce: 24,
        safeTxHash: HASH_C,
        transactions: [tx(HASH_B)],
        fetchByHash: async () => answer,
      });
      expect(result).toEqual({ ok: false, message: NOT_FOUND });
    }
  });

  it('matches the hash without regard to case', async () => {
    const list = [tx(HASH_A)];
    const result = await resolveRequestedTransaction({
      safeAddress: SAFE,
      nonce: 24,
      safeTxHash: HASH_A.toUpperCase().replace('0X', '0x'),
      transactions: list,
      fetchByHash: async () => null,
    });
    expect(result.ok && result.transaction).toBe(list[0]);
  });

  it('rejects a hash in the link that is not 32 bytes of hex, without a lookup', async () => {
    const fetchByHash = vi.fn();
    const result = await resolveRequestedTransaction({
      safeAddress: SAFE,
      nonce: 24,
      safeTxHash: '0x1234',
      transactions: [tx(HASH_A)],
      fetchByHash,
    });
    expect(result).toEqual({ ok: false, message: 'The safeTxHash in the link is not 0x followed by 64 hex characters.' });
    expect(fetchByHash).not.toHaveBeenCalled();
  });

  it('rejects a list with two transactions for the named hash', async () => {
    const result = await resolveRequestedTransaction({
      safeAddress: SAFE,
      nonce: 24,
      safeTxHash: HASH_A,
      transactions: [tx(HASH_A), tx(HASH_A)],
      fetchByHash: async () => null,
    });
    expect(result).toEqual({
      ok: false,
      message: `The Safe API returned more than one transaction with safeTxHash ${HASH_A}. No transaction is shown.`,
    });
  });

  it('propagates a lookup failure', async () => {
    await expect(
      resolveRequestedTransaction({
        safeAddress: SAFE,
        nonce: 24,
        safeTxHash: HASH_C,
        transactions: [tx(HASH_A)],
        fetchByHash: async () => {
          throw new Error('Safe API request failed: 500');
        },
      })
    ).rejects.toThrow('Safe API request failed: 500');
  });
});
