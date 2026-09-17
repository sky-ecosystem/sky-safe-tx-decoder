/**
 * Address — single render path for any Ethereum address shown in the UI.
 *
 * Resolves both built-in tags and address-book tags via core.getAddressTags()
 * and renders the appropriate badge. Built-in + address-book are shown together
 * (e.g. "LockstakeEngine · Sky Staking Vault") so signers see that the protocol
 * is recognized AND that they have explicitly verified it.
 *
 * Three rules hold in every state:
 *   - The address is written in full, EIP-55 checksummed, in monospace. A
 *     truncated address cannot be compared against a source of truth, which is
 *     the only reason to show one.
 *   - A copy control writes the full value, so the signer never retypes it.
 *   - Provenance is on the badge only when two books are loaded and could
 *     disagree. The source is always in the tooltip.
 */

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { getAddressTags, toChecksumAddress, type AddressTag } from '@shield3/sky-safe-core';
import { useAddressBook } from '../address-book/AddressBookContext';
import { useOptionalSafeRoute } from '../safe-route/SafeRouteProvider';

interface AddressProps {
  address: string;
  /**
   * Override the Safe address for the "Your Safe" highlight. Optional —
   * by default the active SafeRouteProvider supplies it, so consumers in
   * /safe/* pages don't need to thread the prop manually. Pass explicitly
   * to render an address relative to a different Safe (rare).
   */
  safeAddress?: string;
  className?: string;
}

function pickBuiltIn(tags: AddressTag[]): AddressTag | undefined {
  return tags.find((t) => t.source === 'built-in');
}
function pickBook(tags: AddressTag[]): AddressTag | undefined {
  return tags.find((t) => t.source === 'address-book');
}

/**
 * EIP-55 casing, via core's wrapper around viem's getAddress. Anything that is
 * not a 20-byte hex address is shown exactly as given rather than hidden.
 */
function checksum(address: string): string {
  return toChecksumAddress(address) ?? address;
}

/** Which book supplied a label, for the tooltip. */
function sourceName(tag: AddressTag): string {
  if (tag.origin === 'remote') return 'Address book service';
  if (tag.origin === 'csv') return 'CSV address book';
  return 'Address book';
}

/**
 * Copy the full address. Quiet by design: the address is the thing to read,
 * this is the thing to click. At least 24 by 24 CSS px, so it is a comfortable
 * target without competing with the address.
 */
function CopyButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async (e: MouseEvent) => {
    // The address often sits inside a link or a clickable row.
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied (an insecure origin, or a browser policy). Silent:
      // the full address is on screen and can still be selected by hand.
    }
  };

  return (
    <button
      type="button"
      onClick={(e) => void copy(e)}
      aria-label={`Copy address ${address}`}
      className="inline-flex min-h-[24px] min-w-[24px] items-center justify-center rounded px-1 text-xs font-normal text-gray-500 hover:text-gray-900 hover:underline"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function Address({ address, safeAddress, className = '' }: AddressProps) {
  // The unknown-address tint only makes sense when we have a managed list of
  // known addresses to compare against (the address book).
  // A configured remote book that failed to load still counts as "a book is
  // in play": fail closed, so the unknown-address tint stays on instead of
  // every address looking plain and therefore fine.
  const { addressBook, remoteBook } = useAddressBook();
  const bookLoaded = addressBook !== null || remoteBook.status !== 'idle';
  // Two books are loaded and could disagree, so each label says which one it
  // came from. With a single book the marker is noise on every address.
  const twoBooks = addressBook !== null && remoteBook.status === 'ok';
  const routeCtx = useOptionalSafeRoute();
  // NEVER truncate — signers must see the full address to detect spoofs.
  const display = checksum(address);

  const origin = (tag: AddressTag): string => {
    if (!twoBooks) return '';
    if (tag.origin === 'remote') return ' (book)';
    if (tag.origin === 'csv') return ' (CSV)';
    return '';
  };

  const wrapper = (extra: string) =>
    `inline-flex flex-wrap items-center gap-1 max-w-full font-mono ${extra} ${className}`;

  const effectiveSafe = safeAddress ?? routeCtx?.safeAddress;
  const isSafe = effectiveSafe !== undefined && address.toLowerCase() === effectiveSafe.toLowerCase();

  if (isSafe) {
    return (
      <span
        className={wrapper('bg-blue-100 text-blue-900 px-1 rounded font-semibold')}
        title="This is your Safe address"
      >
        <span className="break-all">{display}</span>
        <CopyButton address={display} />
        <span className="text-xs bg-blue-200 px-1 rounded">Your Safe</span>
      </span>
    );
  }

  const tags = getAddressTags(address as `0x${string}`);
  const builtIn = pickBuiltIn(tags);
  const book = pickBook(tags);

  // Inactive address-book entry — harsh warning, beats any other state.
  if (book?.status === 'inactive') {
    return (
      <span
        className={wrapper('bg-red-100 text-red-900 border border-red-300 px-1 rounded')}
        title={`${sourceName(book)}: INACTIVE entry, verified ${book.verificationDate || 'n/a'}`}
      >
        <span className="break-all">{display}</span>
        <CopyButton address={display} />
        <span className="text-xs bg-red-600 text-white px-1 rounded font-semibold">
          INACTIVE: {book.label}
          {origin(book)}
        </span>
      </span>
    );
  }

  // The two address books disagree about this address. Show both labels rather
  // than one of them: a label the signer cannot check is worse than no label,
  // so the disagreement itself is the message.
  if (book?.conflict) {
    return (
      <span
        className={wrapper('bg-amber-50 text-amber-900 border border-amber-400 px-1 rounded')}
        title={
          `The address book service and your CSV file disagree about this address. ` +
          `Service: "${book.label}" (${book.status}, verified ${book.verificationDate || 'n/a'}). ` +
          `CSV: "${book.conflict.otherLabel}" (${book.conflict.otherStatus}). ` +
          `Resolve the disagreement at the source before you trust either label.`
        }
      >
        <span className="break-all">{display}</span>
        <CopyButton address={display} />
        <span className="text-xs bg-amber-300 px-1 rounded font-semibold">
          label conflict: {book.label} (book) vs {book.conflict.otherLabel} (CSV)
        </span>
      </span>
    );
  }

  // Both built-in and address-book entry — collapse to a single badge showing
  // the signer's label; the built-in protocol name moves to the tooltip to
  // avoid a redundant double badge.
  if (builtIn && book) {
    return (
      <span
        className={wrapper('bg-green-50 text-green-900 border border-green-300 px-1 rounded')}
        title={`${builtIn.label} — ${builtIn.description} • ${sourceName(book)}, verified ${
          book.verificationDate || 'n/a'
        }`}
      >
        <span className="break-all">{display}</span>
        <CopyButton address={display} />
        <span className="text-xs bg-green-200 px-1 rounded">
          {book.label}
          {origin(book)}
        </span>
      </span>
    );
  }

  // Address-book only.
  if (book) {
    return (
      <span
        className={wrapper('bg-green-50 text-green-900 border border-green-300 px-1 rounded')}
        title={`${sourceName(book)}: ${book.label}, verified ${book.verificationDate || 'n/a'}`}
      >
        <span className="break-all">{display}</span>
        <CopyButton address={display} />
        <span className="text-xs bg-green-200 px-1 rounded">
          {book.label}
          {origin(book)}
        </span>
      </span>
    );
  }

  // Built-in only — show the protocol label.
  if (builtIn) {
    return (
      <span className={wrapper('')} title={builtIn.description}>
        <span className="break-all">{display}</span>
        <CopyButton address={display} />
        <span className="text-xs bg-gray-200 text-gray-800 px-1 rounded">{builtIn.label}</span>
      </span>
    );
  }

  // Unlabeled. If a book is loaded, soft yellow tint; otherwise plain mono.
  if (bookLoaded) {
    return (
      <span className={wrapper('bg-yellow-50 text-yellow-900 px-1 rounded')} title="Not in your address book">
        <span className="break-all">{display}</span>
        <CopyButton address={display} />
      </span>
    );
  }

  return (
    <span className={wrapper('')}>
      <span className="break-all">{display}</span>
      <CopyButton address={display} />
    </span>
  );
}
