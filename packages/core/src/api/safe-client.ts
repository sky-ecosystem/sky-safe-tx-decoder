/**
 * Safe API client.
 *
 * - Transactions come from the Safe Queue Service, one service for every
 *   chain.
 * - Safe info comes from the Safe Transaction Service for the network.
 * - Decodings come from the Safe Decoder Service.
 *
 * Every transaction read is checked against the request before it is
 * returned. Read-only: this client does not propose, sign or delete.
 *
 * @see https://docs.safe.global/core-api/safe-queue-service-reference
 * @see https://docs.safe.global/core-api/transaction-service-reference
 */

import { getAddress, isAddress, type Address, type Hex } from 'viem'
import type {
  SafeApiDataDecoded,
  SafeApiMultisigTransactionResponse,
  SafeApiMultisigTransaction,
  SafeApiSafeInfo,
  SafeQueueMultisigTransaction,
} from '../types.js'
import { SafeApiError } from './errors.js'
import { DECODER_SERVICE_URL, getNetwork, QUEUE_SERVICE_URL } from './networks.js'
import { adaptQueueTransaction, assertTransactionMatches } from './queue-service.js'

export { SafeApiError }

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

/** Returned by `getJson` for a 404 when the caller allows one. */
const NOT_FOUND = Symbol('not found')

/** Page size for Safe Queue Service lists. The service accepts at most 100. */
const PAGE_SIZE = 100

/** Pages of the queue read at most. */
const QUEUE_MAX_PAGES = 5

/** Pages of a Safe's transaction list read at most, for a lookup by nonce. */
const NONCE_SEARCH_MAX_PAGES = 20

/** The status, and the service's `detail` when it sends a string one. */
async function describeFailure(response: Response): Promise<string> {
  const status = response.statusText || `HTTP ${response.status}`
  try {
    const body = (await response.json()) as { detail?: unknown } | null
    if (body && typeof body.detail === 'string') return `${status}: ${body.detail}`
  } catch {
    // The body is not JSON. The status alone describes the failure.
  }
  return status
}

/**
 * The Safe's current nonce from its Safe info, as a number.
 *
 * @throws {SafeApiError} when the service reports a nonce that is not a
 *   non-negative safe integer
 */
export function currentNonceOf(info: SafeApiSafeInfo): number {
  const nonce = Number(info.nonce)
  if (!/^[0-9]+$/.test(String(info.nonce)) || !Number.isSafeInteger(nonce)) {
    throw new SafeApiError(`The Safe Transaction Service reported nonce ${String(info.nonce)}, which is not a valid nonce.`)
  }
  return nonce
}

/**
 * Safe API client for one network.
 */
export class SafeApiClient {
  private readonly baseUrl: string
  private readonly queueUrl: string = QUEUE_SERVICE_URL
  private readonly decoderUrl: string = DECODER_SERVICE_URL
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
   * GET a JSON body, retrying while rate limited.
   *
   * @returns the body, or `NOT_FOUND` for a 404 when `allowNotFound` is set
   * @throws {SafeApiError} on any other non-2xx status, a network failure, or
   *   a body that is not JSON
   */
  private async getJson(
    endpoint: string,
    failure: string,
    allowNotFound = false
  ): Promise<unknown | typeof NOT_FOUND> {
    return retryWithBackoff(async () => {
      let response: Response
      try {
        response = await fetch(endpoint)
      } catch (error) {
        throw new SafeApiError(
          `${failure}: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          error
        )
      }
      if (allowNotFound && response.status === 404) return NOT_FOUND
      if (!response.ok) {
        throw new SafeApiError(`${failure}: ${await describeFailure(response)}`, response.status)
      }
      try {
        return (await response.json()) as unknown
      } catch (error) {
        throw new SafeApiError(`${failure}: the answer is not JSON`, response.status, error)
      }
    }, 3, 1000, this.onRetry)
  }

  /**
   * Read a Safe Queue Service list page. Every record must be for this Safe
   * and this chain.
   *
   * @throws {SafeApiError} when the body is not a page or a record does not match
   */
  private readPage(
    body: unknown,
    safeAddress: Address
  ): { count: number; next: unknown; results: SafeQueueMultisigTransaction[] } {
    const page = body as { count?: unknown; results?: unknown; next?: unknown } | null
    if (!page || typeof page !== 'object' || !Array.isArray(page.results)) {
      throw new SafeApiError('The Safe Queue Service returned a list without a results array.')
    }
    for (const record of page.results) {
      assertTransactionMatches(record, { safe: safeAddress, chainId: this.chainId }, 'Safe Queue Service')
    }
    return {
      count: typeof page.count === 'number' ? page.count : page.results.length,
      next: page.next,
      results: page.results as SafeQueueMultisigTransaction[],
    }
  }

  /**
   * One page of a Safe's transactions from the Safe Queue Service, highest
   * nonce first: `GET /api/v1/safes/{safe}/multisig-transactions?chainId={chainId}&nonceOrder=desc`.
   */
  private async fetchSafeTransactionsPage(safeAddress: Address, limit: number, offset: number) {
    const endpoint =
      `${this.queueUrl}/api/v1/safes/${safeAddress}/multisig-transactions` +
      `?chainId=${this.chainId}&nonceOrder=desc&limit=${limit}&offset=${offset}`
    const body = await this.getJson(endpoint, 'Failed to fetch transactions from the Safe Queue Service')
    return this.readPage(body, safeAddress)
  }

  /**
   * Read the Safe's pending transactions from the Safe Queue Service:
   * `GET /api/v1/multisig-transactions/queue?safes={safe}:{chainId}`.
   *
   * Reads pages of 100 by offset while the service reports a next page, up to
   * five pages. The answer is not trusted to be filtered: callers filter it
   * again.
   *
   * @throws {SafeApiError} when a request fails, a record does not match, or
   *   the queue is longer than five pages. A partial queue is not returned.
   */
  private async fetchQueueRecords(safeAddress: Address): Promise<SafeQueueMultisigTransaction[]> {
    const records = new Map<string, SafeQueueMultisigTransaction>()
    let offset = 0

    for (let page = 0; page < QUEUE_MAX_PAGES; page++) {
      const endpoint =
        `${this.queueUrl}/api/v1/multisig-transactions/queue` +
        `?safes=${safeAddress}:${this.chainId}&nonceOrder=desc&limit=${PAGE_SIZE}&offset=${offset}`
      const body = await this.getJson(endpoint, 'Failed to fetch the queue from the Safe Queue Service')
      const { results, next } = this.readPage(body, safeAddress)
      for (const record of results) records.set(String(record.safeTxHash).toLowerCase(), record)

      if (next === null || next === undefined || results.length === 0) return [...records.values()]
      offset += results.length
    }

    throw new SafeApiError(
      `The Safe Queue Service reports more than ${PAGE_SIZE * QUEUE_MAX_PAGES} pending transactions for Safe ${safeAddress}. ` +
        `This tool reads at most ${PAGE_SIZE * QUEUE_MAX_PAGES} and does not show a partial queue.`
    )
  }

  /**
   * Convert Safe Queue Service records to the Safe Transaction Service shape.
   *
   * With `decode`, each record's calldata goes to the Safe Decoder Service,
   * one request at a time, once per distinct target and calldata. A decoder
   * that does not answer leaves `dataDecoded` null and sets
   * `dataDecodedUnavailable`. It is not reported as "no decoding".
   */
  private async adaptQueueRecords(
    records: SafeQueueMultisigTransaction[],
    threshold: number,
    decode: boolean
  ): Promise<SafeApiMultisigTransaction[]> {
    const decodings = new Map<string, DecodeDataResult>()
    const adapted: SafeApiMultisigTransaction[] = []
    for (const record of records) {
      let decoding: DecodeDataResult | null = null
      if (decode) {
        const data = (record.data ?? '0x') as Hex
        const to = record.to && isAddress(record.to, { strict: false }) ? getAddress(record.to.toLowerCase()) : undefined
        const key = `${to ?? ''}:${data.toLowerCase()}`
        decoding = decodings.get(key) ?? (await this.decodeData(data, to))
        decodings.set(key, decoding)
      }
      adapted.push(adaptQueueTransaction(record, { confirmationsRequired: threshold, decoding }))
    }
    return adapted
  }

  /**
   * Fetch every transaction at a nonce. There can be more than one, for
   * example a transaction and its replacement.
   *
   * The Safe Queue Service does not filter a Safe's list by nonce. This reads
   * `GET /api/v1/safes/{safe}/multisig-transactions?chainId={chainId}&nonceOrder=desc`
   * in pages of 100, keeps the records at this nonce, and stops at the first
   * page that goes below it. The early stop depends on the order, so a list
   * that is not in descending nonce order is an error. At most 20 pages are
   * read.
   *
   * Every record must be for this Safe and chain. Each record kept is decoded
   * and takes the Safe's current threshold as `confirmationsRequired`.
   *
   * @param safeAddress - Safe multisig address (must be checksummed)
   * @param nonce - Transaction nonce
   * @param safeInfo - The Safe's info, when the caller already has it. Read
   *   from the Safe Transaction Service otherwise.
   * @returns Array of transactions with this nonce
   * @throws {SafeApiError} if a request fails, a record does not match the
   *   request, the list is out of order, the nonce is past the page limit, or
   *   no transaction is found
   */
  async fetchTransactionsByNonce(
    safeAddress: Address,
    nonce: number,
    safeInfo?: SafeApiSafeInfo
  ): Promise<SafeApiMultisigTransaction[]> {
    const info = safeInfo ?? (await this.fetchSafeInfo(safeAddress))
    const matches = new Map<string, SafeQueueMultisigTransaction>()
    let offset = 0
    let previous: bigint | null = null
    let reachedEnd = false

    for (let page = 0; page < NONCE_SEARCH_MAX_PAGES && !reachedEnd; page++) {
      const { results, next } = await this.fetchSafeTransactionsPage(safeAddress, PAGE_SIZE, offset)

      for (const record of results) {
        const text = String(record.nonce)
        if (!/^[0-9]+$/.test(text)) {
          throw new SafeApiError(
            `The Safe Queue Service returned ${JSON.stringify(record.nonce)} as the nonce of transaction ${String(record.safeTxHash)}. It is not a decimal integer.`
          )
        }
        const value = BigInt(text)
        if (previous !== null && value > previous) {
          throw new SafeApiError(
            `The Safe Queue Service returned the transactions of Safe ${safeAddress} out of nonce order: nonce ${text} after nonce ${previous}.`
          )
        }
        previous = value
        if (value === BigInt(nonce)) matches.set(String(record.safeTxHash).toLowerCase(), record)
      }

      const belowTarget = previous !== null && previous < BigInt(nonce)
      reachedEnd = belowTarget || next === null || next === undefined || results.length === 0
      offset += results.length
    }

    if (!reachedEnd) {
      throw new SafeApiError(
        `Nonce ${nonce} of Safe ${safeAddress} is beyond the ${PAGE_SIZE * NONCE_SEARCH_MAX_PAGES} most recent transactions. This tool does not read further.`
      )
    }
    if (matches.size === 0) {
      throw new SafeApiError(`No transaction found for Safe ${safeAddress} at nonce ${nonce}`)
    }

    const adapted = await this.adaptQueueRecords([...matches.values()], info.threshold, true)
    for (const tx of adapted) {
      assertTransactionMatches(tx, { safe: safeAddress, nonce }, 'Safe Queue Service')
    }
    return adapted
  }

  /**
   * Fetch one Safe multisig transaction by nonce. Reads as
   * `fetchTransactionsByNonce` does and returns the first transaction.
   *
   * @param safeAddress - Safe multisig address (must be checksummed)
   * @param nonce - Transaction nonce
   * @returns The first transaction at this nonce
   * @throws {SafeApiError} if request fails or no transaction found
   */
  async fetchTransaction(
    safeAddress: Address,
    nonce: number
  ): Promise<SafeApiMultisigTransaction> {
    const transactions = await this.fetchTransactionsByNonce(safeAddress, nonce)

    // Warn if multiple transactions found (can happen with transaction replacement)
    if (transactions.length > 1) {
      console.warn(
        `⚠️  Warning: Multiple transactions (${transactions.length}) found with nonce ${nonce}. Using the first one.`
      )
      console.warn(`   This is normal if you're replacing an existing transaction.\n`)
    }

    return transactions[0]!
  }

  /**
   * Fetch a Safe's most recent transactions from the Safe Queue Service,
   * executed or not, highest nonce first. One page. Every record must be for
   * this Safe and chain. Each record takes the Safe's current threshold as
   * `confirmationsRequired`.
   *
   * @param safeAddress - Safe multisig address
   * @param limit - Number of transactions to fetch, 1 to 100 (default: 20)
   * @param safeInfo - The Safe's info, when the caller already has it. Read
   *   from the Safe Transaction Service otherwise.
   * @param options.decode - Ask the Safe Decoder Service for each record's
   *   decoding. Default true. Without it, `dataDecoded` is null and
   *   `dataDecodedUnavailable` says that no decoding was requested.
   * @returns The page, with records in the Safe Transaction Service shape
   * @throws {SafeApiError} if a request fails or a record does not match
   */
  async fetchTransactions(
    safeAddress: Address,
    limit: number = 20,
    safeInfo?: SafeApiSafeInfo,
    options: { decode?: boolean } = {}
  ): Promise<SafeApiMultisigTransactionResponse> {
    const info = safeInfo ?? (await this.fetchSafeInfo(safeAddress))
    const { count, next, results } = await this.fetchSafeTransactionsPage(safeAddress, limit, 0)
    return {
      count,
      next: typeof next === 'string' ? next : null,
      previous: null,
      results: await this.adaptQueueRecords(results, info.threshold, options.decode ?? true),
    }
  }

  /**
   * Fetch a Safe's configuration from the Safe Transaction Service: nonce,
   * threshold, owners, version.
   *
   * @param safeAddress - Safe multisig address
   * @returns The Safe's current configuration
   * @throws {SafeApiError} if request fails (including after retries), or the
   *   answer names another Safe
   */
  async fetchSafeInfo(safeAddress: Address): Promise<SafeApiSafeInfo> {
    const endpoint = `${this.baseUrl}/api/v1/safes/${safeAddress}/`
    const info = (await this.getJson(endpoint, 'Failed to fetch Safe info')) as SafeApiSafeInfo
    if (!info || typeof info !== 'object') {
      throw new SafeApiError('The Safe Transaction Service returned Safe info that is not an object.')
    }
    if (typeof info.address === 'string' && info.address.toLowerCase() !== safeAddress.toLowerCase()) {
      throw new SafeApiError(
        `The Safe Transaction Service returned Safe info for ${info.address}. The request was for Safe ${safeAddress}.`
      )
    }
    return info
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
   * Decode calldata with the Safe Decoder Service:
   * `POST https://api.safe.global/decoder/api/v1/data-decoder` with
   * `{ "data": ..., "to": ..., "chainId": ... }`.
   *
   * The service requires `to` when `chainId` is sent, so a call without a
   * target sends `{ "data": ... }` only. It rejects a `to` that is not
   * checksummed, so `to` is checksummed here.
   *
   * The answer has the shape of a transaction record's `dataDecoded`,
   * including `valueDecoded` for a MultiSend, plus an `accuracy` field. For a
   * selector it does not know, the service answers 404, which comes back as
   * `none`. When the target's ABI has a fallback function, a decoder can
   * answer with its `fallback` sentinel. That comes back as `decoded`,
   * unchanged, so callers handle it with `isApiFallbackSentinel`.
   *
   * The result keeps two outcomes apart that a caller must not merge:
   *
   * - `none`: the service has no decoding to give. Empty calldata (no
   *   request is sent), a 404, or a 2xx answer with an empty or `null` body.
   * - `failed`: the service did not answer usefully. Any other non-2xx
   *   status, rate limiting that outlasts the retries, a network failure, or
   *   a body that is not a decoding. Nothing is known about the call.
   *
   * @param data - Calldata to decode
   * @param to - Call target. The service uses it to pick a contract's ABI.
   * @param signal - Aborts the request. An aborted call comes back as `failed`.
   */
  async decodeData(data: Hex, to?: Address, signal?: AbortSignal): Promise<DecodeDataResult> {
    if (!data || data === '0x') return { status: 'none' }

    const target = to && isAddress(to, { strict: false }) ? getAddress(to.toLowerCase()) : undefined
    const endpoint = `${this.decoderUrl}/api/v1/data-decoder`
    try {
      return await retryWithBackoff(async (): Promise<DecodeDataResult> => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(target ? { data, to: target, chainId: this.chainId } : { data }),
          signal,
        })

        if (response.status === 429) {
          throw new SafeApiError('Safe API rate limit', 429)
        }
        // The answer for a selector the service has no ABI for, and for empty calldata.
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
   * Look up a multisig transaction by its safeTxHash in the Safe Queue
   * Service: `GET /api/v1/multisig-transactions/{safeTxHash}`.
   *
   * The record must have this safeTxHash and this chain. With `safeAddress`,
   * it must also be for that Safe. It is decoded and takes the Safe's current
   * threshold as `confirmationsRequired`.
   *
   * @returns The transaction, or null when the service answers 404
   * @throws {SafeApiError} on any other failure, including after retries, and
   *   on a record that does not match
   */
  async fetchTransactionByHash(
    safeTxHash: Hex,
    safeAddress?: Address
  ): Promise<SafeApiMultisigTransaction | null> {
    const found = await this.getJson(
      `${this.queueUrl}/api/v1/multisig-transactions/${safeTxHash}`,
      'Failed to fetch the transaction from the Safe Queue Service',
      true
    )
    if (found === NOT_FOUND) return null

    assertTransactionMatches(
      found,
      { safeTxHash, chainId: this.chainId, ...(safeAddress ? { safe: safeAddress } : {}) },
      'Safe Queue Service'
    )
    const record = found as SafeQueueMultisigTransaction
    if (!isAddress(record.safe, { strict: false })) {
      throw new SafeApiError(
        `The Safe Queue Service returned ${JSON.stringify(record.safe)} as the Safe of transaction ${safeTxHash}. It is not an address.`
      )
    }
    const info = await this.fetchSafeInfo(getAddress(record.safe.toLowerCase()))
    const [tx] = await this.adaptQueueRecords([record], info.threshold, true)
    return tx!
  }

  /**
   * Fetch the Safe's queue from the Safe Queue Service: transactions not
   * executed, at or above `fromNonce` (the on-chain nonce), highest nonce
   * first.
   *
   * The same filter is applied to the answer, so a service that ignores a
   * query parameter cannot put an executed or replaced transaction in the
   * queue. An empty array means the service returned zero pending
   * transactions. A failed read throws and never returns an empty array.
   *
   * @param safeAddress - Safe multisig address
   * @param fromNonce - The Safe's current nonce
   * @param options.safeInfo - The Safe's info, for the threshold. Read from
   *   the Safe Transaction Service when absent.
   * @param options.decode - Ask the Safe Decoder Service for each
   *   transaction's decoding. Default true. Without it, `dataDecoded` is null
   *   and `dataDecodedUnavailable` says that no decoding was requested.
   * @throws {SafeApiError} if a request fails (including after retries), or a
   *   record does not match the request
   */
  async fetchQueuedTransactions(
    safeAddress: Address,
    fromNonce: number,
    options: { safeInfo?: SafeApiSafeInfo; decode?: boolean } = {}
  ): Promise<SafeApiMultisigTransaction[]> {
    const info = options.safeInfo ?? (await this.fetchSafeInfo(safeAddress))
    const records = (await this.fetchQueueRecords(safeAddress)).filter(
      (record) =>
        (record.txHash === null || record.txHash === undefined) &&
        // A nonce that is not a decimal string is kept, so the adapter rejects it.
        (!/^[0-9]+$/.test(String(record.nonce)) || BigInt(record.nonce) >= BigInt(fromNonce))
    )
    const adapted = await this.adaptQueueRecords(records, info.threshold, options.decode ?? true)
    return adapted
      .filter((tx) => !tx.isExecuted && tx.nonce >= fromNonce)
      .sort((a, b) => b.nonce - a.nonce)
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
