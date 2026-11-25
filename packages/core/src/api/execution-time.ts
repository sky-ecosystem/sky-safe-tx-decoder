/**
 * Execution time of a Safe transaction, read from a node.
 *
 * The Safe Queue Service record carries the execution transaction hash
 * (`txHash`) and not the time. Two calls give the time:
 *
 * 1. `eth_getTransactionByHash(txHash)` gives the block number.
 * 2. `eth_getBlockByNumber(blockNumber, false)` gives the block timestamp.
 *
 * `eth_getTransactionReceipt` is not used: public nodes answer null for older
 * transactions.
 *
 * The time is display only. It fails closed: any failure, or an answer for
 * another transaction or block, yields null, and the caller shows that the
 * time is not available.
 */

import { rpcCallResult } from './rpc.js';

const HEX_QUANTITY = /^0x[0-9a-fA-F]{1,16}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Read the time of the block that holds a transaction.
 *
 * @param rpcUrl - JSON-RPC endpoint of the network
 * @param txHash - Execution transaction hash
 * @returns the block time as an ISO 8601 UTC string without milliseconds,
 *   for example `2025-10-11T22:39:59Z`, or null on any failure
 */
export async function fetchExecutionTime(rpcUrl: string, txHash: string, signal?: AbortSignal): Promise<string | null> {
  if (!HASH.test(txHash)) return null;

  const tx = (await rpcCallResult(rpcUrl, 'eth_getTransactionByHash', [txHash], signal)) as {
    hash?: unknown;
    blockNumber?: unknown;
  } | null;
  if (!tx || typeof tx !== 'object') return null;
  if (typeof tx.hash !== 'string' || tx.hash.toLowerCase() !== txHash.toLowerCase()) return null;
  // A pending transaction has a null blockNumber.
  if (typeof tx.blockNumber !== 'string' || !HEX_QUANTITY.test(tx.blockNumber)) return null;

  const block = (await rpcCallResult(rpcUrl, 'eth_getBlockByNumber', [tx.blockNumber, false], signal)) as {
    number?: unknown;
    timestamp?: unknown;
  } | null;
  if (!block || typeof block !== 'object') return null;
  if (typeof block.number !== 'string' || !HEX_QUANTITY.test(block.number)) return null;
  if (BigInt(block.number) !== BigInt(tx.blockNumber)) return null;
  if (typeof block.timestamp !== 'string' || !HEX_QUANTITY.test(block.timestamp)) return null;

  const seconds = Number(BigInt(block.timestamp));
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace('.000Z', 'Z');
}
