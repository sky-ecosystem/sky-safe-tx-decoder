/**
 * Address — single render path for any Ethereum address shown in the UI.
 *
 * Resolves both built-in tags and address-book tags via core.getAddressTags()
 * and renders the appropriate badge. Built-in + address-book are shown together
 * (e.g. "LockstakeEngine · Sky Staking Vault") so signers see that the protocol
 * is recognized AND that they have explicitly verified it.
 */

import { getAddressTags, type AddressTag } from '@shield3/sky-safe-core';
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

export function Address({ address, safeAddress, className = '' }: AddressProps) {
  // The unknown-address tint only makes sense when we have a managed list of
  // known addresses to compare against (the address book).
  // A configured remote book that failed to load still counts as "a book is
  // in play": fail closed, so the unknown-address tint stays on instead of
  // every address looking plain and therefore fine.
  const { addressBook, remoteBook } = useAddressBook();
  const bookLoaded = addressBook !== null || remoteBook.status !== 'idle';
  const routeCtx = useOptionalSafeRoute();
  // NEVER truncate — signers must see the full address to detect spoofs.
  const display = address;

  const effectiveSafe = safeAddress ?? routeCtx?.safeAddress;
  const isSafe = effectiveSafe !== undefined && address.toLowerCase() === effectiveSafe.toLowerCase();

  if (isSafe) {
    return (
      <span
        className={`inline-flex items-center gap-1 bg-blue-100 text-blue-900 px-1 rounded font-mono font-semibold ${className}`}
        title="This is your Safe address"
      >
        {display}
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
        className={`inline-flex items-center gap-1 bg-red-100 text-red-900 border border-red-300 px-1 rounded font-mono ${className}`}
        title={`INACTIVE in address book — verified ${book.verificationDate || 'n/a'}`}
      >
        {display}
        <span className="text-xs bg-red-600 text-white px-1 rounded font-semibold">INACTIVE: {book.label}</span>
      </span>
    );
  }

  // The two address-book sources disagree about this address. Show both labels
  // rather than one of them: a label the signer cannot check is worse than no
  // label, so the disagreement itself is the message.
  if (book?.conflict) {
    return (
      <span
        className={`inline-flex items-center gap-1 bg-amber-50 text-amber-900 border border-amber-400 px-1 rounded font-mono ${className}`}
        title={
          `The remote address book and your CSV address book disagree about this address. ` +
          `Remote: "${book.label}" (${book.status}). CSV: "${book.conflict.otherLabel}" (${book.conflict.otherStatus}). ` +
          `Resolve the disagreement at the source before you trust either label.`
        }
      >
        {display}
        <span className="text-xs bg-amber-300 px-1 rounded font-semibold">
          ⚠ label conflict: {book.label} (remote) vs {book.conflict.otherLabel} (csv)
        </span>
      </span>
    );
  }

  // Both built-in and address-book entry — collapse to a single verified badge
  // showing the signer's label; the built-in protocol name moves to the tooltip
  // to avoid a redundant double badge.
  if (builtIn && book) {
    return (
      <span
        className={`inline-flex items-center gap-1 bg-green-50 text-green-900 border border-green-300 px-1 rounded font-mono ${className}`}
        title={`${builtIn.label} — ${builtIn.description} • verified ${book.verificationDate || 'n/a'}`}
      >
        {display}
        <span className="text-xs bg-green-200 px-1 rounded">
          ✓ {book.label}
          {book.origin === 'remote' && ' · remote'}
        </span>
      </span>
    );
  }

  // Address-book only — verified by the signer.
  if (book) {
    return (
      <span
        className={`inline-flex items-center gap-1 bg-green-50 text-green-900 border border-green-300 px-1 rounded font-mono ${className}`}
        title={`Address book: ${book.label} (verified ${book.verificationDate || 'n/a'})`}
      >
        {display}
        <span className="text-xs bg-green-200 px-1 rounded">
          ✓ {book.label}
          {book.origin === 'remote' && ' · remote'}
        </span>
      </span>
    );
  }

  // Built-in only — show the protocol label.
  if (builtIn) {
    return (
      <span className={`inline-flex items-center gap-1 font-mono ${className}`} title={builtIn.description}>
        {display}
        <span className="text-xs bg-gray-200 text-gray-800 px-1 rounded">{builtIn.label}</span>
      </span>
    );
  }

  // Unlabeled. If a book is loaded, soft yellow tint; otherwise plain mono.
  if (bookLoaded) {
    return (
      <span
        className={`bg-yellow-50 text-yellow-900 px-1 rounded font-mono ${className}`}
        title="Not in your address book"
      >
        {display}
      </span>
    );
  }

  return <span className={`font-mono ${className}`}>{display}</span>;
}
