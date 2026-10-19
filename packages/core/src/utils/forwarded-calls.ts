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
 * The rule is structural, never by parameter name. A value counts as
 * forwarded calldata when it is 4 bytes or longer and any of these holds:
 *
 * - it is an element of a `bytes[]`, at any depth. A list of byte strings is
 *   the shape of a batch, including a self-multicall `multicall(bytes[])` that
 *   names no address;
 * - it is a `bytes` value, at any depth, in a function whose parameters hold
 *   an `address` anywhere, including inside a tuple. The address is what makes
 *   it a forwarder rather than a function that stores bytes, such as
 *   `multiSend(bytes)`;
 * - it is a hex string other than a 20-byte one inside a tuple whose
 *   component types the decoding does not give. Without types, a byte string
 *   and a `bytes32` look the same, so both count.
 *
 * Tuples and arrays of tuples are walked, so Multicall3
 * `aggregate((address,bytes)[])` is covered.
 *
 * There is no length rule beyond the 4-byte minimum. Solidity ignores
 * calldata past the arguments it reads, so a selector followed by a partial
 * word, or by any number of extra bytes, still executes. An earlier
 * "selector plus whole 32-byte words" rule let one appended byte hide a call.
 * That rule also exempted a 65-byte ECDSA signature. The exemption is gone
 * too: a one-argument call such as `transferOwnership(address)` padded to 65
 * bytes executes, so a 65-byte value next to an address is not provably a
 * signature. A function such as `permit(address, ..., bytes signature)`
 * therefore gets the notice. That is a cautious false positive.
 *
 * A caller that has decoded the forwarded call itself, such as a custom
 * decoder, does not call this.
 */

import { parseAbiParameters, type AbiParameter, type Hex } from 'viem'

/** One forwarded call that the decoding leaves undecoded. */
export interface ForwardedCall {
  /** The top-level parameter that carries it. */
  param: string
  /** Position within a top-level `bytes[]` parameter, or null otherwise. */
  index: number | null
  /**
   * Where the calldata sits, for display: `data`, `data[1]`, `calls[0][1]`
   * (positional tuple) or `calls[0].callData` (named tuple).
   */
  path: string
  /**
   * The address it is forwarded to, when the decoding names exactly one
   * candidate: the only `address` beside it (in the same tuple, or else in the
   * enclosing parameter list), or the element at the same index of the only
   * `address[]` beside a `bytes[]`. Null otherwise.
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
  /** Tuple components, where the decoder kept them (Sourcify does). */
  components?: readonly AbiParameter[]
}

/**
 * True for a hex string that can be calldata: whole bytes, at least a 4-byte
 * selector. No word alignment is required, because the EVM does not require
 * it. See the module comment.
 */
export function isCalldataShaped(value: unknown): value is Hex {
  if (typeof value !== 'string') return false
  if (!/^0x([0-9a-fA-F]{2})*$/.test(value)) return false
  return (value.length - 2) / 2 >= 4
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

/** Matches an array type and captures the element type, e.g. `bytes[]` or `(address,bytes)[2]`. */
const ARRAY_TYPE = /^(.*)\[\d*\]$/

const ADDRESS_ARRAY_TYPE = /^address\[\d*\]$/

const ADDRESS_HEX = /^0x[0-9a-fA-F]{40}$/

const INDEX_LABEL = /^\d+$/

/**
 * The ABI parameter for one decoded parameter, or null when its type is a
 * tuple whose components are unknown. The Safe API gives tuples as canonical
 * signatures such as `(address,bytes)[]`, which parse. Sourcify gives
 * `tuple[]` with `components`. A bare `tuple[]` with neither is untyped.
 */
function toAbiParameter(param: DecodedParam): AbiParameter | null {
  if (param.components) {
    return { name: param.name, type: param.type, components: param.components } as AbiParameter
  }
  if (param.type.startsWith('tuple')) return null
  if (param.type.startsWith('(')) {
    try {
      const parsed = parseAbiParameters(param.type)
      return parsed.length === 1 ? (parsed[0] as AbiParameter) : null
    } catch {
      return null
    }
  }
  return { name: param.name, type: param.type }
}

/** One component value of a tuple, positional (Safe API) or named (viem). */
function tupleItem(value: unknown, component: AbiParameter, i: number): unknown {
  const items = asArray(value)
  if (items) return items[i]
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return component.name && component.name in record ? record[component.name] : record[i]
  }
  return undefined
}

/** Extend a display path by one tuple component or array element. */
function childPath(path: string, label: string): string {
  if (path === '') return label
  return INDEX_LABEL.test(label) ? `${path}[${label}]` : `${path}.${label}`
}

interface Candidate {
  param: string
  index: number | null
  path: string
  target: string | null
  calldata: Hex
  /** A plain `bytes` value. Counts only in a function that holds an address. */
  needsAddress: boolean
}

interface Walk {
  candidates: Candidate[]
  hasAddress: boolean
}

interface Sibling {
  abi: AbiParameter | null
  value: unknown
  label: string
}

/**
 * Walk one list of siblings: the top-level parameters (`param` null), or the
 * components of one tuple value. `inherited` is the target named by the
 * enclosing list, used when this list holds no address of its own.
 */
function walkSiblings(
  siblings: readonly Sibling[],
  param: string | null,
  path: string,
  inherited: string | null,
  walk: Walk
): void {
  const addresses = siblings.filter(s => s.abi?.type === 'address')
  const addressArrays = siblings.filter(s => s.abi !== null && ADDRESS_ARRAY_TYPE.test(s.abi.type))
  if (addresses.length > 0 || addressArrays.length > 0) walk.hasAddress = true

  let target: string | null = null
  if (addresses.length === 0) target = inherited
  else if (addresses.length === 1 && typeof addresses[0]!.value === 'string') target = addresses[0]!.value
  const targetList = addressArrays.length === 1 ? asArray(addressArrays[0]!.value) : null

  for (const sibling of siblings) {
    walkValue(
      sibling.abi,
      sibling.value,
      param ?? sibling.label,
      childPath(path, sibling.label),
      param === null,
      target,
      targetList,
      walk
    )
  }
}

function walkValue(
  abi: AbiParameter | null,
  value: unknown,
  param: string,
  path: string,
  topLevel: boolean,
  target: string | null,
  targetList: unknown[] | null,
  walk: Walk
): void {
  if (abi === null) {
    walkUntyped(value, param, path, target, walk)
    return
  }

  if (abi.type === 'bytes') {
    if (isCalldataShaped(value)) {
      walk.candidates.push({ param, index: null, path, target, calldata: value, needsAddress: true })
    }
    return
  }

  const arrayMatch = ARRAY_TYPE.exec(abi.type)
  if (arrayMatch) {
    const element = { ...abi, type: arrayMatch[1]! } as AbiParameter
    const items = asArray(value) ?? []
    items.forEach((item, i) => {
      const itemPath = `${path}[${i}]`
      if (element.type !== 'bytes') {
        walkValue(element, item, param, itemPath, false, target, null, walk)
        return
      }
      if (!isCalldataShaped(item)) return
      const listed = targetList?.[i]
      walk.candidates.push({
        param,
        index: topLevel ? i : null,
        path: itemPath,
        target: targetList ? (typeof listed === 'string' ? listed : null) : target,
        calldata: item,
        needsAddress: false,
      })
    })
    return
  }

  if (abi.type === 'tuple') {
    // Components parsed from a canonical signature have no names, so their
    // labels are positional. viem returns a named tuple as an object.
    const components = (abi as { components?: readonly AbiParameter[] }).components ?? []
    const siblings = components.map((component, i) => ({
      abi: component,
      value: tupleItem(value, component, i),
      label: component.name ? component.name : String(i),
    }))
    walkSiblings(siblings, param, path, target, walk)
  }
}

/**
 * Walk a value whose types are unknown. A 20-byte hex string reads as an
 * address. Any other hex string of 4 bytes or more reads as calldata.
 */
function walkUntyped(value: unknown, param: string, path: string, inherited: string | null, walk: Walk): void {
  const items = asArray(value)
  let entries: Array<[string, unknown]>
  if (items) entries = items.map((item, i) => [String(i), item])
  else if (value && typeof value === 'object') entries = Object.entries(value as Record<string, unknown>)
  else return

  const addresses = entries.filter(([, v]) => typeof v === 'string' && ADDRESS_HEX.test(v))
  if (addresses.length > 0) walk.hasAddress = true
  let target: string | null = null
  if (addresses.length === 0) target = inherited
  else if (addresses.length === 1) target = addresses[0]![1] as string

  for (const [key, item] of entries) {
    const itemPath = childPath(path, key)
    if (typeof item !== 'string') {
      walkUntyped(item, param, itemPath, target, walk)
    } else if (!ADDRESS_HEX.test(item) && isCalldataShaped(item)) {
      walk.candidates.push({ param, index: null, path: itemPath, target, calldata: item, needsAddress: false })
    }
  }
}

/**
 * Every forwarded call in a one-layer decoding.
 *
 * Returns an empty array when no value qualifies under the rule in the module
 * comment.
 */
export function findForwardedCalls(parameters: readonly DecodedParam[] | null | undefined): ForwardedCall[] {
  if (!parameters || parameters.length === 0) return []

  const walk: Walk = { candidates: [], hasAddress: false }
  walkSiblings(
    parameters.map(p => ({ abi: toAbiParameter(p), value: p.value, label: p.name })),
    null,
    '',
    null,
    walk
  )

  return walk.candidates
    .filter(c => !c.needsAddress || walk.hasAddress)
    .map(c => ({
      param: c.param,
      index: c.index,
      path: c.path,
      target: c.target,
      selector: c.calldata.slice(0, 10).toLowerCase() as Hex,
      calldata: c.calldata,
    }))
}

/** The fields of one custom-decoded call that isCallFullyDecoded reads. */
interface CustomCallSummary {
  riskLevel?: string
  /** Bytes past the decoded arguments. See DecodedFunction.trailingCalldata. */
  trailingCalldata?: string
}

/**
 * Whether one call is decoded down to what executes.
 *
 * False when the call carries calldata and any of these holds:
 *
 * - the Safe API decoding failed the re-encode check (`mismatch`). The service
 *   served a decoding of different bytes, so this holds even where a custom
 *   decoder decoded the call;
 * - a custom decoder decoded it but rated the main call or any nested call
 *   high risk, which is how a decoder reports a call it cannot name;
 * - a custom decoder found bytes past the decoded arguments of the main call
 *   or any nested call (`trailingCalldata`). The display then does not cover
 *   every byte being signed;
 * - no custom decoder decoded it and no usable one-layer decoding exists;
 * - no custom decoder decoded it and the one-layer decoding did not re-encode
 *   exactly (`trailing-data` or `unverifiable`). The decoding then does not
 *   provably describe the bytes;
 * - the one-layer decoding forwards calldata that nothing decoded.
 *
 * The security checks read the transaction's structure, never its decodings.
 * A caller uses this to keep their all-clear from reading as "no risk" under a
 * call nothing decoded.
 */
export function isCallFullyDecoded(call: {
  data: string | null | undefined
  /** The custom decoder's result, when one decoded the call. */
  custom?: { main: CustomCallSummary; nested?: ReadonlyArray<CustomCallSummary> } | null
  /** The one-layer decoding's parameters (Safe API or Sourcify), when one exists. */
  parameters?: readonly DecodedParam[] | null
  /** True when a one-layer decoding exists. */
  decoded: boolean
  /** The re-encode check of the one-layer decoding, when the caller ran it. */
  verification?: { status?: string } | null
}): boolean {
  if (!call.data || call.data === '0x') return true
  if (call.verification?.status === 'mismatch') return false
  if (call.custom) {
    const calls = [call.custom.main, ...(call.custom.nested ?? [])]
    return !calls.some(c => c.riskLevel === 'high' || c.trailingCalldata !== undefined)
  }
  if (!call.decoded) return false
  if (call.verification && call.verification.status !== 'verified') return false
  return findForwardedCalls(call.parameters).length === 0
}
