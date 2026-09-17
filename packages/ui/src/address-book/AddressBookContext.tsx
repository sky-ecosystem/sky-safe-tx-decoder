/**
 * Address config session state — two independent files:
 *
 *   - Address book (managed): labels for known addresses, owned/updated by the
 *     team. Read-only in the app; drop a fresh file anytime to replace it.
 *   - My Safes (personal): the signer's own Safe shortcuts (the home dropdown).
 *     The only file that is edited (capture/remove) and exported.
 *
 *   - Remote address book (optional): the same labels fetched from a service.
 *     Canonical when present; the CSV book is merged under it and any
 *     disagreement is reported rather than resolved.
 *
 * Keeping them separate avoids a sync trap: updating the managed book never
 * touches your Safes, and capturing a Safe never forces you to re-merge the
 * book. Both are in-memory only (no localStorage); the files you keep externally
 * are the source of truth and are re-loaded each session.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMatch } from 'react-router-dom';
import {
  buildAddressBookTag,
  buildMergedTag,
  classifyConfigCsv,
  clearAddressBookTags,
  mergeAddressBooks,
  parseAddressBookCsv,
  parseRemoteAddressBook,
  registerAddressTag,
  serializeAddressBookCsv,
  type AddressBookConflict,
  type AddressBookEntry,
  type AddressBookSafe,
  type AddressBookSkippedRow,
} from '@shield3/sky-safe-core';
import { useSettings } from '../settings/SettingsContext';

export interface AddressBookSlot {
  entries: AddressBookEntry[];
  skipped: AddressBookSkippedRow[];
  filename: string;
  loadedAt: Date;
}

export interface MySafesSlot {
  safes: AddressBookSafe[];
  skipped: AddressBookSkippedRow[];
  filename: string;
  loadedAt: Date;
}

/**
 * The remote address book fetched from the service. A third, independent
 * source alongside the two CSV slots. Held in React state only — like the
 * CSVs it is never written to localStorage, so it is re-fetched each session.
 */
export interface RemoteBookSlot {
  status: 'idle' | 'loading' | 'ok' | 'error';
  url: string;
  network: string | null;
  entries: AddressBookEntry[];
  skipped: AddressBookSkippedRow[];
  conflicts: AddressBookConflict[];
  fetchedAt: Date | null;
  error: string | null;
  sourceName: string | null;
}

const IDLE_REMOTE: RemoteBookSlot = {
  status: 'idle',
  url: '',
  network: null,
  entries: [],
  skipped: [],
  conflicts: [],
  fetchedAt: null,
  error: null,
  sourceName: null,
};

interface AddressBookContextValue {
  /** Managed address book (labels). Read-only. */
  addressBook: AddressBookSlot | null;
  /** Remote address book fetched from the service. */
  remoteBook: RemoteBookSlot;
  /** Fetch the remote address book. Never throws; failure lands in the slot. */
  loadRemote: (url: string, network: string | null) => Promise<void>;
  clearRemote: () => void;
  /** Personal Safe shortcuts. Editable + exportable. */
  mySafes: MySafesSlot | null;
  /** Load a managed address-book CSV. Throws if the file is the wrong kind. */
  loadAddressBook: (file: File) => Promise<void>;
  /** Load a personal My Safes CSV. Throws if the file is the wrong kind. */
  loadMySafes: (file: File) => Promise<void>;
  clearAddressBook: () => void;
  clearMySafes: () => void;
  /** Add (or update, last-wins) a Safe shortcut in My Safes. */
  addSafe: (safe: AddressBookSafe) => void;
  /** Remove a Safe shortcut by network + address. */
  removeSafe: (network: string, address: string) => void;
  /** Change a Safe shortcut's label, found by network + address. */
  renameSafe: (network: string, address: string, label: string) => void;
  /** Serialize My Safes back to CSV (with kind marker). */
  exportMySafes: () => string;
}

const AddressBookContext = createContext<AddressBookContextValue | null>(null);

function lc(address: string): string {
  return address.toLowerCase();
}

export function AddressBookProvider({ children }: { children: ReactNode }) {
  const [addressBook, setAddressBook] = useState<AddressBookSlot | null>(null);
  const [mySafes, setMySafes] = useState<MySafesSlot | null>(null);
  const [remoteBook, setRemoteBook] = useState<RemoteBookSlot>(IDLE_REMOTE);

  // Rebuild the shared address-book tag bucket from ALL sources whenever any
  // slot changes. Centralizing here lets the three sources coexist instead of
  // clobbering each other's tags. The CSV book and the remote book are merged
  // first so a disagreement between them reaches the badge as a conflict
  // rather than as one silently chosen label.
  useEffect(() => {
    clearAddressBookTags();
    const { entries, conflicts } = mergeAddressBooks(addressBook?.entries ?? [], remoteBook.entries);
    const conflictByKey = new Map(conflicts.map((c) => [c.address.toLowerCase(), c]));
    for (const e of entries) registerAddressTag(e.address, buildMergedTag(e, conflictByKey.get(e.address.toLowerCase())));
    for (const s of mySafes?.safes ?? []) registerAddressTag(s.address, buildAddressBookTag(s));
  }, [addressBook, mySafes, remoteBook]);

  const loadRemote = useCallback(async (url: string, network: string | null) => {
    setRemoteBook({ ...IDLE_REMOTE, status: 'loading', url, network });
    try {
      const requestUrl = new URL(url, window.location.href);
      if (network) requestUrl.searchParams.set('network', network);
      const response = await fetch(requestUrl.toString(), {
        // Same-origin cookies only: the hosted copy sits behind an auth proxy
        // on its own origin. A cross-origin URL therefore gets no credentials
        // and the proxy answers 401, which surfaces as the red banner.
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`Remote address book: HTTP ${response.status}`);
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        // An auth proxy that answers 200 with an HTML login page lands here.
        throw new Error('Remote address book: response was not JSON');
      }
      const result = parseRemoteAddressBook(json, network ? { network } : {});
      setRemoteBook({
        status: 'ok',
        url,
        network,
        entries: result.entries,
        skipped: result.skipped,
        conflicts: [],
        fetchedAt: new Date(),
        error: null,
        sourceName: result.sourceName,
      });
    } catch (e) {
      // Fail closed and loudly: no entries, and the slot leaves 'idle' so the
      // unknown-address tint stays on. A silent empty book would make every
      // address look unchecked-but-fine.
      setRemoteBook({
        ...IDLE_REMOTE,
        status: 'error',
        url,
        network,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  const clearRemote = useCallback(() => setRemoteBook(IDLE_REMOTE), []);

  // Conflicts are a property of the merge, not of the fetch, so they are
  // computed against the current CSV book and mirrored back into the slot for
  // the bar to count.
  const conflicts = useMemo(
    () => mergeAddressBooks(addressBook?.entries ?? [], remoteBook.entries).conflicts,
    [addressBook, remoteBook.entries]
  );

  const loadAddressBook = useCallback(async (file: File) => {
    const text = await file.text();
    const { kind } = classifyConfigCsv(text);
    if (kind === 'my-safes') {
      throw new Error('This looks like a "My Safes" file (Safe rows). Load it under My Safes, not Address book.');
    }
    if (kind === 'mixed') {
      throw new Error('Address book files should contain only address labels, but this file also has Safe rows.');
    }
    const result = parseAddressBookCsv(text);
    setAddressBook({
      entries: result.entries,
      skipped: result.skipped,
      filename: file.name,
      loadedAt: new Date(),
    });
  }, []);

  const loadMySafes = useCallback(async (file: File) => {
    const text = await file.text();
    const { kind } = classifyConfigCsv(text);
    if (kind === 'address-book') {
      throw new Error(
        'This looks like an Address book file (address labels). Load it under Address book, not My Safes.'
      );
    }
    if (kind === 'mixed') {
      throw new Error('My Safes files should contain only Safe rows, but this file also has address labels.');
    }
    const result = parseAddressBookCsv(text);
    setMySafes({
      safes: result.safes,
      skipped: result.skipped,
      filename: file.name,
      loadedAt: new Date(),
    });
  }, []);

  const clearAddressBook = useCallback(() => setAddressBook(null), []);
  const clearMySafes = useCallback(() => setMySafes(null), []);

  const addSafe = useCallback((safe: AddressBookSafe) => {
    setMySafes((prev) => {
      const base: MySafesSlot = prev ?? {
        safes: [],
        skipped: [],
        filename: 'my-safes.csv',
        loadedAt: new Date(),
      };
      const key = lc(safe.address);
      const safes = [...base.safes];
      const idx = safes.findIndex((s) => s.network === safe.network && lc(s.address) === key);
      if (idx >= 0) safes[idx] = safe;
      else safes.push(safe);
      return { ...base, safes };
    });
  }, []);

  const removeSafe = useCallback((network: string, address: string) => {
    setMySafes((prev) => {
      if (!prev) return prev;
      const key = lc(address);
      return { ...prev, safes: prev.safes.filter((s) => !(s.network === network && lc(s.address) === key)) };
    });
  }, []);

  const renameSafe = useCallback((network: string, address: string, label: string) => {
    setMySafes((prev) => {
      if (!prev) return prev;
      const key = lc(address);
      return {
        ...prev,
        safes: prev.safes.map((s) => (s.network === network && lc(s.address) === key ? { ...s, label } : s)),
      };
    });
  }, []);

  const value = useMemo<AddressBookContextValue>(
    () => ({
      addressBook,
      mySafes,
      remoteBook: { ...remoteBook, conflicts },
      loadRemote,
      clearRemote,
      loadAddressBook,
      loadMySafes,
      clearAddressBook,
      clearMySafes,
      addSafe,
      removeSafe,
      renameSafe,
      exportMySafes: () => serializeAddressBookCsv({ entries: [], safes: mySafes?.safes ?? [] }, { kind: 'my-safes' }),
    }),
    [
      addressBook,
      mySafes,
      remoteBook,
      conflicts,
      loadRemote,
      clearRemote,
      loadAddressBook,
      loadMySafes,
      clearAddressBook,
      clearMySafes,
      addSafe,
      removeSafe,
      renameSafe,
    ]
  );

  return <AddressBookContext.Provider value={value}>{children}</AddressBookContext.Provider>;
}

/**
 * Drives the automatic remote fetch. Rendered INSIDE the router (App.tsx),
 * because AddressBookProvider sits outside HashRouter and so cannot read the
 * route itself. Re-fetches when the configured URL or the route network
 * changes, so a per-network book follows the Safe being reviewed.
 *
 * Renders nothing.
 */
export function RemoteAddressBookLoader() {
  const { remoteBook, loadRemote } = useAddressBook();
  const { remoteAddressBookUrl } = useSettings();
  const match = useMatch('/safe/:network/*');
  const network = match?.params.network ?? null;

  useEffect(() => {
    if (remoteAddressBookUrl === '') return;
    if (remoteBook.status === 'loading') return;
    // A failed fetch keeps its url/network, so this does not retry in a loop.
    // Retry is a deliberate act: the button on the bar or on Settings.
    const stale =
      remoteBook.status === 'idle' || remoteBook.url !== remoteAddressBookUrl || remoteBook.network !== network;
    if (!stale) return;
    void loadRemote(remoteAddressBookUrl, network);
  }, [remoteAddressBookUrl, network, remoteBook.status, remoteBook.url, remoteBook.network, loadRemote]);

  return null;
}

export function useAddressBook(): AddressBookContextValue {
  const ctx = useContext(AddressBookContext);
  if (!ctx) {
    throw new Error('useAddressBook must be used within an AddressBookProvider');
  }
  return ctx;
}
