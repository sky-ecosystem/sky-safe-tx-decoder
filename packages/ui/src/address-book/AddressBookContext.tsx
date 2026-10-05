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
 *     disagreement is reported rather than resolved. Its URL comes from the
 *     deployment probe (/sky-safe-config.json) at run time, or from the manual
 *     override on the Settings page.
 *
 * Keeping them separate avoids a sync trap: updating the managed book never
 * touches your Safes, and capturing a Safe never forces you to re-merge the
 * book. Both are in-memory only (no localStorage); the files you keep externally
 * are the source of truth and are re-loaded each session.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMatch } from 'react-router-dom';
import {
  batchAddressTagChanges,
  buildAddressBookTag,
  buildMergedTag,
  checkRemoteAddressBookUrl,
  classifyConfigCsv,
  clearAddressBookTags,
  mergeAddressBooks,
  parseAddressBookCsv,
  parseRemoteAddressBook,
  parseSkySafeConfig,
  resolveAddressBookPageUrl,
  registerAddressTag,
  serializeAddressBookCsv,
  SKY_SAFE_CONFIG_PATH,
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

/**
 * Where the /sky-safe-config.json probe got to.
 *
 *   - skipped:        the page is not http(s) (an offline copy on file://).
 *   - probing:        the request is in flight; no URL decision yet.
 *   - configured:     the deployment named a URL.
 *   - not-configured: the deployment serves no config file (404).
 *   - error:          the probe failed; the reason is in the remote slot.
 */
export type DeploymentConfigStatus = 'skipped' | 'probing' | 'configured' | 'not-configured' | 'error';

/**
 * The remote address book as the security analysis needs it:
 *
 *   - none:    no remote book is configured. CSV-only behaviour.
 *   - loading: the probe is in flight, or a URL is in effect and the book has
 *              not answered yet. Recipients are not checked against it yet.
 *   - ok:      the book loaded; its entries are in the tag registry.
 *   - failed:  the probe or the fetch failed. Recipients are not checked
 *              against it.
 */
export type RemoteBookState = 'none' | 'loading' | 'ok' | 'failed';

interface AddressBookContextValue {
  /** Managed address book (labels). Read-only. */
  addressBook: AddressBookSlot | null;
  /** Remote address book fetched from the service. */
  remoteBook: RemoteBookSlot;
  /** Derived state of the remote book, for the security analysis. */
  remoteBookState: RemoteBookState;
  /** URL this deployment configured, or null when it configured none. */
  deploymentUrl: string | null;
  /** Same-origin page where a person opens the address book, or null. */
  addressBookPageUrl: string | null;
  /** Where the deployment-configuration probe got to. */
  configStatus: DeploymentConfigStatus;
  /** Fetch the remote address book. Never throws; failure lands in the slot. */
  loadRemote: (url: string, network: string | null) => Promise<void>;
  /** Retry whatever failed: the fetch if a URL is in play, else the probe. */
  retryRemote: () => void;
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

/** The manual override when the signer set one, else the deployment's URL. */
function effectiveRemoteUrl(override: string, deploymentUrl: string | null): string {
  const trimmed = override.trim();
  return trimmed !== '' ? trimmed : (deploymentUrl ?? '');
}

export function AddressBookProvider({ children }: { children: ReactNode }) {
  const [addressBook, setAddressBook] = useState<AddressBookSlot | null>(null);
  const [mySafes, setMySafes] = useState<MySafesSlot | null>(null);
  const [remoteBook, setRemoteBook] = useState<RemoteBookSlot>(IDLE_REMOTE);
  const [deploymentUrl, setDeploymentUrl] = useState<string | null>(null);
  const [addressBookPageUrl, setAddressBookPageUrl] = useState<string | null>(null);
  const [configStatus, setConfigStatus] = useState<DeploymentConfigStatus>('probing');
  const { remoteAddressBookUrl } = useSettings();
  const effectiveUrl = effectiveRemoteUrl(remoteAddressBookUrl, deploymentUrl);

  // An idle slot with a URL in effect is about to be fetched by
  // RemoteAddressBookLoader, so it counts as loading, as does the probe.
  const remoteBookState: RemoteBookState =
    remoteBook.status === 'error'
      ? 'failed'
      : remoteBook.status === 'ok'
        ? 'ok'
        : remoteBook.status === 'loading' || configStatus === 'probing' || effectiveUrl !== ''
          ? 'loading'
          : 'none';

  // The CSV book and the remote book are one list: merged so a disagreement
  // between them becomes a conflict on the tag rather than one silently chosen
  // label. Computed once and reused by the tag rebuild and by the bar's count.
  const merged = useMemo(
    () => mergeAddressBooks(addressBook?.entries ?? [], remoteBook.entries),
    [addressBook, remoteBook.entries]
  );

  // Rebuild the shared address-book tag bucket from ALL sources whenever any
  // slot changes. Centralizing here lets the sources coexist instead of
  // clobbering each other's tags. One batch, so subscribers (the address
  // badge, the security analysis; see useAddressTagsVersion) are told once,
  // after the whole rebuild, and never see the bucket half rebuilt.
  useEffect(() => {
    batchAddressTagChanges(() => {
      clearAddressBookTags();
      const byKey = new Map(merged.conflicts.map((c) => [lc(c.address), c]));
      for (const e of merged.entries) registerAddressTag(e.address, buildMergedTag(e, byKey.get(lc(e.address))));
      for (const s of mySafes?.safes ?? []) registerAddressTag(s.address, buildAddressBookTag(s));
    });
  }, [merged, mySafes]);

  /**
   * Fetch the remote address book. Never throws: every failure lands in the
   * slot as `error` with a message that names the cause, because a signer who
   * cannot see why the book is missing has no way to decide whether to sign.
   *
   * No result survives a failure and no result is cached: the slot is reset
   * before the request and rewritten whole afterwards.
   */
  const loadRemote = useCallback(async (url: string, network: string | null) => {
    setRemoteBook({ ...IDLE_REMOTE, status: 'loading', url, network });
    let path = url;
    try {
      // Origin and scheme first: its message is the whole explanation, and it
      // stops a cross-origin request before it is made.
      const requestUrl = checkRemoteAddressBookUrl(url, window.location.href);
      path = requestUrl.pathname;
      if (network) requestUrl.searchParams.set('network', network);

      let response: Response;
      try {
        response = await fetch(requestUrl.toString(), {
          // Same-origin cookies only: the hosted copy sits behind an auth proxy
          // on its own origin.
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
      } catch {
        throw new Error(`Remote address book at ${path} could not be reached. The service may be down.`);
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Remote address book at ${path} refused the request (HTTP ${response.status}). ` +
            `Sign in to the address book service in this browser, then retry.`
        );
      }
      if (!response.ok) {
        throw new Error(`Remote address book at ${path} returned HTTP ${response.status}.`);
      }

      // An auth proxy that answers 200 with an HTML sign-in page is the common
      // failure. The content type names it before the body is read.
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('application/json')) {
        throw new Error(
          `Remote address book at ${path} returned ${contentType || 'no content type'} instead of JSON. ` +
            `The URL probably points at a web page or a sign-in screen.`
        );
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new Error(`Remote address book at ${path} returned a body that is not JSON.`);
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

  /**
   * Read the deployment configuration from the same-origin probe path.
   *
   * The released artifact carries no URL, so the hosted copy is byte-identical
   * to it and this probe is the only configuration. A 404 means the deployment
   * configured nothing: the connector stays idle and says nothing. Every other
   * outcome is an error the signer can read.
   */
  const probeConfig = useCallback(async () => {
    const protocol = window.location.protocol;
    if (protocol !== 'http:' && protocol !== 'https:') {
      // An offline copy opened from disk. Nothing to probe, nothing to say.
      setDeploymentUrl(null);
      setAddressBookPageUrl(null);
      setConfigStatus('skipped');
      return;
    }
    setConfigStatus('probing');
    // A retried probe starts clean. Without this, a probe failure followed by
    // a 404 keeps the old error, and its banner, for the rest of the session.
    setRemoteBook((prev) => (prev.status === 'error' && prev.url === '' ? IDLE_REMOTE : prev));
    try {
      let response: Response;
      try {
        response = await fetch(SKY_SAFE_CONFIG_PATH, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
      } catch {
        throw new Error(`Deployment configuration ${SKY_SAFE_CONFIG_PATH} could not be reached.`);
      }
      if (response.status === 404) {
        setDeploymentUrl(null);
        setAddressBookPageUrl(null);
        setConfigStatus('not-configured');
        return;
      }
      if (!response.ok) {
        throw new Error(`Deployment configuration ${SKY_SAFE_CONFIG_PATH} returned HTTP ${response.status}`);
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new Error(`Deployment configuration ${SKY_SAFE_CONFIG_PATH} is not JSON`);
      }
      const config = parseSkySafeConfig(json);
      setDeploymentUrl(config.remoteAddressBookUrl);
      setAddressBookPageUrl(resolveAddressBookPageUrl(config.addressBookPageUrl, window.location.href));
      setConfigStatus('configured');
    } catch (e) {
      setDeploymentUrl(null);
      setAddressBookPageUrl(null);
      setConfigStatus('error');
      setRemoteBook({
        ...IDLE_REMOTE,
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    void probeConfig();
  }, [probeConfig]);

  const retryRemote = useCallback(() => {
    // A failure before any URL was known is a probe failure; retry that.
    if (remoteBook.url === '') {
      void probeConfig();
      return;
    }
    void loadRemote(remoteBook.url, remoteBook.network);
  }, [remoteBook.url, remoteBook.network, loadRemote, probeConfig]);

  const clearRemote = useCallback(() => setRemoteBook(IDLE_REMOTE), []);

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
      remoteBook: { ...remoteBook, conflicts: merged.conflicts },
      remoteBookState,
      deploymentUrl,
      addressBookPageUrl,
      configStatus,
      loadRemote,
      retryRemote,
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
      remoteBookState,
      deploymentUrl,
      addressBookPageUrl,
      configStatus,
      merged,
      loadRemote,
      retryRemote,
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
 * route itself. Re-fetches when the effective URL or the route network
 * changes, so a per-network book follows the Safe being reviewed.
 *
 * The effective URL is the manual override when the signer set one, else the
 * URL this deployment configured.
 *
 * Renders nothing.
 */
export function RemoteAddressBookLoader() {
  const { remoteBook, loadRemote, deploymentUrl } = useAddressBook();
  const { remoteAddressBookUrl } = useSettings();
  const match = useMatch('/safe/:network/*');
  const network = match?.params.network ?? null;
  const effectiveUrl = effectiveRemoteUrl(remoteAddressBookUrl, deploymentUrl);

  useEffect(() => {
    if (effectiveUrl === '') return;
    if (remoteBook.status === 'loading') return;
    // A failed fetch keeps its url/network, so this does not retry in a loop.
    // Retry is a deliberate act: the button on the bar or on Settings.
    const stale = remoteBook.status === 'idle' || remoteBook.url !== effectiveUrl || remoteBook.network !== network;
    if (!stale) return;
    void loadRemote(effectiveUrl, network);
  }, [effectiveUrl, network, remoteBook.status, remoteBook.url, remoteBook.network, loadRemote]);

  return null;
}

export function useAddressBook(): AddressBookContextValue {
  const ctx = useContext(AddressBookContext);
  if (!ctx) {
    throw new Error('useAddressBook must be used within an AddressBookProvider');
  }
  return ctx;
}
