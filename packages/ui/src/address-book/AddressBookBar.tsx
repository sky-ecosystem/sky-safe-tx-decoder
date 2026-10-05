/**
 * Header strip for the address config.
 *
 * One column holds the address book, the other My Safes (personal Safe
 * shortcuts, editable and exportable).
 *
 * The address-book column has two shapes, and only one source is primary at a
 * time:
 *   - A remote URL is in effect (from the deployment probe or the manual
 *     override): the remote book is the address book. The CSV slot drops to a
 *     text link for a signer who wants to compare a second list against it.
 *   - No remote URL: the CSV slot is the address book, as a drop zone.
 *
 * Lives globally in App.tsx — load a file once and every page picks it up.
 * Each slot validates the dropped file's kind and rejects the wrong one.
 */

import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useAddressBook } from './AddressBookContext';
import { AddressBookBrowser } from './AddressBookBrowser';
import { useSettings } from '../settings/SettingsContext';
import { downloadCsv } from './download';

// Blank templates with `#` comment lines (the parser skips them) so the user
// knows exactly what each column should be. The address book needs no type/
// network columns — every row is a plain address label.
const ADDRESS_BOOK_TEMPLATE = [
  '# sky-safe-config: address-book',
  '# Labels for known addresses — one row per address.',
  '# status must be "active" or "inactive".',
  'address,label,verification_date,status',
  '',
].join('\n');

const MY_SAFES_TEMPLATE = [
  '# sky-safe-config: my-safes',
  '# Your Safe shortcuts (home-page dropdown) — one row per Safe.',
  '# type is always "safe"; network is ethereum, base, or sepolia; status is active or inactive.',
  '# Example row (delete the leading # and edit):',
  '# safe,ethereum,0xYourSafeAddress________________________,My Treasury Safe,YYYY-MM-DD,active',
  'type,network,address,label,verification_date,status',
  '',
].join('\n');

function formatLoadedAt(d: Date): string {
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function AddressBookBar() {
  const {
    addressBook,
    mySafes,
    loadAddressBook,
    loadMySafes,
    clearAddressBook,
    clearMySafes,
    exportMySafes,
    deploymentUrl,
    configStatus,
  } = useAddressBook();
  const { remoteAddressBookUrl } = useSettings();

  // A remote book is in play when the signer overrode the URL or the
  // deployment configured one. Until the probe answers, nothing is decided:
  // showing the CSV slot as primary and then replacing it would tell the
  // signer the wrong thing for a moment.
  const remoteInEffect = remoteAddressBookUrl.trim() !== '' || deploymentUrl !== null;
  const undecided = configStatus === 'probing';

  return (
    <div className="border-b bg-gray-50">
      <div className="container mx-auto px-4 py-2 grid gap-2 md:grid-cols-2">
        {remoteInEffect || undecided ? (
          <RemoteBookColumn undecided={undecided && !remoteInEffect} />
        ) : (
          <ConfigSlot
            title="Address book (managed)"
            hint="labels known addresses during review"
            accentLoaded="border-green-300 bg-green-50 text-green-900"
            templateFilename="address-book-template.csv"
            templateCsv={ADDRESS_BOOK_TEMPLATE}
            onLoad={loadAddressBook}
            onClear={clearAddressBook}
            summary={addressBook ? plural(addressBook.entries.length, 'entry', 'entries') : null}
            loaded={
              addressBook
                ? {
                    filename: addressBook.filename,
                    loadedAt: addressBook.loadedAt,
                    skipped: addressBook.skipped.length,
                  }
                : null
            }
            renderBrowser={(onClose) =>
              addressBook ? (
                <AddressBookBrowser
                  title="Address book"
                  filename={addressBook.filename}
                  loadedAt={addressBook.loadedAt}
                  entries={addressBook.entries}
                  skipped={addressBook.skipped}
                  onClose={onClose}
                />
              ) : null
            }
          />
        )}

        <ConfigSlot
          title="My Safes"
          hint="your Safe shortcuts on the home page"
          accentLoaded="border-blue-300 bg-blue-50 text-blue-900"
          templateFilename="my-safes-template.csv"
          templateCsv={MY_SAFES_TEMPLATE}
          onLoad={loadMySafes}
          onClear={clearMySafes}
          onExport={mySafes ? () => downloadCsv(mySafes.filename, exportMySafes()) : undefined}
          summary={mySafes ? plural(mySafes.safes.length, 'Safe', 'Safes') : null}
          loaded={
            mySafes ? { filename: mySafes.filename, loadedAt: mySafes.loadedAt, skipped: mySafes.skipped.length } : null
          }
          renderBrowser={(onClose) =>
            mySafes ? (
              <AddressBookBrowser
                title="My Safes"
                filename={mySafes.filename}
                loadedAt={mySafes.loadedAt}
                safes={mySafes.safes}
                skipped={mySafes.skipped}
                onClose={onClose}
              />
            ) : null
          }
        />
      </div>
      <RemoteBookErrorBanner />
    </div>
  );
}

/**
 * The address-book column when a remote URL is in effect: the remote strip,
 * with the CSV comparison under it. A failed fetch says nothing here; the
 * full-width banner below the bar carries the whole message.
 */
function RemoteBookColumn({ undecided }: { undecided: boolean }) {
  const { remoteBook, loadRemote, addressBookPageUrl } = useAddressBook();
  const [showBrowser, setShowBrowser] = useState(false);
  const loading = undecided || remoteBook.status === 'loading';

  return (
    <div className="flex h-full flex-col justify-center gap-1">
      {loading && <p className="text-sm text-gray-700">Address book: loading</p>}

      {!loading && remoteBook.status === 'ok' && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 rounded border border-gray-300 bg-white text-sm">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">Address book</span>
            <span className="text-xs text-gray-700">
              <span className="font-mono break-all">{remoteBook.sourceName ?? remoteBook.url}</span>
              {' · '}
              {plural(remoteBook.entries.length, 'entry', 'entries')}
              {remoteBook.skipped.length > 0 && <>{`, ${remoteBook.skipped.length} skipped`}</>}
              {remoteBook.conflicts.length > 0 && (
                <>{`, ${plural(remoteBook.conflicts.length, 'conflict', 'conflicts')} with the CSV file`}</>
              )}
              {remoteBook.fetchedAt && <>{` · fetched ${formatLoadedAt(remoteBook.fetchedAt)}`}</>}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <BarButton onClick={() => setShowBrowser(true)}>View</BarButton>
            <BarButton onClick={() => void loadRemote(remoteBook.url, remoteBook.network)}>Reload</BarButton>
          </div>
        </div>
      )}

      <CsvCompareSlot />

      {showBrowser && remoteBook.status === 'ok' && (
        <AddressBookBrowser
          title="Address book"
          filename={remoteBook.sourceName ?? remoteBook.url}
          loadedAt={remoteBook.fetchedAt ?? new Date()}
          entries={remoteBook.entries}
          skipped={remoteBook.skipped}
          manageHref={addressBookPageUrl}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </div>
  );
}

/**
 * The CSV address book as a second source: one text link until the signer asks
 * for it, then the same drop zone, then a quiet loaded line.
 */
function CsvCompareSlot() {
  const { addressBook, loadAddressBook, clearAddressBook } = useAddressBook();
  const [revealed, setRevealed] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);

  if (addressBook) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-700">
        <span>
          CSV: <span className="font-mono break-all">{addressBook.filename}</span>
          {`, ${plural(addressBook.entries.length, 'entry', 'entries')}`}
          {addressBook.skipped.length > 0 && <>{`, ${addressBook.skipped.length} skipped`}</>}
          {`, loaded ${formatLoadedAt(addressBook.loadedAt)}`}
        </span>
        <span className="flex items-center gap-2">
          <BarButton onClick={() => setShowBrowser(true)}>View</BarButton>
          <BarButton
            onClick={() => {
              setRevealed(false);
              clearAddressBook();
            }}
          >
            Clear
          </BarButton>
        </span>
        {showBrowser && (
          <AddressBookBrowser
            title="CSV address book"
            filename={addressBook.filename}
            loadedAt={addressBook.loadedAt}
            entries={addressBook.entries}
            skipped={addressBook.skipped}
            onClose={() => setShowBrowser(false)}
          />
        )}
      </div>
    );
  }

  if (!revealed) {
    return (
      <div className="text-xs">
        <button type="button" onClick={() => setRevealed(true)} className="text-blue-600 hover:underline">
          Add addresses from a CSV file
        </button>
      </div>
    );
  }

  return (
    <CsvDropZone
      title="CSV address book"
      hint="labels for addresses the address book does not have; a clash with the book is shown on the address"
      templateFilename="address-book-template.csv"
      templateCsv={ADDRESS_BOOK_TEMPLATE}
      onLoad={loadAddressBook}
    />
  );
}

/**
 * Full-width banner for a failed remote address book.
 *
 * Deliberately the loudest thing on the page. A signer who believes the book
 * is loaded, when it is not, reviews every address against nothing, so a
 * failure must be impossible to read past.
 */
function RemoteBookErrorBanner() {
  const { remoteBook, retryRemote } = useAddressBook();
  if (remoteBook.status !== 'error') return null;
  // The cause is one sentence and the consequence is the next one. Some causes
  // already carry their full stop; do not print two.
  const cause = /[.!?]$/.test(remoteBook.error ?? '') ? remoteBook.error : `${remoteBook.error}.`;
  return (
    <div className="bg-red-600 text-white">
      <div className="container mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <p className="font-bold text-sm">
          {cause} Address book labels are not shown.
        </p>
        <button
          type="button"
          onClick={retryRemote}
          className="text-xs font-semibold px-3 py-1.5 bg-white text-red-700 rounded hover:bg-red-50"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function BarButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs px-2 py-1 bg-white border border-gray-300 text-gray-700 rounded hover:bg-gray-100"
    >
      {children}
    </button>
  );
}

interface CsvDropZoneProps {
  title: string;
  hint: string;
  templateFilename: string;
  templateCsv: string;
  onLoad: (file: File) => Promise<void>;
}

/**
 * Drag-and-drop target for one config CSV, with its own error line. Shared by
 * the primary slots and by the CSV comparison under the remote strip.
 */
function CsvDropZone({ title, hint, templateFilename, templateCsv, onLoad }: CsvDropZoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setError(null);
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError(`Expected a .csv file (got "${file.name}").`);
      return;
    }
    try {
      await onLoad(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  };

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`flex h-full flex-col justify-center gap-1 px-3 py-2 rounded border-2 border-dashed text-sm transition-colors ${
          dragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300'
        }`}
      >
        <div className="text-gray-700">
          <span className="font-semibold">{title}:</span> drag a CSV here, or{' '}
          <button type="button" onClick={() => fileInputRef.current?.click()} className="text-blue-600 hover:underline">
            browse files
          </button>
          {' · '}
          <button
            type="button"
            onClick={() => downloadCsv(templateFilename, templateCsv)}
            className="text-blue-600 hover:underline"
          >
            blank template
          </button>
        </div>
        <div className="text-xs text-gray-500">{hint}</div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = '';
          }}
        />
      </div>
      {error && (
        <div className="mt-1 px-3 py-2 rounded border border-red-300 bg-red-50 text-sm text-red-800">{error}</div>
      )}
    </div>
  );
}

interface ConfigSlotProps {
  title: string;
  hint: string;
  accentLoaded: string;
  templateFilename: string;
  templateCsv: string;
  onLoad: (file: File) => Promise<void>;
  onClear: () => void;
  onExport?: () => void;
  summary: string | null;
  loaded: { filename: string; loadedAt: Date; skipped: number } | null;
  renderBrowser: (onClose: () => void) => ReactNode;
}

function ConfigSlot({
  title,
  hint,
  accentLoaded,
  templateFilename,
  templateCsv,
  onLoad,
  onClear,
  onExport,
  summary,
  loaded,
  renderBrowser,
}: ConfigSlotProps) {
  const [showBrowser, setShowBrowser] = useState(false);

  if (loaded === null) {
    return (
      <CsvDropZone
        title={title}
        hint={hint}
        templateFilename={templateFilename}
        templateCsv={templateCsv}
        onLoad={onLoad}
      />
    );
  }

  return (
    <div>
      <div
        className={`flex h-full flex-wrap items-center justify-between gap-3 px-3 py-2 rounded border text-sm ${accentLoaded}`}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold">{title}</span>
          <span className="text-xs">
            <span className="font-mono break-all">{loaded.filename}</span>
            {' · '}
            {summary}
            {loaded.skipped > 0 && (
              <>
                {', '}
                <span className="text-yellow-800 font-semibold">{loaded.skipped} skipped</span>
              </>
            )}
            {' · '}loaded {formatLoadedAt(loaded.loadedAt)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <BarButton onClick={() => setShowBrowser(true)}>View</BarButton>
          {onExport && <BarButton onClick={onExport}>Export</BarButton>}
          <BarButton onClick={onClear}>Clear</BarButton>
        </div>
      </div>
      {showBrowser && renderBrowser(() => setShowBrowser(false))}
    </div>
  );
}
