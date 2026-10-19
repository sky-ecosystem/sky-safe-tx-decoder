/**
 * Nonce checks for a transaction that is not proposed yet.
 */

/**
 * The nonce Safe's web app proposes for a new transaction: the Safe's on-chain
 * nonce, or one past the highest queued nonce when the queue runs past it.
 */
export function recommendedProposalNonce(onchainNonce: number, queuedNonces: readonly number[]): number {
  let next = onchainNonce;
  for (const queued of queuedNonces) {
    if (queued + 1 > next) next = queued + 1;
  }
  return next;
}

export interface ProposalNonceCheck {
  /** Below the on-chain nonce. A transaction with this nonce already executed. */
  used: boolean;
  /** A queued transaction already uses this nonce. Only one of them can execute. */
  queued: boolean;
}

/**
 * Compare a proposal's nonce with the Safe's on-chain nonce and its queue.
 *
 * `queuedNonces` holds the nonces of transactions that are not executed and
 * are at or above the on-chain nonce. A transaction below it that never
 * executed was replaced, and is not in the queue.
 */
export function checkProposalNonce(
  nonce: bigint,
  onchainNonce: number,
  queuedNonces: readonly number[]
): ProposalNonceCheck {
  return {
    used: nonce < BigInt(onchainNonce),
    queued: queuedNonces.some((queued) => BigInt(queued) === nonce),
  };
}
