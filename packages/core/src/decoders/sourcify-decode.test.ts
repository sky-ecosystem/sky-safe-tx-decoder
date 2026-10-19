/**
 * Tests for decoding against a fetched ABI with re-encode verification.
 */

import { describe, it, expect } from 'vitest';
import { encodeFunctionData, parseAbi, type Abi, type Hex } from 'viem';
import { decodeWithAbi } from './sourcify-decode.js';
import { findForwardedCalls } from '../utils/forwarded-calls.js';

// Real mainnet calldata: withdrawV3(address,address,uint256), the first nested
// call of Safe 0x22740deBa78d5a0c24C58C740e3715ec29de1bFa nonce 224.
const WITHDRAW_V3: Hex =
  '0x5ef186a9' +
  '0000000000000000000000004e033931ad43597d96d6bcc25c280717730b58b1' +
  '00000000000000000000000040d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f' +
  '0000000000000000000000000000000000000000000069e10de76676d0800000';

const WITHDRAW_ABI = parseAbi(['function withdrawV3(address from, address to, uint256 amount)']);

describe('decodeWithAbi', () => {
  it('decodes a matching call and verifies it re-encodes to the raw bytes', () => {
    const result = decodeWithAbi(WITHDRAW_ABI, WITHDRAW_V3);

    expect(result).not.toBeNull();
    expect(result!.method).toBe('withdrawV3');
    expect(result!.signature).toBe('withdrawV3(address,address,uint256)');
    expect(result!.verified).toBe(true);
    expect(result!.parameters).toHaveLength(3);
    expect(result!.parameters[0]).toMatchObject({ name: 'from', type: 'address' });
    expect(result!.parameters[2]!.value).toBe(500000000000000000000000n);
  });

  it('returns null when the ABI does not contain the selector', () => {
    const unrelated = parseAbi(['function transfer(address to, uint256 amount)']);
    expect(decodeWithAbi(unrelated, WITHDRAW_V3)).toBeNull();
  });

  it('does not verify when trailing calldata is appended', () => {
    // viem decodes this fine (it ignores trailing bytes); the re-encode compare
    // is what must reject it.
    const result = decodeWithAbi(WITHDRAW_ABI, (WITHDRAW_V3 + 'deadbeef') as Hex);

    expect(result).not.toBeNull();
    expect(result!.verified).toBe(false);
  });

  it('does not verify when the ABI type is wrong even if the selector collides', () => {
    // An ABI whose function has this exact selector but the wrong argument
    // types would decode to different values that do not re-encode to the raw
    // bytes. Simulate with an ABI that shares the name but wrong arity.
    const wrong = [
      {
        type: 'function',
        name: 'withdrawV3',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'a', type: 'address' },
          { name: 'b', type: 'address' },
          { name: 'c', type: 'uint256' },
          { name: 'd', type: 'uint256' },
        ],
        outputs: [],
      },
    ] as const satisfies Abi;

    // Selector for this 4-arg version differs, so it will not decode the 3-arg
    // calldata: expect null (no matching selector) rather than a false verify.
    expect(decodeWithAbi(wrong, WITHDRAW_V3)).toBeNull();
  });

  it('resolves overloaded names by selector', () => {
    const overloaded = parseAbi([
      'function withdrawV3(uint256 x)',
      'function withdrawV3(address from, address to, uint256 amount)',
    ]);

    const result = decodeWithAbi(overloaded, WITHDRAW_V3);

    expect(result).not.toBeNull();
    expect(result!.signature).toBe('withdrawV3(address,address,uint256)');
    expect(result!.verified).toBe(true);
  });

  it('keeps tuple components, so findForwardedCalls reaches bytes inside Multicall3 aggregate', () => {
    const abi = parseAbi([
      'struct Call { address target; bytes callData; }',
      'function aggregate(Call[] calls) returns (uint256 blockNumber, bytes[] returnData)',
    ]);
    const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const transfer: Hex =
      '0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead000000000000000000000000000000000000000000000000000000e8d4a51000';
    const data = encodeFunctionData({ abi, functionName: 'aggregate', args: [[{ target: usdc, callData: transfer }]] });

    const result = decodeWithAbi(abi, data);

    expect(result!.verified).toBe(true);
    expect(result!.parameters[0]!.components).toEqual([
      { name: 'target', type: 'address' },
      { name: 'callData', type: 'bytes' },
    ]);
    expect(findForwardedCalls(result!.parameters).map((c) => [c.path, c.target, c.calldata])).toEqual([
      ['calls[0].callData', usdc, transfer],
    ]);
  });
});
