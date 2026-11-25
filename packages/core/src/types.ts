/**
 * Core TypeScript types for Safe transaction handling
 * Ported from safe-tx-hashes-util bash script
 */

import type { Address, Hash, Hex } from 'viem'

/**
 * Supported Safe contract versions
 * @see https://github.com/safe-global/safe-smart-account
 */
export type SafeVersion = string // e.g., "1.3.0", "1.4.1", "1.5.0+L2"

/**
 * Safe transaction operation type
 * @see https://github.com/safe-global/safe-smart-account/blob/main/contracts/libraries/Enum.sol
 */
export enum Operation {
  Call = 0,
  DelegateCall = 1,
}

/**
 * Safe transaction data structure
 * Maps to Safe.sol execTransaction parameters
 */
export interface SafeTransactionData {
  to: Address
  value: bigint | string
  data: Hex
  operation: Operation
  safeTxGas: bigint | string
  baseGas: bigint | string
  gasPrice: bigint | string
  gasToken: Address
  refundReceiver: Address
  nonce: bigint | string
}

/**
 * Network configuration. `apiUrl` is the Safe Transaction Service for the
 * chain, used for Safe info. The Safe Queue Service and the Safe Decoder
 * Service have one URL for every chain and take `chainId` as a parameter.
 */
export interface NetworkConfig {
  name: string
  chainId: number
  apiUrl: string
  /** Short prefix used by Safe UI (e.g., 'eth', 'sep') */
  safePrefix: string
  /** Etherscan base URL */
  etherscanUrl: string
  /**
   * Public JSON-RPC endpoint. Used only to read a proxy's EIP-1967
   * implementation slot when resolving a Sourcify ABI for a proxied call.
   */
  rpcUrl: string
}

/**
 * Computed hashes for a Safe transaction
 */
export interface SafeTransactionHashes {
  domainHash: Hash
  messageHash: Hash
  safeTxHash: Hash
}

/**
 * Result of transaction decoding
 */
export interface DecodedTransaction {
  method: string
  parameters: Array<{
    name: string
    type: string
    value: string | bigint | boolean
  }>
  warnings?: string[]
  riskLevel?: 'none' | 'low' | 'medium' | 'high'
}

/**
 * Safe Transaction Service API response types
 * @see https://docs.safe.global/core-api/transaction-service-reference
 */

/**
 * A page of transactions in the Safe Transaction Service record shape.
 */
export interface SafeApiMultisigTransactionResponse {
  count: number
  next: string | null
  previous: string | null
  results: SafeApiMultisigTransaction[]
}

/**
 * Multisig transaction in the Safe Transaction Service record shape. The
 * client converts every Safe Queue Service record to this shape with
 * `adaptQueueTransaction`. That service does not return `executionDate`,
 * `blockNumber`, the gas and fee fields, `trusted` or `signatures`, so they
 * are null or false on a converted record.
 */
export interface SafeApiMultisigTransaction {
  safe: Address
  to: Address
  value: string
  data: Hex | null
  operation: number
  gasToken: Address
  safeTxGas: number
  baseGas: number
  gasPrice: string
  refundReceiver: Address
  nonce: number
  executionDate: string | null
  submissionDate: string
  modified: string
  blockNumber: number | null
  transactionHash: string | null
  safeTxHash: string
  executor: Address | null
  /**
   * Owner the service attributes the proposal to. When an owner submitted the
   * proposal, this is that owner. When a delegate submitted it, this is the
   * delegator owner who authorised the delegate, not the submitting address.
   */
  proposer: Address | null
  /**
   * Delegate that actually submitted the proposal, when a delegate submitted
   * it. Null when an owner submitted it directly. When set, `proposer` holds
   * the delegator owner.
   */
  proposedByDelegate: Address | null
  isExecuted: boolean
  isSuccessful: boolean | null
  ethGasPrice: string | null
  maxFeePerGas: string | null
  maxPriorityFeePerGas: string | null
  gasUsed: number | null
  fee: string | null
  origin: string | null
  dataDecoded: SafeApiDataDecoded | null
  confirmationsRequired: number
  confirmations: SafeApiConfirmation[]
  trusted: boolean
  signatures: string | null
  /**
   * The Safe Queue Service does not return a decoding, so the client asks the
   * Safe Decoder Service. When the decoder did not answer, or the caller did
   * not ask for a decoding, `dataDecoded` is null for want of an answer and
   * this field holds the reason. Absent when `dataDecoded` is the decoder's
   * own answer.
   */
  dataDecodedUnavailable?: string
}

/**
 * Multisig transaction as the Safe Queue Service returns it.
 *
 * All addresses are lowercase. `to`, `gasToken` and `refundReceiver` are null
 * when unset or the zero address. Numbers are decimal strings.
 *
 * @see https://docs.safe.global/core-api/safe-queue-service-reference
 */
export interface SafeQueueMultisigTransaction {
  safeTxHash: string
  /** Decimal string. */
  chainId: string
  safe: string
  /** Decimal string. */
  nonce: string
  /**
   * Address credited with the proposal: the signer for `OWNER`, the delegating
   * owner for `DELEGATE`, the owner Safe for `NESTED_OWNER`. Null for `UNKNOWN`.
   */
  proposer: string | null
  /** `OWNER`, `DELEGATE`, `NESTED_OWNER` or `UNKNOWN`. An open list. */
  proposedVia: string
  /** Address that signed the proposal, set only when it differs from `proposer`. */
  proposedBy: string | null
  to: string | null
  value: string
  data: string | null
  operation: number
  safeTxGas: string
  baseGas: string
  gasPrice: string
  gasToken: string | null
  refundReceiver: string | null
  /** Null until execution. */
  failed: boolean | null
  notes: string | null
  originName: string | null
  originUrl: string | null
  /** Execution transaction hash. Null while the transaction is not executed. */
  txHash: string | null
  executor: string | null
  created: string
  modified: string
  confirmations: SafeQueueConfirmation[]
}

/**
 * Confirmation as the Safe Queue Service returns it.
 */
export interface SafeQueueConfirmation {
  owner: string
  signature: string
  signatureType: string
  created: string
  modified: string
}

/**
 * Page of a Safe Queue Service list.
 */
export interface SafeQueueMultisigTransactionResponse {
  count: number
  next: string | null
  previous: string | null
  results: SafeQueueMultisigTransaction[]
}

/**
 * Nested transaction within MultiSend (from Safe API valueDecoded)
 */
export interface SafeApiNestedTransaction {
  operation: number
  to: string
  value: string
  data: string
  dataDecoded?: SafeApiDataDecoded | null
}

/**
 * Decoded transaction data from Safe Transaction Service
 */
export interface SafeApiDataDecoded {
  method: string
  parameters: Array<{
    name: string
    type: string
    value: string
    /**
     * For MultiSend transactions, this contains an array of nested transactions
     * For other types, this may contain structured data
     */
    valueDecoded?: SafeApiNestedTransaction[] | unknown
  }>
  /**
   * How the Safe Decoder Service matched the ABI: `FULL_MATCH`,
   * `PARTIAL_MATCH`, `ONLY_FUNCTION_MATCH` or `NO_MATCH`. Present only on a
   * Decoder Service answer. The tool re-encodes every decoding, so it does not
   * rely on this field.
   */
  accuracy?: string
}

/**
 * Transaction confirmation from a Safe owner
 */
export interface SafeApiConfirmation {
  owner: Address
  submissionDate: string
  transactionHash: string | null
  signature: string
  signatureType: string
}

/**
 * Response from /api/v1/safes/{address}/
 */
export interface SafeApiSafeInfo {
  address: Address
  /**
   * Current nonce. The service serialises this as a decimal string on some
   * deployments and as a number on others, so callers must normalise it.
   */
  nonce: number | string
  threshold: number
  owners: Address[]
  masterCopy: Address
  modules: Address[]
  fallbackHandler: Address
  guard: Address
  version: string
}
