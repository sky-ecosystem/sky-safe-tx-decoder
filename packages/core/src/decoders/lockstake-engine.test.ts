/**
 * Tests for the LockstakeEngine decoder's re-encode self-check.
 *
 * viem's decoder ignores bytes past the end of the encoded arguments. Without
 * a re-encode check, a call with appended bytes renders as an ordinary call.
 */

import { describe, it, expect } from 'vitest';
import type { Hex } from 'viem';
import { encodeFunctionData, parseAbi } from 'viem';
import { LockstakeEngineDecoder } from './lockstake-engine.js';
import { isCallFullyDecoded } from '../utils/forwarded-calls.js';

const ABI = parseAbi([
  'function hope(address owner, uint256 index, address usr)',
  'function multicall(bytes[] data) returns (bytes[] results)',
]);

const HOPE = encodeFunctionData({
  abi: ABI,
  functionName: 'hope',
  args: ['0x3dE688267Cf099307aBdd85F64D8efe03D0b2b26', 0n, '0x000000000000000000000000000000000000dEaD'],
});

const decoder = new LockstakeEngineDecoder();

describe('LockstakeEngineDecoder re-encode self-check', () => {
  it('leaves an exact call unmarked', () => {
    const result = decoder.decode(HOPE);
    expect(result.main.name).toBe('hope');
    expect(result.main.trailingCalldata).toBeUndefined();
  });

  it('marks trailing bytes on a single call, so the CLI withholds its all-clear', () => {
    const data = `${HOPE}00` as Hex;
    const result = decoder.decode(data);

    expect(result.main.name).toBe('hope');
    expect(result.main.trailingCalldata).toBe('0x00');
    expect(result.main.warnings!.join(' ')).toContain('0x00');
    expect(isCallFullyDecoded({ data, custom: result, decoded: false })).toBe(false);
  });

  it('marks trailing bytes inside a nested multicall entry', () => {
    const data = encodeFunctionData({ abi: ABI, functionName: 'multicall', args: [[HOPE, `${HOPE}ff`]] });
    const result = decoder.decode(data);

    expect(result.main.trailingCalldata).toBeUndefined();
    expect(result.nested!.map((call) => call.trailingCalldata)).toEqual([undefined, '0xff']);
    expect(isCallFullyDecoded({ data, custom: result, decoded: false })).toBe(false);
  });

  it('marks trailing bytes after the multicall arguments', () => {
    const clean = encodeFunctionData({ abi: ABI, functionName: 'multicall', args: [[HOPE]] });
    const data = `${clean}deadbeef` as Hex;
    const result = decoder.decode(data);

    expect(result.main.trailingCalldata).toBe('0xdeadbeef');
    expect(isCallFullyDecoded({ data, custom: result, decoded: false })).toBe(false);
  });
});
