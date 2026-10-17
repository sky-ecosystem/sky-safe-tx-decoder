import { describe, it, expect } from 'vitest';
import { findForwardedCalls, isCallFullyDecoded, isCalldataShaped } from './forwarded-calls.js';

/**
 * The Safe Transaction Service's own decoding of Safe
 * 0x3dE688267Cf099307aBdd85F64D8efe03D0b2b26 nonce 23, safeTxHash
 * 0xf3f4dac699606e56bfb467feb0f06fe9560e6060dc84d464554d19eb69903dfe, exactly
 * as served. 0.5.0 rendered this as a verified decoding with no warning.
 */
const NONCE_23_DATA_DECODED = {
  method: 'call',
  parameters: [
    { name: 'target', type: 'address', value: '0x24169Afb34fAe4D4356BC54Bd80319131e35ca38' },
    {
      name: 'data',
      type: 'bytes',
      value:
        '0xd04771b8000000000000000000000000802148d518a6de2af866f9a61ffb5e5c39156db20000000000000000000000000000000000000000000000000000005d21dba000000000000000000000000000000000000000000000005484860fb7f9de20c037',
    },
  ],
};

describe('findForwardedCalls', () => {
  it('finds the Controller call inside the Safe API decoding of AdministeredAgent.call', () => {
    expect(findForwardedCalls(NONCE_23_DATA_DECODED.parameters)).toEqual([
      {
        param: 'data',
        index: null,
        target: '0x24169Afb34fAe4D4356BC54Bd80319131e35ca38',
        selector: '0xd04771b8',
        calldata: NONCE_23_DATA_DECODED.parameters[1]!.value,
      },
    ]);
  });

  it('pairs each bytes[] element with the address[] element at the same index', () => {
    const calls = findForwardedCalls([
      {
        name: 'targets',
        type: 'address[]',
        value: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'],
      },
      {
        name: 'data',
        type: 'bytes[]',
        value: [
          '0xa5b7e02d000000000000000000000000000000000000000000000000000000000000002a',
          '0xdeadbeef',
        ],
      },
      { name: 'values', type: 'uint256[]', value: ['0', '0'] },
    ]);
    expect(calls.map(c => [c.index, c.target, c.selector])).toEqual([
      [0, '0x1111111111111111111111111111111111111111', '0xa5b7e02d'],
      [1, '0x2222222222222222222222222222222222222222', '0xdeadbeef'],
    ]);
  });

  it('reads a bytes[] the Safe API sends as a JSON string', () => {
    const calls = findForwardedCalls([
      { name: 'targets', type: 'address[]', value: '["0x1111111111111111111111111111111111111111"]' },
      { name: 'data', type: 'bytes[]', value: '["0xdeadbeef"]' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe('0x1111111111111111111111111111111111111111');
  });

  it('names no target when two address parameters could be it', () => {
    const calls = findForwardedCalls([
      { name: 'a', type: 'address', value: '0x1111111111111111111111111111111111111111' },
      { name: 'b', type: 'address', value: '0x2222222222222222222222222222222222222222' },
      { name: 'data', type: 'bytes', value: '0xdeadbeef' },
    ]);
    expect(calls[0]!.target).toBeNull();
  });

  it('ignores bytes in a function with no address parameter, such as multiSend', () => {
    expect(
      findForwardedCalls([{ name: 'transactions', type: 'bytes', value: '0xdeadbeef' }])
    ).toEqual([]);
  });

  it('ignores a 65-byte signature, which is not whole 32-byte words after a selector', () => {
    expect(
      findForwardedCalls([
        { name: 'owner', type: 'address', value: '0x1111111111111111111111111111111111111111' },
        { name: 'signature', type: 'bytes', value: `0x${'ab'.repeat(65)}` },
      ])
    ).toEqual([]);
  });

  it('ignores empty bytes and bytes shorter than a selector', () => {
    for (const value of ['0x', '0xabcdef']) {
      expect(
        findForwardedCalls([
          { name: 'target', type: 'address', value: '0x1111111111111111111111111111111111111111' },
          { name: 'data', type: 'bytes', value },
        ])
      ).toEqual([]);
    }
  });
});

describe('isCalldataShaped', () => {
  it('accepts a selector alone and a selector with whole words', () => {
    expect(isCalldataShaped('0xdeadbeef')).toBe(true);
    expect(isCalldataShaped(`0xdeadbeef${'00'.repeat(64)}`)).toBe(true);
  });

  it('rejects a partial word, odd hex and non-strings', () => {
    expect(isCalldataShaped(`0xdeadbeef${'00'.repeat(31)}`)).toBe(false);
    expect(isCalldataShaped('0xdeadbee')).toBe(false);
    expect(isCalldataShaped(42)).toBe(false);
  });
});

describe('isCallFullyDecoded', () => {
  const data = NONCE_23_DATA_DECODED.parameters[1]!.value;

  it('is false for the 0.5.0 rendering of nonce 23: a Safe API decoding that forwards undecoded calldata', () => {
    expect(isCallFullyDecoded({ data, decoded: true, parameters: NONCE_23_DATA_DECODED.parameters })).toBe(false);
  });

  it('is true once a custom decoder decodes the call at medium risk', () => {
    expect(isCallFullyDecoded({ data, decoded: true, custom: { main: { riskLevel: 'medium' } } })).toBe(true);
  });

  it('is false when the custom decoder reports the call as high risk', () => {
    expect(isCallFullyDecoded({ data, decoded: true, custom: { main: { riskLevel: 'high' } } })).toBe(false);
  });

  it('is false when nothing decoded the call', () => {
    expect(isCallFullyDecoded({ data, decoded: false })).toBe(false);
  });

  it('is true for a call with no calldata and for a one-layer decoding that forwards nothing', () => {
    expect(isCallFullyDecoded({ data: '0x', decoded: false })).toBe(true);
    expect(
      isCallFullyDecoded({
        data: '0xa9059cbb',
        decoded: true,
        parameters: [
          { name: 'to', type: 'address', value: '0x1111111111111111111111111111111111111111' },
          { name: 'amount', type: 'uint256', value: '1' },
        ],
      })
    ).toBe(true);
  });
});
