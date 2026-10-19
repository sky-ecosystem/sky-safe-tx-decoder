/**
 * Proposer mode: check a transaction before it is proposed.
 *
 * The person pastes the JSON tab from the Safe web app, or types the fields.
 * The page computes the hashes and runs the same decoding and security
 * analysis as the queued-transaction page, through the same function and the
 * same review component. Only the Safe API record is missing, so:
 *
 * - The Safe API's decoding comes from the service's data decoder, for the
 *   same calldata.
 * - Sections that describe a queued record (status, confirmations, timeline,
 *   proposer, the same-nonce selector, the API hash comparison) are not shown.
 *
 * Entered data lives in this component's state only. Nothing goes to the URL
 * or to browser storage.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  SafeApiClient,
  checkProposalNonce,
  defaultSafeTxFieldValues,
  formatSafeTxJson,
  readSafeTxJson,
  recommendedProposalNonce,
  validateSafeTxFields,
  type SafeApiDataDecoded,
  type SafeTxField,
  type SafeTxFieldValues,
  type SafeTxInputError,
} from '@shield3/sky-safe-core';
import { Address } from '../components/Address';
import { useSafeRoute } from '../safe-route/SafeRouteProvider';
import { isSimulatedSafe } from '../safe-route/isSimulatedSafe';
import {
  analyzeTransaction,
  fieldsFromSafeTransactionData,
  type AnalyzedTransaction,
} from '../analysis/analyzeTransaction';
import { TransactionReview } from '../analysis/TransactionReview';

/** The Safe's state this page needs, read once per Safe. */
interface SafeState {
  version: string;
  onchainNonce: number;
  queuedNonces: number[];
  recommendedNonce: number;
}

/** Field order on screen: the call, the nonce, then the gas refund group. */
const FIELD_ORDER: SafeTxField[] = [
  'to',
  'value',
  'operation',
  'data',
  'nonce',
  'safeTxGas',
  'baseGas',
  'gasPrice',
  'gasToken',
  'refundReceiver',
];

const FIELD_LABELS: Partial<Record<SafeTxField, string>> = {
  value: 'value (wei)',
  gasPrice: 'gasPrice (wei)',
};

const WIDE_FIELDS: SafeTxField[] = ['to', 'data', 'gasToken', 'refundReceiver'];

function decoderCacheKey(network: string, to: string, data: string): string {
  return `${network}|${to}|${data}`;
}

function rateLimitAware(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    if (err.message.includes('429') || err.message.toLowerCase().includes('rate limit')) {
      return 'Rate limited by Safe API. Please try again in a moment. Safe rate limits the public API for security.';
    }
    return err.message;
  }
  return fallback;
}

export default function ProposeTransaction() {
  const navigate = useNavigate();
  const { network, safeAddress, chainId } = useSafeRoute();
  const address = safeAddress;

  const [safeState, setSafeState] = useState<SafeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState('Loading Safe version...');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<SafeTxInputError | null>(null);
  const [fields, setFields] = useState<SafeTxFieldValues>(defaultSafeTxFieldValues);

  const [analyzed, setAnalyzed] = useState<AnalyzedTransaction | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  // A Find in queue result, for the analysis it was asked for. A result for
  // an earlier analysis is not shown.
  const [lookup, setLookup] = useState<{
    for: AnalyzedTransaction | null;
    state: 'looking' | 'not-found' | 'error';
    message?: string;
  } | null>(null);
  const analyzedRef = useRef<AnalyzedTransaction | null>(null);
  analyzedRef.current = analyzed;

  // Data decoder answers already received in this visit, by target and
  // calldata, so editing the nonce or a gas field does not ask the service
  // again. A failed call is not an answer and is not kept. In memory only,
  // and gone when the page closes.
  const decoderCache = useRef(new Map<string, SafeApiDataDecoded | null>());
  // Bumped by Retry, to run the analysis again for the same fields.
  const [decoderRetry, setDecoderRetry] = useState(0);

  // The Safe's version, on-chain nonce and queue. Read once per Safe. A new
  // Safe starts from an empty form: nothing entered for one Safe carries over.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setLoadError(null);
        setSafeState(null);
        setJsonText('');
        setJsonError(null);
        setFields(defaultSafeTxFieldValues());
        decoderCache.current.clear();
        const client = new SafeApiClient(network, (message) => {
          if (!cancelled) setLoadingMessage(message);
        });
        setLoadingMessage('Loading Safe version...');
        const version = await client.fetchSafeVersion(address);
        setLoadingMessage('Loading Safe nonce and queue...');
        const info = await client.fetchSafeInfo(address);
        const onchainNonce = Number(info.nonce);
        if (!Number.isSafeInteger(onchainNonce) || onchainNonce < 0) {
          throw new Error(`The Safe API reported nonce ${String(info.nonce)}, which is not a valid nonce.`);
        }
        const queued = await client.fetchQueuedTransactions(address, onchainNonce);
        const queuedNonces = [...new Set(queued.map((tx) => Number(tx.nonce)))].sort((a, b) => a - b);
        if (cancelled) return;
        const recommendedNonce = recommendedProposalNonce(onchainNonce, queuedNonces);
        setSafeState({ version, onchainNonce, queuedNonces, recommendedNonce });
        // Pre-fill the nonce Safe's web app would propose. The form appears
        // only after this, so a pasted nonce always comes later and wins.
        setFields({ ...defaultSafeTxFieldValues(), nonce: String(recommendedNonce) });
      } catch (err) {
        if (!cancelled) setLoadError(rateLimitAware(err, 'Failed to load the Safe'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [network, address]);

  const recommendedText = safeState ? String(safeState.recommendedNonce) : '';

  const onJsonChange = (text: string) => {
    setJsonText(text);
    if (text.trim() === '') {
      setJsonError(null);
      setFields({ ...defaultSafeTxFieldValues(), nonce: recommendedText });
      return;
    }
    const read = readSafeTxJson(text);
    if (!read.ok) {
      setJsonError(read.error);
      return;
    }
    setJsonError(null);
    // A paste has every key, or readSafeTxJson rejects it. Nothing is filled
    // in for a pasted transaction: not a default, not the recommended nonce.
    setFields(read.values);
  };

  const onFieldChange = (field: SafeTxField, value: string) => {
    const next = { ...fields, [field]: value };
    setFields(next);
    // The fields are the source now. Rewrite the JSON from them, in Safe's
    // format, so the two never disagree.
    setJsonError(null);
    setJsonText(formatSafeTxJson(next));
  };

  // Nothing is checked until something is entered.
  const started = jsonText.trim() !== '' || fields.to !== '' || fields.value !== '' || fields.data !== '';
  const validation = useMemo(() => validateSafeTxFields(fields), [fields]);
  const fieldErrors = started && !validation.ok ? validation.errors : [];
  const errors: SafeTxInputError[] = jsonError ? [jsonError] : fieldErrors;
  const invalidFields = new Set(errors.map((error) => error.field));

  // The transaction to analyze, or null while the input is invalid. Keyed by
  // its canonical JSON so an edit that changes nothing does not re-run it.
  const validTransaction = !jsonError && validation.ok ? validation.transaction : null;
  const validKey = validTransaction ? JSON.stringify(validTransaction) : null;

  useEffect(() => {
    // Any change clears the previous result first: hashes must never show
    // for fields that are no longer on screen.
    setAnalyzed(null);
    setAnalysisError(null);
    setLookup(null);
    if (!validTransaction || !safeState) {
      setAnalyzing(false);
      return;
    }

    let cancelled = false;
    setAnalyzing(true);
    const timer = setTimeout(async () => {
      try {
        const fieldsForAnalysis = fieldsFromSafeTransactionData(validTransaction);
        const cacheKey = decoderCacheKey(network, fieldsForAnalysis.to, fieldsForAnalysis.data);
        let dataDecoded: SafeApiDataDecoded | null = null;
        let apiDecoderFailed = false;
        if (decoderCache.current.has(cacheKey)) {
          dataDecoded = decoderCache.current.get(cacheKey) ?? null;
        } else {
          const result = await new SafeApiClient(network).decodeData(fieldsForAnalysis.data, fieldsForAnalysis.to);
          if (result.status === 'failed') {
            apiDecoderFailed = true;
          } else {
            dataDecoded = result.status === 'decoded' ? result.decoded : null;
            decoderCache.current.set(cacheKey, dataDecoded);
          }
        }
        if (cancelled) return;
        setAnalyzed(
          analyzeTransaction({
            network,
            chainId,
            safeAddress: address,
            version: safeState.version,
            transaction: fieldsForAnalysis,
            dataDecoded,
            apiDecoderFailed,
          })
        );
      } catch (err) {
        if (!cancelled) setAnalysisError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setAnalyzing(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // validKey stands for validTransaction, which is a new object each render.
  }, [validKey, safeState, network, chainId, address, decoderRetry]);

  const retryDecoder = () => {
    if (!analyzed) return;
    decoderCache.current.delete(decoderCacheKey(network, analyzed.transaction.to, analyzed.transaction.data));
    setDecoderRetry((n) => n + 1);
  };

  // The nonce warnings depend on the nonce alone, so they show while another
  // field is still invalid.
  const nonceText = fields.nonce.trim();
  const enteredNonce = !jsonError && /^[0-9]+$/.test(nonceText) ? BigInt(nonceText) : null;
  const nonceCheck =
    enteredNonce !== null
      ? checkProposalNonce(enteredNonce, safeState?.onchainNonce ?? 0, safeState?.queuedNonces ?? [])
      : null;

  const findInQueue = async () => {
    if (!analyzed) return;
    const target = analyzed;
    setLookup({ for: target, state: 'looking' });
    try {
      const found = await new SafeApiClient(network).fetchTransactionByHash(target.hashes.safeTxHash);
      // The fields changed while the lookup ran. Its answer is for hashes no
      // longer on screen.
      if (analyzedRef.current !== target) return;
      // The service is asked by hash. Accept its answer only for this Safe and
      // this exact hash.
      if (
        found &&
        found.safeTxHash.toLowerCase() === target.hashes.safeTxHash.toLowerCase() &&
        found.safe.toLowerCase() === address.toLowerCase()
      ) {
        navigate(`/safe/${network}/${address}/tx/${target.transaction.nonce}?safeTxHash=${found.safeTxHash}`);
        return;
      }
      setLookup({ for: target, state: 'not-found' });
    } catch (err) {
      if (analyzedRef.current !== target) return;
      setLookup({ for: target, state: 'error', message: rateLimitAware(err, 'Lookup failed') });
    }
  };
  const lookupState = lookup && lookup.for === analyzed ? lookup : null;

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col items-center justify-center py-12 space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
          <p className="text-gray-700 font-medium">{loadingMessage}</p>
        </div>
      </div>
    );
  }

  if (loadError || !safeState) {
    return (
      <div className="max-w-6xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800">
            <strong>Error:</strong> {loadError || 'Failed to load the Safe'}
          </p>
        </div>
      </div>
    );
  }

  const inputClass = (field: SafeTxField) =>
    `w-full px-3 py-2 border rounded-lg font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
      invalidFields.has(field) ? 'border-red-500 bg-red-50' : 'border-gray-300'
    }`;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Development-only, eliminated from a production build with the mock. */}
      {import.meta.env.DEV && isSimulatedSafe(address) && (
        <div className="border-4 border-fuchsia-500 bg-fuchsia-50 rounded-lg p-4">
          <p className="font-bold text-fuchsia-900">SIMULATED SAFE. NOT A REAL SAFE.</p>
          <p className="text-sm text-fuchsia-900 mt-1">
            Its version, nonce and queue, and the Safe API decoding of fixture calldata, are fabricated locally.
          </p>
        </div>
      )}

      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <button
            onClick={() => navigate(`/safe/${network}/${address}`)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
          >
            ← Back to List
          </button>
          <h2 className="text-2xl font-bold">Paste a transaction</h2>
        </div>
        <div className="text-sm text-gray-600 space-y-1">
          <p>
            Safe: <Address address={address} />
          </p>
          <p>
            Network: {network} | Safe Version: {safeState.version}
          </p>
        </div>
      </div>

      {/* Input */}
      <div className="border-2 border-gray-300 rounded-lg p-6 space-y-4">
        <div>
          <label htmlFor="propose-json" className="block text-sm font-semibold text-gray-700 mb-2">
            Transaction JSON
          </label>
          <textarea
            id="propose-json"
            value={jsonText}
            onChange={(e) => onJsonChange(e.target.value)}
            placeholder="Paste the JSON tab from Safe's web app."
            rows={12}
            spellCheck={false}
            autoComplete="off"
            className={`w-full px-3 py-2 border rounded-lg font-mono text-xs break-all focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
              jsonError ? 'border-red-500 bg-red-50' : 'border-gray-300'
            }`}
          />
        </div>

        {errors.length > 0 && (
          <div className="bg-red-50 border-2 border-red-400 rounded-lg p-3" role="alert">
            <ul className="text-sm text-red-900 space-y-1 break-all">
              {errors.map((error, i) => (
                <li key={i}>{error.message}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {FIELD_ORDER.map((field) => (
            <div key={field} className={WIDE_FIELDS.includes(field) ? 'md:col-span-2' : undefined}>
              <label htmlFor={`propose-${field}`} className="block text-xs font-semibold text-gray-700 mb-1 font-mono">
                {FIELD_LABELS[field] ?? field}
              </label>
              {field === 'operation' ? (
                <select
                  id="propose-operation"
                  value={fields.operation}
                  onChange={(e) => onFieldChange('operation', e.target.value)}
                  className={inputClass('operation')}
                >
                  <option value="0">0 (call)</option>
                  <option value="1">1 (delegatecall)</option>
                  {/* A pasted value that is neither stays visible, so the
                      error names what is on screen. */}
                  {fields.operation !== '0' && fields.operation !== '1' && (
                    <option value={fields.operation}>{fields.operation}</option>
                  )}
                </select>
              ) : field === 'data' ? (
                <textarea
                  id="propose-data"
                  value={fields.data}
                  onChange={(e) => onFieldChange('data', e.target.value)}
                  rows={4}
                  spellCheck={false}
                  autoComplete="off"
                  className={`${inputClass('data')} text-xs break-all`}
                />
              ) : (
                <input
                  id={`propose-${field}`}
                  type="text"
                  inputMode={field === 'to' || field === 'gasToken' || field === 'refundReceiver' ? 'text' : 'numeric'}
                  value={fields[field]}
                  onChange={(e) => onFieldChange(field, e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  className={inputClass(field)}
                />
              )}
              {field === 'nonce' && nonceCheck?.used && (
                <p className="mt-2 text-sm text-orange-800 bg-orange-50 border border-orange-300 rounded p-2">
                  Nonce already used.
                </p>
              )}
              {field === 'nonce' && nonceCheck?.queued && (
                <p className="mt-2 text-sm text-amber-900 bg-amber-50 border border-amber-400 rounded p-2">
                  Nonce {String(enteredNonce)} is already queued. Only one transaction per nonce can execute.{' '}
                  <Link
                    to={`/safe/${network}/${address}/tx/${String(enteredNonce)}`}
                    className="font-semibold underline"
                  >
                    View nonce {String(enteredNonce)}
                  </Link>
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {analyzing && (
        <div className="flex items-center gap-3 text-gray-700" role="status" aria-live="polite">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
          <p className="font-medium">Checking the transaction...</p>
        </div>
      )}

      {analysisError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800">
            <strong>Error:</strong> {analysisError}
          </p>
        </div>
      )}

      {analyzed && (
        <>
          <TransactionReview analyzed={analyzed} hashCheck={{ kind: 'proposal' }} onRetryDecoder={retryDecoder} />

          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={findInQueue}
              disabled={lookupState?.state === 'looking'}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
            >
              Find in queue
            </button>
            {lookupState?.state === 'looking' && <span className="text-sm text-gray-600">Looking up...</span>}
            {lookupState?.state === 'not-found' && <span className="text-sm text-gray-700">Not in the queue yet.</span>}
            {lookupState?.state === 'error' && (
              <span className="text-sm text-red-800">Lookup failed: {lookupState.message}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
