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

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
/** transfer(0x000000000000000000000000000000000000dEaD, 1000000000000). */
const TRANSFER =
  '0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead000000000000000000000000000000000000000000000000000000e8d4a51000';
/** The same transfer with one 0x00 byte appended. Solidity ignores it, so the call executes. */
const TRANSFER_PLUS_ONE = `${TRANSFER}00`;
/** Controller mint(uint256) as in probe case 9. */
const PAU_MINT = '0xa5b7e02d00000000000000000000000000000000000000000000d3c21bcecceda1000000';
/** The Safe API decoding of `call(USDC, TRANSFER_PLUS_ONE)` to an unregistered forwarder. */
const FORWARD_PLUS_ONE_PARAMS = [
  { name: 'target', type: 'address', value: USDC },
  { name: 'data', type: 'bytes', value: TRANSFER_PLUS_ONE },
];

describe('findForwardedCalls', () => {
  it('finds the Controller call inside the Safe API decoding of AdministeredAgent.call', () => {
    expect(findForwardedCalls(NONCE_23_DATA_DECODED.parameters)).toEqual([
      {
        param: 'data',
        index: null,
        target: '0x24169Afb34fAe4D4356BC54Bd80319131e35ca38',
        path: 'data',
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

  it('reports a 65-byte value, because a selector and one argument padded to 65 bytes executes', () => {
    // transferOwnership(0x...dEaD) is 36 bytes. Solidity ignores the 29 bytes
    // that follow, so this 65-byte value is a working call, not a signature.
    const padded = `0xf2fde38b${'00'.repeat(12)}000000000000000000000000000000000000dEaD${'00'.repeat(29)}`;
    const calls = findForwardedCalls([
      { name: 'target', type: 'address', value: '0x1111111111111111111111111111111111111111' },
      { name: 'data', type: 'bytes', value: padded },
    ]);
    expect(calls.map(c => [c.path, c.selector, c.calldata])).toEqual([['data', '0xf2fde38b', padded]]);
  });

  it('reports calldata with trailing bytes past the last whole word, which Solidity ignores', () => {
    expect(findForwardedCalls(FORWARD_PLUS_ONE_PARAMS)).toEqual([
      {
        param: 'data',
        index: null,
        path: 'data',
        target: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        selector: '0xa9059cbb',
        calldata: TRANSFER_PLUS_ONE,
      },
    ]);
  });

  it('reports a PAU Controller call padded with one byte, to an agent no decoder covers', () => {
    const calls = findForwardedCalls([
      { name: 'target', type: 'address', value: '0x24169Afb34fAe4D4356BC54Bd80319131e35ca38' },
      { name: 'data', type: 'bytes', value: `${PAU_MINT}00` },
    ]);
    expect(calls.map(c => [c.target, c.selector])).toEqual([['0x24169Afb34fAe4D4356BC54Bd80319131e35ca38', '0xa5b7e02d']]);
  });

  it('reports bytes inside a Safe API tuple[], as in Multicall3 aggregate((address,bytes)[])', () => {
    const calls = findForwardedCalls([
      { name: 'calls', type: '(address,bytes)[]', value: [[USDC, TRANSFER], [DAI, TRANSFER_PLUS_ONE]] },
    ]);
    expect(calls.map(c => [c.path, c.target, c.selector, c.calldata])).toEqual([
      ['calls[0][1]', USDC, '0xa9059cbb', TRANSFER],
      ['calls[1][1]', DAI, '0xa9059cbb', TRANSFER_PLUS_ONE],
    ]);
  });

  it('reports bytes inside aggregate3((address,bool,bytes)[]) sent as a JSON string', () => {
    const calls = findForwardedCalls([
      { name: 'calls', type: '(address,bool,bytes)[]', value: JSON.stringify([[USDC, true, TRANSFER]]) },
    ]);
    expect(calls.map(c => [c.path, c.target])).toEqual([['calls[0][2]', USDC]]);
  });

  it('reports bytes inside a tuple[] whose components the decoding does not name', () => {
    const calls = findForwardedCalls([{ name: 'calls', type: 'tuple[]', value: [[USDC, TRANSFER]] }]);
    expect(calls.map(c => [c.path, c.target, c.selector])).toEqual([['calls[0][1]', USDC, '0xa9059cbb']]);
  });

  it('reports bytes inside a Sourcify tuple[], where viem returns named objects', () => {
    const calls = findForwardedCalls([
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'callData', type: 'bytes' },
        ],
        value: [{ target: USDC, callData: TRANSFER }],
      },
    ]);
    expect(calls.map(c => [c.path, c.target, c.selector])).toEqual([['calls[0].callData', USDC, '0xa9059cbb']]);
  });

  it('reports a bytes[] with no address parameter, as in a self-multicall(bytes[])', () => {
    const calls = findForwardedCalls([{ name: 'data', type: 'bytes[]', value: [TRANSFER] }]);
    expect(calls.map(c => [c.path, c.target, c.selector, c.calldata])).toEqual([['data[0]', null, '0xa9059cbb', TRANSFER]]);
  });

  it('ignores a tuple with no bytes in it', () => {
    expect(
      findForwardedCalls([
        { name: 'order', type: '(address,uint256,bytes32)', value: [USDC, '1', `0x${'ab'.repeat(32)}`] },
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

  it('accepts a selector followed by a partial word, which Solidity executes', () => {
    expect(isCalldataShaped(`0xdeadbeef${'00'.repeat(31)}`)).toBe(true);
    expect(isCalldataShaped(TRANSFER_PLUS_ONE)).toBe(true);
  });

  it('rejects fewer than four bytes, odd hex and non-strings', () => {
    expect(isCalldataShaped('0xabcdef')).toBe(false);
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

  it('is false for a one-layer decoding that forwards calldata with one trailing byte', () => {
    expect(isCallFullyDecoded({ data, decoded: true, parameters: FORWARD_PLUS_ONE_PARAMS })).toBe(false);
  });

  it('is false for a one-layer decoding of Multicall3 aggregate and of multicall(bytes[])', () => {
    expect(
      isCallFullyDecoded({ data, decoded: true, parameters: [{ name: 'calls', type: '(address,bytes)[]', value: [[USDC, TRANSFER]] }] })
    ).toBe(false);
    expect(
      isCallFullyDecoded({ data, decoded: true, parameters: [{ name: 'data', type: 'bytes[]', value: [TRANSFER] }] })
    ).toBe(false);
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
