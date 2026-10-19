/**
 * Pick the transaction a transaction page shows.
 *
 * A link can name one transaction by its safeTxHash. That transaction is
 * shown, or none is. Another transaction at the same nonce is never shown in
 * its place: the page would then show a hash check for a transaction the
 * person did not ask about.
 */

import type { Hex } from 'viem';
import type { SafeApiMultisigTransaction } from '../types.js';

export interface ResolveRequestedTransactionInput {
  safeAddress: string;
  nonce: number;
  /** The safeTxHash the link names, or null when it names none. */
  safeTxHash: string | null;
  /** The Safe API's transactions at this nonce. */
  transactions: readonly SafeApiMultisigTransaction[];
  /** Look up one transaction by its safeTxHash. Null when there is none. */
  fetchByHash: (safeTxHash: Hex) => Promise<SafeApiMultisigTransaction | null>;
}

export type ResolveRequestedTransactionResult =
  | {
      ok: true;
      transaction: SafeApiMultisigTransaction;
      /** The transactions at this nonce, the requested one included. */
      transactions: SafeApiMultisigTransaction[];
    }
  | { ok: false; message: string };

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The transaction to show for a Safe, a nonce and an optional safeTxHash.
 *
 * - No safeTxHash: the first transaction at the nonce, as before.
 * - A safeTxHash: the transaction at the nonce with that hash. When the list
 *   at the nonce does not hold it (the list is one page, or the service
 *   answers inconsistently), it is looked up by hash. The answer is accepted
 *   only for this hash, this Safe and this nonce. Otherwise the result is an
 *   error, and no transaction is shown.
 */
export async function resolveRequestedTransaction(
  input: ResolveRequestedTransactionInput
): Promise<ResolveRequestedTransactionResult> {
  const { safeAddress, nonce, safeTxHash, transactions } = input;

  if (safeTxHash === null) {
    const first = transactions[0];
    if (!first) return { ok: false, message: `No transaction found for Safe ${safeAddress} at nonce ${nonce}.` };
    return { ok: true, transaction: first, transactions: [...transactions] };
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(safeTxHash)) {
    return { ok: false, message: 'The safeTxHash in the link is not 0x followed by 64 hex characters.' };
  }

  const notFound = {
    ok: false as const,
    message: `Transaction ${safeTxHash} was not found among the transactions at nonce ${nonce} for Safe ${safeAddress}. No other transaction is shown.`,
  };

  const matches = transactions.filter((tx) => sameHex(tx.safeTxHash, safeTxHash));
  if (matches.length > 1) {
    return {
      ok: false,
      message: `The Safe API returned more than one transaction with safeTxHash ${safeTxHash}. No transaction is shown.`,
    };
  }
  if (matches.length === 1) {
    return { ok: true, transaction: matches[0]!, transactions: [...transactions] };
  }

  const found = await input.fetchByHash(safeTxHash as Hex);
  if (
    !found ||
    typeof found.safeTxHash !== 'string' ||
    !sameHex(found.safeTxHash, safeTxHash) ||
    typeof found.safe !== 'string' ||
    !sameHex(found.safe, safeAddress) ||
    Number(found.nonce) !== nonce
  ) {
    return notFound;
  }
  return { ok: true, transaction: found, transactions: [...transactions, found] };
}
