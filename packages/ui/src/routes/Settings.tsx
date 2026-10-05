/**
 * Settings page — the in-session config, in the order a signer cares about.
 *
 *   - Address book: the organisation's book on this origin when the deployment
 *     configured one (source, count, fetch time, a link to open it, Reload);
 *     otherwise the manual URL for a locally run copy.
 *   - CSV address book: read-only; on a hosted copy it is a comparison file.
 *   - My Safes (personal): add / edit label / remove, and export.
 *   - Decoding: the Sourcify fallback.
 *
 * Config is session-only (no localStorage). Nothing survives the tab.
 */

import { useState } from 'react';
import { useAddressBook } from '../address-book/AddressBookContext';
import { useSettings } from '../settings/SettingsContext';
import { EntryTable } from '../address-book/tables';
import { downloadCsv } from '../address-book/download';
import type { AddressBookSafe, AddressBookSkippedRow } from '@shield3/sky-safe-core';

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

const NETWORK_OPTIONS = [
  { value: 'ethereum', label: 'Ethereum Mainnet' },
  { value: 'base', label: 'Base' },
  { value: 'sepolia', label: 'Sepolia Testnet' },
];

function safeKey(network: string, address: string): string {
  return `${network}:${address.toLowerCase()}`;
}

function SkippedRows({ skipped }: { skipped: AddressBookSkippedRow[] }) {
  if (skipped.length === 0) return null;
  return (
    <div className="mt-3">
      <h4 className="text-xs font-semibold text-yellow-800 mb-1">Skipped rows ({skipped.length})</h4>
      <div className="border border-yellow-200 bg-yellow-50 rounded">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-yellow-900 border-b border-yellow-200">
              <th className="px-3 py-2 w-16">Row</th>
              <th className="px-3 py-2">Reason</th>
              <th className="px-3 py-2">Raw</th>
            </tr>
          </thead>
          <tbody>
            {skipped.map((r, idx) => (
              <tr key={idx} className="border-b border-yellow-100 last:border-0">
                <td className="px-3 py-2 font-mono">{r.row}</td>
                <td className="px-3 py-2">{r.reason}</td>
                <td className="px-3 py-2 font-mono break-all">{r.raw}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddSafeForm() {
  const { addSafe } = useAddressBook();
  const [network, setNetwork] = useState('ethereum');
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const addr = address.trim();
    const lbl = label.trim();
    if (!ADDRESS_PATTERN.test(addr)) {
      setError('Enter a valid address (0x followed by 40 hex characters).');
      return;
    }
    if (!lbl) {
      setError('Enter a label.');
      return;
    }
    addSafe({ address: addr as `0x${string}`, label: lbl, network, status: 'active', verificationDate: '' });
    setAddress('');
    setLabel('');
    setError(null);
  };

  return (
    <form onSubmit={handleAdd} className="rounded-lg border border-gray-200 bg-gray-50 p-3 mb-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-600">
          Network
          <select
            value={network}
            onChange={(e) => setNetwork(e.target.value)}
            className="block mt-1 px-2 py-1 border border-gray-300 rounded text-sm bg-white"
          >
            {NETWORK_OPTIONS.map((n) => (
              <option key={n.value} value={n.value}>
                {n.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-gray-600 flex-1 min-w-[20rem]">
          Safe address
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x…"
            className="block mt-1 w-full px-2 py-1 border border-gray-300 rounded text-sm font-mono"
          />
        </label>
        <label className="text-xs text-gray-600 flex-1 min-w-[12rem]">
          Label
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Treasury Safe"
            className="block mt-1 w-full px-2 py-1 border border-gray-300 rounded text-sm"
          />
        </label>
        <button type="submit" className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
          Add Safe
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </form>
  );
}

function MySafesTable({ safes }: { safes: AddressBookSafe[] }) {
  const { removeSafe, renameSafe } = useAddressBook();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (safes.length === 0) {
    return <p className="text-sm text-gray-500">No Safes yet. Add one above, or open a Safe and use the banner.</p>;
  }

  const startEdit = (s: AddressBookSafe) => {
    setEditingKey(safeKey(s.network, s.address));
    setDraft(s.label);
  };
  const saveEdit = (s: AddressBookSafe) => {
    const t = draft.trim();
    if (t) renameSafe(s.network, s.address, t);
    setEditingKey(null);
  };

  return (
    <div className="border rounded overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left bg-gray-50 border-b">
            <th className="px-3 py-2 w-28">Network</th>
            <th className="px-3 py-2">Address</th>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2 w-20">Status</th>
            <th className="px-3 py-2 w-36" />
          </tr>
        </thead>
        <tbody>
          {safes.map((s) => {
            const key = safeKey(s.network, s.address);
            const editing = editingKey === key;
            return (
              <tr key={key} className="border-b last:border-0 hover:bg-gray-50">
                <td className="px-3 py-2 font-mono">{s.network}</td>
                <td className="px-3 py-2 font-mono break-all">{s.address}</td>
                <td className="px-3 py-2">
                  {editing ? (
                    <input
                      type="text"
                      value={draft}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveEdit(s);
                        if (e.key === 'Escape') setEditingKey(null);
                      }}
                      className="w-full px-1 py-0.5 border border-gray-300 rounded text-xs"
                    />
                  ) : (
                    s.label
                  )}
                </td>
                <td className="px-3 py-2">{s.status}</td>
                <td className="px-3 py-2">
                  {editing ? (
                    <span className="flex gap-2">
                      <button type="button" onClick={() => saveEdit(s)} className="text-blue-600 hover:underline">
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingKey(null)}
                        className="text-gray-500 hover:underline"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="flex gap-2">
                      <button type="button" onClick={() => startEdit(s)} className="text-blue-600 hover:underline">
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => removeSafe(s.network, s.address)}
                        className="text-red-600 hover:underline"
                      >
                        Remove
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatFetchedAt(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The manual URL for a locally run copy: input, Load, Clear, and the rule. */
function OverrideUrlFields() {
  const { loadRemote, clearRemote } = useAddressBook();
  const { remoteAddressBookUrl, setRemoteAddressBookUrl } = useSettings();
  const override = remoteAddressBookUrl.trim();
  return (
    <>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-600 flex-1 min-w-[20rem]">
          Address book URL
          <input
            type="text"
            value={remoteAddressBookUrl}
            onChange={(e) => setRemoteAddressBookUrl(e.target.value)}
            placeholder="/api/v1/addresses"
            className="block mt-1 w-full px-2 py-1 border border-gray-300 rounded text-sm font-mono"
          />
        </label>
        <button
          type="button"
          disabled={override === ''}
          onClick={() => void loadRemote(override, null)}
          className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:bg-gray-300"
        >
          Load
        </button>
        <button
          type="button"
          // Clearing the URL too, otherwise the auto-loader refetches at once.
          onClick={() => {
            setRemoteAddressBookUrl('');
            clearRemote();
          }}
          className="px-3 py-1.5 border border-gray-300 rounded text-sm hover:bg-gray-100"
        >
          Clear
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-600">
        The URL must be on this page&apos;s origin. A local dev server needs a proxy so the path is same-origin.
      </p>
    </>
  );
}

function AddressBookSection() {
  const { remoteBook, loadRemote, deploymentUrl, addressBookPageUrl } = useAddressBook();
  const configured = deploymentUrl !== null;

  return (
    <section>
      <h3 className="text-xl font-semibold mb-1">Address book</h3>
      {configured ? (
        <>
          <p className="text-sm text-gray-600 mb-3">
            This deployment loads labels from the organisation&apos;s address book on this origin. When it cannot be
            reached, a red banner says why and its labels are not shown.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 rounded border border-gray-300 bg-white text-sm">
            <span className="text-gray-800">
              {remoteBook.status === 'ok' && (
                <>
                  <span className="font-mono break-all">{remoteBook.sourceName ?? remoteBook.url}</span>
                  {` · ${remoteBook.entries.length} entries`}
                  {remoteBook.skipped.length > 0 && <>{`, ${remoteBook.skipped.length} skipped`}</>}
                  {remoteBook.conflicts.length > 0 && <>{`, ${remoteBook.conflicts.length} conflicts with the CSV file`}</>}
                  {remoteBook.fetchedAt && <>{` · fetched ${formatFetchedAt(remoteBook.fetchedAt)}`}</>}
                </>
              )}
              {remoteBook.status === 'loading' && 'Loading'}
              {remoteBook.status === 'error' && <span className="font-semibold text-red-700">{remoteBook.error}</span>}
              {remoteBook.status === 'idle' && (
                <>
                  Configured at <span className="font-mono break-all">{deploymentUrl}</span>
                </>
              )}
            </span>
            <span className="flex items-center gap-3">
              {addressBookPageUrl && (
                <a href={addressBookPageUrl} className="text-blue-700 hover:underline whitespace-nowrap">
                  Open address book ↗
                </a>
              )}
              <button
                type="button"
                onClick={() => void loadRemote(remoteBook.url || deploymentUrl, remoteBook.network)}
                className="px-3 py-1 border border-gray-300 rounded text-sm hover:bg-gray-100"
              >
                Reload
              </button>
            </span>
          </div>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-gray-700">Use a different URL (locally run copy only)</summary>
            <div className="mt-2">
              <OverrideUrlFields />
            </div>
          </details>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-600 mb-3">
            Not configured by this deployment. A locally run copy can load the organisation&apos;s address book for
            this session from a URL on this origin.
          </p>
          <OverrideUrlFields />
          {remoteBook.status === 'error' && <p className="mt-2 text-sm font-semibold text-red-700">{remoteBook.error}</p>}
          {remoteBook.status === 'ok' && (
            <p className="mt-2 text-sm text-green-800">
              {remoteBook.entries.length} entries, {remoteBook.skipped.length} skipped, {remoteBook.conflicts.length}{' '}
              conflicts with the CSV address book.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export default function Settings() {
  const { addressBook, mySafes, exportMySafes, deploymentUrl } = useAddressBook();
  const { sourcifyFallback, setSourcifyFallback } = useSettings();
  const hosted = deploymentUrl !== null;

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h2 className="text-3xl font-bold mb-2">Settings</h2>
        <p className="text-gray-600">
          {hosted
            ? 'Settings live in memory for this session. Nothing is kept after you close the tab.'
            : 'Settings live in memory for this session. The CSV files you keep are the source of truth; drag them onto the bar above to load them.'}
        </p>
      </div>

      <AddressBookSection />

      {/* CSV address book — read-only; a comparison file on the hosted copy */}
      <section>
        <h3 className="text-xl font-semibold mb-1">CSV address book</h3>
        {addressBook ? (
          <>
            <p className="text-sm text-gray-600 mb-3">
              <span className="font-mono break-all">{addressBook.filename}</span>
              {hosted ? ', compared against the address book above. ' : '. '}
              Replace it by loading another file on the bar above.
            </p>
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-semibold text-green-800 mb-2">
                  Active ({addressBook.entries.filter((e) => e.status === 'active').length})
                </h4>
                <EntryTable entries={addressBook.entries.filter((e) => e.status === 'active')} />
              </div>
              {addressBook.entries.some((e) => e.status === 'inactive') && (
                <div>
                  <h4 className="text-sm font-semibold text-red-800 mb-2">
                    Inactive ({addressBook.entries.filter((e) => e.status === 'inactive').length})
                  </h4>
                  <EntryTable entries={addressBook.entries.filter((e) => e.status === 'inactive')} />
                </div>
              )}
            </div>
            <SkippedRows skipped={addressBook.skipped} />
          </>
        ) : (
          <p className="text-sm text-gray-500">
            {hosted
              ? 'None loaded. To compare a CSV file against the address book above, drag it onto the bar.'
              : 'None loaded. Drag your CSV address book onto the bar above.'}
          </p>
        )}
      </section>

      {/* My Safes — add / edit / remove + export */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <h3 className="text-xl font-semibold">My Safes</h3>
            <p className="text-sm text-gray-600">Your personal Safe shortcuts (the home-page dropdown).</p>
          </div>
          {mySafes && mySafes.safes.length > 0 && (
            <button
              type="button"
              onClick={() => downloadCsv(mySafes.filename, exportMySafes())}
              className="text-sm px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Export My Safes (CSV)
            </button>
          )}
        </div>

        <AddSafeForm />
        <MySafesTable safes={mySafes?.safes ?? []} />
        {mySafes && <SkippedRows skipped={mySafes.skipped} />}
      </section>

      {/* Decoding — Sourcify fallback */}
      <section>
        <h3 className="text-xl font-semibold mb-1">Decoding</h3>
        <label className="flex items-start gap-3 mt-3 cursor-pointer">
          <input
            type="checkbox"
            checked={sourcifyFallback}
            onChange={(e) => setSourcifyFallback(e.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <span className="text-sm">
            <span className="font-semibold">Sourcify ABI fallback</span>
            <span className="block text-gray-600 mt-1">
              When the Safe Transaction Service returns no decoded data for a call, fetch the contract&apos;s verified
              ABI from Sourcify and decode with it, following an EIP-1967 proxy to its implementation when needed. The
              result is re-encoded and byte-compared against the raw calldata before it is shown, the same check applied
              to Safe API decodings.
            </span>
            <span className="block text-amber-700 mt-1">
              On by default. The request tells sourcify.dev which contract, and so which transaction, you are
              inspecting. Turn it off to make no such request.
            </span>
          </span>
        </label>
      </section>
    </div>
  );
}
