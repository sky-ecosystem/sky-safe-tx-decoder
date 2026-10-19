import { describe, it, expect } from 'vitest';
import {
  SAFE_TX_FIELDS,
  defaultSafeTxFieldValues,
  formatSafeTxJson,
  parseSafeTxJson,
  readSafeTxJson,
  validateSafeTxFields,
  type SafeTxFieldValues,
} from './safe-tx-input.js';
import { calculateSafeTxHash } from '../hash/calculator.js';

/** Safe web app JSON tab, copied with its copy button. */
const SAFE_JSON_TAB = `{
  "to": "0xA79C6968E3c75aE4eF388370d1f142720D498fEC",
  "value": "10000000000000",
  "data": "0x",
  "operation": 0,
  "baseGas": "0",
  "gasPrice": "0",
  "gasToken": "0x0000000000000000000000000000000000000000",
  "refundReceiver": "0x0000000000000000000000000000000000000000",
  "nonce": 10,
  "safeTxGas": "0"
}`;

/** The same transaction as the Safe Transaction Service serves it for Safe 0xf65475e74C1Ed6d004d5240b06E3088724dFDA5d, nonce 520. */
const NONCE_520_JSON = JSON.stringify({
  to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  value: '0',
  data: '0xa9059cbb000000000000000000000000fbca5c7138892f987313d9fa615ecb3a35997351000000000000000000000000000000000000000000000000000000a03ce998c8',
  operation: 0,
  safeTxGas: '0',
  baseGas: '0',
  gasPrice: '0',
  gasToken: '0x0000000000000000000000000000000000000000',
  refundReceiver: '0x0000000000000000000000000000000000000000',
  nonce: 520,
});

/** Executed nonce 24 of test Safe 0x3dE688267Cf099307aBdd85F64D8efe03D0b2b26 on Ethereum, in the JSON tab's layout. */
const NONCE_24_JSON_TAB = `{
  "to": "0x1837505D104F7a6D8b7e19452610B0A3D652EF12",
  "value": "0",
  "data": "0x1b8b921d00000000000000000000000024169afb34fae4d4356bc54bd80319131e35ca3800000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000064e7accdce000000000000000000000000802148d518a6de2af866f9a61ffb5e5c39156db2000000000000000000000000000000000000000000007ea954dee7dfbfcc32240000000000000000000000000000000000000000000000000000008b92d193c500000000000000000000000000000000000000000000000000000000",
  "operation": 0,
  "baseGas": "0",
  "gasPrice": "0",
  "gasToken": "0x0000000000000000000000000000000000000000",
  "refundReceiver": "0x0000000000000000000000000000000000000000",
  "nonce": 24,
  "safeTxGas": "0"
}`;

function validValues(overrides: Partial<SafeTxFieldValues> = {}): SafeTxFieldValues {
  return {
    ...defaultSafeTxFieldValues(),
    to: '0xA79C6968E3c75aE4eF388370d1f142720D498fEC',
    value: '0',
    data: '0x',
    nonce: '10',
    ...overrides,
  };
}

function errorsFor(values: SafeTxFieldValues) {
  const result = validateSafeTxFields(values);
  return result.ok ? [] : result.errors;
}

describe('parseSafeTxJson', () => {
  it("parses Safe's JSON tab sample", () => {
    const result = parseSafeTxJson(SAFE_JSON_TAB);
    expect(result).toEqual({
      ok: true,
      transaction: {
        to: '0xA79C6968E3c75aE4eF388370d1f142720D498fEC',
        value: '10000000000000',
        data: '0x',
        operation: 0,
        safeTxGas: '0',
        baseGas: '0',
        gasPrice: '0',
        gasToken: '0x0000000000000000000000000000000000000000',
        refundReceiver: '0x0000000000000000000000000000000000000000',
        nonce: '10',
      },
    });
  });

  it('reproduces the safeTxHash the Safe Transaction Service reports for a real transaction', () => {
    const result = parseSafeTxJson(NONCE_520_JSON);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const hashes = calculateSafeTxHash(1, '0xf65475e74C1Ed6d004d5240b06E3088724dFDA5d', result.transaction, '1.3.0');
    expect(hashes.safeTxHash).toBe('0x3afdbbdfca4f869f5918b012b771f7cd6aa2dc63c80bf63169dc82502663e3b5');
  });

  it('reproduces all three hashes of executed nonce 24 of Safe 0x3dE688267Cf099307aBdd85F64D8efe03D0b2b26', () => {
    const result = parseSafeTxJson(NONCE_24_JSON_TAB);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const hashes = calculateSafeTxHash(1, '0x3dE688267Cf099307aBdd85F64D8efe03D0b2b26', result.transaction, '1.3.0');
    expect(hashes).toEqual({
      domainHash: '0xa56b14e9eb212bf7806cae73036c4b9a69074b9c85a89559903124d4ebf4a4c0',
      messageHash: '0x9425dfff62db0bc6483df249c93e8c6498970aee929ffe79d4019a1019d094c2',
      safeTxHash: '0xb361e998b3b5c25c2c536f83ad558efdb2d24e1209a50b06d26c0a5e4aba4fda',
    });
  });

  it('rejects the nonce 24 paste with its nonce line removed', () => {
    const text = NONCE_24_JSON_TAB.replace('  "nonce": 24,\n', '');
    expect(text).not.toContain('nonce');
    expect(parseSafeTxJson(text)).toEqual({
      ok: false,
      errors: [{ field: 'nonce', message: 'Missing key "nonce". Copy the whole transaction from the JSON tab.' }],
    });
  });

  it('accepts numbers as JSON numbers or as decimal strings, with the same result', () => {
    const asNumbers = parseSafeTxJson(
      JSON.stringify({ ...JSON.parse(SAFE_JSON_TAB), value: 10000000000000, baseGas: 0, operation: 0, nonce: 10 })
    );
    const asStrings = parseSafeTxJson(
      JSON.stringify({
        ...JSON.parse(SAFE_JSON_TAB),
        value: '10000000000000',
        baseGas: '0',
        operation: '0',
        nonce: '10',
      })
    );
    expect(asNumbers.ok).toBe(true);
    expect(asNumbers).toEqual(asStrings);
  });

  it('rejects a paste that omits the gas fields, gas token and refund receiver, and names each key', () => {
    const result = parseSafeTxJson(
      JSON.stringify({
        to: '0xA79C6968E3c75aE4eF388370d1f142720D498fEC',
        value: '1',
        data: '0x',
        operation: 0,
        nonce: 3,
      })
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          field: null,
          message:
            'Missing keys "safeTxGas", "baseGas", "gasPrice", "gasToken", "refundReceiver". Copy the whole transaction from the JSON tab.',
        },
      ],
    });
  });

  it('rejects a paste without a nonce, and does not fill one', () => {
    const copy = JSON.parse(SAFE_JSON_TAB) as Record<string, unknown>;
    delete copy.nonce;
    expect(parseSafeTxJson(JSON.stringify(copy))).toEqual({
      ok: false,
      errors: [{ field: 'nonce', message: 'Missing key "nonce". Copy the whole transaction from the JSON tab.' }],
    });
  });

  it('normalises an all-lower-case address to its checksum and data to lower case', () => {
    const result = parseSafeTxJson(
      JSON.stringify({
        ...JSON.parse(SAFE_JSON_TAB),
        to: '0xa79c6968e3c75ae4ef388370d1f142720d498fec',
        data: '0xA9059CBB',
      })
    );
    expect(result.ok && result.transaction.to).toBe('0xA79C6968E3c75aE4eF388370d1f142720D498fEC');
    expect(result.ok && result.transaction.data).toBe('0xa9059cbb');
  });
});

describe('readSafeTxJson rejections', () => {
  const base = JSON.parse(SAFE_JSON_TAB) as Record<string, unknown>;

  it('rejects text that is not JSON', () => {
    expect(readSafeTxJson('{ "to": ')).toEqual({
      ok: false,
      error: { field: null, message: 'Not valid JSON. The text ends before the JSON is complete.' },
    });
  });

  it('reports where JSON is invalid without echoing any of the pasted text', () => {
    // An unquoted address. The engine's own message quotes the first
    // characters of the address, a truncated identifier, so it is not shown.
    const cases: [string, string][] = [
      ['to: 0x1837505D104F7a6D8b7e19452610B0A3D652EF12', 'Not valid JSON. Check line 1, column 1.'],
      ['{ "to": 0x1837505D104F7a6D8b7e19452610B0A3D652EF12 }', 'Not valid JSON. Check line 1, column 10.'],
      ['{\n  "to": "0x1837505D104F7a6D8b7e19452610B0A3D652EF12",\n  "value": 0x0\n}', 'Not valid JSON. Check line 3, column 13.'],
      ['{\r\n  "to": "0x1837505D104F7a6D8b7e19452610B0A3D652EF12"\r\n  "value": "0"\r\n}', 'Not valid JSON. Check line 3, column 3.'],
      ['{ "to": "0x1837505D104F7a6D8b7e19452610B0A3D652EF12", }', 'Not valid JSON. Check line 1, column 55.'],
      ['{ "to": "0x18\u0001" }', 'Not valid JSON. Check line 1, column 14.'],
      ['{} 0x1837505D104F7a6D8b7e19452610B0A3D652EF12', 'Not valid JSON. Check line 1, column 4.'],
    ];
    for (const [text, message] of cases) {
      expect(() => JSON.parse(text)).toThrow();
      const result = readSafeTxJson(text);
      expect(result).toEqual({ ok: false, error: { field: null, message } });
    }
  });

  it('reports invalid JSON without a position when the text nests too deep to scan', () => {
    expect(readSafeTxJson('['.repeat(200_000))).toEqual({
      ok: false,
      error: { field: null, message: 'Not valid JSON.' },
    });
  });

  it('rejects JSON that is not one object', () => {
    for (const text of ['[]', 'null', '"0x"', '42']) {
      expect(readSafeTxJson(text)).toEqual({
        ok: false,
        error: { field: null, message: 'Expected one JSON object with the transaction fields.' },
      });
    }
  });

  it('rejects an unknown key and names it', () => {
    expect(readSafeTxJson(JSON.stringify({ ...base, safeTxHash: '0x00' }))).toEqual({
      ok: false,
      error: { field: null, message: 'Unknown key "safeTxHash". Copy the transaction from the JSON tab.' },
    });
  });

  it('rejects __proto__ as an unknown key', () => {
    const text = SAFE_JSON_TAB.replace('{', '{ "__proto__": {},');
    expect(readSafeTxJson(text)).toEqual({
      ok: false,
      error: { field: null, message: 'Unknown key "__proto__". Copy the transaction from the JSON tab.' },
    });
  });

  it('rejects a repeated key, which JSON.parse would drop silently', () => {
    const text = SAFE_JSON_TAB.replace('"value"', '"to": "0x0000000000000000000000000000000000000001",\n  "value"');
    expect(readSafeTxJson(text)).toEqual({ ok: false, error: { field: null, message: 'Duplicate key "to".' } });
  });

  it('does not mistake a nested key for a repeated top-level key', () => {
    // Nested objects are not a valid field value, so this fails on type, not
    // on a duplicate.
    const text = SAFE_JSON_TAB.replace('"data": "0x"', '"data": { "to": "x" }');
    expect(readSafeTxJson(text)).toEqual({ ok: false, error: { field: 'data', message: 'data must be a string.' } });
  });

  it('rejects a paste that omits any one key, and names it', () => {
    for (const key of SAFE_TX_FIELDS) {
      const copy = { ...base };
      delete copy[key];
      expect(readSafeTxJson(JSON.stringify(copy))).toEqual({
        ok: false,
        error: { field: key, message: `Missing key "${key}". Copy the whole transaction from the JSON tab.` },
      });
    }
  });

  it('rejects a JSON number that cannot be read exactly', () => {
    const text = SAFE_JSON_TAB.replace('"10000000000000"', '10000000000000000000000');
    expect(readSafeTxJson(text)).toEqual({
      ok: false,
      error: { field: 'value', message: 'value is not an exact non-negative integer. Write it as a decimal string.' },
    });
  });

  it('rejects negative and fractional JSON numbers', () => {
    expect(readSafeTxJson(JSON.stringify({ ...base, nonce: -1 })).ok).toBe(false);
    expect(readSafeTxJson(JSON.stringify({ ...base, nonce: 1.5 })).ok).toBe(false);
  });

  it('rejects a value of the wrong JSON type', () => {
    expect(readSafeTxJson(JSON.stringify({ ...base, to: 1 }))).toEqual({
      ok: false,
      error: { field: 'to', message: 'to must be a string.' },
    });
    expect(readSafeTxJson(JSON.stringify({ ...base, value: null }))).toEqual({
      ok: false,
      error: { field: 'value', message: 'value must be a number or a decimal string.' },
    });
    expect(readSafeTxJson(JSON.stringify({ ...base, operation: true }))).toEqual({
      ok: false,
      error: { field: 'operation', message: 'operation must be a number or a decimal string.' },
    });
  });
});

describe('validateSafeTxFields rejections', () => {
  it('accepts valid values', () => {
    expect(errorsFor(validValues())).toEqual([]);
  });

  it("rejects the Data tab's shortened gas token as truncated", () => {
    expect(errorsFor(validValues({ gasToken: '0x0000...0000' }))).toEqual([
      { field: 'gasToken', message: 'gasToken looks truncated. Copy it from the JSON tab.' },
    ]);
  });

  it('rejects a Unicode ellipsis as truncated', () => {
    expect(errorsFor(validValues({ refundReceiver: '0x0000…0000' }))).toEqual([
      { field: 'refundReceiver', message: 'refundReceiver looks truncated. Copy it from the JSON tab.' },
    ]);
  });

  it('rejects shortened calldata as truncated', () => {
    expect(errorsFor(validValues({ data: '0xa9059cbb0000...0000' }))).toEqual([
      { field: 'data', message: 'data looks truncated. Copy it from the JSON tab.' },
    ]);
  });

  it('rejects whitespace inside hex as truncated', () => {
    expect(errorsFor(validValues({ to: '0xA79C6968E3c75aE4eF38 8370d1f142720D498fEC' }))).toEqual([
      { field: 'to', message: 'to looks truncated. Copy it from the JSON tab.' },
    ]);
    expect(errorsFor(validValues({ data: '0xa9059cbb\n00' }))).toEqual([
      { field: 'data', message: 'data looks truncated. Copy it from the JSON tab.' },
    ]);
  });

  it('rejects an ellipsis in an integer as truncated', () => {
    expect(errorsFor(validValues({ value: '1000...000' }))).toEqual([
      { field: 'value', message: 'value looks truncated. Copy it from the JSON tab.' },
    ]);
  });

  it('ignores leading and trailing whitespace', () => {
    const result = validateSafeTxFields(
      validValues({ to: '  0xA79C6968E3c75aE4eF388370d1f142720D498fEC\n', nonce: ' 10 ' })
    );
    expect(result.ok && result.transaction.to).toBe('0xA79C6968E3c75aE4eF388370d1f142720D498fEC');
    expect(result.ok && result.transaction.nonce).toBe('10');
  });

  it('rejects a mixed-case address with a bad EIP-55 checksum', () => {
    // Last character case flipped from the checksummed form.
    expect(errorsFor(validValues({ to: '0xA79C6968E3c75aE4eF388370d1f142720D498fEc' }))).toEqual([
      { field: 'to', message: 'to has an invalid EIP-55 checksum. Copy it from the JSON tab.' },
    ]);
  });

  it('rejects a bad checksum on the gas token and refund receiver too', () => {
    const bad = '0x5EA1d9A6dDC3A0329378a327746D71A2019eC332'.replace('d9A6', 'D9A6');
    const errors = errorsFor(validValues({ gasToken: bad, refundReceiver: bad }));
    expect(errors.map((e) => e.field)).toEqual(['gasToken', 'refundReceiver']);
  });

  it('accepts all-lower-case and all-upper-case addresses, which carry no checksum', () => {
    expect(errorsFor(validValues({ to: '0xa79c6968e3c75ae4ef388370d1f142720d498fec' }))).toEqual([]);
    expect(errorsFor(validValues({ to: '0xA79C6968E3C75AE4EF388370D1F142720D498FEC' }))).toEqual([]);
  });

  it('rejects an address of the wrong length or alphabet', () => {
    for (const to of [
      '0xA79C6968E3c75aE4eF388370d1f142720D498fE',
      'A79C6968E3c75aE4eF388370d1f142720D498fEC00',
      '0xG79C6968E3c75aE4eF388370d1f142720D498fEC',
      '0XA79C6968E3c75aE4eF388370d1f142720D498fEC',
    ]) {
      expect(errorsFor(validValues({ to }))).toEqual([
        { field: 'to', message: 'to must be 0x followed by 40 hex characters.' },
      ]);
    }
  });

  it('rejects odd-length and non-hex calldata', () => {
    for (const data of ['0xa9059cb', '0xzz', 'a9059cbb']) {
      expect(errorsFor(validValues({ data }))).toEqual([
        { field: 'data', message: 'data must be 0x followed by an even number of hex characters.' },
      ]);
    }
  });

  it('rejects empty calldata with the instruction to enter 0x', () => {
    expect(errorsFor(validValues({ data: '' }))).toEqual([
      { field: 'data', message: 'data is required. Enter 0x for no calldata.' },
    ]);
  });

  it('rejects negative, hex, fractional and exponent integers', () => {
    for (const value of ['-1', '0x10', '1.5', '1e18', '+1']) {
      expect(errorsFor(validValues({ value }))).toEqual([
        { field: 'value', message: 'value must be a non-negative decimal integer.' },
      ]);
    }
  });

  it('rejects an integer past uint256', () => {
    const tooBig = (1n << 256n).toString();
    expect(errorsFor(validValues({ safeTxGas: tooBig }))).toEqual([
      { field: 'safeTxGas', message: 'safeTxGas is larger than uint256 allows.' },
    ]);
    expect(errorsFor(validValues({ safeTxGas: ((1n << 256n) - 1n).toString() }))).toEqual([]);
  });

  it('strips leading zeros from integers', () => {
    const result = validateSafeTxFields(validValues({ nonce: '007' }));
    expect(result.ok && result.transaction.nonce).toBe('7');
  });

  it('accepts only 0 or 1 as the operation', () => {
    expect(validateSafeTxFields(validValues({ operation: '1' }))).toMatchObject({
      ok: true,
      transaction: { operation: 1 },
    });
    for (const operation of ['2', '-1', 'call', '01']) {
      expect(errorsFor(validValues({ operation }))).toEqual([
        { field: 'operation', message: 'operation must be 0 (call) or 1 (delegatecall).' },
      ]);
    }
  });

  it('names every empty required field, one error per field, in field order', () => {
    const errors = errorsFor(defaultSafeTxFieldValues());
    expect(errors).toEqual([
      { field: 'to', message: 'to is required.' },
      { field: 'value', message: 'value is required.' },
      { field: 'data', message: 'data is required. Enter 0x for no calldata.' },
      { field: 'nonce', message: 'nonce is required.' },
    ]);
  });
});

describe('formatSafeTxJson', () => {
  it('writes the JSON tab sample back byte for byte', () => {
    const read = readSafeTxJson(SAFE_JSON_TAB);
    if (!read.ok) throw new Error(read.error.message);
    expect(formatSafeTxJson({ ...defaultSafeTxFieldValues(), ...read.values })).toBe(SAFE_JSON_TAB);
  });

  it('writes every field, and keeps text that is not a plain decimal as a string', () => {
    const text = formatSafeTxJson(validValues({ nonce: '007', operation: 'x' }));
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed).sort()).toEqual([...SAFE_TX_FIELDS].sort());
    expect(parsed.nonce).toBe('007');
    expect(parsed.operation).toBe('x');
  });
});
