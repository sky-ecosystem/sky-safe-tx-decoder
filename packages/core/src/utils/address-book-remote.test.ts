/**
 * Tests for the remote address book parser and the CSV/remote merge.
 *
 * Addresses are written in full everywhere — never truncated.
 */

import { describe, it, expect } from 'vitest';
import {
  buildMergedTag,
  checkRemoteAddressBookUrl,
  mergeAddressBooks,
  parseRemoteAddressBook,
  parseSkySafeConfig,
} from './address-book-remote.js';
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

describe('parseSkySafeConfig', () => {
  it('accepts a body with a remoteAddressBookUrl string', () => {
    expect(parseSkySafeConfig({ remoteAddressBookUrl: '/api/v1/addresses' })).toEqual({
      remoteAddressBookUrl: '/api/v1/addresses',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseSkySafeConfig({ remoteAddressBookUrl: '  /api/v1/addresses  ' })).toEqual({
      remoteAddressBookUrl: '/api/v1/addresses',
    });
  });

  it('ignores other fields', () => {
    expect(parseSkySafeConfig({ remoteAddressBookUrl: '/api/v1/addresses', other: 1 })).toEqual({
      remoteAddressBookUrl: '/api/v1/addresses',
    });
  });

  it('rejects a body that is not a JSON object', () => {
    const message = 'Deployment configuration /sky-safe-config.json is not JSON';
    expect(() => parseSkySafeConfig(null)).toThrow(message);
    expect(() => parseSkySafeConfig('<html>login</html>')).toThrow(message);
    expect(() => parseSkySafeConfig(42)).toThrow(message);
    expect(() => parseSkySafeConfig([{ remoteAddressBookUrl: '/api/v1/addresses' }])).toThrow(message);
  });

  it('rejects a body without a usable remoteAddressBookUrl', () => {
    const message = 'Deployment configuration /sky-safe-config.json has no remoteAddressBookUrl';
    expect(() => parseSkySafeConfig({})).toThrow(message);
    expect(() => parseSkySafeConfig({ remoteAddressBookUrl: '' })).toThrow(message);
    expect(() => parseSkySafeConfig({ remoteAddressBookUrl: '   ' })).toThrow(message);
    expect(() => parseSkySafeConfig({ remoteAddressBookUrl: 42 })).toThrow(message);
    expect(() => parseSkySafeConfig({ remote_address_book_url: '/api/v1/addresses' })).toThrow(message);
  });
});

describe('checkRemoteAddressBookUrl', () => {
  const page = 'https://decoder.example.org/decoder/index.html#/safe/ethereum/0x0000000000000000000000000000000000000000';

  it('resolves a relative path against the page', () => {
    const url = checkRemoteAddressBookUrl('/api/v1/addresses', page);
    expect(url.toString()).toBe('https://decoder.example.org/api/v1/addresses');
  });

  it('accepts an absolute URL on the page origin', () => {
    const url = checkRemoteAddressBookUrl('https://decoder.example.org/api/v1/addresses', page);
    expect(url.pathname).toBe('/api/v1/addresses');
  });

  it('rejects another origin and names both origins in full', () => {
    expect(() => checkRemoteAddressBookUrl('https://book.example.net/api/v1/addresses', page)).toThrow(
      "Remote address book URL is on another origin (https://book.example.net). " +
        "It must be on this page's origin (https://decoder.example.org)."
    );
  });

  it('rejects another port on the same host', () => {
    expect(() => checkRemoteAddressBookUrl('https://decoder.example.org:8443/api/v1/addresses', page)).toThrow(
      'is on another origin (https://decoder.example.org:8443)'
    );
  });

  it('rejects a scheme that is not http or https', () => {
    expect(() => checkRemoteAddressBookUrl('ftp://decoder.example.org/api', page)).toThrow(
      'Remote address book URL must be http or https (got ftp:).'
    );
  });

  it('rejects any URL on a page opened from a file', () => {
    expect(() => checkRemoteAddressBookUrl('/api/v1/addresses', 'file:///Users/signer/index.html')).toThrow(
      'Remote address book URL must be http or https (got file:).'
    );
  });

  it('accepts a loopback dev server proxied on its own origin', () => {
    const url = checkRemoteAddressBookUrl('/api/v1/addresses', 'http://localhost:5173/');
    expect(url.toString()).toBe('http://localhost:5173/api/v1/addresses');
  });
});

describe('mergeAddressBooks with an empty remote list', () => {
  it('returns an empty book when both sources are empty', () => {
    expect(mergeAddressBooks([], [])).toEqual({ entries: [], conflicts: [] });
  });

  it('keeps every CSV entry, in order, with no conflicts', () => {
    const csv = [
      csvEntry({ address: USDS }),
      csvEntry({ address: USDT, label: 'Tether' }),
      csvEntry({ address: USDC, label: 'USD Coin', status: 'inactive' }),
    ];
    const { entries, conflicts } = mergeAddressBooks(csv, []);
    expect(conflicts).toHaveLength(0);
    expect(entries.map((e) => e.address)).toEqual([USDS, USDT, USDC]);
    expect(entries.map((e) => e.origin)).toEqual(['csv', 'csv', 'csv']);
    expect(entries[2]!.status).toBe('inactive');
  });

  it('leaves an entry that already carries an origin untouched', () => {
    const csv = [csvEntry({ address: USDS, origin: 'remote' })];
    const { entries } = mergeAddressBooks(csv, []);
    expect(entries[0]!.origin).toBe('remote');
  });
});
