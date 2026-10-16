/**
 * The review a signer reads for one Safe transaction: security warnings, the
 * decoded and raw call, and the hashes to compare with a hardware wallet.
 *
 * Rendered by the queued-transaction page and by proposer mode from the same
 * `AnalyzedTransaction`, so both show the same text for the same fields. The
 * sections that exist only for a queued transaction (status, confirmations,
 * timeline, the API hash comparison) are the caller's, passed in or left out.
 *
 * The Sourcify fallback, the PAU dispatch check and the security analysis run
 * here, after the synchronous analysis, scoped to the `AnalyzedTransaction`
 * object they were started for.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  analyzeSecurity,
  pauVerificationTargets,
  verifyPauDispatches,
  describePauDispatchMismatch,
  isPauFrozenTableCaveat,
  decodeViaSourcify,
  getSourcifyContractUrl,
  getNetwork,
  type SecurityAnalysisResult,
  type SourcifyDecodeResult,
  type DecodedFunction,
  type PauVerification,
} from '@shield3/sky-safe-core';
import { AddressHighlighter } from '../components/AddressHighlighter';
import { Address } from '../components/Address';
import { ParamValue } from '../components/ParamValue';
import { WeiValue } from '../components/WeiValue';
import { HashHex } from '../components/HashHex';
import { NestedSafeHashes } from '../components/NestedSafeHashes';
import { useAddressBook } from '../address-book/AddressBookContext';
import { useAddressTagsVersion } from '../address-book/useAddressTagsVersion';
import { useSettings } from '../settings/SettingsContext';
import { decodingState, type AnalyzedTransaction } from './analyzeTransaction';

/**
 * Deep-convert bigints to strings so a decoded value can be rendered.
 * viem returns integers as bigint, and JSON.stringify (used by ParamValue for
 * arrays/tuples) throws on bigint. Scalars stay renderable — a numeric string
 * still gets the decimals picker.
 */
function toDisplayValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toDisplayValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toDisplayValue(v)]));
  }
  return value;
}

/**
 * Build a canonical function signature from a decoded method name and its
 * parameter types, e.g. `withdrawV3(address,address,uint256)`. Shown on every
 * decoded-method box so the Safe API and Sourcify boxes read the same way.
 */
function buildSignature(method: string, parameters: Array<{ type: string }>): string {
  return `${method}(${parameters.map((p) => p.type).join(',')})`;
}

/**
 * Shared parameter-row list for a decoded call. Used by the Safe API path and
 * the Sourcify path — the rows are identical; only the provenance banner above
 * them differs. Values pass through toDisplayValue so bigints from viem render.
 */
function DecodedParamList({
  parameters,
  amountTarget,
}: {
  parameters: Array<{ name: string; type: string; value: unknown }>;
  /** Call target and signature, so a token amount can preselect its scale. */
  amountTarget?: { network: string; to: string; signature: string };
}) {
  if (parameters.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-gray-700">Parameters:</p>
      {parameters.map((param, i) => (
        <div key={i} className="text-xs">
          <span className="font-semibold">{param.name}</span>
          <span className="text-gray-500"> ({param.type})</span>
          <div className="bg-white p-2 rounded border mt-1 break-all">
            <ParamValue
              type={param.type}
              value={toDisplayValue(param.value)}
              amount={amountTarget ? { ...amountTarget, paramIndex: i } : undefined}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The calls a decoder unpacked out of one call — a MultiSend inside a
 * MultiSend, or the individual Controller calls inside a PAU
 * `AdministeredAgent.batchCall`.
 *
 * Shared by the top-level decoded pane and each MultiSend item, so a batch
 * renders the same wherever it appears. Before this existed only the top-level
 * pane rendered `nested`, and a batch reached through a MultiSend showed its
 * summary with none of its calls.
 */
/**
 * The warnings a decoding carries, minus the PAU frozen-table caveat.
 *
 * That caveat says the dispatch table was not checked against the chain. It is
 * correct for the CLI, which makes no network calls, and wrong here: this app
 * always runs the live check and surfaces the two problem states itself (a
 * verified result renders nothing).
 */
function withoutPauFrozenCaveat(warnings: string[] | undefined): string[] {
  return (warnings ?? []).filter((warning) => !isPauFrozenTableCaveat(warning));
}

function NestedCallList({ calls }: { calls: DecodedFunction[] }) {
  if (calls.length === 0) return null;
  return (
    <div className="border-t pt-4 mt-3">
      <p className="font-semibold mb-3">Nested Calls ({calls.length}):</p>
      <div className="space-y-3">
        {calls.map((call, idx) => (
          <div key={idx} className="bg-gray-50 rounded-lg p-4 border">
            <div className="flex items-start gap-2 mb-2">
              <span className="text-xs font-semibold text-purple-600 bg-purple-100 px-2 py-1 rounded">
                Call {idx + 1}
              </span>
              <div className="flex-1">
                <p className="font-semibold">{call.name}</p>
                <p className="text-xs font-mono text-gray-500 break-all">{call.signature}</p>
              </div>
            </div>
            {call.explanation && (
              <div className="text-sm text-gray-600 mb-2 whitespace-pre-wrap break-words">
                <AddressHighlighter text={call.explanation} />
              </div>
            )}
            {call.parameters.length > 0 && (
              <div className="space-y-2 mt-3">
                {call.parameters.map((param, i) => (
                  <div key={i} className="text-sm">
                    <span className="font-semibold">{param.name}</span>
                    <span className="text-gray-500"> ({param.type})</span>
                    <div className="text-xs bg-white p-2 rounded border mt-1 break-all">
                      <ParamValue type={param.type} value={toDisplayValue(param.value)} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* This call's own bytes, next to the decoding of those same bytes.
                Behind a disclosure because a signer reads the decoding first
                and the hex only to check it — never shortened, and never
                summarised. */}
            {call.rawCalldata && (
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer text-gray-600 hover:underline">
                  Raw calldata
                </summary>
                <div className="mt-1 bg-white p-2 rounded border font-mono break-all text-gray-700">
                  {call.rawCalldata}
                </div>
              </details>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Provenance banner for a PAU Controller call.
 *
 * The PAU decoder resolves a Controller call selector against a table frozen at
 * a recorded block. That table is a copy of on-chain state, and a stale copy
 * does not fail to decode — it names the wrong facet function while the
 * arguments still round-trip. The banner states which of the three cases the
 * signer is looking at, and never lets the frozen case pass silently.
 *
 * `mismatch` is rendered by the caller in place of the decoding, not beside it.
 */
function PauDispatchBanner({ results, pending }: { results: PauVerification[]; pending: boolean }) {
  if (pending) {
    return (
      <div className="mt-3 flex items-center gap-2 rounded border border-slate-300 bg-slate-50 p-2 text-xs text-slate-700" role="status" aria-live="polite">
        <Spinner />
        Checking the frozen PAU dispatch table against the Controller…
      </div>
    );
  }

  if (results.length === 0) return null;

  // A verified result renders nothing. The check exists to catch a stale
  // table; when the chain agrees, green text would only train signers to
  // scroll past banners. Only the two problem states speak.
  const unavailable = results.filter((result) => result.status === 'unavailable');

  return (
    <div className="mt-3 space-y-2">
      {unavailable.map((result, i) => (
        <div key={`u${i}`} className="rounded border border-amber-400 bg-amber-50 p-2 text-xs text-amber-900">
          <p className="font-semibold">Function names NOT verified against the chain this session.</p>
          {result.frozenAtBlock !== undefined ? (
            <>
              <p className="mt-1">
                Names come from a copy frozen at block {result.frozenAtBlock} (
                {result.frozenAtDate}).
              </p>
              <details className="mt-1">
                <summary className="cursor-pointer hover:underline">Details</summary>
                <p className="mt-1 break-all">
                  A selector rewired on chain since then would decode to the same argument types
                  under a different function name. Check {result.callSelectors.join(', ')} against
                  getDispatches on Controller {result.controller} before signing.
                </p>
                {result.reason && <p className="mt-1">Reason: {result.reason}</p>}
              </details>
            </>
          ) : (
            <>
              <p className="mt-1 break-all">Controller {result.controller}.</p>
              {result.reason && <p className="mt-1">Reason: {result.reason}</p>}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The refusal. Rendered instead of a decoding, never beside one.
 *
 * A frozen entry that disagrees with the chain would still produce a clean,
 * round-tripping decoding under the wrong function name, so presenting the
 * arguments at all would be presenting a claim this build cannot stand behind.
 */
function PauDispatchMismatchBlock({ results, calldata }: { results: PauVerification[]; calldata: string }) {
  return (
    <div className="mt-3 rounded border-4 border-red-500 bg-red-50 p-3">
      <p className="font-bold text-red-900">
        DO NOT SIGN — the Controller&apos;s dispatch table does not match this build&apos;s frozen copy.
      </p>
      <p className="mt-2 text-sm text-red-900">
        This build resolves a PAU call selector to a facet function through a table frozen at a
        recorded block. For this call the Controller reports something different, so the function
        name and arguments this build would show are not what executes. The decoding is withheld
        rather than shown with a caveat.
      </p>
      {results.map((result, i) => (
        <div key={i} className="mt-2 space-y-1">
          {result.frozenAtBlock !== undefined && (
            <p className="text-xs text-red-900">
              Controller {result.controller}, table frozen at block {result.frozenAtBlock} (
              {result.frozenAtDate}).
            </p>
          )}
          {result.mismatches.map((mismatch, j) => (
            <p key={j} className="text-xs text-red-900 break-all font-mono">
              {describePauDispatchMismatch(mismatch)}
            </p>
          ))}
        </div>
      ))}
      <p className="mt-2 text-xs font-semibold text-red-900">Raw calldata:</p>
      <p className="text-xs text-red-900 break-all font-mono">{calldata}</p>
    </div>
  );
}

/**
 * Small inline activity indicator for a pending Sourcify lookup. Deliberately
 * understated: it marks an answer as not-yet-known, and must not compete with
 * the warning styling reserved for a real decoding problem.
 */
function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 shrink-0 rounded-full border-2 border-slate-400 border-t-transparent animate-spin"
    />
  );
}

/**
 * Render a decoding obtained from a Sourcify ABI. Only the provenance banner is
 * Sourcify-specific — the source of a decoding matters to a signer, so it is
 * shown explicitly and distinctly from a Safe API decoding. The parameter rows
 * reuse DecodedParamList. A result that did not re-encode to the raw calldata
 * is shown as a hard DO-NOT-SIGN warning, never as a decoding.
 */
function SourcifyDecodedView({
  result,
  chainId,
  network,
  to,
}: {
  result: SourcifyDecodeResult;
  /** Chain id — for the Sourcify link, which is per-chain. */
  chainId: number;
  /** Network name — for the token-decimals lookup, which is per-network. */
  network: string;
  /** The call target. The ABI came from here unless a proxy was followed. */
  to: string;
}) {
  // Link to the contract whose ABI produced this decoding — the implementation
  // when a proxy was followed, otherwise the call target. Linking the proxy
  // instead would point a signer at sources that do not contain this function.
  const abiSource = result.implementation ?? to;
  if (result.status === 'mismatch') {
    return (
      <div className="bg-red-50 border-2 border-red-400 rounded p-3">
        <p className="font-semibold text-red-900 mb-1">⚠️ Sourcify decoding did not match the raw calldata</p>
        <p className="text-xs text-red-900 break-all">
          Decoding <span className="font-mono">{result.signature}</span> with the ABI from Sourcify re-encoded to
          different bytes than this call contains. The parameters cannot be trusted. DO NOT SIGN. Re-encoded:{' '}
          {result.reencoded}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="bg-blue-50 rounded p-3 border border-blue-200">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-semibold text-blue-900">Method: {result.method}</p>
          <a
            href={getSourcifyContractUrl(chainId, abiSource)}
            target="_blank"
            rel="noopener noreferrer"
            title={`ABI from Sourcify, verified against the contract's on-chain bytecode (not the Safe API). The decoded parameters re-encode to the exact bytes in this call. Opens the verified sources for ${abiSource} on Sourcify.`}
            className="text-xs font-semibold px-2 py-0.5 rounded bg-blue-100 text-blue-800 underline decoration-dotted underline-offset-2 hover:bg-blue-200"
          >
            Sourcify ↗
          </a>
          {result.implementation && (
            <span
              title={
                result.beacon
                  ? "This target is a beacon proxy. Its beacon was asked for the current implementation, and the call was decoded with that implementation's ABI."
                  : "This target is a proxy. The call was decoded with its EIP-1967 implementation's ABI."
              }
              className="text-xs font-semibold px-2 py-0.5 rounded bg-blue-100 text-blue-800"
            >
              {result.beacon ? 'via beacon implementation' : 'via implementation'}
            </span>
          )}
        </div>
        <p className="text-xs font-mono text-blue-700 mt-1">{result.signature}</p>
        {result.implementation && (
          <p className="text-xs text-gray-600 mt-1">
            {result.beacon ? (
              <>
                Proxy → beacon <span className="font-mono break-all">{result.beacon}</span> → implementation{' '}
                <span className="font-mono break-all">{result.implementation}</span>
              </>
            ) : (
              <>
                Proxy → implementation <span className="font-mono break-all">{result.implementation}</span>
              </>
            )}
          </p>
        )}
      </div>
      {/* Trailing calldata. The parameters below re-encode to the start of this
          call exactly, so they are shown normally — this is a warning about
          bytes they do not cover, not a reason to distrust them. Amber, not
          red: spending the red DO-NOT-SIGN banner on a call whose parameters
          are correct is what teaches signers to ignore it. */}
      {result.status === 'trailing-data' && (
        <div className="bg-amber-50 border-2 border-amber-400 rounded p-3">
          <p className="font-semibold text-amber-900">
            ⚠️ Extra calldata: {result.trailingBytes}{' '}
            {result.trailingBytes === 1 ? 'byte' : 'bytes'}
          </p>
          <p className="font-mono text-xs text-amber-900 break-all mt-1">{result.trailingData}</p>
          <p className="text-xs text-amber-900 mt-2">
            Parameters below are verified. These bytes are not part of them, and they are included
            in the hash you sign.
          </p>
          <p className="text-xs font-semibold text-amber-900 mt-2">
            Confirm they are expected for this contract.
          </p>
          {/* The mechanism is context, not an instruction. A signer mid-review
              needs the bytes and the action; the explanation is here for the
              one time they want it. */}
          <details className="mt-2">
            <summary className="text-xs text-amber-900 cursor-pointer hover:underline">
              Why this happens
            </summary>
            <p className="text-xs text-amber-900 mt-1">
              Appending bytes to calldata is always permitted — an ABI decoder checks that calldata
              is long enough for its parameters, not that it is exactly that length. SDKs use this
              for attribution tags. Most contracts ignore the extra bytes, but one that hashes its
              own calldata, forwards <span className="font-mono">msg.data</span>, or reads the tail
              deliberately (ERC-2771) does not.
            </p>
          </details>
        </div>
      )}
      {/* Always the call target, never the implementation: a token's identity
          is the address a transfer is sent to. For a proxied token (USDC) the
          proxy is the token; the implementation holds no balances. */}
      <DecodedParamList
        parameters={result.parameters}
        amountTarget={{ network, to, signature: result.signature }}
      />
    </div>
  );
}

/**
 * How the hashes are checked on this page.
 *
 * `queued`: the Safe API reported a safeTxHash for the record. The computed
 * hash is compared with it, and a mismatch is a DO NOT SIGN.
 *
 * `proposal`: nothing to compare with yet. The person compares the computed
 * safeTxHash with Safe's Hashes tab and with the hardware wallet.
 */
export type HashCheck = { kind: 'queued'; apiSafeTxHash: string } | { kind: 'proposal' };

export function TransactionReview({
  analyzed,
  hashCheck,
  beforeHashes,
  onRetryDecoder,
}: {
  analyzed: AnalyzedTransaction;
  hashCheck: HashCheck;
  /** Rendered between the transaction data and the hashes. */
  beforeHashes?: ReactNode;
  /**
   * Proposer mode: ask Safe's data decoder again. Offered only where the
   * decoder did not answer and nothing else decoded the call.
   */
  onRetryDecoder?: () => void;
}) {
  const { network, chainId, transaction, hashes, customDecoded, multiSendTxs, apiDecodedVerification, multiSendVerification } =
    analyzed;
  const address = analyzed.safeAddress;
  // The security analysis reads the core address tag registry, which effects
  // rewrite after this component renders (the address book rebuild, the
  // network swap). tagsVersion changes after every rewrite, so the analysis
  // below depends on it rather than on the slots that feed the registry.
  // remoteBookState tells the analysis when a configured remote book is still
  // loading or failed, so it never reports an all-clear in either case.
  const { remoteBookState } = useAddressBook();
  const tagsVersion = useAddressTagsVersion();
  const { sourcifyFallback } = useSettings();

  // Scoped to the analysis it was computed for, like the Sourcify and PAU
  // results below, so a new analysis never shows the previous one's warnings
  // for the frame before this effect runs.
  const [securityState, setSecurityState] = useState<{
    txKey: AnalyzedTransaction | null;
    result: SecurityAnalysisResult | null;
  }>({ txKey: null, result: null });
  // Sourcify fallback results — a decoding for a call the Safe API could not
  // decode, keyed by the nested MultiSend index (or 'top' for a direct call).
  // Each is re-encode-verified in core before it reaches here.
  const [sourcifyTop, setSourcifyTop] = useState<SourcifyDecodeResult | null>(null);
  const [sourcifyNested, setSourcifyNested] = useState<Record<number, SourcifyDecodeResult>>({});
  /**
   * Which Sourcify lookups have finished, keyed by target ('top' or a nested
   * MultiSend index) and scoped to one analysis.
   *
   * A target absent from `keys` has not produced an answer yet, so the UI shows
   * "checking" instead of a verdict. This is deliberately not a single boolean:
   * a global flag starts false, so the first paint claimed "Sourcify has no
   * verified ABI for it either" before any lookup had run, and then flipped once
   * a decoding arrived. A signer must never be shown a definitive
   * "cannot be decoded" that is merely "not asked yet".
   *
   * `txKey` scopes the map to the analysis it was built for, so switching
   * transactions cannot show the previous one's completions for a frame.
   */
  const [sourcifyDone, setSourcifyDone] = useState<{
    txKey: AnalyzedTransaction | null;
    keys: Record<string, boolean>;
  }>({
    txKey: null,
    keys: {},
  });
  /**
   * Live checks of the frozen PAU dispatch table, keyed the same way as the
   * Sourcify results ('top' or a nested MultiSend index) and scoped to one
   * analysis.
   *
   * `pending` starts true for every key that has PAU calldata, so the banner
   * says "checking" rather than showing a frozen-table caveat that a completed
   * check is about to replace.
   */
  const [pauChecks, setPauChecks] = useState<{
    txKey: AnalyzedTransaction | null;
    results: Record<string, PauVerification[]>;
    pending: Record<string, boolean>;
  }>({ txKey: null, results: {}, pending: {} });
  const [viewMode, setViewMode] = useState<'decoded' | 'raw'>('decoded');
  // Hash display case — default uppercase to match Ledger and similar devices.
  const [hashUppercase, setHashUppercase] = useState(true);

  // Re-run security analysis whenever the transaction OR address book changes.
  // Keeping this separate from the fetch means loading/clearing the book while
  // a transaction is open updates warnings live, without re-fetching.
  useEffect(() => {
    const analysis = analyzeSecurity(transaction, {
      additionalAddresses: analyzed.paramAddresses.map((address) => ({ address })),
      safeAddress: analyzed.safeAddress,
      remoteBook: remoteBookState === 'loading' || remoteBookState === 'failed' ? remoteBookState : undefined,
    });
    setSecurityState({ txKey: analyzed, result: analysis });
  }, [analyzed, transaction, tagsVersion, remoteBookState]);

  // `apiDecoded`, `hasCustomDecoding`, `hasCalldata` and `undecodable` come
  // from one expression shared with nothing else, so the Sourcify effect and
  // the render below agree. See decodingState.
  const { apiDecoded, hasCustomDecoding, undecodable } = decodingState(analyzed);

  // Sourcify fallback: for any call the Safe API could not decode and no custom
  // decoder covers, fetch the contract's verified ABI from Sourcify and decode
  // with it. Runs only when the setting is on. Kept separate from the analysis
  // so toggling the setting re-runs only this, and so a slow Sourcify request
  // never blocks the hash verification. Every result is re-encode-verified in
  // core before it is stored.
  useEffect(() => {
    // Clear prior results whenever the transaction or the setting changes, so a
    // disabled setting or a new transaction never shows a stale decoding.
    setSourcifyTop(null);
    setSourcifyNested({});
    setSourcifyDone({ txKey: analyzed, keys: {} });

    if (!sourcifyFallback) return;

    // Build the list of undecodable targets: a direct call with no decoding, or
    // each nested MultiSend item with neither a custom decoder nor API data.
    type Target = { key: 'top' | number; to: string; data: string };
    const targets: Target[] = [];

    // The same `undecodable` the render uses. See decodingState.
    if (undecodable && transaction.data) {
      targets.push({ key: 'top', to: transaction.to, data: transaction.data });
    }

    if (multiSendTxs) {
      multiSendTxs.forEach((item, index) => {
        const data = item.tx.data;
        if (!item.decoded && !item.apiDecoded && data && data !== '0x') {
          targets.push({ key: index, to: item.tx.to, data });
        }
      });
    }

    if (targets.length === 0) return;

    const controller = new AbortController();
    let cancelled = false;

    // Public RPC for this network — used only to resolve a proxy's EIP-1967
    // implementation (directly, or via its beacon) when the call target's own
    // ABI does not decode.
    const rpcUrl = (() => {
      try {
        return getNetwork(network).rpcUrl;
      } catch {
        return undefined;
      }
    })();

    (async () => {
      await Promise.all(
        targets.map(async (target) => {
          try {
            const decoded = await decodeViaSourcify({
              chainId,
              to: target.to,
              data: target.data as `0x${string}`,
              rpcUrl,
              signal: controller.signal,
            });
            if (cancelled) return;
            if (decoded) {
              if (target.key === 'top') {
                setSourcifyTop(decoded);
              } else {
                setSourcifyNested((prev) => ({ ...prev, [target.key as number]: decoded }));
              }
            }
          } finally {
            // Mark this target answered whether or not a decoding came back, so
            // its "checking" state resolves to a verdict. Per target, not per
            // batch: a MultiSend item that resolves early must not keep showing
            // "checking" until the slowest sibling finishes.
            if (!cancelled) {
              setSourcifyDone((prev) => ({ ...prev, keys: { ...prev.keys, [String(target.key)]: true } }));
            }
          }
        })
      );
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [analyzed, transaction, undecodable, multiSendTxs, sourcifyFallback, chainId, network]);

  // PAU dispatch check: for every call this transaction makes to a PAU
  // AdministeredAgent, ask the Controller what its call selectors dispatch to
  // and compare the answer to this build's frozen table.
  //
  // This is not an ABI lookup and is not gated on the Sourcify setting. The
  // frozen table is the one place in this tool where a stale copy produces a
  // confident WRONG label rather than a missing one, and one eth_call is what
  // turns that into a loud failure. When the call cannot be made the decoding
  // still renders, with the frozen-at block stated — which is also the CLI's
  // permanent behaviour, since the CLI makes no network calls at all.
  useEffect(() => {
    setPauChecks({ txKey: analyzed, results: {}, pending: {} });

    const work: Array<{ key: string; target: ReturnType<typeof pauVerificationTargets>[number] }> = [];

    const collect = (key: string, to: string, data: string | null | undefined) => {
      if (!data || data === '0x') return;
      for (const target of pauVerificationTargets(to, data as `0x${string}`)) {
        work.push({ key, target });
      }
    };

    collect('top', transaction.to, transaction.data);
    multiSendTxs?.forEach((item, index) => collect(String(index), item.tx.to, item.tx.data));

    if (work.length === 0) return;

    const pending: Record<string, boolean> = {};
    for (const item of work) pending[item.key] = true;
    setPauChecks({ txKey: analyzed, results: {}, pending });

    const controller = new AbortController();
    let cancelled = false;

    const rpcUrl = (() => {
      try {
        return getNetwork(network).rpcUrl;
      } catch {
        return undefined;
      }
    })();

    (async () => {
      await Promise.all(
        work.map(async ({ key, target }) => {
          const result = rpcUrl
            ? await verifyPauDispatches({ rpcUrl, target, signal: controller.signal })
            : ({
                controller: target.controller,
                status: 'unavailable' as const,
                callSelectors: target.callSelectors,
                mismatches: [],
                unknownSelectors: [],
                reason: 'no RPC endpoint is configured for this network',
              } satisfies PauVerification);
          if (cancelled) return;
          setPauChecks((prev) => ({
            txKey: prev.txKey,
            results: { ...prev.results, [key]: [...(prev.results[key] ?? []), result] },
            pending: { ...prev.pending, [key]: false },
          }));
        })
      );
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [analyzed, transaction, multiSendTxs, network]);

  const security = securityState.txKey === analyzed ? securityState.result : null;
  // Queued page only: the computed hash against the one the Safe API reported.
  // Proposer mode has nothing to compare with until the transaction exists.
  const hashesMatch = hashCheck.kind === 'queued' && hashes.safeTxHash === hashCheck.apiSafeTxHash;
  const hasRisks = security && security.overallRisk !== 'none';
  // Sourcify lookups still outstanding for this transaction. Computed during
  // render rather than read from a loading flag set inside the effect, so the
  // first paint already shows "checking" — the effect runs after paint, which is
  // what made a definitive "cannot be decoded" flash before the real answer.
  const sourcifyDoneKeys = sourcifyDone.txKey === analyzed ? sourcifyDone.keys : {};
  const sourcifyPendingTop = undecodable && !sourcifyTop && sourcifyFallback && !sourcifyDoneKeys['top'];
  const isNestedSourcifyPending = (idx: number) =>
    sourcifyFallback && !sourcifyNested[idx] && !sourcifyDoneKeys[String(idx)];
  // Force the raw view and disable the Decoded toggle only while nothing has
  // decoded the call. A Sourcify fallback result (verified in core) counts as a
  // decoding, so once it arrives the Decoded view becomes available again.
  // This also holds while a lookup is pending, so the raw bytes stay on screen
  // for the whole wait rather than the pane going empty.
  const showRawOnly = undecodable && !sourcifyTop;
  const effectiveViewMode = showRawOnly ? 'raw' : viewMode;

  // PAU dispatch check, scoped to this transaction the same way the Sourcify
  // results are. `pauRefused` gates the decoded rendering: a frozen entry that
  // disagrees with the chain is withheld, not annotated.
  const pauScoped = pauChecks.txKey === analyzed;
  const pauResults = (key: string) => (pauScoped ? (pauChecks.results[key] ?? []) : []);
  const pauPending = (key: string) => pauScoped && pauChecks.pending[key] === true;
  const pauRefused = (key: string) =>
    pauResults(key).some((result) => result.status === 'mismatch');

  return (
    <>
      {/* STEP 1: Security Warnings - MOST IMPORTANT */}
      {hasRisks && (
        <div
          className={`border-2 rounded-lg p-6 ${
            security.overallRisk === 'critical'
              ? 'border-red-600 bg-red-50'
              : security.overallRisk === 'high'
                ? 'border-orange-600 bg-orange-50'
                : security.overallRisk === 'medium'
                  ? 'border-yellow-600 bg-yellow-50'
                  : 'border-blue-500 bg-blue-50'
          }`}
        >
          <div className="flex items-start gap-3 mb-4">
            <div className="text-3xl">⚠️</div>
            <div className="flex-1">
              <h3 className="text-xl font-bold mb-1">Security Warnings</h3>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Risk Level:</span>
                <span
                  className={`px-3 py-1 rounded-full font-bold uppercase text-sm ${
                    security.overallRisk === 'critical'
                      ? 'bg-red-600 text-white'
                      : security.overallRisk === 'high'
                        ? 'bg-orange-600 text-white'
                        : security.overallRisk === 'medium'
                          ? 'bg-yellow-600 text-white'
                          : 'bg-blue-500 text-white'
                  }`}
                >
                  {security.overallRisk}
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            {security.delegateCall.warning && (
              <div className="bg-white rounded-lg p-4">
                <p className="font-semibold mb-2">🔴 Delegate Call Warning</p>
                <p className="text-sm">{security.delegateCall.warning}</p>
              </div>
            )}

            {security.gasToken.warnings.length > 0 && (
              <div className="bg-white rounded-lg p-4">
                <p className="font-semibold mb-2">🔴 Gas Token Attack</p>
                <ul className="text-sm space-y-1">
                  {security.gasToken.warnings.map((warning, i) => (
                    <li key={i}>• {warning}</li>
                  ))}
                </ul>
              </div>
            )}

            {security.ownerModification.warning && (
              <div className="bg-white rounded-lg p-4">
                <p className="font-semibold mb-2">🔴 Owner/Threshold Modification</p>
                <p className="text-sm">{security.ownerModification.warning}</p>
              </div>
            )}

            {security.moduleGuard.warnings && security.moduleGuard.warnings.length > 0 && (
              <div className="bg-white rounded-lg p-4">
                <p className="font-semibold mb-2">🔴 Module/Guard Warning</p>
                <ul className="text-sm space-y-1">
                  {security.moduleGuard.warnings.map((warning, i) => (
                    <li key={i}>• {warning}</li>
                  ))}
                </ul>
              </div>
            )}

            {(security.addressBook.warnings.length > 0 || security.addressBook.remoteBook) && (
              <div className="bg-white rounded-lg p-4">
                <p className="font-semibold mb-2">
                  {security.addressBook.warningLevel === 'high' ? '🔴' : '🟡'} Address Book
                </p>
                <ul className="text-sm space-y-1">
                  {/* A configured remote book that is not loaded. Never silent:
                      an empty section would read as every recipient checked. */}
                  {security.addressBook.remoteBook === 'failed' && (
                    <li>
                      • The address book did not load. Recipients are not checked.
                    </li>
                  )}
                  {security.addressBook.remoteBook === 'loading' && (
                    <li>
                      • The address book is loading. Recipients are not checked yet.
                    </li>
                  )}
                  {security.addressBook.warnings.map((r, i) => (
                    <li key={i}>
                      •{' '}
                      {r.status === 'inactive' ? (
                        <>
                          <strong>INACTIVE</strong> address ({r.label}) — <Address address={r.address} />
                          {r.isNested && ' (nested in MultiSend)'}
                        </>
                      ) : (
                        <>
                          Unknown address — <Address address={r.address} />
                          {r.isNested && ' (nested in MultiSend)'}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* STEP 2: Transaction Data - What are you signing? */}
      <div className="border-2 border-gray-300 rounded-lg overflow-hidden">
        <div className="bg-gray-100 p-4 border-b-2 border-gray-300">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xl font-bold">Transaction Data</h3>
              <p className="text-sm text-gray-600 mt-1">Review what this transaction does before signing</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setViewMode('decoded')}
                disabled={showRawOnly}
                title={
                  showRawOnly
                    ? analyzed.apiDecoderFailed
                      ? "Not decoded: Safe's decoder did not answer. Showing raw data."
                      : 'Not decoded: no ABI found. Showing raw data.'
                    : undefined
                }
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  showRawOnly
                    ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    : effectiveViewMode === 'decoded'
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                Decoded
              </button>
              <button
                onClick={() => setViewMode('raw')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  effectiveViewMode === 'raw' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                Raw
              </button>
            </div>
          </div>
        </div>

        <div className="p-6">
          {undecodable && sourcifyTop && (
            <div className="mb-6">
              <SourcifyDecodedView
                result={sourcifyTop}
                chainId={chainId}
                network={network}
                to={transaction.to}
              />
            </div>
          )}

          {undecodable && !sourcifyTop && sourcifyPendingTop && (
            <div className="mb-6 bg-slate-50 border border-slate-300 rounded-lg p-4" role="status" aria-live="polite">
              <div className="flex items-center gap-2">
                <Spinner />
                <p className="font-semibold text-slate-800">Checking Sourcify for a verified ABI…</p>
              </div>
            </div>
          )}

          {undecodable && !sourcifyTop && !sourcifyPendingTop && (
            <div className="mb-6 bg-amber-50 border-2 border-amber-400 rounded-lg p-4">
              {/* A decoder that did not answer is not a decoder that found
                  nothing. Say which, and offer the retry only for the first. */}
              {analyzed.apiDecoderFailed ? (
                <div className="flex items-center gap-3 flex-wrap">
                  <p className="font-semibold text-amber-900">Not decoded: Safe&apos;s decoder did not answer.</p>
                  {onRetryDecoder && (
                    <button
                    type="button"
                    onClick={onRetryDecoder}
                    className="px-3 py-1 text-xs font-semibold rounded border border-amber-500 bg-white text-amber-900 hover:bg-amber-100"
                  >
                    Retry
                  </button>
                  )}
                </div>
              ) : (
                <p className="font-semibold text-amber-900">Not decoded: no ABI found</p>
              )}
              <p className="text-sm text-amber-900 mt-1">
                Verify the raw data below independently before signing.
              </p>
              {!sourcifyFallback && (
                <p className="text-sm text-amber-900 mt-2">
                  Enable Sourcify fallback in Settings to search additional sources for the ABI.
                </p>
              )}
            </div>
          )}

          {effectiveViewMode === 'decoded' ? (
            <div className="space-y-6">
              {/* Which contract is being called, ABOVE the decoding — the same
                  order each nested MultiSend call uses.

                  It reads as a header rather than a footnote because the target
                  is what gives the decoding its meaning: "transfer 1" means
                  nothing until you know 1 of what, and the amount's decimal
                  scale is derived from this address. A signer who reads the
                  parameters first has already formed a belief about the amount
                  before learning which token it is denominated in. Two
                  different orders between direct and batched calls also trains
                  a habit that is wrong half the time. */}
              <div className="pb-4 border-b space-y-3 text-sm">
                <div>
                  <span className="text-gray-600 font-medium">To Address:</span>
                  <div className="text-xs mt-1 break-all">
                    <Address address={transaction.to} />
                  </div>
                </div>
                <div>
                  <span className="text-gray-600 font-medium">Value:</span> <WeiValue value={transaction.value} />
                </div>
                <div>
                  <span className="text-gray-600 font-medium">Operation:</span>{' '}
                  {transaction.operation === 0 ? 'Call' : transaction.operation === 1 ? 'DelegateCall' : 'Unknown'}
                </div>
              </div>

              {/* A PAU dispatch mismatch withholds the decoding entirely. See
                  PauDispatchMismatchBlock. */}
              {customDecoded && pauRefused('top') && (
                <PauDispatchMismatchBlock results={pauResults('top')} calldata={transaction.data ?? '0x'} />
              )}

              {/* Enhanced Custom Decoder */}
              {customDecoded && !pauRefused('top') && (
                <div className="space-y-4">
                  <PauDispatchBanner results={pauResults('top')} pending={pauPending('top')} />
                  <div className="bg-purple-50 rounded-lg p-4 border border-purple-200">
                    <div className="flex items-start gap-2 mb-3">
                      <span className="text-lg">🔍</span>
                      <div className="flex-1">
                        <p className="font-semibold text-purple-900 mb-1">{customDecoded.main.name}</p>
                        <p className="text-xs font-mono text-purple-600">{customDecoded.main.signature}</p>
                      </div>
                    </div>
                    {customDecoded.main.explanation && (
                      // whitespace-pre-wrap: decoder explanations may list one
                      // item per line (e.g. SPBEAM rate tables) and those line
                      // breaks are load-bearing for review.
                      <div className="text-sm text-gray-700 bg-white p-3 rounded whitespace-pre-wrap">
                        <AddressHighlighter text={customDecoded.main.explanation} />
                      </div>
                    )}
                  </div>

                  {/* Decoder self-check failures (e.g. the decoded parameters
                      do not re-encode to the raw calldata). Shown above the
                      parameters, because the parameters are what is untrusted. */}
                  {customDecoded.generalWarnings && customDecoded.generalWarnings.length > 0 && (
                    <div className="bg-red-50 border-2 border-red-400 rounded-lg p-4">
                      <p className="font-semibold text-red-900 mb-2">⚠️ Decoder verification failed</p>
                      <ul className="text-sm space-y-1">
                        {customDecoded.generalWarnings.map((warning, i) => (
                          <li key={i} className="text-red-900 break-all">
                            {warning}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {customDecoded.main.parameters.length > 0 && (
                    <div>
                      <p className="font-semibold mb-3">Parameters:</p>
                      <div className="space-y-3">
                        {customDecoded.main.parameters.map((param, i) => (
                          <div key={i} className="bg-gray-50 rounded-lg p-4">
                            <div className="flex items-start justify-between mb-2">
                              <span className="font-semibold">{param.name}</span>
                              <span className="text-xs text-gray-500 font-mono">{param.type}</span>
                            </div>
                            <div className="text-sm break-all bg-white p-3 rounded border">
                              <ParamValue type={param.type} value={param.value} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {withoutPauFrozenCaveat(customDecoded.main.warnings).length > 0 && (
                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                      <p className="font-semibold text-yellow-900 mb-2">⚠️ Function-Specific Warnings:</p>
                      <ul className="text-sm space-y-1">
                        {withoutPauFrozenCaveat(customDecoded.main.warnings).map((warning, i) => (
                          <li key={i} className="text-yellow-800">
                            • {warning}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Nested Calls */}
                  {customDecoded.nested && <NestedCallList calls={customDecoded.nested} />}
                </div>
              )}

              {/* MultiSend Batched Transactions */}
              {multiSendTxs && multiSendTxs.length > 0 && (
                <div className="space-y-4">
                  <div
                    className={`rounded-lg p-4 border ${
                      multiSendVerification?.status === 'mismatch'
                        ? 'bg-red-50 border-red-400'
                        : multiSendVerification?.status === 'unverifiable'
                          ? 'bg-amber-50 border-amber-400'
                          : 'bg-indigo-50 border-indigo-200'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-lg">📦</span>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-indigo-900">MultiSend Batch</p>
                          {multiSendVerification?.status === 'mismatch' && (
                            <span className="text-xs font-semibold px-2 py-0.5 rounded bg-red-100 text-red-800">
                              ⚠ Mismatch
                            </span>
                          )}
                          {multiSendVerification?.status === 'unverifiable' && (
                            <span className="text-xs font-semibold px-2 py-0.5 rounded bg-amber-100 text-amber-900">
                              ⚠ Unchecked
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-indigo-700">{multiSendTxs.length} transactions in this batch</p>
                        {multiSendVerification?.status === 'mismatch' && (
                          <p className="text-xs text-red-700 mt-2">⚠️ Warning: {multiSendVerification.error}</p>
                        )}
                        {multiSendVerification?.status === 'unverifiable' && (
                          <p className="text-xs text-amber-800 mt-2">
                            This decoding could not be checked against the raw data: {multiSendVerification.error}.
                            Nothing shown here has been verified — read the Raw view before signing.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {multiSendTxs.map((item, idx) => (
                    <div key={idx} className="bg-gray-50 rounded-lg p-4 border-2 border-gray-200">
                      <div className="flex items-start gap-3 mb-3">
                        <span className="text-sm font-bold text-indigo-600 bg-indigo-100 px-3 py-1 rounded-full">
                          #{idx + 1}
                        </span>
                        <div className="flex-1">
                          <div className="text-sm space-y-2">
                            <div>
                              <span className="text-gray-600 font-medium">To:</span>
                              <div className="text-xs mt-1 break-all">
                                <Address address={item.tx.to} />
                              </div>
                            </div>
                            <div>
                              <span className="text-gray-600 font-medium">Value:</span>{' '}
                              <WeiValue value={item.tx.value} />
                            </div>
                            <div>
                              <span className="text-gray-600 font-medium">Operation:</span>{' '}
                              {item.tx.operation === 0 ? 'Call' : item.tx.operation === 1 ? 'DelegateCall' : 'Unknown'}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* A PAU dispatch mismatch withholds this call's decoding. */}
                      {item.decoded && pauRefused(String(idx)) && (
                        <PauDispatchMismatchBlock
                          results={pauResults(String(idx))}
                          calldata={item.tx.data}
                        />
                      )}

                      {/* Custom decoded data for nested transaction */}
                      {item.decoded && !pauRefused(String(idx)) && (
                        <div className="mt-3 pt-3 border-t border-gray-300">
                          <PauDispatchBanner
                            results={pauResults(String(idx))}
                            pending={pauPending(String(idx))}
                          />
                          <div className="bg-purple-50 rounded p-3 border border-purple-200 mb-3 mt-3">
                            <p className="font-semibold text-purple-900">{item.decoded.main.name}</p>
                            <p className="text-xs font-mono text-purple-600">{item.decoded.main.signature}</p>
                            {item.decoded.main.explanation && (
                              <div className="text-sm text-gray-700 mt-2">
                                <AddressHighlighter text={item.decoded.main.explanation} />
                              </div>
                            )}
                          </div>
                          {item.decoded.main.parameters.length > 0 && (
                            <div className="space-y-2">
                              <p className="text-xs font-semibold text-gray-700">Parameters:</p>
                              {item.decoded.main.parameters.map((param, i) => (
                                <div key={i} className="text-xs">
                                  <span className="font-semibold">{param.name}</span>
                                  <span className="text-gray-500"> ({param.type})</span>
                                  <div className="bg-white p-2 rounded border mt-1 break-all">
                                    <ParamValue type={param.type} value={param.value} />
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          {item.decoded.generalWarnings && item.decoded.generalWarnings.length > 0 && (
                            <div className="mt-2 bg-red-50 border-2 border-red-400 rounded p-2">
                              <p className="text-xs font-semibold text-red-900 mb-1">⚠️ Decoder verification failed</p>
                              {item.decoded.generalWarnings.map((warning, i) => (
                                <p key={i} className="text-xs text-red-900 break-all">
                                  {warning}
                                </p>
                              ))}
                            </div>
                          )}
                          {withoutPauFrozenCaveat(item.decoded.main.warnings).length > 0 && (
                            <div className="mt-2 bg-yellow-50 border border-yellow-200 rounded p-2">
                              {withoutPauFrozenCaveat(item.decoded.main.warnings).map((warning, i) => (
                                <p key={i} className="text-xs text-yellow-800 break-all">
                                  ⚠️ {warning}
                                </p>
                              ))}
                            </div>
                          )}
                          {/* The calls this one unpacks into. A PAU batchCall
                              reached through a MultiSend renders every
                              Controller call here; without this the batch showed
                              only its summary. */}
                          {item.decoded.nested && <NestedCallList calls={item.decoded.nested} />}
                        </div>
                      )}

                      {/* Safe API decoded data (when no custom decoder) */}
                      {!item.decoded && item.apiDecoded && (
                        <div className="mt-3 pt-3 border-t border-gray-300">
                          <div
                            className={`rounded p-3 border mb-3 ${
                              item.verification?.status === 'mismatch'
                                ? 'bg-red-50 border-red-400'
                                : item.verification?.status === 'unverifiable'
                                  ? 'bg-amber-50 border-amber-400'
                                  : 'bg-blue-50 border-blue-200'
                            }`}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <p className="font-semibold text-blue-900">Method: {item.apiDecoded.method}</p>
                              {item.verification?.status === 'mismatch' && (
                                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-red-100 text-red-800">
                                  ⚠ Mismatch
                                </span>
                              )}
                              {item.verification?.status === 'unverifiable' && (
                                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-amber-100 text-amber-900">
                                  ⚠ Unchecked
                                </span>
                              )}
                            </div>
                            {item.verification?.status === 'mismatch' && (
                              <p className="text-xs text-red-700 mt-2">⚠️ Warning: {item.verification.error}</p>
                            )}
                            {item.verification?.status === 'unverifiable' && (
                              <p className="text-xs text-amber-800 mt-2">
                                This decoding could not be checked against the raw data: {item.verification.error}.
                                Nothing shown here has been verified — read the Raw view before signing.
                              </p>
                            )}
                            <p className="text-xs font-mono text-blue-700 mt-1">
                              {buildSignature(item.apiDecoded.method, item.apiDecoded.parameters)}
                            </p>
                          </div>
                          {/* No preselected scale unless this decoding was
                              proven against the raw bytes. A friendly "= 1,000
                              USDS" next to a mismatched or unchecked decoding
                              lends it credibility it has not earned. */}
                          <DecodedParamList
                            parameters={item.apiDecoded.parameters}
                            amountTarget={
                              item.verification && item.verification.status !== 'verified'
                                ? undefined
                                : {
                                    network,
                                    to: item.tx.to,
                                    signature: buildSignature(item.apiDecoded.method, item.apiDecoded.parameters),
                                  }
                            }
                          />
                        </div>
                      )}

                      {/* Neither a custom decoder nor the Safe API could decode
                          this nested call. Previously this rendered nothing at
                          all, so a call carrying real calldata showed only
                          To/Value/Operation — the function and its arguments
                          were hidden. Show the selector and the full calldata
                          so the signer can see and verify what is being called.
                          A call with no calldata is a plain value/no-op call
                          and is labelled as such. */}
                      {!item.decoded && !item.apiDecoded && (
                        <div className="mt-3 pt-3 border-t border-gray-300">
                          {sourcifyNested[idx] ? (
                            <SourcifyDecodedView
                              result={sourcifyNested[idx]!}
                              chainId={chainId}
                              network={network}
                              to={item.tx.to}
                            />
                          ) : item.tx.data && item.tx.data !== '0x' ? (
                            isNestedSourcifyPending(idx) ? (
                              <div className="bg-slate-50 rounded p-3 border border-slate-300" role="status" aria-live="polite">
                                <div className="flex items-center gap-2 mb-1">
                                  <Spinner />
                                  <p className="font-semibold text-slate-800">Checking Sourcify for a verified ABI…</p>
                                </div>
                                <p className="text-xs text-slate-700 mb-3">
                                  Neither the Safe API nor this tool could decode this call. Looking for an ABI verified
                                  against this contract&rsquo;s on-chain bytecode. The calldata below is already final
                                  and does not depend on the result.
                                </p>
                                <p className="text-xs font-semibold text-gray-700">Function selector:</p>
                                <p className="text-xs font-mono bg-white p-2 rounded border break-all mb-2">
                                  {item.tx.data.slice(0, 10)}
                                </p>
                                <p className="text-xs font-semibold text-gray-700">Calldata:</p>
                                <p className="text-xs font-mono bg-white p-2 rounded border break-all">{item.tx.data}</p>
                              </div>
                            ) : (
                              <div className="bg-amber-50 rounded p-3 border border-amber-200">
                                {analyzed.apiDecoderFailed ? (
                                  <div className="flex items-center gap-3 flex-wrap mb-1">
                                    <p className="font-semibold text-amber-900">
                                      Not decoded: Safe&apos;s decoder did not answer.
                                    </p>
                                    {onRetryDecoder && (
                                      <button
                                        type="button"
                                        onClick={onRetryDecoder}
                                        className="px-3 py-1 text-xs font-semibold rounded border border-amber-500 bg-white text-amber-900 hover:bg-amber-100"
                                      >
                                        Retry
                                      </button>
                                    )}
                                  </div>
                                ) : (
                                  <p className="font-semibold text-amber-900 mb-1">Not decoded: no ABI found</p>
                                )}
                                <p className="text-xs text-amber-800 mb-3">
                                  Verify the calldata below independently before signing.
                                  {!sourcifyFallback &&
                                    ' Enable Sourcify fallback in Settings to search additional sources for the ABI.'}
                                </p>
                                <p className="text-xs font-semibold text-gray-700">Function selector:</p>
                                <p className="text-xs font-mono bg-white p-2 rounded border break-all mb-2">
                                  {item.tx.data.slice(0, 10)}
                                </p>
                                <p className="text-xs font-semibold text-gray-700">Calldata:</p>
                                <p className="text-xs font-mono bg-white p-2 rounded border break-all">{item.tx.data}</p>
                              </div>
                            )
                          ) : (
                            <p className="text-xs text-gray-500">No calldata — this is a plain value/no-op call.</p>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Safe API Decoded Data (if no custom decoder). apiDecoded is
                  null for the "fallback" sentinel, so those route to the
                  undecodable block above instead of rendering here. */}
              {!hasCustomDecoding && apiDecoded && (
                <div className="space-y-4">
                  <div
                    className={`rounded-lg p-4 border ${
                      apiDecodedVerification?.status === 'mismatch'
                        ? 'bg-red-50 border-red-400'
                        : apiDecodedVerification?.status === 'unverifiable'
                          ? 'bg-amber-50 border-amber-400'
                          : 'bg-blue-50 border-blue-200'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <p className="font-semibold text-blue-900">Method: {apiDecoded.method}</p>
                      {apiDecodedVerification?.status === 'mismatch' && (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-red-100 text-red-800">
                          ⚠ Mismatch
                        </span>
                      )}
                      {apiDecodedVerification?.status === 'unverifiable' && (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-amber-100 text-amber-900">
                          ⚠ Unchecked
                        </span>
                      )}
                    </div>
                    {apiDecodedVerification?.status === 'mismatch' && (
                      <p className="text-xs text-red-700 mt-2">⚠️ Warning: {apiDecodedVerification.error}</p>
                    )}
                    {apiDecodedVerification?.status === 'unverifiable' && (
                      <p className="text-xs text-amber-800 mt-2">
                        This decoding could not be checked against the raw data: {apiDecodedVerification.error}. Nothing
                        shown here has been verified — read the Raw view before signing.
                      </p>
                    )}
                    <p className="text-xs font-mono text-blue-700 mt-1">
                      {buildSignature(apiDecoded.method, apiDecoded.parameters)}
                    </p>
                  </div>

                  {apiDecoded.parameters.length > 0 && (
                    <div>
                      <p className="font-semibold mb-3">Parameters:</p>
                      <div className="space-y-3">
                        {apiDecoded.parameters.map((param, i) => (
                          <div key={i} className="bg-gray-50 rounded-lg p-4">
                            <div className="flex items-start justify-between mb-2">
                              <span className="font-semibold">{param.name}</span>
                              <span className="text-xs text-gray-500 font-mono">{param.type}</span>
                            </div>
                            <div className="text-sm break-all bg-white p-3 rounded border">
                              <ParamValue
                                type={param.type}
                                value={param.value}
                                amount={
                                  apiDecodedVerification && apiDecodedVerification.status !== 'verified'
                                    ? undefined
                                    : {
                                        network,
                                        to: transaction.to,
                                        signature: buildSignature(apiDecoded.method, apiDecoded.parameters),
                                        paramIndex: i,
                                      }
                                }
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

            </div>
          ) : (
            /* Raw View */
            <div className="space-y-4 font-mono text-sm">
              <div>
                <p className="text-gray-600 font-semibold mb-2">To:</p>
                <p className="bg-gray-50 p-3 rounded break-all">{transaction.to}</p>
              </div>
              <div>
                <p className="text-gray-600 font-semibold mb-2">Value (wei):</p>
                <p className="bg-gray-50 p-3 rounded">{transaction.value}</p>
              </div>
              <div>
                <p className="text-gray-600 font-semibold mb-2">Data:</p>
                <p className="bg-gray-50 p-3 rounded break-all text-xs">{transaction.data}</p>
              </div>
              <div>
                <p className="text-gray-600 font-semibold mb-2">Operation:</p>
                <p className="bg-gray-50 p-3 rounded">{transaction.operation}</p>
              </div>
              <div>
                <p className="text-gray-600 font-semibold mb-2">Safe TX Gas:</p>
                <p className="bg-gray-50 p-3 rounded">{transaction.safeTxGas}</p>
              </div>
              <div>
                <p className="text-gray-600 font-semibold mb-2">Base Gas:</p>
                <p className="bg-gray-50 p-3 rounded">{transaction.baseGas}</p>
              </div>
              <div>
                <p className="text-gray-600 font-semibold mb-2">Gas Price:</p>
                <p className="bg-gray-50 p-3 rounded">{transaction.gasPrice}</p>
              </div>
              <div>
                <p className="text-gray-600 font-semibold mb-2">Gas Token:</p>
                <p className="bg-gray-50 p-3 rounded break-all">{transaction.gasToken}</p>
              </div>
              <div>
                <p className="text-gray-600 font-semibold mb-2">Refund Receiver:</p>
                <p className="bg-gray-50 p-3 rounded break-all">{transaction.refundReceiver}</p>
              </div>
              <div>
                <p className="text-gray-600 font-semibold mb-2">Nonce:</p>
                <p className="bg-gray-50 p-3 rounded">{transaction.nonce}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {beforeHashes}

      {/* STEP 3: Hash Verification - Compare to your hardware wallet */}
      {hashes && (
        <div className="border-2 border-blue-300 rounded-lg overflow-hidden">
          <div className="bg-blue-50 p-4 border-b-2 border-blue-300">
            <h3 className="text-lg font-bold text-blue-900 mb-1">Hardware Wallet Verification</h3>
            {hashCheck.kind === 'queued' ? (
              <p className="text-sm text-blue-800">
                Compare these hashes with what appears on your hardware wallet screen
              </p>
            ) : (
              // Proposer mode states its one instruction here, once.
              <p className="text-sm text-blue-800">
                Compare the safeTxHash with Safe&apos;s Hashes tab and your hardware wallet. If they differ, do not sign.
              </p>
            )}
          </div>

          <div className="p-6 space-y-4">
            {hashCheck.kind === 'queued' && (
              <div className="bg-yellow-50 border-2 border-yellow-400 rounded-lg p-4">
                <p className="font-semibold text-yellow-900 mb-2">⚠️ Critical Step</p>
                <p className="text-sm text-yellow-900">
                  Your device may show one or more of these hashes. Verify they match. If any hash doesn't match, DO NOT
                  SIGN!
                </p>
              </div>
            )}

            <div className="space-y-4">
              <div className="flex justify-end">
                <div className="inline-flex overflow-hidden rounded border border-gray-200 text-xs">
                  <button
                    type="button"
                    onClick={() => setHashUppercase(true)}
                    className={`px-2 py-0.5 ${hashUppercase ? 'bg-gray-100 text-gray-800' : 'text-gray-400 hover:text-gray-600'}`}
                  >
                    ABC
                  </button>
                  <button
                    type="button"
                    onClick={() => setHashUppercase(false)}
                    className={`px-2 py-0.5 ${!hashUppercase ? 'bg-gray-100 text-gray-800' : 'text-gray-400 hover:text-gray-600'}`}
                  >
                    abc
                  </button>
                </div>
              </div>

              <div>
                <p className="text-sm font-semibold text-gray-700 mb-2">Domain Hash:</p>
                <div className="bg-gray-900 p-3 rounded-lg">
                  <HashHex value={hashes.domainHash} uppercase={hashUppercase} className="text-sm" />
                </div>
                <p className="text-xs text-gray-500 mt-1">Unique per Safe. EIP-712 domain separator.</p>
              </div>

              <div>
                <p className="text-sm font-semibold text-gray-700 mb-2">Message Hash:</p>
                <div className="bg-gray-900 p-3 rounded-lg">
                  <HashHex value={hashes.messageHash} uppercase={hashUppercase} className="text-sm" />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Unique per transaction. Often shown on Ledger Nano S and similar smaller devices.
                </p>
              </div>

              <div>
                <p className="text-sm font-semibold text-gray-700 mb-2">safeTxHash:</p>
                <div className="bg-gray-900 p-3 rounded-lg">
                  <HashHex value={hashes.safeTxHash} uppercase={hashUppercase} className="text-sm" />
                </div>
                <p className="text-xs text-gray-500 mt-1">Unique per transaction per Safe. Shown on some devices.</p>
              </div>
            </div>

            {/* An owner that is itself a Safe signs a different transaction —
                its own approveHash call — so its signers verify different
                hashes. Optional and collapsed: most Safes have no nested owner.
                The parent hash passed in is the one computed above. On the
                queued page it is gated on matching the API. In proposer mode
                there is no API hash yet, and the person compares the computed
                one with Safe's Hashes tab. */}
            <NestedSafeHashes
              network={network}
              chainId={chainId}
              parentSafeAddress={address as string}
              computedParentSafeTxHash={hashCheck.kind === 'proposal' || hashesMatch ? hashes.safeTxHash : null}
              uppercase={hashUppercase}
            />

            {hashCheck.kind === 'queued' && !hashesMatch && (
              <div className="bg-red-50 border-2 border-red-400 rounded-lg p-4">
                <p className="font-semibold text-red-900 mb-2">⚠️ HASH MISMATCH WARNING</p>
                <p className="text-sm text-red-900">
                  Our calculated Safe Transaction Hash does not match what the Safe API provided. This could indicate
                  the API is compromised or returning incorrect data. DO NOT SIGN!
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
