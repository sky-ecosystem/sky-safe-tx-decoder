import { afterEach, describe, expect, it } from 'vitest'
import {
  _clearNetworkBuiltIns,
  _registerNetworkBuiltIn,
  batchAddressTagChanges,
  clearAddressBookTags,
  getAddressTag,
  getAddressTagsVersion,
  registerAddressTag,
  subscribeAddressTags,
  unregisterAddressBookTag,
  type AddressTag,
} from './address-tags.js'
import { loadNetworkContracts } from '../contracts/index.js'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const CORE_ONLY = '0x3333333333333333333333333333333333333333'
// USDS on Ethereum, a network built-in.
const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F'

function bookTag(label: string): AddressTag {
  return { label, description: label, category: 'address-book', source: 'address-book', status: 'active' }
}

const unsubscribers: Array<() => void> = []
function listen(): { calls: number } {
  const counter = { calls: 0 }
  unsubscribers.push(subscribeAddressTags(() => counter.calls++))
  return counter
}

afterEach(() => {
  while (unsubscribers.length > 0) unsubscribers.pop()!()
  clearAddressBookTags()
  _clearNetworkBuiltIns()
})

describe('address tag registry change tracking', () => {
  it('increments the version and notifies on every address-book registration', () => {
    const counter = listen()
    const before = getAddressTagsVersion()
    registerAddressTag(A, bookTag('A'))
    registerAddressTag(B, bookTag('B'))
    expect(getAddressTagsVersion()).toBe(before + 2)
    expect(counter.calls).toBe(2)
  })

  it('increments the version and notifies on a built-in registration', () => {
    const counter = listen()
    const before = getAddressTagsVersion()
    // The core built-in bucket is never cleared, so this address is used only here.
    registerAddressTag(CORE_ONLY, { label: 'core', description: 'core', category: 'other', source: 'built-in' })
    expect(getAddressTagsVersion()).toBe(before + 1)
    expect(counter.calls).toBe(1)
  })

  it('increments the version and notifies on clear and on removal', () => {
    registerAddressTag(A, bookTag('A'))
    registerAddressTag(B, bookTag('B'))
    const counter = listen()
    const before = getAddressTagsVersion()
    unregisterAddressBookTag(A)
    expect(getAddressTagsVersion()).toBe(before + 1)
    clearAddressBookTags()
    expect(getAddressTagsVersion()).toBe(before + 2)
    expect(counter.calls).toBe(2)
    expect(getAddressTag(B)).toBeUndefined()
  })

  it('increments the version on network built-in registration and clear', () => {
    const counter = listen()
    const before = getAddressTagsVersion()
    _registerNetworkBuiltIn(A, { label: 'A', description: 'A', category: 'protocol' })
    _clearNetworkBuiltIns()
    expect(getAddressTagsVersion()).toBe(before + 2)
    expect(counter.calls).toBe(2)
  })

  it('shows a listener the registry after the change', () => {
    const seen: Array<string | undefined> = []
    unsubscribers.push(subscribeAddressTags(() => seen.push(getAddressTag(A)?.label)))
    registerAddressTag(A, bookTag('first'))
    clearAddressBookTags()
    expect(seen).toEqual(['first', undefined])
  })

  it('stops notifying after unsubscribe', () => {
    let calls = 0
    const unsubscribe = subscribeAddressTags(() => calls++)
    registerAddressTag(A, bookTag('A'))
    unsubscribe()
    registerAddressTag(B, bookTag('B'))
    expect(calls).toBe(1)
  })

  it('notifies once for a batch, after every change in it is applied', () => {
    const seen: Array<[string | undefined, string | undefined]> = []
    unsubscribers.push(subscribeAddressTags(() => seen.push([getAddressTag(A)?.label, getAddressTag(B)?.label])))
    const before = getAddressTagsVersion()
    batchAddressTagChanges(() => {
      clearAddressBookTags()
      registerAddressTag(A, bookTag('A'))
      registerAddressTag(B, bookTag('B'))
    })
    expect(getAddressTagsVersion()).toBe(before + 3)
    expect(seen).toEqual([['A', 'B']])
  })

  it('notifies once for nested batches, at the end of the outermost', () => {
    const counter = listen()
    batchAddressTagChanges(() => {
      registerAddressTag(A, bookTag('A'))
      batchAddressTagChanges(() => registerAddressTag(B, bookTag('B')))
      expect(counter.calls).toBe(0)
    })
    expect(counter.calls).toBe(1)
  })

  it('does not notify for a batch that changes nothing', () => {
    const counter = listen()
    const before = getAddressTagsVersion()
    batchAddressTagChanges(() => {})
    expect(getAddressTagsVersion()).toBe(before)
    expect(counter.calls).toBe(0)
  })

  it('notifies and rethrows when a batch throws part way', () => {
    const counter = listen()
    expect(() =>
      batchAddressTagChanges(() => {
        registerAddressTag(A, bookTag('A'))
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(counter.calls).toBe(1)
    // The batch is closed: the next change notifies on its own.
    registerAddressTag(B, bookTag('B'))
    expect(counter.calls).toBe(2)
  })

  it('swaps network contracts in one notification', () => {
    const seen: Array<string | undefined> = []
    unsubscribers.push(subscribeAddressTags(() => seen.push(getAddressTag(USDS)?.label)))
    loadNetworkContracts('ethereum')
    loadNetworkContracts('base')
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBeDefined()
    expect(seen[1]).toBeUndefined()
  })
})
