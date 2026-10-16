/**
 * The analysis a signer reviews, computed from the signed fields of one Safe
 * transaction.
 *
 * Shared by the queued-transaction page, which reads the fields from the Safe
 * Transaction Service, and by proposer mode, where a person enters them before
 * the transaction exists. Both pass the same inputs here: the signed fields,
 * the Safe, its version, the chain, and the Safe API's decoding of the
 * calldata (a record's `dataDecoded`, or the data decoder's answer for the
 * same calldata). Everything a signer sees about the call is derived here or
 * from this result, so the two pages cannot drift apart.
 */

import {
  calculateSafeTxHash,
  decoderRegistry,
  LockstakeEngineDecoder,
  SPBEAMDecoder,
  StUsdsRateSetterDecoder,
  PASConfiguratorDecoder,
  createPauAgentDecoders,
  decodeMultiSend,
  isMultiSend,
  verifyDecodedData,
  isApiFallbackSentinel,
  extractAddressesFromApiDecoded,
  extractAddressesFromDecodedTransaction,
  type SafeApiMultisigTransaction,
  type SafeApiNestedTransaction,
  type SafeApiDataDecoded,
  type SafeTransactionData,
  type SafeTxHashResult,
  type DecodedTransactionData,
  type DecodedMultiSendTransaction,
  type DecodeVerificationResult,
} from '@shield3/sky-safe-core';

// Register custom decoders
decoderRegistry.register(new LockstakeEngineDecoder());
decoderRegistry.register(new SPBEAMDecoder());
decoderRegistry.register(new StUsdsRateSetterDecoder());
decoderRegistry.register(new PASConfiguratorDecoder());
// One per PAU AdministeredAgent — see packages/core/src/decoders/PAU.md.
for (const decoder of createPauAgentDecoders()) decoderRegistry.register(decoder);

/** One call inside a MultiSend, with every decoding of it this app has. */
export interface MultiSendItem {
  tx: DecodedMultiSendTransaction;
  decoded?: DecodedTransactionData;
  apiDecoded?: SafeApiDataDecoded | null;
  verification?: DecodeVerificationResult;
}

/** The signed fields as strings, the form both sources reduce to. */
export interface TransactionFields {
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: `0x${string}`;
  refundReceiver: `0x${string}`;
  nonce: string;
}

export interface AnalyzedTransaction {
  network: string;
  chainId: number;
  safeAddress: `0x${string}`;
  version: string;
  transaction: TransactionFields;
  /** The Safe API's decoding of the calldata, as received. */
  dataDecoded: SafeApiDataDecoded | null;
  hashes: SafeTxHashResult;
  customDecoded: DecodedTransactionData | null;
  multiSendTxs: MultiSendItem[] | null;
  apiDecodedVerification: DecodeVerificationResult | null;
  multiSendVerification: DecodeVerificationResult | null;
  /** Addresses from decoded parameters, for the address book check. */
  paramAddresses: `0x${string}`[];
}

/**
 * The signed fields of a Safe Transaction Service record.
 *
 * The service reports a call without calldata as `data: null`. The contract
 * hashes empty bytes for it, so null is read as `0x`. Passing null on threw in
 * the hash calculation, and the page showed an error for every such
 * transaction, an on-chain rejection included.
 */
export function fieldsFromApiTransaction(tx: SafeApiMultisigTransaction): TransactionFields {
  return {
    to: tx.to,
    value: tx.value,
    data: tx.data ?? '0x',
    operation: tx.operation,
    safeTxGas: tx.safeTxGas.toString(),
    baseGas: tx.baseGas.toString(),
    gasPrice: tx.gasPrice,
    gasToken: tx.gasToken,
    refundReceiver: tx.refundReceiver,
    nonce: tx.nonce.toString(),
  };
}

/** Validated fields from proposer mode, in the same string form. */
export function fieldsFromSafeTransactionData(tx: SafeTransactionData): TransactionFields {
  return {
    to: tx.to,
    value: tx.value.toString(),
    data: tx.data,
    operation: tx.operation,
    safeTxGas: tx.safeTxGas.toString(),
    baseGas: tx.baseGas.toString(),
    gasPrice: tx.gasPrice.toString(),
    gasToken: tx.gasToken,
    refundReceiver: tx.refundReceiver,
    nonce: tx.nonce.toString(),
  };
}

/**
 * Compute the hashes and decode the calldata.
 *
 * Synchronous: every network answer it needs (the Safe version and the API
 * decoding) is an input. The Sourcify fallback, the PAU dispatch check and the
 * security analysis run after this, from its result.
 */
export function analyzeTransaction(input: {
  network: string;
  chainId: number;
  safeAddress: `0x${string}`;
  version: string;
  transaction: TransactionFields;
  dataDecoded: SafeApiDataDecoded | null;
}): AnalyzedTransaction {
  const { network, chainId, safeAddress, version, transaction: tx, dataDecoded } = input;

  // chainId comes from SafeRouteProvider — no manual network lookup here.
  const hashes = calculateSafeTxHash(chainId, safeAddress, tx, version);

  let customDecoded: DecodedTransactionData | null = null;
  let multiSendTxs: MultiSendItem[] | null = null;
  let apiDecodedVerification: DecodeVerificationResult | null = null;
  let multiSendVerification: DecodeVerificationResult | null = null;

  // Decode multisend / custom decoders first — we need decoded data to
  // feed the address-book check with param-level addresses.
  const extracted: `0x${string}`[] = [];

  // Always pull addresses from the Safe API's dataDecoded (covers
  // multisend nested calls via valueDecoded recursion).
  extracted.push(...extractAddressesFromApiDecoded(dataDecoded));

  if (tx.data && tx.data !== '0x' && tx.data.length > 2) {
    if (isMultiSend(tx.data)) {
      const nestedTxs = decodeMultiSend(tx.data);

      // Verify the outer MultiSend transaction itself
      if (dataDecoded) {
        multiSendVerification = verifyDecodedData(tx.data, dataDecoded);
      }

      if (nestedTxs) {
        // Get Safe API decoded nested transactions from valueDecoded
        let apiNestedTxs: SafeApiNestedTransaction[] | null = null;
        if (dataDecoded?.parameters) {
          const transactionsParam = dataDecoded.parameters.find((p) => p.name === 'transactions');
          if (transactionsParam?.valueDecoded && Array.isArray(transactionsParam.valueDecoded)) {
            apiNestedTxs = transactionsParam.valueDecoded as SafeApiNestedTransaction[];
          }
        }

        // Try to decode each nested transaction with custom decoders + preserve Safe API data
        multiSendTxs = nestedTxs.map((nestedTx, index) => {
          const nestedDecoded = decoderRegistry.decode(nestedTx.to as `0x${string}`, nestedTx.data, network);

          if (nestedDecoded) {
            extracted.push(...extractAddressesFromDecodedTransaction(nestedDecoded));
          }

          // Get corresponding Safe API decoded data. Treat the Safe
          // service's "fallback" sentinel as no decoding, so an
          // undecodable call falls through to the raw/selector view
          // instead of being re-encode-checked as fallback() and flagged.
          const rawApiDecoded = apiNestedTxs?.[index]?.dataDecoded || null;
          const apiDecoded = isApiFallbackSentinel(rawApiDecoded) ? null : rawApiDecoded;

          // Verify Safe API decoded data against raw data
          const verification = apiDecoded ? verifyDecodedData(nestedTx.data, apiDecoded) : undefined;

          return { tx: nestedTx, decoded: nestedDecoded, apiDecoded, verification };
        });
      }
    } else {
      // Try direct custom decoder
      const decoded = decoderRegistry.decode(tx.to, tx.data, network);
      if (decoded) {
        customDecoded = decoded;
        extracted.push(...extractAddressesFromDecodedTransaction(decoded));
      } else if (dataDecoded && !isApiFallbackSentinel(dataDecoded)) {
        // If no custom decoder but Safe API has a real decoding, verify
        // it. The "fallback" sentinel is not a real decoding — skip it so
        // the call is treated as undecodable rather than flagged.
        apiDecodedVerification = verifyDecodedData(tx.data, dataDecoded);
      }
    }
  }

  return {
    network,
    chainId,
    safeAddress,
    version,
    transaction: tx,
    dataDecoded,
    hashes,
    customDecoded,
    multiSendTxs,
    apiDecodedVerification,
    multiSendVerification,
    paramAddresses: extracted,
  };
}

/**
 * Is this call decoded, and by what? Read by both the Sourcify lookup and the
 * render, because both must agree on it.
 *
 * They previously each rebuilt the test from raw state and disagreed. An empty
 * MultiSend (`multiSendTxs === []`, which `decodeMultiSend` returns for
 * `multiSend("")`) made the effect's `!multiSendTxs` false — so it queued no
 * lookup — while the render's `multiSendTxs.length > 0` was also false, so it
 * called the call undecodable and waited for a lookup that was never queued.
 * The result was a spinner that never resolved, in place of the amber block
 * that says "verify the raw data against an independent source before
 * signing". A signer was left waiting instead of warned. One expression, used
 * by both, is what stops that recurring.
 *
 * The Safe API's "fallback" sentinel is not a usable decoding — treat it as
 * absent everywhere the decision is made.
 */
export function decodingState(analyzed: AnalyzedTransaction) {
  const { transaction, dataDecoded, customDecoded, multiSendTxs } = analyzed;
  const apiDecoded = !isApiFallbackSentinel(dataDecoded) ? dataDecoded : null;
  const hasCustomDecoding = Boolean(customDecoded || (multiSendTxs && multiSendTxs.length > 0));
  const hasCalldata = Boolean(transaction.data && transaction.data !== '0x' && transaction.data.length > 2);
  const undecodable = hasCalldata && !hasCustomDecoding && !apiDecoded;
  return { apiDecoded, hasCustomDecoding, hasCalldata, undecodable };
}
