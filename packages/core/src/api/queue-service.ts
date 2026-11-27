/**
 * Safe Queue Service records: response checks and the adapter to the
 * Safe Transaction Service record shape the rest of the tool reads.
 *
 * The Safe Queue Service drops a query parameter it does not know and returns
 * 200 without that filter. A filter on the server is therefore not evidence of
 * anything. Every record read is checked here against what was asked for
 * before it is used.
 *
 * @see https://docs.safe.global/core-api/safe-queue-service-migration
 */

import { getAddress, isAddress, zeroAddress, type Address, type Hex } from 'viem';
import type { SafeApiConfirmation, SafeApiMultisigTransaction, SafeQueueMultisigTransaction } from '../types.js';
import type { DecodeDataResult } from './safe-client.js';
import { SafeApiError } from './errors.js';

/** Which service a record came from. Used in error messages. */
export type SafeServiceName = 'Safe Queue Service';

/** What a request asked for. Each field set here must match the record. */
export interface TransactionExpectation {
  safe?: string;
  /** Checked only on Safe Queue Service records, which carry `chainId`. */
  chainId?: number;
  nonce?: number;
  safeTxHash?: string;
}

/** A received value, in full, for an error message. */
function shown(value: unknown): string {
  if (typeof value === 'string') {
    return isAddress(value, { strict: false }) ? getAddress(value.toLowerCase()) : JSON.stringify(value);
  }
  return JSON.stringify(value) ?? String(value);
}

/** An expected address, in full and checksummed when it is one. */
function expectedAddress(value: string): string {
  return isAddress(value, { strict: false }) ? getAddress(value.toLowerCase()) : value;
}

function sameText(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

function sameInteger(received: unknown, expected: number): boolean {
  if (typeof received !== 'string' && typeof received !== 'number') return false;
  const text = String(received);
  if (!/^[0-9]+$/.test(text)) return false;
  return BigInt(text) === BigInt(expected);
}

/**
 * Throw unless the record matches every expected field.
 *
 * Addresses and hashes compare without regard to case. The message names the
 * full expected value and the full received value.
 *
 * @throws {SafeApiError} on the first mismatch
 */
export function assertTransactionMatches(
  record: unknown,
  expected: TransactionExpectation,
  source: SafeServiceName
): void {
  if (!record || typeof record !== 'object') {
    throw new SafeApiError(`The ${source} returned ${shown(record)} where a transaction was expected.`);
  }
  const tx = record as Record<string, unknown>;
  const id = typeof tx.safeTxHash === 'string' ? `transaction ${tx.safeTxHash}` : 'a transaction';

  if (expected.safeTxHash !== undefined && !sameText(tx.safeTxHash, expected.safeTxHash)) {
    throw new SafeApiError(
      `The ${source} returned safeTxHash ${shown(tx.safeTxHash)}. The request was for safeTxHash ${expected.safeTxHash}.`
    );
  }
  if (expected.safe !== undefined && !sameText(tx.safe, expected.safe)) {
    throw new SafeApiError(
      `The ${source} returned ${id} for Safe ${shown(tx.safe)}. The request was for Safe ${expectedAddress(expected.safe)}.`
    );
  }
  if (expected.chainId !== undefined && !sameInteger(tx.chainId, expected.chainId)) {
    throw new SafeApiError(
      `The ${source} returned ${id} for chain ${shown(tx.chainId)}. The request was for chain ${expected.chainId}.`
    );
  }
  if (expected.nonce !== undefined && !sameInteger(tx.nonce, expected.nonce)) {
    throw new SafeApiError(
      `The ${source} returned ${id} with nonce ${shown(tx.nonce)}. The request was for nonce ${expected.nonce}.`
    );
  }
}

/** A required address, checksummed. */
function requiredAddress(field: string, value: unknown, safeTxHash: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new SafeApiError(
      `The Safe Queue Service returned ${shown(value)} as ${field} of transaction ${safeTxHash}. It is not an address.`
    );
  }
  return getAddress(value.toLowerCase());
}

/** An address that may be null, checksummed. */
function optionalAddress(field: string, value: unknown, safeTxHash: string): Address | null {
  return value === null || value === undefined ? null : requiredAddress(field, value, safeTxHash);
}

/** A decimal string, kept as a string. */
function decimalString(field: string, value: unknown, safeTxHash: string): string {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new SafeApiError(
      `The Safe Queue Service returned ${shown(value)} as ${field} of transaction ${safeTxHash}. It is not a decimal integer.`
    );
  }
  return value;
}

/**
 * A decimal string read as a number. A value above 2^53 - 1 is rejected: a
 * number cannot hold it exactly, and a rounded value would change the hash.
 */
function safeNumber(field: string, value: unknown, safeTxHash: string): number {
  const text = decimalString(field, value, safeTxHash);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    throw new SafeApiError(
      `The Safe Queue Service returned ${field} ${text} for transaction ${safeTxHash}. This tool does not read a value this large exactly.`
    );
  }
  return number;
}

/** Origin in the Safe Transaction Service form: a JSON string, or null. */
function originOf(name: string | null, url: string | null): string | null {
  if (name === null && url === null) return null;
  const origin: Record<string, string> = {};
  if (name !== null) origin.name = name;
  if (url !== null) origin.url = url;
  return JSON.stringify(origin);
}

export interface AdaptQueueTransactionInput {
  /** The Safe's threshold, from the Safe Transaction Service Safe info. */
  confirmationsRequired: number;
  /**
   * The Safe Decoder Service's answer for this record's calldata, or null when the
   * caller did not ask for one.
   */
  decoding: DecodeDataResult | null;
}

/**
 * Convert a Safe Queue Service record to the Safe Transaction Service shape.
 *
 * - Every address is checksummed. A null `to`, `gasToken` or `refundReceiver`
 *   becomes the zero address, which is the value the Safe hashes.
 * - `nonce`, `safeTxGas` and `baseGas` become numbers. `value` and `gasPrice`
 *   stay decimal strings.
 * - `transactionHash` is `txHash`. The record is executed when `txHash` is set.
 *   `isSuccessful` is the opposite of `failed`, and null while `failed` is null.
 * - `proposedByDelegate` is `proposedBy` only when `proposedVia` is
 *   `DELEGATE`. Then `proposer` is the delegating owner, as on the Safe
 *   Transaction Service.
 * - `confirmationsRequired` is the Safe's current threshold. For an executed
 *   record it can differ from the threshold at execution, so the UI and the
 *   CLI do not show it for an executed record.
 * - The Safe Queue Service does not return `executionDate`, `blockNumber`, the
 *   gas and fee fields, `trusted` or `signatures`. They are null or false.
 *
 * Call `assertTransactionMatches` on the raw record first.
 *
 * @throws {SafeApiError} when a field is not of the documented form
 */
export function adaptQueueTransaction(
  record: SafeQueueMultisigTransaction,
  input: AdaptQueueTransactionInput
): SafeApiMultisigTransaction {
  const hash = typeof record.safeTxHash === 'string' ? record.safeTxHash : shown(record.safeTxHash);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new SafeApiError(`The Safe Queue Service returned ${hash} as a safeTxHash. It is not 32 bytes of hex.`);
  }
  if (record.data !== null && (typeof record.data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(record.data))) {
    throw new SafeApiError(`The Safe Queue Service returned data of transaction ${hash} that is not hex.`);
  }
  if (record.operation !== 0 && record.operation !== 1) {
    throw new SafeApiError(
      `The Safe Queue Service returned operation ${shown(record.operation)} for transaction ${hash}. It must be 0 or 1.`
    );
  }
  if (!Array.isArray(record.confirmations)) {
    throw new SafeApiError(`The Safe Queue Service returned transaction ${hash} without a confirmations list.`);
  }

  const confirmations: SafeApiConfirmation[] = record.confirmations.map((confirmation) => ({
    owner: requiredAddress('a confirmation owner', confirmation.owner, hash),
    submissionDate: confirmation.created,
    transactionHash: null,
    signature: confirmation.signature,
    signatureType: confirmation.signatureType,
  }));

  let dataDecoded: SafeApiMultisigTransaction['dataDecoded'] = null;
  let dataDecodedUnavailable: string | undefined;
  if (input.decoding === null) {
    dataDecodedUnavailable = 'not requested';
  } else if (input.decoding.status === 'decoded') {
    dataDecoded = input.decoding.decoded;
  } else if (input.decoding.status === 'failed') {
    dataDecodedUnavailable = input.decoding.reason;
  }

  const adapted: SafeApiMultisigTransaction = {
    safe: requiredAddress('safe', record.safe, hash),
    to: optionalAddress('to', record.to, hash) ?? zeroAddress,
    value: decimalString('value', record.value, hash),
    data: record.data as Hex | null,
    operation: record.operation,
    gasToken: optionalAddress('gasToken', record.gasToken, hash) ?? zeroAddress,
    safeTxGas: safeNumber('safeTxGas', record.safeTxGas, hash),
    baseGas: safeNumber('baseGas', record.baseGas, hash),
    gasPrice: decimalString('gasPrice', record.gasPrice, hash),
    refundReceiver: optionalAddress('refundReceiver', record.refundReceiver, hash) ?? zeroAddress,
    nonce: safeNumber('nonce', record.nonce, hash),
    executionDate: null,
    submissionDate: record.created,
    modified: record.modified,
    blockNumber: null,
    transactionHash: record.txHash,
    safeTxHash: hash,
    executor: optionalAddress('executor', record.executor, hash),
    proposer: optionalAddress('proposer', record.proposer, hash),
    proposedByDelegate:
      record.proposedVia === 'DELEGATE' ? optionalAddress('proposedBy', record.proposedBy, hash) : null,
    isExecuted: record.txHash !== null && record.txHash !== undefined,
    isSuccessful: record.failed === null || record.failed === undefined ? null : !record.failed,
    ethGasPrice: null,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    gasUsed: null,
    fee: null,
    origin: originOf(record.originName ?? null, record.originUrl ?? null),
    dataDecoded,
    confirmationsRequired: input.confirmationsRequired,
    confirmations,
    trusted: false,
    signatures: null,
  };
  if (dataDecodedUnavailable !== undefined) adapted.dataDecodedUnavailable = dataDecodedUnavailable;
  return adapted;
}
