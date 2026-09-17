/**
 * Session-only app settings.
 *
 * Like the address book, settings are held in memory only — there is no
 * localStorage anywhere in this app, and that is deliberate for a security
 * tool. A setting therefore resets to its default on every load, and the
 * default is the safe one.
 *
 * Two settings. The remote address book URL is documented on the field below.
 *
 * The Sourcify ABI fallback: when the Safe Transaction
 * Service cannot decode a call, and this is enabled, the app fetches the
 * contract's verified ABI from Sourcify and decodes with it. It is ON by
 * default: the Safe API decoding gap is common enough that a signer is better
 * served seeing a verified decoding than raw bytes. The request it makes to
 * sourcify.dev reveals which contract — and therefore which transaction — is
 * being inspected; a signer who does not want that egress can turn it off. The
 * decoding it produces is always re-encoded and byte-compared against the raw
 * calldata before display, exactly like Safe API decodings.
 */

import { createContext, useContext, useState, type ReactNode } from 'react';

interface SettingsValue {
  /** Fetch a verified ABI from Sourcify when the Safe API cannot decode a call. */
  sourcifyFallback: boolean;
  setSourcifyFallback: (enabled: boolean) => void;
  /** URL of the remote address book service. Empty means not configured. */
  remoteAddressBookUrl: string;
  setRemoteAddressBookUrl: (url: string) => void;
}

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [sourcifyFallback, setSourcifyFallback] = useState(true);
  // A build-time default is configuration, not persisted state: it ships with
  // the bundle and is re-read from the bundle on every load, so it cannot go
  // stale or be tampered with in the browser the way a localStorage copy
  // could. The hosted copy behind the auth proxy builds with this set to
  // /api/v1/addresses; every other build starts empty. Editing it here changes
  // the session only — nothing is written anywhere.
  const [remoteAddressBookUrl, setRemoteAddressBookUrl] = useState(
    import.meta.env.VITE_REMOTE_ADDRESS_BOOK_URL ?? ''
  );

  return (
    <SettingsContext.Provider
      value={{ sourcifyFallback, setSourcifyFallback, remoteAddressBookUrl, setRemoteAddressBookUrl }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return ctx;
}
