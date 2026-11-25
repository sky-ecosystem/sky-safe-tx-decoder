import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  SafeApiClient,
  type DecodeDataResult,
  type SafeApiMultisigTransaction,
  currentNonceOf,
  getSafeUrl,
  getEtherscanAddressUrl,
} from '@shield3/sky-safe-core';
import { isApiFallbackSentinel } from '@shield3/sky-safe-core';
import { Address } from '../components/Address';
import { WeiValue } from '../components/WeiValue';
import { conciseTimeline } from '../components/TransactionLog';
import { useSafeRoute } from '../safe-route/SafeRouteProvider';

/** One decoder request per distinct target and calldata. */
function decodingKey(tx: SafeApiMultisigTransaction): string {
  return `${tx.to.toLowerCase()}:${(tx.data ?? '0x').toLowerCase()}`;
}

export default function SafeTransactions() {
  // network + safeAddress come from SafeRouteProvider — no manual useParams,
  // no manual loadNetworkContracts.
  const { network, safeAddress } = useSafeRoute();
  const address = safeAddress;
  const navigate = useNavigate();

  const [transactions, setTransactions] = useState<SafeApiMultisigTransaction[]>([]);
  // The Safe's current nonce, from its Safe info. A transaction that is not
  // executed is pending at or above it, and not executed below it.
  const [currentNonce, setCurrentNonce] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState('Loading transactions...');
  const [error, setError] = useState<string | null>(null);
  const [showPendingOnly, setShowPendingOnly] = useState(false);
  const [nonceInput, setNonceInput] = useState('');
  // Decoder answers by decodingKey. The list renders before them, and each
  // row updates as its answer arrives.
  const [decodings, setDecodings] = useState<Map<string, DecodeDataResult>>(new Map());

  useEffect(() => {
    const fetchTransactions = async () => {
      try {
        setLoading(true);
        setError(null);
        setTransactions([]);
        setLoadingMessage('Loading transactions...');

        const client = new SafeApiClient(network, (message) => {
          setLoadingMessage(message);
        });
        // Safe info gives the current nonce and the threshold. The list comes
        // from the Safe Queue Service. A failure of either is an error, never
        // an empty list.
        const safeInfo = await client.fetchSafeInfo(address as `0x${string}`);
        const nonce = currentNonceOf(safeInfo);
        // Without decodings, so the list shows at once. They follow below.
        const result = await client.fetchTransactions(address as `0x${string}`, 20, safeInfo, { decode: false });

        setCurrentNonce(nonce);
        setTransactions(result.results);
      } catch (err) {
        let errorMessage = 'Failed to fetch transactions';

        if (err instanceof Error) {
          // Check for rate limiting (429 status)
          if (err.message.includes('429') || err.message.toLowerCase().includes('rate limit')) {
            errorMessage =
              'Rate limited by Safe API. Please try again in a moment. Safe rate limits the public API for security.';
          } else {
            errorMessage = err.message;
          }
        }

        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchTransactions();
  }, [address, network]);

  // Decode the rows in the background, one request at a time: the decoder
  // rate limits requests without an API key, and parallel requests get 429.
  // Aborted when the list, the Safe or the network changes, and on unmount.
  useEffect(() => {
    const controller = new AbortController();
    setDecodings(new Map());
    const client = new SafeApiClient(network);
    (async () => {
      const asked = new Set<string>();
      for (const tx of transactions) {
        if (tx.dataDecoded || !tx.data || tx.data === '0x') continue;
        const key = decodingKey(tx);
        if (asked.has(key)) continue;
        asked.add(key);
        const result = await client.decodeData(tx.data as `0x${string}`, tx.to, controller.signal);
        if (controller.signal.aborted) return;
        setDecodings((previous) => new Map(previous).set(key, result));
      }
    })();
    return () => controller.abort();
  }, [transactions, address, network]);

  const handleTransactionClick = (tx: SafeApiMultisigTransaction) => {
    // The safeTxHash names this transaction, not another one at its nonce.
    navigate(`/safe/${network}/${address}/tx/${tx.nonce.toString()}?safeTxHash=${tx.safeTxHash}`);
  };

  const isPending = (tx: SafeApiMultisigTransaction) =>
    !tx.isExecuted && currentNonce !== null && Number(tx.nonce) >= currentNonce;

  const handleNonceSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (nonceInput && !isNaN(parseInt(nonceInput))) {
      navigate(`/safe/${network}/${address}/tx/${nonceInput}`);
    }
  };

  const filteredTransactions = showPendingOnly ? transactions.filter(isPending) : transactions;

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

  if (error) {
    return (
      <div className="max-w-6xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800">
            <strong>Error:</strong> {error}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-2xl font-bold mb-2">Safe Transactions</h2>
            <p className="text-gray-600 text-sm mb-1">
              Safe: <Address address={address} />
            </p>
            <p className="text-gray-600 text-sm">Network: {network}</p>
          </div>
          <div className="flex gap-2">
            <Link
              to={`/safe/${network}/${address}/propose`}
              className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-white bg-blue-600 border border-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Paste a transaction
            </Link>
            <a
              href={getSafeUrl(network, address)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
            >
              View on Safe ↗
            </a>
            <a
              href={getEtherscanAddressUrl(network, address)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-50 border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors"
            >
              View on Etherscan ↗
            </a>
          </div>
        </div>
      </div>

      {/* Nonce input and filters */}
      <div className="mb-6 space-y-4">
        <form onSubmit={handleNonceSubmit} className="flex gap-2">
          <input
            type="number"
            value={nonceInput}
            onChange={(e) => setNonceInput(e.target.value)}
            placeholder="Go to nonce..."
            className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            min="0"
          />
          <button
            type="submit"
            className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            Go
          </button>
        </form>

        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-600">
            Showing {filteredTransactions.length} of {transactions.length} transactions
            {transactions.length === 20 && <span className="text-gray-500"> (20 most recent)</span>}
          </p>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={showPendingOnly}
              onChange={(e) => setShowPendingOnly(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span>Show pending only</span>
          </label>
        </div>
      </div>

      {filteredTransactions.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500">
            {showPendingOnly
              ? `The ${transactions.length} most recent transactions from the Safe Queue Service do not include one pending at or above nonce ${currentNonce}.`
              : 'The Safe Queue Service returned zero transactions for this Safe.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredTransactions.map((tx) => (
            <div
              key={tx.safeTxHash}
              onClick={() => handleTransactionClick(tx)}
              className="border rounded-lg p-4 hover:border-blue-500 hover:shadow-md cursor-pointer transition-all"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">Nonce: {tx.nonce}</span>
                    <span
                      className={`text-sm px-2 py-1 rounded ${
                        tx.isExecuted
                          ? tx.isSuccessful
                            ? 'bg-green-100 text-green-800'
                            : 'bg-red-100 text-red-800'
                          : isPending(tx)
                            ? 'bg-yellow-100 text-yellow-800'
                            : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {tx.isExecuted
                        ? tx.isSuccessful
                          ? 'Executed'
                          : 'Failed'
                        : isPending(tx)
                          ? 'Pending'
                          : 'Not executed'}
                    </span>
                  </div>

                  <div className="space-y-1 text-sm">
                    <div>
                      <span className="text-gray-600">To:</span> <Address address={tx.to} />
                    </div>
                    <div>
                      <span className="text-gray-600">Value:</span> <WeiValue value={tx.value} />
                    </div>
                    {(() => {
                      if (!tx.data || tx.data === '0x') return null;
                      const decoding: DecodeDataResult | undefined = tx.dataDecoded
                        ? { status: 'decoded', decoded: tx.dataDecoded }
                        : decodings.get(decodingKey(tx));
                      if (!decoding) {
                        return (
                          <div>
                            <span className="text-gray-600">Method:</span>{' '}
                            <span className="text-gray-500 italic">decoding…</span>
                          </div>
                        );
                      }
                      if (decoding.status === 'failed') {
                        // The decoder did not answer. That is not "no ABI found".
                        return (
                          <div>
                            <span className="text-gray-600">Method:</span>{' '}
                            <span className="text-gray-500 italic">
                              not decoded: Safe&apos;s decoder did not answer
                            </span>
                          </div>
                        );
                      }
                      if (decoding.status === 'none') return null;
                      return isApiFallbackSentinel(decoding.decoded) ? (
                        // The Safe API's "fallback" is its "could not decode"
                        // sentinel, not a real method. Do not show it as one.
                        <div>
                          <span className="text-gray-600">Method:</span>{' '}
                          <span className="text-gray-500 italic">unable to decode</span>
                        </div>
                      ) : (
                        <div>
                          <span className="text-gray-600">Method:</span>{' '}
                          <span className="font-semibold">{decoding.decoded.method}</span>
                        </div>
                      );
                    })()}
                    <div>
                      {/* The threshold is the current one. It applies to a
                          pending transaction only: an executed or replaced
                          one shows its count alone. */}
                      <span className="text-gray-600">Confirmations:</span>{' '}
                      {isPending(tx)
                        ? `${tx.confirmations.length}/${tx.confirmationsRequired}`
                        : tx.confirmations.length}
                    </div>
                    {/* Compact lifecycle log, indented under confirmations. */}
                    <div className="mt-1 ml-1 space-y-0.5 border-l-2 border-gray-200 pl-3">
                      {conciseTimeline(tx).map((row, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-1 text-xs text-gray-500">
                          <span className="font-medium text-gray-600">{row.label}</span>
                          {row.time && <span>· {row.time}</span>}
                          {row.actor && (
                            <>
                              <span>by</span>
                              <Address address={row.actor} />
                            </>
                          )}
                          {row.delegateOf !== undefined &&
                            (row.delegateOf === null ? (
                              <span>proposed by a delegate</span>
                            ) : (
                              <>
                                <span>delegate of</span>
                                <Address address={row.delegateOf} />
                              </>
                            ))}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="text-right">
                  <button className="text-blue-600 hover:text-blue-700 font-medium text-sm">Analyze →</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
