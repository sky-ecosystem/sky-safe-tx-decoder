/**
 * Read a Safe transaction that a person enters by hand: the JSON from the
 * Safe web app's JSON tab, or the ten fields typed one by one.
 *
 * Strict by design. These fields are the whole input to the hash a signer
 * compares with a hardware wallet, and a value that is close to right does not
 * fail: it produces a different hash. So nothing is guessed or repaired.
 * Every rejection names the field and the reason.
 *
 * The Safe web app's Data tab shows some values shortened (`0x0000...0000`).
 * A shortened value is rejected with a message that says so, never expanded.
 */

import { getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import type { SafeTransactionData } from '../types.js';
import { ZERO_ADDRESS } from '../security/constants.js';

/** The fields of a Safe transaction, named as Safe's JSON tab names them. */
export const SAFE_TX_FIELDS = [
  'to',
  'value',
  'data',
  'operation',
  'safeTxGas',
  'baseGas',
  'gasPrice',
  'gasToken',
  'refundReceiver',
  'nonce',
] as const;

export type SafeTxField = (typeof SAFE_TX_FIELDS)[number];

/** Every field as the text a person entered or pasted. */
export type SafeTxFieldValues = Record<SafeTxField, string>;

/** Key order of Safe's JSON tab, so formatted output reads the same. */
const SAFE_JSON_ORDER: readonly SafeTxField[] = [
  'to',
  'value',
  'data',
  'operation',
  'baseGas',
  'gasPrice',
  'gasToken',
  'refundReceiver',
  'nonce',
  'safeTxGas',
];

const ADDRESS_FIELDS: readonly SafeTxField[] = ['to', 'gasToken', 'refundReceiver'];
const INTEGER_FIELDS: readonly SafeTxField[] = ['value', 'safeTxGas', 'baseGas', 'gasPrice', 'nonce'];

const UINT256_MAX = (1n << 256n) - 1n;

/** An error about one field, or about the JSON as a whole (`field: null`). */
export interface SafeTxInputError {
  field: SafeTxField | null;
  message: string;
}

/**
 * The values a new entry starts from. Gas fields are 0 and the gas token and
 * refund receiver are the zero address, written in full. `to`, `value`,
 * `data` and `nonce` start empty and must be entered.
 */
export function defaultSafeTxFieldValues(): SafeTxFieldValues {
  return {
    to: '',
    value: '',
    data: '',
    operation: '0',
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce: '',
  };
}

function isSafeTxField(key: string): key is SafeTxField {
  return (SAFE_TX_FIELDS as readonly string[]).includes(key);
}

/**
 * The keys of the top-level object in `text`, in order, duplicates included.
 *
 * `JSON.parse` keeps the last of two equal keys and drops the first without a
 * trace, so a paste could show one `to` and hash another. This scan sees both.
 * Only called on text that `JSON.parse` already accepted.
 */
function topLevelKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') {
        if (text[end] === '\\') end++;
        end++;
      }
      const literal = text.substring(i, end + 1);
      i = end + 1;
      if (depth === 1) {
        let next = i;
        while (next < text.length && /\s/.test(text[next]!)) next++;
        if (text[next] === ':') keys.push(JSON.parse(literal) as string);
      }
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    i++;
  }
  return keys;
}

/**
 * The offset of the first JSON syntax error in `text`, `text.length` when the
 * text ends early, or null when the text nests too deep to scan.
 *
 * Only called on text that `JSON.parse` rejected. The engine's own message
 * quotes the start of the bad text, which for a pasted address or hash is a
 * truncated identifier. This scan finds the position without quoting
 * anything.
 */
function jsonErrorOffset(text: string): number | null {
  let i = 0;
  const fail = (): never => {
    throw i;
  };
  const skipSpace = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const scanString = () => {
    i++;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '"') {
        i++;
        return;
      }
      if (ch === '\\') {
        i++;
        const escape = text[i];
        if (escape !== undefined && '"\\/bfnrt'.includes(escape)) {
          i++;
        } else if (escape === 'u') {
          i++;
          for (let k = 0; k < 4; k++) {
            if (!/[0-9a-fA-F]/.test(text[i] ?? '')) fail();
            i++;
          }
        } else {
          fail();
        }
        continue;
      }
      if (ch < ' ') fail();
      i++;
    }
    fail();
  };
  const number = /-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
  const scanValue = (): void => {
    skipSpace();
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      i++;
      skipSpace();
      if (text[i] === close) {
        i++;
        return;
      }
      for (;;) {
        if (close === '}') {
          skipSpace();
          if (text[i] !== '"') fail();
          scanString();
          skipSpace();
          if (text[i] !== ':') fail();
          i++;
        }
        scanValue();
        skipSpace();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === close) {
          i++;
          return;
        }
        fail();
      }
    }
    if (ch === '"') return scanString();
    number.lastIndex = i;
    const match = number.exec(text);
    if (match) {
      i += match[0].length;
      return;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return;
      }
    }
    fail();
  };

  try {
    scanValue();
    skipSpace();
    if (i < text.length) fail();
    return null;
  } catch (error) {
    // A number is a position. Anything else is the stack running out.
    return typeof error === 'number' ? error : null;
  }
}

/** Why `text` is not valid JSON, by line and column, quoting none of it. */
function invalidJsonMessage(text: string): string {
  const offset = jsonErrorOffset(text);
  if (offset === null) return 'Not valid JSON.';
  if (offset >= text.length) return 'Not valid JSON. The text ends before the JSON is complete.';
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - before.lastIndexOf('\n');
  return `Not valid JSON. Check line ${line}, column ${column}.`;
}

export type ReadSafeTxJsonResult =
  | { ok: true; values: SafeTxFieldValues }
  | { ok: false; error: SafeTxInputError };

/**
 * Read the JSON from Safe's JSON tab into field text.
 *
 * Checks structure only: valid JSON, one object, no unknown or repeated key,
 * all ten keys present, and each value of a type the JSON tab uses. Numbers
 * may be JSON numbers or decimal strings. The values themselves are checked
 * by `validateSafeTxFields`.
 *
 * The JSON tab always writes all ten keys. A missing key means the paste is
 * incomplete, so nothing is filled in for it: not a default, not the nonce
 * the Safe would use next.
 */
export function readSafeTxJson(text: string): ReadSafeTxJsonResult {
  const fail = (message: string, field: SafeTxField | null = null): ReadSafeTxJsonResult => ({
    ok: false,
    error: { field, message },
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The engine's message is not shown. It quotes part of the paste.
    return fail(invalidJsonMessage(text));
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('Expected one JSON object with the transaction fields.');
  }

  const seen = new Set<string>();
  for (const key of topLevelKeys(text)) {
    if (seen.has(key)) return fail(`Duplicate key "${key}".`);
    seen.add(key);
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!isSafeTxField(key)) return fail(`Unknown key "${key}". Copy the transaction from the JSON tab.`);
  }
  const missing = SAFE_TX_FIELDS.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (missing.length > 0) {
    const names = missing.map((key) => `"${key}"`).join(', ');
    return fail(
      `Missing ${missing.length === 1 ? 'key' : 'keys'} ${names}. Copy the whole transaction from the JSON tab.`,
      missing.length === 1 ? missing[0]! : null
    );
  }

  const values = defaultSafeTxFieldValues();
  for (const key of SAFE_TX_FIELDS) {
    const raw = record[key];
    if (key === 'operation' || INTEGER_FIELDS.includes(key)) {
      if (typeof raw === 'number') {
        // A JSON number past 2^53 has already lost digits by the time it is
        // read. Refuse it rather than hash a rounded value.
        if (!Number.isSafeInteger(raw) || raw < 0) {
          return fail(`${key} is not an exact non-negative integer. Write it as a decimal string.`, key);
        }
        values[key] = String(raw);
      } else if (typeof raw === 'string') {
        values[key] = raw;
      } else {
        return fail(`${key} must be a number or a decimal string.`, key);
      }
    } else if (typeof raw === 'string') {
      values[key] = raw;
    } else {
      return fail(`${key} must be a string.`, key);
    }
  }

  return { ok: true, values };
}

function looksTruncated(value: string): boolean {
  return value.includes('...') || value.includes('…');
}

function truncatedMessage(field: SafeTxField): string {
  return `${field} looks truncated. Copy it from the JSON tab.`;
}

function validateAddress(field: SafeTxField, raw: string): { value: Address } | { error: string } {
  const value = raw.trim();
  if (value === '') return { error: `${field} is required.` };
  if (looksTruncated(value) || /\s/.test(value)) return { error: truncatedMessage(field) };
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return { error: `${field} must be 0x followed by 40 hex characters.` };
  }
  const checksummed = getAddress(value.toLowerCase());
  const hex = value.slice(2);
  const mixedCase = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  // EIP-55: only a mixed-case address carries a checksum. All lower-case or
  // all upper-case is accepted and shown checksummed.
  if (mixedCase && checksummed !== value) {
    return { error: `${field} has an invalid EIP-55 checksum. Copy it from the JSON tab.` };
  }
  return { value: checksummed };
}

function validateData(raw: string): { value: Hex } | { error: string } {
  const value = raw.trim();
  if (value === '') return { error: 'data is required. Enter 0x for no calldata.' };
  if (looksTruncated(value) || /\s/.test(value)) return { error: truncatedMessage('data') };
  if (!/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    return { error: 'data must be 0x followed by an even number of hex characters.' };
  }
  return { value: value.toLowerCase() as Hex };
}

function validateInteger(field: SafeTxField, raw: string): { value: string } | { error: string } {
  const value = raw.trim();
  if (value === '') return { error: `${field} is required.` };
  if (looksTruncated(value)) return { error: truncatedMessage(field) };
  if (!/^[0-9]+$/.test(value)) return { error: `${field} must be a non-negative decimal integer.` };
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) return { error: `${field} is larger than uint256 allows.` };
  return { value: parsed.toString() };
}

function validateOperation(raw: string): { value: 0 | 1 } | { error: string } {
  const value = raw.trim();
  if (value === '') return { error: 'operation is required.' };
  if (looksTruncated(value)) return { error: truncatedMessage('operation') };
  if (value === '0') return { value: 0 };
  if (value === '1') return { value: 1 };
  return { error: 'operation must be 0 (call) or 1 (delegatecall).' };
}

export type ValidateSafeTxResult =
  | { ok: true; transaction: SafeTransactionData }
  | { ok: false; errors: SafeTxInputError[] };

/**
 * Check every field and return the transaction in canonical form: addresses
 * EIP-55 checksummed, data lower-case, integers as decimal strings without
 * leading zeros. Returns one error per invalid field, in field order.
 *
 * Leading and trailing whitespace is ignored. Whitespace inside a hex value,
 * or an ellipsis anywhere, is reported as a truncated value.
 */
export function validateSafeTxFields(values: SafeTxFieldValues): ValidateSafeTxResult {
  const errors: SafeTxInputError[] = [];
  const out: Partial<Record<SafeTxField, unknown>> = {};

  for (const field of SAFE_TX_FIELDS) {
    const raw = values[field] ?? '';
    const result = ADDRESS_FIELDS.includes(field)
      ? validateAddress(field, raw)
      : field === 'data'
        ? validateData(raw)
        : field === 'operation'
          ? validateOperation(raw)
          : validateInteger(field, raw);
    if ('error' in result) errors.push({ field, message: result.error });
    else out[field] = result.value;
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    transaction: {
      to: out.to as Address,
      value: out.value as string,
      data: out.data as Hex,
      operation: out.operation as 0 | 1,
      safeTxGas: out.safeTxGas as string,
      baseGas: out.baseGas as string,
      gasPrice: out.gasPrice as string,
      gasToken: out.gasToken as Address,
      refundReceiver: out.refundReceiver as Address,
      nonce: out.nonce as string,
    },
  };
}

/**
 * Read and validate Safe's JSON tab in one step. A paste that omits any of
 * the ten keys, the nonce included, is rejected and names the missing keys.
 */
export function parseSafeTxJson(text: string): ValidateSafeTxResult {
  const read = readSafeTxJson(text);
  if (!read.ok) return { ok: false, errors: [read.error] };
  return validateSafeTxFields(read.values);
}

/**
 * Write field text as Safe's JSON tab writes it: the same key order, two-space
 * indent, `operation` and `nonce` as numbers, every other value as a string.
 * A value that is not a plain decimal is written as the string it is, so the
 * output never hides what was entered.
 */
export function formatSafeTxJson(values: SafeTxFieldValues): string {
  const ordered: Record<string, string | number> = {};
  for (const key of SAFE_JSON_ORDER) {
    const raw = values[key] ?? '';
    if (
      (key === 'operation' || key === 'nonce') &&
      /^(0|[1-9][0-9]*)$/.test(raw) &&
      Number.isSafeInteger(Number(raw))
    ) {
      ordered[key] = Number(raw);
    } else {
      ordered[key] = raw;
    }
  }
  return JSON.stringify(ordered, null, 2);
}
