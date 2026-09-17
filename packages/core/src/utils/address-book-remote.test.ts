/**
 * Tests for the remote address book parser and the CSV/remote merge.
 *
 * Addresses are written in full everywhere — never truncated.
 */

import { describe, it, expect } from 'vitest';
import { buildMergedTag, mergeAddressBooks, parseRemoteAddressBook } from './address-book-remote.js';
import type { AddressBookEntry } from './address-book.js';

const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F' as `0x${string}`;
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7' as `0x${string}`;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`;
const TREASURY = '0xf65475e74C1Ed6d004d5240b06E3088724dFDA5d' as `0x${string}`;

function body(entries: unknown[]): unknown {
  return {
    source: { name: 'sff-address-book', generated_at: '2026-09-17T10:00:00.000Z' },
    entries,
  };
}

function remoteRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    address: USDS,
    label: 'USDS token',
    networks: ['ethereum'],
    status: 'active',
    last_verified: '2026-09-01',
    updated_at: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

function csvEntry(overrides: Partial<AddressBookEntry> = {}): AddressBookEntry {
  return {
    address: USDS,
    label: 'USDS token',
    verificationDate: '2026-08-01',
    status: 'active',
    type: 'address',
    ...overrides,
  };
}

describe('parseRemoteAddressBook', () => {
  it('rejects a body that is not the documented envelope', () => {
    expect(() => parseRemoteAddressBook(null)).toThrow('Remote address book: unexpected response shape');
    expect(() => parseRemoteAddressBook('<html>401</html>')).toThrow('Remote address book: unexpected response shape');
    expect(() => parseRemoteAddressBook({ entries: 'nope' })).toThrow(
      'Remote address book: unexpected response shape'
    );
  });

  it('parses a valid response, mapping last_verified and marking the origin', () => {
    const result = parseRemoteAddressBook(body([remoteRow()]));
    expect(result.sourceName).toBe('sff-address-book');
    expect(result.generatedAt).toBe('2026-09-17T10:00:00.000Z');
    expect(result.skipped).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      address: USDS,
      label: 'USDS token',
      verificationDate: '2026-09-01',
      status: 'active',
      type: 'address',
      origin: 'remote',
    });
  });

  it('defaults verificationDate to an empty string when last_verified is absent', () => {
    const row = remoteRow();
    delete row.last_verified;
    const result = parseRemoteAddressBook(body([row]));
    expect(result.entries[0]!.verificationDate).toBe('');
  });

  it('keeps rows valid on the requested network, including "all"', () => {
    const result = parseRemoteAddressBook(
      body([
        remoteRow({ address: USDS, networks: ['ethereum'] }),
        remoteRow({ address: USDT, label: 'Everywhere', networks: ['all'] }),
        remoteRow({ address: USDC, label: 'Base only', networks: ['base'] }),
      ]),
      { network: 'ethereum' }
    );
    expect(result.entries.map((e) => e.address)).toEqual([USDS, USDT]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe('not valid on ethereum');
  });

  it('keeps every row when no network is requested', () => {
    const result = parseRemoteAddressBook(
      body([remoteRow({ address: USDS, networks: ['ethereum'] }), remoteRow({ address: USDC, networks: ['base'] })])
    );
    expect(result.entries).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  it('skips rows with an invalid address, empty label, bad status, or bad networks', () => {
    const result = parseRemoteAddressBook(
      body([
        remoteRow({ address: '0xnothex' }),
        remoteRow({ address: USDT, label: '' }),
        remoteRow({ address: USDC, status: 'retired' }),
        remoteRow({ address: TREASURY, networks: 'ethereum' }),
      ])
    );
    expect(result.entries).toHaveLength(0);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'invalid address "0xnothex"',
      'empty label',
      'status must be "active" or "inactive" (got "retired")',
      'networks must be an array of strings',
    ]);
  });

  it('de-dupes by lower-case address, last wins, and records the dropped row', () => {
    const result = parseRemoteAddressBook(
      body([
        remoteRow({ address: USDS, label: 'Old label' }),
        remoteRow({ address: USDS.toLowerCase(), label: 'New label' }),
      ])
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.label).toBe('New label');
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/duplicate of row 2; later entry kept/);
  });
});

describe('mergeAddressBooks', () => {
  it('returns the CSV entries unchanged when the remote list is empty', () => {
    const csv = [csvEntry({ address: USDS }), csvEntry({ address: USDT, label: 'Tether' })];
    const { entries, conflicts } = mergeAddressBooks(csv, []);
    expect(conflicts).toHaveLength(0);
    expect(entries.map((e) => e.address)).toEqual([USDS, USDT]);
    expect(entries[0]).toEqual({ ...csv[0], origin: 'csv' });
    expect(entries[1]).toEqual({ ...csv[1], origin: 'csv' });
  });

  it('keeps remote-only entries with the remote origin', () => {
    const remote = parseRemoteAddressBook(body([remoteRow()])).entries;
    const { entries, conflicts } = mergeAddressBooks([], remote);
    expect(conflicts).toHaveLength(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.origin).toBe('remote');
  });

  it('orders remote entries first, then CSV-only entries', () => {
    const remote = parseRemoteAddressBook(body([remoteRow({ address: USDS })])).entries;
    const csv = [csvEntry({ address: USDT, label: 'Tether' }), csvEntry({ address: USDC, label: 'USD Coin' })];
    const { entries } = mergeAddressBooks(csv, remote);
    expect(entries.map((e) => e.address)).toEqual([USDS, USDT, USDC]);
    expect(entries.map((e) => e.origin)).toEqual(['remote', 'csv', 'csv']);
  });

  it('records no conflict when both sources agree, and keeps the remote entry', () => {
    const remote = parseRemoteAddressBook(body([remoteRow({ address: USDS, label: 'USDS token' })])).entries;
    const csv = [csvEntry({ address: USDS.toLowerCase() as `0x${string}`, label: 'USDS token' })];
    const { entries, conflicts } = mergeAddressBooks(csv, remote);
    expect(conflicts).toHaveLength(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.origin).toBe('remote');
    expect(entries[0]!.verificationDate).toBe('2026-09-01');
  });

  it('records a conflict on a differing label and keeps the remote entry', () => {
    const remote = parseRemoteAddressBook(body([remoteRow({ address: USDS, label: 'USDS token' })])).entries;
    const csv = [csvEntry({ address: USDS, label: 'Sky USDS (my note)' })];
    const { entries, conflicts } = mergeAddressBooks(csv, remote);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe('USDS token');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.address).toBe(USDS);
    expect(conflicts[0]!.csv.label).toBe('Sky USDS (my note)');
    expect(conflicts[0]!.remote.label).toBe('USDS token');
  });

  it('records a conflict on a differing status', () => {
    const remote = parseRemoteAddressBook(body([remoteRow({ address: USDS, status: 'inactive' })])).entries;
    const csv = [csvEntry({ address: USDS, status: 'active' })];
    const { conflicts } = mergeAddressBooks(csv, remote);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.csv.status).toBe('active');
    expect(conflicts[0]!.remote.status).toBe('inactive');
  });
});

describe('buildMergedTag', () => {
  it('carries the origin through and stays an address-book tag', () => {
    const entry = parseRemoteAddressBook(body([remoteRow()])).entries[0]!;
    const tag = buildMergedTag(entry);
    expect(tag.source).toBe('address-book');
    expect(tag.category).toBe('address-book');
    expect(tag.origin).toBe('remote');
    expect(tag.label).toBe('USDS token');
    expect(tag.conflict).toBeUndefined();
  });

  it('carries the conflict through', () => {
    const remote = parseRemoteAddressBook(body([remoteRow({ label: 'USDS token' })])).entries;
    const csv = [csvEntry({ label: 'Sky USDS (my note)', status: 'inactive' })];
    const { entries, conflicts } = mergeAddressBooks(csv, remote);
    const tag = buildMergedTag(entries[0]!, conflicts[0]!);
    expect(tag.origin).toBe('remote');
    expect(tag.conflict).toEqual({
      otherLabel: 'Sky USDS (my note)',
      otherStatus: 'inactive',
      otherOrigin: 'csv',
    });
  });

  it('omits the origin for an entry that has none', () => {
    const tag = buildMergedTag(csvEntry());
    expect(tag.origin).toBeUndefined();
  });
});
