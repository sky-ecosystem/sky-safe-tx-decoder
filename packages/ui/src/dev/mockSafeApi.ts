/**
 * Development-only mock of the Safe Queue Service, the Safe Info route of the
 * Safe Transaction Service, and the Safe Decoder Service.
 *
 * ## Why this exists
 *
 * A decoder can only be reviewed against a transaction the app can load, and
 * the app loads transactions from the Safe Queue Service by Safe address and
 * nonce. A contract that has never been called from a Safe therefore has no
 * transaction to inspect, and its decoder cannot be seen rendered at all.
 *
 * This module serves fabricated transactions for one sentinel Safe address so
 * that decoder output can be reviewed before any real transaction exists.
 *
 * ## Why it cannot reach production
 *
 * This is a signing tool. Fabricated transaction data rendered as though it
 * were real would be a serious failure, so the guarantee here is structural
 * rather than a runtime flag:
 *
 * - Nothing imports this module statically. `installMockSafeApi` is reached
 *   only through a dynamic `import()` inside an `import.meta.env.DEV` branch in
 *   `main.tsx`. Vite replaces that expression with `false` in a production
 *   build, the branch is eliminated, and this module is never pulled into the
 *   graph. It produces no chunk.
 * - `installMockSafeApi` additionally refuses to run unless
 *   `import.meta.env.DEV` is true, so importing it by hand still does nothing.
 * - Interception is scoped to one sentinel Safe address. Every other address,
 *   including every real Safe, passes through to the network untouched.
 * - The data decoder request names no Safe. It is answered only while a
 *   sentinel Safe page is on screen, and only for a fixture's own calldata.
 *
 * `MOCK_MARKER` below is a unique string used to assert the above: a production
 * bundle must not contain it.
 *
 * ## Honest hashes
 *
 * Fixtures carry a placeholder `safeTxHash`. The app recomputes the hash from
 * the transaction fields and will report a mismatch, which is the correct
 * outcome for fabricated data. Nothing here fakes a passing verification.
 */

/** Unique to this module. A production bundle must not contain it. */
export const MOCK_MARKER = 'SAFE_API_MOCK_FIXTURE_9f3a2c'

/**
 * Sentinel Safe address the mock answers for.
 *
 * Not a real Safe. Chosen so it cannot collide with a deployed one, and so it
 * is recognisable on sight in a URL.
 */
export const MOCK_SAFE_ADDRESS = '0xfeEDfaCeFeEdFaceFEedFACefEEDFaCEfEeDfAce'

/** Global the UI reads to decide whether to show the simulated-data banner. */
declare global {
  interface Window {
    __safeApiMockAddress?: string
    /**
     * Set to 500 or 429 in the browser console to make the data decoder fail
     * on the sentinel Safe's pages, to review the "decoder did not answer"
     * state. Delete it, or set it to undefined, to answer again.
     */
    __safeApiMockDecoderFailure?: number
  }
}

interface Fixture {
  description: string
  version: string
  transaction: Record<string, unknown>
}

/**
 * Fixtures, eagerly imported so a lookup is synchronous.
 *
 * `import.meta.glob` is a Vite primitive, so these are only bundled when this
 * module is, which in a production build is never.
 */
const FIXTURE_MODULES = import.meta.glob<Fixture>('./fixtures/*.json', {
  eager: true,
  import: 'default',
})

/** Fixtures keyed by the nonce declared inside each file. */
const BY_NONCE = new Map<number, Fixture>()

for (const fixture of Object.values(FIXTURE_MODULES)) {
  const nonce = Number(fixture.transaction.nonce)
  if (Number.isFinite(nonce)) BY_NONCE.set(nonce, fixture)
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * The sentinel Safe's on-chain nonce.
 *
 * Every fixture is served as not executed. With this nonce, fixtures 0 to 12
 * count as used and 13 and 14 as queued, so proposer mode recommends 15 and
 * can show both nonce warnings.
 */
const MOCK_ONCHAIN_NONCE = 13

/** The Safe info shape the client expects: version, and nonce for proposer mode. */
function safeInfo() {
  return {
    address: MOCK_SAFE_ADDRESS,
    nonce: MOCK_ONCHAIN_NONCE,
    threshold: 2,
    owners: [],
    masterCopy: '0x0000000000000000000000000000000000000000',
    modules: [],
    fallbackHandler: '0x0000000000000000000000000000000000000000',
    guard: '0x0000000000000000000000000000000000000000',
    version: '1.3.0',
  }
}

/** Whether the page on screen is one of the sentinel Safe's pages. */
function onSentinelRoute(): boolean {
  return window.location.hash.toLowerCase().includes(MOCK_SAFE_ADDRESS.toLowerCase())
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  if (typeof init?.body === 'string') return init.body
  if (input instanceof Request) return input.clone().text()
  return null
}

/** The fixture whose top-level call has this target and calldata, if any. */
function fixtureForCall(body: string | null): Fixture | undefined {
  if (!body) return undefined
  let call: { to?: unknown; data?: unknown }
  try {
    call = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof call.to !== 'string' || typeof call.data !== 'string') return undefined
  const to = call.to.toLowerCase()
  const data = call.data.toLowerCase()
  for (const fixture of BY_NONCE.values()) {
    const tx = fixture.transaction
    if (String(tx.to).toLowerCase() === to && String(tx.data).toLowerCase() === data) return fixture
  }
  return undefined
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** An address in the Safe Queue Service form: lowercase, and null for zero. */
function queueAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.toLowerCase() === ZERO_ADDRESS) return null
  return value.toLowerCase()
}

/**
 * A fixture in the Safe Queue Service record shape, as the real service
 * returns it. The client converts it, so the pages read fixtures through the
 * same adapter as a real Safe. The record does not carry a decoding: the
 * client asks the Safe Decoder Service, which this mock answers for fixture
 * calldata.
 */
function toQueueRecord(tx: Record<string, unknown>, chainId: string) {
  const delegate = queueAddress(tx.proposedByDelegate)
  // The client keeps one record per safeTxHash, and several fixtures share
  // the zero placeholder. A zero placeholder becomes the nonce, padded to 32
  // bytes, which is unique per fixture and still not the real hash.
  const placeholder = /^0x0{64}$/.test(String(tx.safeTxHash))
  return {
    safeTxHash: placeholder ? `0x${Number(tx.nonce).toString(16).padStart(64, '0')}` : tx.safeTxHash,
    chainId,
    safe: String(tx.safe).toLowerCase(),
    nonce: String(tx.nonce),
    proposer: queueAddress(tx.proposer),
    proposedVia: delegate ? 'DELEGATE' : tx.proposer ? 'OWNER' : 'UNKNOWN',
    proposedBy: delegate,
    to: queueAddress(tx.to),
    value: String(tx.value),
    data: tx.data ?? null,
    operation: tx.operation,
    safeTxGas: String(tx.safeTxGas),
    baseGas: String(tx.baseGas),
    gasPrice: String(tx.gasPrice),
    gasToken: queueAddress(tx.gasToken),
    refundReceiver: queueAddress(tx.refundReceiver),
    failed: null,
    notes: null,
    originName: null,
    originUrl: null,
    txHash: null,
    executor: null,
    // A fixture without a submission date keeps none. The timeline then
    // shows the time as pending, not an invented date.
    created: tx.submissionDate ?? '',
    modified: tx.modified ?? tx.submissionDate ?? '',
    confirmations: Array.isArray(tx.confirmations)
      ? tx.confirmations.map((c: Record<string, unknown>) => ({
          owner: String(c.owner).toLowerCase(),
          signature: c.signature,
          signatureType: c.signatureType,
          created: c.submissionDate,
          modified: c.submissionDate,
        }))
      : [],
  }
}

/**
 * GET /queue/api/v1/multisig-transactions/queue for the sentinel Safe: the
 * fixtures at or above the mock on-chain nonce, in the Safe Queue Service
 * shape, with its `nonceOrder`, `limit` and `offset`.
 */
function queueAnswer(url: string): Response {
  const params = new URL(url).searchParams
  const chainId = (params.get('safes') ?? '').split(':')[1] ?? '1'
  const order = params.get('nonceOrder') === 'desc' ? -1 : 1
  const limit = Number(params.get('limit') ?? 50)
  const offset = Number(params.get('offset') ?? 0)
  const all = [...BY_NONCE.entries()]
    .filter(([nonce]) => nonce >= MOCK_ONCHAIN_NONCE)
    .sort(([a], [b]) => order * (a - b))
    .map(([, fixture]) => toQueueRecord(fixture.transaction, chainId))
  const results = all.slice(offset, offset + limit)
  const more = offset + limit < all.length
  return json({ count: all.length, next: more ? 'next' : null, previous: offset > 0 ? 'previous' : null, results })
}

/**
 * GET /queue/api/v1/safes/{address}/multisig-transactions for the sentinel
 * Safe: every fixture, in the Safe Queue Service shape, with its `chainId`,
 * `nonceOrder`, `limit` and `offset`. The Safe page list and the lookup by
 * nonce read this route.
 */
function listAnswer(url: string): Response {
  const params = new URL(url).searchParams
  const chainId = params.get('chainId') ?? '1'
  const order = params.get('nonceOrder') === 'asc' ? 1 : -1
  const limit = Number(params.get('limit') ?? 50)
  const offset = Number(params.get('offset') ?? 0)
  const all = [...BY_NONCE.entries()]
    .sort(([a], [b]) => order * (a - b))
    .map(([, fixture]) => toQueueRecord(fixture.transaction, chainId))
  const results = all.slice(offset, offset + limit)
  const more = offset + limit < all.length
  return json({ count: all.length, next: more ? 'next' : null, previous: offset > 0 ? 'previous' : null, results })
}

/**
 * Install the interceptor. No-op outside a development build.
 *
 * Wraps `window.fetch` and answers only for URLs naming the sentinel Safe.
 * Anything else is delegated to the original `fetch` unchanged, so a real Safe
 * still reaches the real service even while this is installed.
 */
export function installMockSafeApi(): void {
  if (!import.meta.env.DEV) return
  if (window.__safeApiMockAddress) return

  const realFetch = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

    // POST /decoder/api/v1/data-decoder, the Safe Decoder Service. The request
    // names no Safe, so it is answered only while a sentinel Safe page is on
    // screen, and only for a fixture's own calldata. The answer is that
    // fixture's dataDecoded, so a fixture decodes the same on its transaction
    // page and in proposer mode. A fixture without one gets a 200 with a null
    // body, which the client reads as no decoding. Any other calldata goes to
    // the real service.
    //
    // While window.__safeApiMockDecoderFailure is set, every such request on a
    // sentinel Safe page fails with that status instead.
    if (/\/decoder\/api\/v1\/data-decoder$/.test(url) && onSentinelRoute()) {
      const failure = window.__safeApiMockDecoderFailure
      if (failure !== undefined) {
        return new Response(JSON.stringify({ detail: `Simulated data decoder failure ${failure}` }), {
          status: failure,
          headers: { 'content-type': 'application/json' },
        })
      }
      const fixture = fixtureForCall(await requestBody(input, init))
      if (fixture) {
        const decoded = fixture.transaction.dataDecoded
        return decoded ? json(decoded) : json(null)
      }
    }

    if (!url.toLowerCase().includes(MOCK_SAFE_ADDRESS.toLowerCase())) {
      return realFetch(input as RequestInfo, init)
    }

    // Safe Queue Service: the queue, which proposer mode reads.
    if (/\/queue\/api\/v1\/multisig-transactions\/queue\?/.test(url)) return queueAnswer(url)

    // Safe Queue Service: the Safe's transaction list, which the Safe page and
    // the lookup by nonce read.
    if (/\/queue\/api\/v1\/safes\/[^/]+\/multisig-transactions\?/.test(url)) return listAnswer(url)

    // Safe Transaction Service: /api/v1/safes/{address}/, the Safe info.
    if (/\/tx-service\/[^/]+\/api\/v1\/safes\/[^/]+\/$/.test(url)) return json(safeInfo())

    return realFetch(input as RequestInfo, init)
  }

  window.__safeApiMockAddress = MOCK_SAFE_ADDRESS

  console.warn(
    `[${MOCK_MARKER}] Safe API mock installed for ${MOCK_SAFE_ADDRESS}. ` +
      `Transactions for that address are fabricated. Every other address is untouched.`
  )
}
