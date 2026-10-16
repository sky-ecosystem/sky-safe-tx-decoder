/**
 * Development-only mock of the Safe Transaction Service.
 *
 * ## Why this exists
 *
 * A decoder can only be reviewed against a transaction the app can load, and
 * the app loads transactions from the Safe Transaction Service by Safe address
 * and nonce. A contract that has never been called from a Safe therefore has no
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
 * Fixtures carry a zero `safeTxHash`. The app recomputes the hash from the
 * transaction fields and will report a mismatch, which is the correct outcome
 * for fabricated data. Nothing here fakes a passing verification.
 */

import type { SafeApiMultisigTransaction } from '@shield3/sky-safe-core'

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

function transactionsFor(nonce: number): SafeApiMultisigTransaction[] {
  const fixture = BY_NONCE.get(nonce)
  return fixture ? [fixture.transaction as unknown as SafeApiMultisigTransaction] : []
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

function allTransactions(): SafeApiMultisigTransaction[] {
  return [...BY_NONCE.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, fixture]) => fixture.transaction as unknown as SafeApiMultisigTransaction)
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

    // POST /api/v1/data-decoder/ for proposer mode. The request names no Safe,
    // so it is answered only while a sentinel Safe page is on screen, and only
    // for a fixture's own calldata. The answer is that fixture's dataDecoded,
    // so a fixture checked in proposer mode decodes as it does on its
    // transaction page. A fixture without one gets a 200 with a null body,
    // which the client reads as no decoding, the same as the null the fixture
    // carries. Any other calldata goes to the real service.
    //
    // While window.__safeApiMockDecoderFailure is set, every such request on a
    // sentinel Safe page fails with that status instead.
    if (/\/api\/v1\/data-decoder\/$/.test(url) && onSentinelRoute()) {
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

    // /api/v1/safes/{address}/  — Safe info, used for the version
    if (/\/safes\/[^/]+\/$/.test(url)) return json(safeInfo())

    // /api/v*/safes/{address}/multisig-transactions/?nonce=N
    const nonceMatch = url.match(/[?&]nonce=(\d+)/)
    if (nonceMatch) {
      const results = transactionsFor(Number(nonceMatch[1]))
      return json({ count: results.length, next: null, previous: null, results })
    }

    // /api/v1/safes/{address}/multisig-transactions/?limit=N  — the list view
    // Also the queue proposer mode reads. Its filters are not applied here.
    // The client applies them itself.
    if (url.includes('multisig-transactions')) {
      const results = allTransactions()
      return json({ count: results.length, next: null, previous: null, results })
    }

    return realFetch(input as RequestInfo, init)
  }

  window.__safeApiMockAddress = MOCK_SAFE_ADDRESS

  console.warn(
    `[${MOCK_MARKER}] Safe API mock installed for ${MOCK_SAFE_ADDRESS}. ` +
      `Transactions for that address are fabricated. Every other address is untouched.`
  )
}
