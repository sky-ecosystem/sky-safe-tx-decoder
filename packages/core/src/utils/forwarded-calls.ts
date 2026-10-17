/**
 * Find calls that a decoded call forwards to another contract, and that the
 * decoding therefore does not describe.
 *
 * A Safe API or Sourcify decoding of a forwarder decodes one layer only. A
 * signature such as `call(address target, bytes data)` decodes to an address
 * and a byte string, and the re-encode check passes, because that IS a correct
 * decoding of the outer call. What actually executes is inside `data`, and
 * nothing has decoded it. Before this check such a call rendered as an
 * ordinary verified decoding with no warning.
 *
 * This happened on Safe 0x3dE688267Cf099307aBdd85F64D8efe03D0b2b26, nonces 2,
 * 3, 4 and 22 to 25: `AdministeredAgent.call` to a PAU Controller whose call
 * selectors appear in no ABI. The PAU decoder now decodes that agent, but the
 * same shape recurs on any forwarder no custom decoder covers, for example an
 * AdministeredAgent with the same bytecode at an address this build does not
 * register.
 *
 * The rule is structural, never by parameter name:
 *
 * - the function takes an `address` (or `address[]`) parameter, which is what
 *   makes it a forwarder rather than a function that stores bytes; and
 * - a `bytes` (or `bytes[]`) parameter holds a value shaped like ABI-encoded
 *   calldata: a 4-byte selector followed by whole 32-byte words.
 *
 * The word rule keeps a 65-byte ECDSA signature out. A caller that has decoded
 * the forwarded call itself, such as a custom decoder, does not call this.
 */

import type { Hex } from 'viem'

/** One forwarded call that the decoding leaves undecoded. */
export interface ForwardedCall {
  /** The `bytes` or `bytes[]` parameter that carries it. */
  param: string
  /** Position within a `bytes[]` parameter, or null for `bytes`. */
  index: number | null
  /**
   * The address it is forwarded to, when the decoding names exactly one
   * candidate: the only `address` parameter, or the element at the same index
   * of the only `address[]` parameter. Null otherwise.
   */
  target: string | null
  /** The first four bytes, in full. */
  selector: Hex
  /** The complete forwarded calldata. Never shortened. */
  calldata: Hex
}

interface DecodedParam {
  name: string
  type: string
  value: unknown
}

/** True for a hex string shaped like ABI-encoded calldata. */
export function isCalldataShaped(value: unknown): value is Hex {
  if (typeof value !== 'string') return false
  if (!/^0x([0-9a-fA-F]{2})*$/.test(value)) return false
  const bytes = (value.length - 2) / 2
  return bytes >= 4 && (bytes - 4) % 32 === 0
}

/**
 * Read an array value. The Safe API types every value as a string but returns
 * arrays as JSON arrays; Sourcify keeps them structured. Accept both, and a
 * JSON-encoded string for safety.
 */
function asArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Every forwarded call in a one-layer decoding.
 *
 * Returns an empty array for a function with no address parameter, or with no
 * calldata-shaped bytes.
 */
export function findForwardedCalls(parameters: readonly DecodedParam[] | null | undefined): ForwardedCall[] {
  if (!parameters || parameters.length === 0) return []

  const addresses = parameters.filter(p => p.type === 'address')
  const addressArrays = parameters.filter(p => p.type === 'address[]')
  if (addresses.length === 0 && addressArrays.length === 0) return []

  const singleTarget =
    addresses.length === 1 && typeof addresses[0]!.value === 'string' ? (addresses[0]!.value as string) : null
  const targetList = addressArrays.length === 1 ? asArray(addressArrays[0]!.value) : null

  const found: ForwardedCall[] = []
  for (const param of parameters) {
    if (param.type === 'bytes' && isCalldataShaped(param.value)) {
      found.push({
        param: param.name,
        index: null,
        target: singleTarget,
        selector: param.value.slice(0, 10).toLowerCase() as Hex,
        calldata: param.value,
      })
    } else if (param.type === 'bytes[]') {
      const items = asArray(param.value) ?? []
      items.forEach((item, index) => {
        if (!isCalldataShaped(item)) return
        const listed = targetList?.[index]
        found.push({
          param: param.name,
          index,
          target: typeof listed === 'string' ? listed : null,
          selector: item.slice(0, 10).toLowerCase() as Hex,
          calldata: item,
        })
      })
    }
  }
  return found
}

/**
 * Whether one call is decoded down to what executes.
 *
 * False when the call carries calldata and any of these holds:
 *
 * - a custom decoder decoded it but rated it high risk, which is how a decoder
 *   reports a call it cannot name;
 * - no custom decoder decoded it and no usable one-layer decoding exists;
 * - the one-layer decoding forwards calldata that nothing decoded.
 *
 * The security checks read the transaction's structure, never its decodings.
 * A caller uses this to keep their all-clear from reading as "no risk" under a
 * call nothing decoded.
 */
export function isCallFullyDecoded(call: {
  data: string | null | undefined
  /** The custom decoder's result, when one decoded the call. */
  custom?: { main: { riskLevel?: string } } | null
  /** The one-layer decoding's parameters (Safe API or Sourcify), when one exists. */
  parameters?: readonly DecodedParam[] | null
  /** True when a one-layer decoding exists. */
  decoded: boolean
}): boolean {
  if (!call.data || call.data === '0x') return true
  if (call.custom) return call.custom.main.riskLevel !== 'high'
  if (!call.decoded) return false
  return findForwardedCalls(call.parameters).length === 0
}
