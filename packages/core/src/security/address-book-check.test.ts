import { afterEach, describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { checkAddressBook } from './address-book-check.js'
import { analyzeSecurity } from './analyzer.js'
import { clearAddressBookTags, registerAddressTag, type AddressBookStatus } from '../utils/address-tags.js'
import { ZERO_ADDRESS } from './constants.js'
import type { SafeTransactionData } from '../types.js'

const KNOWN: Address = '0x1111111111111111111111111111111111111111'
const RETIRED: Address = '0x2222222222222222222222222222222222222222'

function addToBook(address: Address, status: AddressBookStatus = 'active'): void {
  registerAddressTag(address, {
    label: address,
    description: 'test entry',
    category: 'address-book',
    source: 'address-book',
    status,
    verificationDate: '2026-09-01',
  })
}

function tx(to: Address): SafeTransactionData {
  return {
    to,
    value: '0',
    data: '0x',
    operation: 0,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce: '1',
  }
}

afterEach(() => clearAddressBookTags())

describe('address book check: remote book state', () => {
  it('stays silent with no book and no remote book, as before', () => {
    expect(checkAddressBook(KNOWN, '0x')).toEqual({ addressBookLoaded: false, recipients: [], warnings: [] })
  })

  it('reports a failed remote book when no entries are loaded', () => {
    expect(checkAddressBook(KNOWN, '0x', [], { remoteBook: 'failed' })).toEqual({
      addressBookLoaded: false,
      recipients: [],
      warnings: [],
      warningLevel: 'medium',
      remoteBook: 'failed',
    })
  })

  it('reports a loading remote book when no entries are loaded', () => {
    const result = checkAddressBook(KNOWN, '0x', [], { remoteBook: 'loading' })
    expect(result.warningLevel).toBe('medium')
    expect(result.remoteBook).toBe('loading')
  })

  it('keeps checking against the loaded entries and adds the remote state', () => {
    addToBook(KNOWN)
    const result = checkAddressBook(KNOWN, '0x', [], { remoteBook: 'failed' })
    expect(result.addressBookLoaded).toBe(true)
    expect(result.recipients.map((r) => r.status)).toEqual(['verified'])
    expect(result.warnings).toEqual([])
    expect(result.warningLevel).toBe('medium')
    expect(result.remoteBook).toBe('failed')
  })

  it('keeps an inactive recipient at high while the remote book loads', () => {
    addToBook(RETIRED, 'inactive')
    const result = checkAddressBook(RETIRED, '0x', [], { remoteBook: 'loading' })
    expect(result.warningLevel).toBe('high')
    expect(result.remoteBook).toBe('loading')
  })

  it('returns the CSV-only shape when no remote state is passed', () => {
    addToBook(KNOWN)
    const result = checkAddressBook(KNOWN, '0x')
    expect(result).not.toHaveProperty('remoteBook')
    expect(result.warningLevel).toBeUndefined()
  })
})

describe('security analyzer: remote book state', () => {
  it('is not an all-clear while the remote book is loading or after it failed', () => {
    addToBook(KNOWN)
    expect(analyzeSecurity(tx(KNOWN)).overallRisk).toBe('none')
    for (const remoteBook of ['loading', 'failed'] as const) {
      const result = analyzeSecurity(tx(KNOWN), { remoteBook })
      expect(result.overallRisk).toBe('medium')
      expect(result.requiresCarefulReview).toBe(true)
      expect(result.addressBook.remoteBook).toBe(remoteBook)
    }
  })
})
