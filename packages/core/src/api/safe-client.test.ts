/**
 * Tests for the Safe API client: the Safe Decoder Service, the transaction
 * reads from the Safe Queue Service, and Safe info from the Safe Transaction
 * Service. `fetch` is stubbed.
 *
 * TRANSFER_DECODED is the decoding of the calldata of Safe
 * 0xf65475e74C1Ed6d004d5240b06E3088724dFDA5d, nonce 520.
 *
 * QUEUE_520 is the live Safe Queue Service record for that transaction,
 * captured on 2026-11-25 from
 * https://api.safe.global/queue/api/v1/multisig-transactions/0x3afdbbdfca4f869f5918b012b771f7cd6aa2dc63c80bf63169dc82502663e3b5
 * (service version 0.11.0).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { zeroAddress } from 'viem';
import { SafeApiClient } from './safe-client.js';
import { adaptQueueTransaction } from './queue-service.js';
import { calculateSafeTxHash } from '../hash/index.js';
import type { SafeApiSafeInfo, SafeQueueMultisigTransaction } from '../types.js';

const BASE = 'https://api.safe.global/tx-service/eth';
const QUEUE = 'https://api.safe.global/queue';
const DECODER = 'https://api.safe.global/decoder/api/v1/data-decoder';
const SAFE = '0xf65475e74C1Ed6d004d5240b06E3088724dFDA5d';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TRANSFER_DATA =
  '0xa9059cbb000000000000000000000000fbca5c7138892f987313d9fa615ecb3a35997351000000000000000000000000000000000000000000000000000000a03ce998c8';
const TRANSFER_DECODED = {
  method: 'transfer',
  parameters: [
    { name: 'to', type: 'address', value: '0xfBcA5C7138892F987313d9FA615ECB3a35997351' },
    { name: 'value', type: 'uint256', value: '688216709320' },
  ],
};
const SAFE_TX_HASH = '0x3afdbbdfca4f869f5918b012b771f7cd6aa2dc63c80bf63169dc82502663e3b5';

/** `raw` is the body text as sent. Otherwise `body` is sent as JSON, and an absent body as an empty one. */
type Answer = { status: number; body?: unknown; raw?: string; statusText?: string } | Error;

function stubFetch(answers: Answer[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const answer = answers.shift();
      if (!answer) throw new Error('unexpected request');
      if (answer instanceof Error) throw answer;
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        statusText: answer.statusText ?? '',
        json: async () => answer.body,
        text: async () => answer.raw ?? (answer.body === undefined ? '' : JSON.stringify(answer.body)),
      };
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('decodeData', () => {
  it('POSTs data, to and chainId to the Safe Decoder Service and returns its decoding', async () => {
    const calls = stubFetch([{ status: 200, body: TRANSFER_DECODED }]);
    const result = await new SafeApiClient('ethereum').decodeData(TRANSFER_DATA, USDC);
    expect(result).toEqual({ status: 'decoded', decoded: TRANSFER_DECODED });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(DECODER);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ data: TRANSFER_DATA, to: USDC, chainId: 1 });
  });

  it('checksums to, which the service requires', async () => {
    const calls = stubFetch([{ status: 200, body: TRANSFER_DECODED }]);
    await new SafeApiClient('ethereum').decodeData(TRANSFER_DATA, USDC.toLowerCase() as `0x${string}`);
    expect(JSON.parse(calls[0]!.init?.body as string).to).toBe(USDC);
  });

  it('sends data alone without a target, since the service requires to with chainId', async () => {
    const calls = stubFetch([{ status: 200, body: TRANSFER_DECODED }]);
    await new SafeApiClient('ethereum').decodeData(TRANSFER_DATA);
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ data: TRANSFER_DATA });
  });

  it('accepts the accuracy field of the live answer', async () => {
    // The live Safe Decoder Service answer for this calldata, target and chain.
    const live = {
      method: 'transfer',
      parameters: [
        { name: 'to', type: 'address', value: '0xfBcA5C7138892F987313d9FA615ECB3a35997351', valueDecoded: null },
        { name: 'value', type: 'uint256', value: '688216709320', valueDecoded: null },
      ],
      accuracy: 'FULL_MATCH',
    };
    stubFetch([{ status: 200, body: live }]);
    expect(await new SafeApiClient('ethereum').decodeData(TRANSFER_DATA, USDC)).toEqual({
      status: 'decoded',
      decoded: live,
    });
  });

  it('answers none for empty calldata, without a request', async () => {
    const calls = stubFetch([]);
    expect(await new SafeApiClient('ethereum').decodeData('0x', USDC)).toEqual({ status: 'none' });
    expect(calls).toHaveLength(0);
  });

  it("returns the service's fallback sentinel unchanged, as a decoding", async () => {
    // The live service answers this for an unknown selector only when the
    // target's ABI has a fallback function.
    stubFetch([{ status: 200, body: { method: 'fallback', parameters: [] } }]);
    expect(await new SafeApiClient('ethereum').decodeData('0xdeadbeef', USDC)).toEqual({
      status: 'decoded',
      decoded: { method: 'fallback', parameters: [] },
    });
  });

  it('answers none for an empty or null body', async () => {
    for (const raw of ['', '   ', 'null']) {
      stubFetch([{ status: 200, raw }]);
      expect(await new SafeApiClient('ethereum').decodeData(TRANSFER_DATA, USDC)).toEqual({ status: 'none' });
    }
  });

  it('answers none for 404, the answer for a selector the service does not know', async () => {
    // Checked against the live Safe Decoder Service: 0xdeadbeef to USDC on
    // chain 1 answers 404 with {"detail":"Cannot find function selector to decode data"}.
    stubFetch([{ status: 404, raw: '' }]);
    expect(
      await new SafeApiClient('ethereum').decodeData('0xdeadbeef', '0x24169Afb34fAe4D4356BC54Bd80319131e35ca38')
    ).toEqual({ status: 'none' });
    stubFetch([{ status: 404, body: { detail: 'Cannot find function selector to decode data' } }]);
    expect(await new SafeApiClient('ethereum').decodeData(TRANSFER_DATA, USDC)).toEqual({ status: 'none' });
  });

  it('fails on any other non-2xx answer, naming the status', async () => {
    for (const status of [400, 403, 422, 500, 503]) {
      stubFetch([{ status, body: { detail: 'x' } }]);
      expect(await new SafeApiClient('ethereum').decodeData(TRANSFER_DATA, USDC)).toEqual({
        status: 'failed',
        reason: `HTTP ${status}`,
      });
    }
  });

  it('fails on a body that is not a decoding', async () => {
    for (const body of [
      {},
      [],
      'transfer',
      42,
      { method: 'transfer' },
      { parameters: [] },
      { method: 1, parameters: [] },
    ]) {
      stubFetch([{ status: 200, body }]);
      expect(await new SafeApiClient('ethereum').decodeData(TRANSFER_DATA, USDC)).toEqual({
        status: 'failed',
        reason: 'the answer is not a decoding',
      });
    }
  });

  it('fails on a body that is not JSON', async () => {
    stubFetch([{ status: 200, raw: '<html>gateway</html>' }]);
    expect(await new SafeApiClient('ethereum').decodeData(TRANSFER_DATA, USDC)).toEqual({
      status: 'failed',
      reason: 'the answer is not JSON',
    });
  });

  it('fails on a network failure', async () => {
    stubFetch([new TypeError('Failed to fetch')]);
    expect(await new SafeApiClient('ethereum').decodeData(TRANSFER_DATA, USDC)).toEqual({
      status: 'failed',
      reason: 'Failed to fetch',
    });
  });

  it('retries a rate-limited request with the client backoff', async () => {
    vi.useFakeTimers();
    const calls = stubFetch([{ status: 429 }, { status: 200, body: TRANSFER_DECODED }]);
    const retries: string[] = [];
    const pending = new SafeApiClient('ethereum', (message) => retries.push(message)).decodeData(TRANSFER_DATA, USDC);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ status: 'decoded', decoded: TRANSFER_DECODED });
    expect(calls).toHaveLength(2);
    expect(retries).toHaveLength(1);
  });

  it('fails when rate limiting outlasts the retries', async () => {
    vi.useFakeTimers();
    const calls = stubFetch([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
    const pending = new SafeApiClient('ethereum').decodeData(TRANSFER_DATA, USDC);
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    expect(await pending).toEqual({ status: 'failed', reason: 'rate limited' });
    expect(calls).toHaveLength(4);
  });
});

const QUEUE_520: SafeQueueMultisigTransaction = {
  safeTxHash: SAFE_TX_HASH,
  chainId: '1',
  safe: '0xf65475e74c1ed6d004d5240b06e3088724dfda5d',
  nonce: '520',
  proposer: '0xa9b441515bf707a85e28f15e6ffe47797acb2df3',
  proposedVia: 'DELEGATE',
  proposedBy: '0x0c4aa531c5b3f1214ffb32614721f6e751f3f060',
  to: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  value: '0',
  data: TRANSFER_DATA,
  operation: 0,
  safeTxGas: '0',
  baseGas: '0',
  gasPrice: '0',
  gasToken: null,
  refundReceiver: null,
  failed: false,
  notes: null,
  originName: null,
  originUrl: null,
  txHash: '0x7db4b12ee758ce4ca099d4dabcf1a839f40953fe9d06ed5c39ef65248d265c8f',
  executor: '0x0c4aa531c5b3f1214ffb32614721f6e751f3f060',
  created: '2025-10-11T22:14:08.535340Z',
  modified: '2025-10-11T22:40:03.107953Z',
  confirmations: [
    {
      owner: '0xdab8aaed5928696db3cb141c0b67c5731372bd70',
      signature:
        '0xc243995f22684f66bef2aaac5a0d18f08f52a72a2709c831e968ff10212052ea19d94de5af7a6213e3694b45f939ad275303a4a0c16fbeac9a5a2e14b54c82fb1c',
      signatureType: 'EOA',
      created: '2025-10-11T22:15:23.353362Z',
      modified: '2025-10-11T22:15:23.353362Z',
    },
    {
      owner: '0xa9b441515bf707a85e28f15e6ffe47797acb2df3',
      signature:
        '0xb2f6bcfd88ad98a7499fba7009501152e980b7713c86a1e8db9369dc381e43ed5c2072975eac4a288ff22ceba6f6021024f39450daac56079a0de088776846401b',
      signatureType: 'EOA',
      created: '2025-10-11T22:39:26.771104Z',
      modified: '2025-10-11T22:39:26.771104Z',
    },
  ],
};

/** The fixture Safe's info as the Safe Transaction Service served it on 2026-11-25. */
const SAFE_INFO: SafeApiSafeInfo = {
  address: SAFE,
  nonce: '613',
  threshold: 3,
  owners: [],
  masterCopy: '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552',
  modules: [],
  fallbackHandler: '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4',
  guard: zeroAddress,
  version: '1.3.0',
};

const OTHER_SAFE = '0x5EA1d9A6dDC3A0329378a327746D71A2019eC332';
const OTHER_HASH = '0x7db4b12ee758ce4ca099d4dabcf1a839f40953fe9d06ed5c39ef65248d265c8f';

/** A distinct full-length safeTxHash for test record `n`. */
const hashFor = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

/** A pending queue record at `nonce`, built from the live record. */
function pending(nonce: number, overrides: Partial<SafeQueueMultisigTransaction> = {}): SafeQueueMultisigTransaction {
  return {
    ...QUEUE_520,
    safeTxHash: hashFor(nonce),
    nonce: String(nonce),
    txHash: null,
    failed: null,
    executor: null,
    ...overrides,
  };
}

const page = (results: unknown[], next: string | null = null) => ({
  status: 200,
  body: { count: results.length, next, previous: null, results },
});

const queueUrl = (offset: number) =>
  `${QUEUE}/api/v1/multisig-transactions/queue?safes=${SAFE}:1&nonceOrder=desc&limit=100&offset=${offset}`;

describe('adaptQueueTransaction', () => {
  const adapt = (
    record: SafeQueueMultisigTransaction,
    decoding: Parameters<typeof adaptQueueTransaction>[1]['decoding'] = null
  ) => adaptQueueTransaction(record, { confirmationsRequired: 3, decoding });

  it('maps the live record to the Safe Transaction Service shape', () => {
    const tx = adapt(QUEUE_520, { status: 'decoded', decoded: TRANSFER_DECODED });
    expect(tx).toMatchObject({
      safe: SAFE,
      to: USDC,
      value: '0',
      data: TRANSFER_DATA,
      operation: 0,
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      safeTxGas: 0,
      baseGas: 0,
      gasPrice: '0',
      nonce: 520,
      safeTxHash: SAFE_TX_HASH,
      transactionHash: '0x7db4b12ee758ce4ca099d4dabcf1a839f40953fe9d06ed5c39ef65248d265c8f',
      isExecuted: true,
      isSuccessful: true,
      submissionDate: '2025-10-11T22:14:08.535340Z',
      modified: '2025-10-11T22:40:03.107953Z',
      executor: '0x0c4aA531c5b3F1214ffb32614721F6e751F3f060',
      // The Safe Transaction Service record for this transaction has the same
      // proposer and proposedByDelegate.
      proposer: '0xa9b441515bF707A85E28F15E6ffE47797ACB2df3',
      proposedByDelegate: '0x0c4aA531c5b3F1214ffb32614721F6e751F3f060',
      confirmationsRequired: 3,
      dataDecoded: TRANSFER_DECODED,
      executionDate: null,
      blockNumber: null,
      trusted: false,
      signatures: null,
      origin: null,
    });
    expect(tx.dataDecodedUnavailable).toBeUndefined();
    // Owners as the Safe Transaction Service record for this transaction has them.
    expect(tx.confirmations).toEqual([
      {
        owner: '0xDAb8aaeD5928696DB3Cb141c0b67C5731372BD70',
        submissionDate: '2025-10-11T22:15:23.353362Z',
        transactionHash: null,
        signature: QUEUE_520.confirmations[0]!.signature,
        signatureType: 'EOA',
      },
      {
        owner: '0xa9b441515bF707A85E28F15E6ffE47797ACB2df3',
        submissionDate: '2025-10-11T22:39:26.771104Z',
        transactionHash: null,
        signature: QUEUE_520.confirmations[1]!.signature,
        signatureType: 'EOA',
      },
    ]);
  });

  it('reads a null to as the zero address', () => {
    expect(adapt({ ...QUEUE_520, to: null }).to).toBe(zeroAddress);
  });

  it('checksums a non-zero gasToken and refundReceiver', () => {
    const tx = adapt({ ...QUEUE_520, gasToken: QUEUE_520.to, refundReceiver: QUEUE_520.proposer });
    expect(tx.gasToken).toBe(USDC);
    expect(tx.refundReceiver).toBe('0xa9b441515bF707A85E28F15E6ffE47797ACB2df3');
  });

  it('sets proposedByDelegate only for a DELEGATE proposal', () => {
    for (const proposedVia of ['OWNER', 'NESTED_OWNER', 'UNKNOWN', 'SOMETHING_NEW']) {
      expect(adapt({ ...QUEUE_520, proposedVia }).proposedByDelegate).toBeNull();
    }
    expect(adapt({ ...QUEUE_520, proposedVia: 'DELEGATE', proposedBy: null }).proposedByDelegate).toBeNull();
  });

  it('reads the execution state from txHash and failed', () => {
    const queued = adapt(pending(613));
    expect(queued.isExecuted).toBe(false);
    expect(queued.isSuccessful).toBeNull();
    expect(queued.transactionHash).toBeNull();
    expect(adapt({ ...QUEUE_520, failed: true }).isSuccessful).toBe(false);
  });

  it('keeps origin in the Safe Transaction Service form', () => {
    expect(adapt({ ...QUEUE_520, originName: 'Safe{Wallet}', originUrl: null }).origin).toBe('{"name":"Safe{Wallet}"}');
  });

  it('marks a decoder failure, and does not present it as no decoding', () => {
    const failed = adapt(QUEUE_520, { status: 'failed', reason: 'HTTP 500' });
    expect(failed.dataDecoded).toBeNull();
    expect(failed.dataDecodedUnavailable).toBe('HTTP 500');

    const none = adapt(QUEUE_520, { status: 'none' });
    expect(none.dataDecoded).toBeNull();
    expect(none.dataDecodedUnavailable).toBeUndefined();

    expect(adapt(QUEUE_520, null).dataDecodedUnavailable).toBe('not requested');
  });

  it('rejects a gas value a number cannot hold exactly', () => {
    expect(() => adapt({ ...QUEUE_520, safeTxGas: '9007199254740993' })).toThrow(
      `The Safe Queue Service returned safeTxGas 9007199254740993 for transaction ${SAFE_TX_HASH}. This tool does not read a value this large exactly.`
    );
  });

  it('rejects a field that is not of the documented form, naming the full value', () => {
    expect(() => adapt({ ...QUEUE_520, to: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb4' })).toThrow(
      `The Safe Queue Service returned "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb4" as to of transaction ${SAFE_TX_HASH}. It is not an address.`
    );
    expect(() => adapt({ ...QUEUE_520, nonce: '0x208' })).toThrow('as nonce of transaction');
    expect(() => adapt({ ...QUEUE_520, operation: 2 })).toThrow('It must be 0 or 1.');
  });
});

describe('a Safe Queue Service record hashes to its safeTxHash', () => {
  it('computes the safeTxHash the service reports for the live nonce-520 record', async () => {
    stubFetch([
      { status: 200, body: QUEUE_520 },
      { status: 200, body: SAFE_INFO },
      { status: 200, body: TRANSFER_DECODED },
    ]);
    const tx = (await new SafeApiClient('ethereum').fetchTransactionByHash(SAFE_TX_HASH))!;
    const computed = calculateSafeTxHash(
      1,
      tx.safe,
      {
        to: tx.to,
        value: tx.value,
        data: tx.data ?? '0x',
        operation: tx.operation,
        safeTxGas: String(tx.safeTxGas),
        baseGas: String(tx.baseGas),
        gasPrice: tx.gasPrice,
        gasToken: tx.gasToken,
        refundReceiver: tx.refundReceiver,
        nonce: String(tx.nonce),
      },
      SAFE_INFO.version
    );
    expect(computed.safeTxHash).toBe(SAFE_TX_HASH);
    expect(tx.safeTxHash).toBe(SAFE_TX_HASH);
  });
});

describe('fetchTransactionByHash', () => {
  it('reads the Safe Queue Service, then the threshold and the decoding', async () => {
    const calls = stubFetch([
      { status: 200, body: QUEUE_520 },
      { status: 200, body: SAFE_INFO },
      { status: 200, body: TRANSFER_DECODED },
    ]);
    const tx = await new SafeApiClient('ethereum').fetchTransactionByHash(SAFE_TX_HASH, SAFE);
    expect(calls.map((c) => c.url)).toEqual([
      `${QUEUE}/api/v1/multisig-transactions/${SAFE_TX_HASH}`,
      `${BASE}/api/v1/safes/${SAFE}/`,
      DECODER,
    ]);
    expect(tx).toMatchObject({
      safe: SAFE,
      nonce: 520,
      isExecuted: true,
      transactionHash: QUEUE_520.txHash,
      executionDate: null,
      confirmationsRequired: 3,
      dataDecoded: TRANSFER_DECODED,
    });
  });

  it('returns null on a 404, and asks no other service', async () => {
    const calls = stubFetch([{ status: 404, body: { detail: 'MultisigTransaction not found.' } }]);
    expect(await new SafeApiClient('ethereum').fetchTransactionByHash(SAFE_TX_HASH)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('throws on any other failure', async () => {
    for (const status of [422, 500, 503]) {
      const calls = stubFetch([{ status, body: { detail: 'Service down' } }]);
      await expect(new SafeApiClient('ethereum').fetchTransactionByHash(SAFE_TX_HASH)).rejects.toThrow(
        `Failed to fetch the transaction from the Safe Queue Service: HTTP ${status}: Service down`
      );
      expect(calls).toHaveLength(1);
    }
  });

  it('rejects a record with another safeTxHash, naming both in full', async () => {
    stubFetch([{ status: 200, body: { ...QUEUE_520, safeTxHash: OTHER_HASH } }]);
    await expect(new SafeApiClient('ethereum').fetchTransactionByHash(SAFE_TX_HASH)).rejects.toThrow(
      `The Safe Queue Service returned safeTxHash "${OTHER_HASH}". The request was for safeTxHash ${SAFE_TX_HASH}.`
    );
  });

  it('rejects a record for another chain', async () => {
    stubFetch([{ status: 200, body: { ...QUEUE_520, chainId: '137' } }]);
    await expect(new SafeApiClient('ethereum').fetchTransactionByHash(SAFE_TX_HASH)).rejects.toThrow(
      `The Safe Queue Service returned transaction ${SAFE_TX_HASH} for chain "137". The request was for chain 1.`
    );
  });

  it('rejects a record for another Safe when the Safe is given', async () => {
    stubFetch([{ status: 200, body: { ...QUEUE_520, safe: OTHER_SAFE.toLowerCase() } }]);
    await expect(new SafeApiClient('ethereum').fetchTransactionByHash(SAFE_TX_HASH, SAFE)).rejects.toThrow(
      `The Safe Queue Service returned transaction ${SAFE_TX_HASH} for Safe ${OTHER_SAFE}. The request was for Safe ${SAFE}.`
    );
  });
});

describe('fetchQueuedTransactions', () => {
  it('reads the Safe Queue Service queue and keeps only queued transactions, highest nonce first', async () => {
    const calls = stubFetch([
      // A service that ignored its own filter would return these. Executed,
      // and not executed but below the on-chain nonce (replaced), are dropped.
      page([pending(614), pending(615), { ...QUEUE_520, nonce: '614', safeTxHash: hashFor(9) }, pending(612)]),
    ]);
    const queued = await new SafeApiClient('ethereum').fetchQueuedTransactions(SAFE, 613, {
      safeInfo: SAFE_INFO,
      decode: false,
    });
    expect(queued.map((t) => t.nonce)).toEqual([615, 614]);
    expect(queued.every((t) => t.confirmationsRequired === 3 && t.dataDecodedUnavailable === 'not requested')).toBe(
      true
    );
    expect(calls.map((c) => c.url)).toEqual([queueUrl(0)]);
  });

  it('reads the Safe info for the threshold when the caller does not pass it', async () => {
    const calls = stubFetch([{ status: 200, body: SAFE_INFO }, page([])]);
    expect(await new SafeApiClient('ethereum').fetchQueuedTransactions(SAFE, 613, { decode: false })).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/api/v1/safes/${SAFE}/`, queueUrl(0)]);
  });

  it('returns an empty array only when the service returns zero pending transactions', async () => {
    stubFetch([page([])]);
    expect(await new SafeApiClient('ethereum').fetchQueuedTransactions(SAFE, 613, { safeInfo: SAFE_INFO })).toEqual([]);
  });

  it('reads further pages by offset while the service reports a next page', async () => {
    const first = Array.from({ length: 100 }, (_, i) => pending(900 - i));
    const calls = stubFetch([page(first, 'more'), page([pending(700)])]);
    const queued = await new SafeApiClient('ethereum').fetchQueuedTransactions(SAFE, 613, {
      safeInfo: SAFE_INFO,
      decode: false,
    });
    expect(queued).toHaveLength(101);
    expect(calls.map((c) => c.url)).toEqual([queueUrl(0), queueUrl(100)]);
  });

  it('throws rather than return a partial queue past five pages', async () => {
    const answers = Array.from({ length: 5 }, (_, p) =>
      page(
        Array.from({ length: 100 }, (_, i) => pending(10_000 - p * 100 - i)),
        'more'
      )
    );
    stubFetch(answers);
    await expect(
      new SafeApiClient('ethereum').fetchQueuedTransactions(SAFE, 613, { safeInfo: SAFE_INFO, decode: false })
    ).rejects.toThrow(
      `The Safe Queue Service reports more than 500 pending transactions for Safe ${SAFE}. This tool reads at most 500 and does not show a partial queue.`
    );
  });

  it('decodes each distinct calldata once, and marks a decoder failure', async () => {
    const calls = stubFetch([
      page([pending(615), pending(614), pending(613, { data: '0xdeadbeef' })]),
      { status: 200, body: TRANSFER_DECODED },
      { status: 500 },
    ]);
    const queued = await new SafeApiClient('ethereum').fetchQueuedTransactions(SAFE, 613, { safeInfo: SAFE_INFO });
    expect(calls).toHaveLength(3);
    expect(queued.map((t) => t.dataDecoded)).toEqual([TRANSFER_DECODED, TRANSFER_DECODED, null]);
    expect(queued[2]!.dataDecodedUnavailable).toBe('HTTP 500');
  });

  it('throws when the queue cannot be read, and does not return an empty queue', async () => {
    stubFetch([
      {
        status: 422,
        body: { detail: `Safe ${SAFE} does not exist on the selected chain` },
      },
    ]);
    await expect(
      new SafeApiClient('ethereum').fetchQueuedTransactions(SAFE, 13, { safeInfo: SAFE_INFO })
    ).rejects.toThrow(
      `Failed to fetch the queue from the Safe Queue Service: HTTP 422: Safe ${SAFE} does not exist on the selected chain`
    );
  });

  it('rejects a record for another Safe or another chain', async () => {
    stubFetch([page([pending(614, { safe: OTHER_SAFE.toLowerCase() })])]);
    await expect(
      new SafeApiClient('ethereum').fetchQueuedTransactions(SAFE, 613, { safeInfo: SAFE_INFO })
    ).rejects.toThrow(`for Safe ${OTHER_SAFE}. The request was for Safe ${SAFE}.`);

    stubFetch([page([pending(614, { chainId: '10' })])]);
    await expect(
      new SafeApiClient('ethereum').fetchQueuedTransactions(SAFE, 613, { safeInfo: SAFE_INFO })
    ).rejects.toThrow(`for chain "10". The request was for chain 1.`);
  });
});

const listUrl = (limit: number, offset: number) =>
  `${QUEUE}/api/v1/safes/${SAFE}/multisig-transactions?chainId=1&nonceOrder=desc&limit=${limit}&offset=${offset}`;

/** `count` records from `top` down, one per nonce, with no calldata to decode. */
const descending = (top: number, count: number) =>
  Array.from({ length: count }, (_, i) => pending(top - i, { data: null }));

describe('fetchTransactionsByNonce', () => {
  it('pages the Safe list, keeps the nonce, and stops below it', async () => {
    const calls = stubFetch([
      page(descending(700, 100), 'more'),
      page([...descending(600, 51), pending(550, { safeTxHash: hashFor(1550) }), ...descending(549, 48)], 'more'),
      { status: 200, body: TRANSFER_DECODED },
    ]);
    const txs = await new SafeApiClient('ethereum').fetchTransactionsByNonce(SAFE, 550, SAFE_INFO);
    expect(txs.map((t) => t.safeTxHash)).toEqual([hashFor(550), hashFor(1550)]);
    expect(txs.map((t) => t.nonce)).toEqual([550, 550]);
    expect(calls.map((c) => c.url)).toEqual([listUrl(100, 0), listUrl(100, 100), DECODER]);
  });

  it('finds an executed transaction in the list', async () => {
    stubFetch([
      page([pending(521, { data: null }), QUEUE_520, pending(519, { data: null })]),
      {
        status: 200,
        body: TRANSFER_DECODED,
      },
    ]);
    const [tx] = await new SafeApiClient('ethereum').fetchTransactionsByNonce(SAFE, 520, SAFE_INFO);
    expect(tx).toMatchObject({ safeTxHash: SAFE_TX_HASH, isExecuted: true, nonce: 520 });
  });

  it('reads the Safe info when the caller does not pass it', async () => {
    const calls = stubFetch([
      { status: 200, body: SAFE_INFO },
      page([QUEUE_520]),
      { status: 200, body: TRANSFER_DECODED },
    ]);
    await new SafeApiClient('ethereum').fetchTransactionsByNonce(SAFE, 520);
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/safes/${SAFE}/`);
  });

  it('rejects a list that is not in descending nonce order, since the early stop depends on it', async () => {
    stubFetch([page([pending(600), pending(612)])]);
    await expect(new SafeApiClient('ethereum').fetchTransactionsByNonce(SAFE, 520, SAFE_INFO)).rejects.toThrow(
      `The Safe Queue Service returned the transactions of Safe ${SAFE} out of nonce order: nonce 612 after nonce 600.`
    );
  });

  it('rejects a record for another Safe', async () => {
    stubFetch([page([pending(520, { safe: OTHER_SAFE.toLowerCase() })])]);
    await expect(new SafeApiClient('ethereum').fetchTransactionsByNonce(SAFE, 520, SAFE_INFO)).rejects.toThrow(
      `The Safe Queue Service returned transaction ${hashFor(520)} for Safe ${OTHER_SAFE}. The request was for Safe ${SAFE}.`
    );
  });

  it('throws when no transaction is found', async () => {
    stubFetch([page(descending(700, 3))]);
    await expect(new SafeApiClient('ethereum').fetchTransactionsByNonce(SAFE, 520, SAFE_INFO)).rejects.toThrow(
      `No transaction found for Safe ${SAFE} at nonce 520`
    );
  });

  it('throws when the nonce is beyond the page limit', async () => {
    stubFetch(Array.from({ length: 20 }, (_, p) => page(descending(10_000 - p * 100, 100), 'more')));
    await expect(new SafeApiClient('ethereum').fetchTransactionsByNonce(SAFE, 5, SAFE_INFO)).rejects.toThrow(
      `Nonce 5 of Safe ${SAFE} is beyond the 2000 most recent transactions. This tool does not read further.`
    );
  });

  it('throws on a failed read', async () => {
    const calls = stubFetch([{ status: 503, body: { detail: 'Safe information is unavailable' } }]);
    await expect(new SafeApiClient('ethereum').fetchTransactionsByNonce(SAFE, 614, SAFE_INFO)).rejects.toThrow(
      'Failed to fetch transactions from the Safe Queue Service: HTTP 503: Safe information is unavailable'
    );
    expect(calls).toHaveLength(1);
  });
});

describe('fetchTransactions', () => {
  it('reads one page of the Safe list and converts it', async () => {
    const calls = stubFetch([page([pending(614, { data: null }), QUEUE_520]), { status: 200, body: TRANSFER_DECODED }]);
    const result = await new SafeApiClient('ethereum').fetchTransactions(SAFE, 20, SAFE_INFO);
    expect(result.results.map((t) => t.nonce)).toEqual([614, 520]);
    expect(calls.map((c) => c.url)).toEqual([listUrl(20, 0), DECODER]);
  });

  it('does not call the decoder with decode: false', async () => {
    const calls = stubFetch([page([QUEUE_520])]);
    const result = await new SafeApiClient('ethereum').fetchTransactions(SAFE, 20, SAFE_INFO, { decode: false });
    expect(calls.map((c) => c.url)).toEqual([listUrl(20, 0)]);
    expect(result.results[0]).toMatchObject({ dataDecoded: null, dataDecodedUnavailable: 'not requested' });
  });

  it('returns an empty list only when the service returns zero transactions', async () => {
    stubFetch([page([])]);
    expect((await new SafeApiClient('ethereum').fetchTransactions(SAFE, 20, SAFE_INFO)).results).toEqual([]);
  });

  it('rejects a record for another Safe', async () => {
    stubFetch([page([pending(1, { safe: OTHER_SAFE.toLowerCase() })])]);
    await expect(new SafeApiClient('ethereum').fetchTransactions(SAFE, 20, SAFE_INFO)).rejects.toThrow(
      `for Safe ${OTHER_SAFE}. The request was for Safe ${SAFE}.`
    );
  });
});

describe('fetchSafeInfo', () => {
  it('rejects Safe info for another Safe', async () => {
    stubFetch([{ status: 200, body: { ...SAFE_INFO, address: OTHER_SAFE } }]);
    await expect(new SafeApiClient('ethereum').fetchSafeInfo(SAFE)).rejects.toThrow(
      `The Safe Transaction Service returned Safe info for ${OTHER_SAFE}. The request was for Safe ${SAFE}.`
    );
  });
});
