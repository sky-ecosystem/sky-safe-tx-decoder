import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { SafeApiClient, resolveRequestedTransaction, type SafeApiMultisigTransaction } from '@shield3/sky-safe-core';
import { Address } from '../components/Address';
import { TransactionLog } from '../components/TransactionLog';
import { useSafeRoute } from '../safe-route/SafeRouteProvider';
import { isSimulatedSafe } from '../safe-route/isSimulatedSafe';
import {
  analyzeTransaction,
  fieldsFromApiTransaction,
  type AnalyzedTransaction,
} from '../analysis/analyzeTransaction';
import { TransactionReview } from '../analysis/TransactionReview';

export default function TransactionAnalysis() {
  const navigate = useNavigate();
  const params = useParams<{ nonce: string }>();
  const nonce = params.nonce!;
  // network, safeAddress (here as `address` for backwards-compat naming),
  // chainId all come from SafeRouteProvider — no manual useParams threading,
  // no manual loadNetworkContracts call, no chainId derivation.
  const { network, safeAddress, chainId } = useSafeRoute();
  const address = safeAddress;
  const [searchParams] = useSearchParams();
  const safeTxHashParam = searchParams.get('safeTxHash');

  const [allTransactions, setAllTransactions] = useState<SafeApiMultisigTransaction[]>([]);
  const [transaction, setTransaction] = useState<SafeApiMultisigTransaction | null>(null);
  // Hashes, decodings and re-encode checks for the selected transaction. The
  // same function computes them in proposer mode. See analyzeTransaction.
  const [analyzed, setAnalyzed] = useState<AnalyzedTransaction | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState('Loading transaction...');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAndAnalyze = async () => {
      try {
        setLoading(true);
        setError(null);
        setLoadingMessage('Loading transaction...');

        // Clear the previous analysis before fetching. This effect re-runs
        // when the transaction changes (a nonce change, or a safeTxHash switch
        // via the same-nonce dropdown), but the component instance is reused,
        // so its state persists. The Decoded pane must never render one
        // transaction's operations under another transaction's hash.
        setAnalyzed(null);

        const client = new SafeApiClient(network, (message) => {
          setLoadingMessage(message);
        });

        setTransaction(null);
        setAllTransactions([]);

        // Fetch all transactions with this nonce
        const transactions = await client.fetchTransactionsByNonce(address as `0x${string}`, parseInt(nonce));

        // A safeTxHash in the link (the same-nonce selector, or Find in queue)
        // names one transaction. That one is shown, or an error. Never
        // another transaction at the same nonce.
        const resolved = await resolveRequestedTransaction({
          safeAddress: address,
          nonce: parseInt(nonce),
          safeTxHash: safeTxHashParam,
          transactions,
          fetchByHash: (hash) => client.fetchTransactionByHash(hash),
        });
        if (!resolved.ok) {
          setError(resolved.message);
          return;
        }
        const tx = resolved.transaction;
        setAllTransactions(resolved.transactions);
        setTransaction(tx);

        // Fetch Safe version
        setLoadingMessage('Loading Safe version...');
        const safeVersion = await client.fetchSafeVersion(address as `0x${string}`);
        setLoadingMessage('Calculating transaction hash...');

        setAnalyzed(
          analyzeTransaction({
            network,
            chainId,
            safeAddress: address,
            version: safeVersion,
            transaction: fieldsFromApiTransaction(tx),
            dataDecoded: tx.dataDecoded,
          })
        );
      } catch (err) {
        let errorMessage = 'Failed to fetch transaction';

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

    fetchAndAnalyze();
  }, [address, nonce, network, safeTxHashParam]);

  // Handler for switching between multiple transactions
  const handleTransactionSwitch = (safeTxHash: string) => {
    navigate(`/safe/${network}/${address}/tx/${nonce}?safeTxHash=${safeTxHash}`);
  };

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

  if (error || !transaction || !analyzed) {
    return (
      <div className="max-w-6xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800 break-words">
            <strong>Error:</strong> {error || 'Transaction not found'}
          </p>
        </div>
      </div>
    );
  }

  const version = analyzed.version;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Simulated-data banner. `import.meta.env.DEV` is replaced with false in
          a production build, so this branch and its strings are eliminated
          along with the mock itself. See src/dev/mockSafeApi.ts. */}
      {import.meta.env.DEV && isSimulatedSafe(address) && (
        <div className="border-4 border-fuchsia-500 bg-fuchsia-50 rounded-lg p-4">
          <p className="font-bold text-fuchsia-900">SIMULATED DATA. NOT A REAL TRANSACTION.</p>
          <p className="text-sm text-fuchsia-900 mt-1">
            This transaction was constructed locally to review how the decoder renders. It is not
            from any Safe, nobody proposed it, and it cannot be signed.
          </p>
          <p className="text-sm text-fuchsia-900 mt-2">
            The hash check below will fail. That is expected: the fixture carries a placeholder
            safeTxHash, and the app recomputes the real one rather than trusting it.
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
          <h2 className="text-2xl font-bold">Transaction Analysis</h2>
        </div>
        <div className="text-sm text-gray-600 space-y-1">
          <p>
            Safe: <Address address={address} />
          </p>
          <p>
            Network: {network} | Nonce: {nonce} | Safe Version: {version}
          </p>
        </div>
      </div>

      {/* Transaction Selector (if multiple exist) */}
      {allTransactions.length > 1 && (
        <div className="border-2 border-blue-500 bg-blue-50 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-blue-800 font-semibold mb-1">Multiple Transactions with Nonce {nonce}</p>
              <p className="text-sm text-blue-700">Select which transaction to analyze:</p>
            </div>
            <select
              value={transaction.safeTxHash}
              onChange={(e) => handleTransactionSwitch(e.target.value)}
              className="px-3 py-2 border border-blue-300 rounded-lg bg-white text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {allTransactions.map((tx, idx) => {
                const status = tx.isExecuted
                  ? tx.isSuccessful
                    ? '✅ Executed'
                    : '❌ Failed'
                  : `⏳ Pending (${tx.confirmations?.length || 0}/${tx.confirmationsRequired})`;
                const date = tx.submissionDate ? new Date(tx.submissionDate).toLocaleString() : 'Unknown';
                return (
                  // The full safeTxHash, never abbreviated: this selector is how
                  // a signer tells competing transactions on the same nonce
                  // apart, and lookalike hashes differ in the middle.
                  <option key={tx.safeTxHash} value={tx.safeTxHash}>
                    [{idx + 1}] {status} | {date} | {tx.safeTxHash}
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      )}

      <TransactionReview
        analyzed={analyzed}
        hashCheck={{ kind: 'queued', apiSafeTxHash: transaction.safeTxHash }}
        // Queued only: execution status, confirmations, and the lifecycle
        // timeline. Proposer mode has no record yet and shows none of it.
        beforeHashes={
          <div className="bg-gray-50 rounded-lg p-4 border">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600">Status:</span>
              <span
                className={`font-semibold ${
                  transaction.isExecuted
                    ? transaction.isSuccessful
                      ? 'text-green-600'
                      : 'text-red-600'
                    : 'text-yellow-600'
                }`}
              >
                {transaction.isExecuted ? (transaction.isSuccessful ? '✅ Executed' : '❌ Failed') : '⏳ Pending'}
              </span>
            </div>
            {!transaction.isExecuted && (
              <div className="flex items-center justify-between text-sm mt-2">
                <span className="text-gray-600">Confirmations:</span>
                <span>
                  {transaction.confirmations.length} / {transaction.confirmationsRequired}
                </span>
              </div>
            )}

            {/* Lifecycle timeline: proposed → signed → rejected/executed. */}
            <div className="mt-4 pt-4 border-t border-gray-200">
              <p className="text-gray-600 text-sm font-medium mb-2">Timeline</p>
              <TransactionLog transaction={transaction} allTransactions={allTransactions} safeAddress={address as string} />
            </div>
          </div>
        }
      />
    </div>
  );
}
