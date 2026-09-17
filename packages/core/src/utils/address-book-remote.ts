/**
 * Remote address book ingest and merge.
 *
 * Pure functions only — this module never fetches. The caller performs the
 * request and hands the parsed JSON body here, so the validation is testable
 * without a network and identical in the UI and in tests.
 *
 * Wire shape (GET <url>?network=<network>):
 *
 *   {
 *     "source":  { "name": "sff-address-book", "generated_at": "<ISO 8601>" },
 *     "entries": [
 *       { "id": 1, "address": "0x...", "label": "...", "networks": ["ethereum"],
 *         "status": "active", "last_verified": "2026-09-01",
 *         "updated_at": "<ISO 8601>" }
 *     ]
 *   }
 *
 * `networks` may contain "all". A row that is not valid on the requested
 * network is skipped rather than dropped silently, so the UI can report
 * "loaded 47, skipped 3".
 *
 * Remote entries keep source: 'address-book' in the tag registry. Only the
 * additive `origin` field distinguishes them, so the address-book check and
 * every other consumer behave exactly as they did for CSV-only signers.
 */

import type { Address } from 'viem';
import { buildAddressBookTag, type AddressBookEntry, type AddressBookSkippedRow } from './address-book.js';
import type { AddressBookOrigin, AddressBookStatus, AddressTag } from './address-tags.js';

export type { AddressBookOrigin };

export interface RemoteAddressBookResult {
  entries: AddressBookEntry[];
  skipped: AddressBookSkippedRow[];
  /** `source.generated_at` from the response, or null when absent. */
  generatedAt: string | null;
  /** `source.name` from the response, or null when absent. */
  sourceName: string | null;
}

export interface RemoteAddressBookOptions {
  /** Keep only rows valid on this network (or on "all"). Omit to keep all rows. */
  network?: string;
}

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Validate and convert a remote response body into address-book entries.
 *
 * Throws only on a body that is not the documented envelope. Individual bad
 * rows are skipped with a reason, never thrown on — one malformed row must not
 * cost the signer the whole book.
 */
export function parseRemoteAddressBook(json: unknown, options: RemoteAddressBookOptions = {}): RemoteAddressBookResult {
  if (typeof json !== 'object' || json === null || !Array.isArray((json as { entries?: unknown }).entries)) {
    throw new Error('Remote address book: unexpected response shape');
  }
  const body = json as { entries: unknown[]; source?: unknown };
  const source = typeof body.source === 'object' && body.source !== null ? (body.source as Record<string, unknown>) : {};
  const sourceName = typeof source.name === 'string' ? source.name : null;
  const generatedAt = typeof source.generated_at === 'string' ? source.generated_at : null;

  const entries: AddressBookEntry[] = [];
  const skipped: AddressBookSkippedRow[] = [];
  // De-dupe by address (last wins), mirroring parseAddressBookCsv.
  const seen = new Map<string, number>();

  for (let i = 0; i < body.entries.length; i++) {
    const rowNumber = i + 1;
    const row = body.entries[i];
    const raw = JSON.stringify(row) ?? String(row);

    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      skipped.push({ row: rowNumber, raw, reason: 'row is not an object' });
      continue;
    }
    const record = row as Record<string, unknown>;
    const address = str(record.address);
    const label = str(record.label);
    const status = str(record.status).toLowerCase();
    const networks = record.networks;

    if (!ADDRESS_PATTERN.test(address)) {
      skipped.push({ row: rowNumber, raw, reason: `invalid address "${address}"` });
      continue;
    }
    if (label === '') {
      skipped.push({ row: rowNumber, raw, reason: 'empty label' });
      continue;
    }
    if (status !== 'active' && status !== 'inactive') {
      skipped.push({ row: rowNumber, raw, reason: `status must be "active" or "inactive" (got "${status}")` });
      continue;
    }
    if (!Array.isArray(networks) || networks.some((n) => typeof n !== 'string')) {
      skipped.push({ row: rowNumber, raw, reason: 'networks must be an array of strings' });
      continue;
    }
    if (options.network !== undefined) {
      const wanted = options.network.toLowerCase();
      const ok = (networks as string[]).some((n) => {
        const name = n.toLowerCase();
        return name === 'all' || name === wanted;
      });
      if (!ok) {
        skipped.push({ row: rowNumber, raw, reason: `not valid on ${options.network}` });
        continue;
      }
    }

    const entry: AddressBookEntry = {
      address: address as Address,
      label,
      verificationDate: str(record.last_verified),
      status: status as AddressBookStatus,
      type: 'address',
      origin: 'remote',
    };
    const key = address.toLowerCase();
    const existingIdx = seen.get(key);
    if (existingIdx !== undefined) {
      skipped.push({
        row: rowNumber - 1,
        raw: 'previous entry for same address',
        reason: `duplicate of row ${rowNumber}; later entry kept`,
      });
      entries[existingIdx] = entry;
    } else {
      seen.set(key, entries.length);
      entries.push(entry);
    }
  }

  return { entries, skipped, generatedAt, sourceName };
}

export interface AddressBookConflict {
  address: Address;
  csv: AddressBookEntry;
  remote: AddressBookEntry;
}

export interface MergedAddressBook {
  entries: AddressBookEntry[];
  conflicts: AddressBookConflict[];
}

/**
 * Merge the CSV book with the remote book, keyed by lower-case address.
 *
 * The remote book is the canonical one, so it wins on a collision. A label or
 * status disagreement is recorded as a conflict rather than resolved quietly:
 * two sources naming one address differently is exactly the condition a signer
 * must see before trusting either label.
 *
 * Order is deterministic: remote entries in input order, then CSV-only entries
 * in input order. With an empty remote list the result is the CSV entries in
 * their original order, unchanged except for the additive `origin` field.
 */
export function mergeAddressBooks(csv: AddressBookEntry[], remote: AddressBookEntry[]): MergedAddressBook {
  const csvByKey = new Map<string, AddressBookEntry>();
  for (const entry of csv) {
    csvByKey.set(entry.address.toLowerCase(), { ...entry, origin: entry.origin ?? 'csv' });
  }

  const entries: AddressBookEntry[] = [];
  const conflicts: AddressBookConflict[] = [];
  const taken = new Set<string>();

  for (const entry of remote) {
    const key = entry.address.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    const kept: AddressBookEntry = { ...entry, origin: entry.origin ?? 'remote' };
    entries.push(kept);
    const other = csvByKey.get(key);
    if (other && (other.label !== kept.label || other.status !== kept.status)) {
      conflicts.push({ address: kept.address, csv: other, remote: kept });
    }
  }

  for (const [key, entry] of csvByKey) {
    if (taken.has(key)) continue;
    entries.push(entry);
  }

  return { entries, conflicts };
}

/**
 * Build the registry tag for a merged entry, carrying provenance and any
 * conflict through to the badge.
 */
export function buildMergedTag(entry: AddressBookEntry, conflict?: AddressBookConflict): AddressTag {
  const tag = buildAddressBookTag(entry);
  if (entry.origin) tag.origin = entry.origin;
  if (conflict) {
    tag.conflict = {
      otherLabel: conflict.csv.label,
      otherStatus: conflict.csv.status,
      otherOrigin: 'csv',
    };
  }
  return tag;
}

/**
 * Same-origin path of the deployment configuration probe.
 *
 * The hosted copy must be byte-identical to the released artifact, so the
 * address book URL cannot be baked into the bundle. The page reads it at
 * run time from this path instead. A deployment that does not serve the file
 * answers 404 and the connector stays idle.
 */
export const SKY_SAFE_CONFIG_PATH = '/sky-safe-config.json';

export interface SkySafeConfig {
  /** URL of the address book list endpoint. Same-origin with the page. */
  remoteAddressBookUrl: string;
}

/**
 * Validate the body of {@link SKY_SAFE_CONFIG_PATH}.
 *
 * Throws with the cause in the message, because that message is shown to the
 * signer as the banner text. A silent fallback would leave the signer with an
 * unlabelled transaction and no reason for it.
 */
export function parseSkySafeConfig(json: unknown): SkySafeConfig {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error(`Deployment configuration ${SKY_SAFE_CONFIG_PATH} is not JSON`);
  }
  const value = (json as Record<string, unknown>).remoteAddressBookUrl;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Deployment configuration ${SKY_SAFE_CONFIG_PATH} has no remoteAddressBookUrl`);
  }
  return { remoteAddressBookUrl: value.trim() };
}

/**
 * Resolve the address book URL against the page and check it is usable.
 *
 * Two rules, both fail-closed:
 *   - The scheme must be http or https. A file:// page cannot fetch a book.
 *   - The origin must match the page. The request carries same-origin
 *     credentials, so a cross-origin URL reaches a service that cannot
 *     authenticate the signer, and the labels would come from an origin the
 *     signer never authorised.
 *
 * The thrown message is the banner text, so it names the two origins in full.
 */
export function checkRemoteAddressBookUrl(url: string, pageHref: string): URL {
  const page = new URL(pageHref);
  let resolved: URL;
  try {
    resolved = new URL(url, pageHref);
  } catch {
    throw new Error(`Remote address book URL "${url}" is not a valid URL.`);
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new Error(
      `Remote address book URL must be http or https (got ${resolved.protocol}). ` +
        `A copy opened from a file cannot load a remote address book.`
    );
  }
  if (resolved.origin !== page.origin) {
    throw new Error(
      `Remote address book URL is on another origin (${resolved.origin}). ` +
        `It must be on this page's origin (${page.origin}).`
    );
  }
  return resolved;
}
