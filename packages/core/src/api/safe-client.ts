/**
 * Safe Transaction Service API Client
 * Port of bash script lines 1289-1348 (API fetching logic)
 *
 * @see https://docs.safe.global/core-api/transaction-service-reference
 */

import type { Address, Hex } from 'viem'
import type {
  SafeApiDataDecoded,
  SafeApiMultisigTransactionResponse,
  SafeApiMultisigTransaction,
  SafeApiSafeInfo,
} from '../types.js'
import { getNetwork } from './networks.js'

/**
 * Error thrown when Safe API request fails
 */
export class SafeApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly response?: unknown
  ) {
    super(message)
    this.name = 'SafeApiError'
  }
}

/**
 * Outcome of a data decoder call. See `SafeApiClient.decodeData`.
 *
 * `decoded` may hold the service's `fallback` sentinel, which callers treat as
 * no decoding. `failed` means the service gave no usable answer, which is not
 * the same as an answer of "no decoding".
 */
export type DecodeDataResult =
  | { status: 'decoded'; decoded: SafeApiDataDecoded }
  | { status: 'none' }
  | { status: 'failed'; reason: string }

/**
 * Callback for retry notifications
 */
export type RetryCallback = (message: string, attempt: number, maxRetries: number, delay: number) => void

/**
 * Retry a function with exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000,
  onRetry?: RetryCallback
): Promise<T> {
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error

      // Check if it's a rate limit error (429)
      const isRateLimit =
        error instanceof SafeApiError &&
        (error.statusCode === 429 ||
          error.message.toLowerCase().includes('rate limit'))

      // Don't retry non-rate-limit errors
      if (!isRateLimit || attempt === maxRetries) {
        throw error
      }

      // Calculate delay with exponential backoff: 1s, 2s, 4s, 8s...
      const delay = initialDelay * Math.pow(2, attempt)
      const message = `Rate limited. Retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...`

      console.warn(message)

      // Notify callback if provided
      if (onRetry) {
        onRetry(message, attempt + 1, maxRetries, delay)
      }

      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw lastError
}

/**
 * Safe Transaction Service API Client
 */
export class SafeApiClient {
  private readonly baseUrl: string
  private readonly chainId: number
  private readonly networkName: string
  private readonly onRetry?: RetryCallback

  constructor(network: string = 'ethereum', onRetry?: RetryCallback) {
    const networkConfig = getNetwork(network)
    this.baseUrl = networkConfig.apiUrl
    this.chainId = networkConfig.chainId
    this.networkName = networkConfig.name
    this.onRetry = onRetry
  }

  /**
   * Fetch all Safe multisig transactions by nonce (handles multiple with same nonce)
   *
   * @param safeAddress - Safe multisig address (must be checksummed)
   * @param nonce - Transaction nonce
   * @returns Array of transactions with this nonce
   * @throws {SafeApiError} if request fails or no transaction found
   */
  async fetchTransactionsByNonce(
    safeAddress: Address,
    nonce: number
  ): Promise<SafeApiMultisigTransaction[]> {
    return retryWithBackoff(async () => {
      const endpoint = `${this.baseUrl}/api/v2/safes/${safeAddress}/multisig-transactions/?nonce=${nonce}`

      try {
        const response = await fetch(endpoint)

        if (!response.ok) {
          throw new SafeApiError(
            `Safe API request failed: ${response.statusText}`,
            response.status
          )
        }

        const data = (await response.json()) as SafeApiMultisigTransactionResponse

        // Check if any transactions were found
        if (data.count === 0 || data.results.length === 0) {
          throw new SafeApiError(
            `No transaction found for Safe ${safeAddress} at nonce ${nonce}`
          )
        }

        return data.results
      } catch (error) {
        if (error instanceof SafeApiError) {
          throw error
        }

        // Handle network errors
        throw new SafeApiError(
          `Failed to fetch transaction: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          error
        )
      }
    }, 3, 1000, this.onRetry)
  }

  /**
   * Fetch Safe multisig transaction by nonce
   * Port of bash script endpoint construction (line 1197)
   *
   * @param safeAddress - Safe multisig address (must be checksummed)
   * @param nonce - Transaction nonce
   * @returns Transaction data from Safe Transaction Service
   * @throws {SafeApiError} if request fails or no transaction found
   */
  async fetchTransaction(
    safeAddress: Address,
    nonce: number
  ): Promise<SafeApiMultisigTransaction> {
    const endpoint = `${this.baseUrl}/api/v2/safes/${safeAddress}/multisig-transactions/?nonce=${nonce}`

    try {
      const response = await fetch(endpoint)

      if (!response.ok) {
        throw new SafeApiError(
          `Safe API request failed: ${response.statusText}`,
          response.status
        )
      }

      const data = (await response.json()) as SafeApiMultisigTransactionResponse

      // Check if any transactions were found
      if (data.count === 0 || data.results.length === 0) {
        throw new SafeApiError(
          `No transaction found for Safe ${safeAddress} at nonce ${nonce}`
        )
      }

      // Warn if multiple transactions found (can happen with transaction replacement)
      if (data.count > 1) {
        console.warn(
          `⚠️  Warning: Multiple transactions (${data.count}) found with nonce ${nonce}. Using the first one.`
        )
        console.warn(
          `   This is normal if you're replacing an existing transaction.`
        )
        console.warn(`   API endpoint: ${endpoint}\n`)
      }

      // Return the first transaction
      return data.results[0]!
    } catch (error) {
      if (error instanceof SafeApiError) {
        throw error
      }

      // Handle network errors
      throw new SafeApiError(
        `Failed to fetch transaction: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error
      )
    }
  }

  /**
   * Fetch all transactions for a Safe
   * Reference: https://docs.safe.global/core-api/transaction-service-reference/mainnet#List-Transactions
   *
   * @param safeAddress - Safe multisig address
   * @param limit - Maximum number of transactions to fetch (default: 20)
   * @returns Transaction list response from Safe Transaction Service
   * @throws {SafeApiError} if request fails
   */
  async fetchTransactions(
    safeAddress: Address,
    limit: number = 20
  ): Promise<SafeApiMultisigTransactionResponse> {
    return retryWithBackoff(async () => {
      const endpoint = `${this.baseUrl}/api/v1/safes/${safeAddress}/multisig-transactions/?limit=${limit}`

      try {
        const response = await fetch(endpoint)

        if (!response.ok) {
          throw new SafeApiError(
            `Safe API request failed: ${response.statusText}`,
            response.status
          )
        }

        const data = (await response.json()) as SafeApiMultisigTransactionResponse
        return data
      } catch (error) {
        if (error instanceof SafeApiError) {
          throw error
        }

        throw new SafeApiError(
          `Failed to fetch transactions: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          error
        )
      }
    }, 3, 1000, this.onRetry)
  }

  /**
   * Fetch a Safe's configuration: nonce, threshold, owners, version.
   *
   * @param safeAddress - Safe multisig address
   * @returns The Safe's current configuration
   * @throws {SafeApiError} if request fails (including after retries)
   */
  async fetchSafeInfo(safeAddress: Address): Promise<SafeApiSafeInfo> {
    return retryWithBackoff(async () => {
      const endpoint = `${this.baseUrl}/api/v1/safes/${safeAddress}/`

      try {
        const response = await fetch(endpoint)

        if (!response.ok) {
          throw new SafeApiError(
            `Failed to fetch Safe info: ${response.statusText}`,
            response.status
          )
        }

        return (await response.json()) as SafeApiSafeInfo
      } catch (error) {
        if (error instanceof SafeApiError) {
          throw error
        }

        throw new SafeApiError(
          `Failed to fetch Safe info: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          error
        )
      }
    }, 3, 1000, this.onRetry)
  }

  /**
   * Fetch Safe contract version
   * Port of bash script lines 1200-1204
   *
   * @param safeAddress - Safe multisig address
   * @returns Safe contract version (e.g., "1.3.0", "1.4.1+L2")
   * @throws {SafeApiError} if request fails (including after retries)
   */
  async fetchSafeVersion(safeAddress: Address): Promise<string> {
    return retryWithBackoff(async () => {
      const endpoint = `${this.baseUrl}/api/v1/safes/${safeAddress}/`

      try {
        const response = await fetch(endpoint)

        if (!response.ok) {
          throw new SafeApiError(
            `Failed to fetch Safe version: ${response.statusText}`,
            response.status
          )
        }

        const data = (await response.json()) as SafeApiSafeInfo
        return data.version || '0.0.0'
      } catch (error) {
        if (error instanceof SafeApiError) {
          throw error
        }

        // Handle network errors
        throw new SafeApiError(
          `Failed to fetch Safe version: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          error
        )
      }
    }, 3, 1000, this.onRetry)
  }

  /**
   * Decode calldata with the service's data decoder:
   * `POST /api/v1/data-decoder/` with `{ "data": ..., "to": ... }`.
   *
   * The answer has the shape of a transaction record's `dataDecoded`,
   * including `valueDecoded` for a MultiSend. Checked against the live
   * service: for an existing transaction it returns that record's
   * `dataDecoded` exactly. For a selector it does not know, the service
   * answers 404 with an empty body, which comes back as `none`. When the
   * target's ABI has a fallback function, it answers 200 with its `fallback`
   * sentinel instead. That comes back as `decoded`, unchanged, so callers
   * handle it with `isApiFallbackSentinel` as they do for a record.
   *
   * The result keeps two outcomes apart that a caller must not merge:
   *
   * - `none`: the service has no decoding to give. Empty calldata (no
   *   request is sent, since the service rejects `0x` with 422), a 404, or
   *   a 2xx answer with an empty or `null` body.
   * - `failed`: the service did not answer usefully. Any other non-2xx
   *   status, rate limiting that outlasts the retries, a network failure, or
   *   a body that is not a decoding. Nothing is known about the call.
   *
   * @param data - Calldata to decode
   * @param to - Call target. The service uses it to pick a contract's ABI.
   */
  async decodeData(data: Hex, to?: Address): Promise<DecodeDataResult> {
    if (!data || data === '0x') return { status: 'none' }

    const endpoint = `${this.baseUrl}/api/v1/data-decoder/`
    try {
      return await retryWithBackoff(async (): Promise<DecodeDataResult> => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(to ? { data, to } : { data }),
        })

        if (response.status === 429) {
          throw new SafeApiError('Safe API rate limit', 429)
        }
        // The service's answer for a selector it has no ABI for.
        if (response.status === 404) return { status: 'none' }
        if (!response.ok) {
          return { status: 'failed', reason: `HTTP ${response.status}` }
        }

        const text = (await response.text()).trim()
        if (text === '' || text === 'null') return { status: 'none' }

        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          return { status: 'failed', reason: 'the answer is not JSON' }
        }
        const decoded = body as Partial<SafeApiDataDecoded> | null
        if (
          !decoded ||
          typeof decoded !== 'object' ||
          typeof decoded.method !== 'string' ||
          !Array.isArray(decoded.parameters)
        ) {
          return { status: 'failed', reason: 'the answer is not a decoding' }
        }
        return { status: 'decoded', decoded: decoded as SafeApiDataDecoded }
      }, 3, 1000, this.onRetry)
    } catch (error) {
      if (error instanceof SafeApiError && error.statusCode === 429) {
        return { status: 'failed', reason: 'rate limited' }
      }
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Look up a multisig transaction by its safeTxHash:
   * `GET /api/v2/multisig-transactions/{safeTxHash}/`.
   *
   * @returns The transaction, or null when the service has no transaction with
   *   this hash (404)
   * @throws {SafeApiError} on any other failure, including after retries
   */
  async fetchTransactionByHash(safeTxHash: Hex): Promise<SafeApiMultisigTransaction | null> {
    return retryWithBackoff(async () => {
      const endpoint = `${this.baseUrl}/api/v2/multisig-transactions/${safeTxHash}/`

      try {
        const response = await fetch(endpoint)

        if (response.status === 404) return null
        if (!response.ok) {
          throw new SafeApiError(
            `Safe API request failed: ${response.statusText}`,
            response.status
          )
        }

        return (await response.json()) as SafeApiMultisigTransaction
      } catch (error) {
        if (error instanceof SafeApiError) {
          throw error
        }

        throw new SafeApiError(
          `Failed to fetch transaction: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          error
        )
      }
    }, 3, 1000, this.onRetry)
  }

  /**
   * Fetch the Safe's queue: transactions not executed, at or above
   * `fromNonce` (the on-chain nonce), highest nonce first.
   *
   * The same filter is applied to the answer, so a service that ignores a
   * query parameter cannot put an executed or replaced transaction in the
   * queue. Reads up to five pages of 100.
   *
   * @throws {SafeApiError} if a request fails (including after retries)
   */
  async fetchQueuedTransactions(
    safeAddress: Address,
    fromNonce: number
  ): Promise<SafeApiMultisigTransaction[]> {
    const PAGE = 100
    const MAX_PAGES = 5
    const queued: SafeApiMultisigTransaction[] = []

    for (let page = 0; page < MAX_PAGES; page++) {
      const endpoint =
        `${this.baseUrl}/api/v1/safes/${safeAddress}/multisig-transactions/` +
        `?executed=false&nonce__gte=${fromNonce}&ordering=-nonce&limit=${PAGE}&offset=${page * PAGE}`

      const data = await retryWithBackoff(async () => {
        try {
          const response = await fetch(endpoint)
          if (!response.ok) {
            throw new SafeApiError(
              `Failed to fetch queued transactions: ${response.statusText}`,
              response.status
            )
          }
          return (await response.json()) as SafeApiMultisigTransactionResponse
        } catch (error) {
          if (error instanceof SafeApiError) {
            throw error
          }
          throw new SafeApiError(
            `Failed to fetch queued transactions: ${error instanceof Error ? error.message : String(error)}`,
            undefined,
            error
          )
        }
      }, 3, 1000, this.onRetry)

      for (const tx of data.results) {
        if (!tx.isExecuted && Number(tx.nonce) >= fromNonce) queued.push(tx)
      }
      if (data.results.length < PAGE || !data.next) break
    }

    return queued
  }

  /**
   * Get the network name for this client
   */
  getNetworkName(): string {
    return this.networkName
  }

  /**
   * Get the chain ID for this client
   */
  getChainId(): number {
    return this.chainId
  }
}

/**
 * Create a Safe API client for a specific network
 */
export function createSafeApiClient(network: string = 'ethereum'): SafeApiClient {
  return new SafeApiClient(network)
}
