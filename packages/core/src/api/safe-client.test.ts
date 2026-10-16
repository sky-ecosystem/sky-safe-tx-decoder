/**
 * Tests for the Safe Transaction Service client calls used before a
 * transaction is proposed. `fetch` is stubbed.
 *
 * The data-decoder answer below is the live service's answer for the calldata
 * of Safe 0xf65475e74C1Ed6d004d5240b06E3088724dFDA5d, nonce 520. It equals
 * that transaction record's dataDecoded.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SafeApiClient } from './safe-client.js';

const BASE = 'https://api.safe.global/tx-service/eth';
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
  it('POSTs data and to to the data decoder and returns its decoding', async () => {
    const calls = stubFetch([{ status: 200, body: TRANSFER_DECODED }]);
    const result = await new SafeApiClient('ethereum').decodeData(TRANSFER_DATA, USDC);
    expect(result).toEqual({ status: 'decoded', decoded: TRANSFER_DECODED });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/data-decoder/`);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ data: TRANSFER_DATA, to: USDC });
  });

  it('answers none for empty calldata, without a request', async () => {
    const calls = stubFetch([]);
    expect(await new SafeApiClient('ethereum').decodeData('0x', USDC)).toEqual({ status: 'none' });
    expect(calls).toHaveLength(0);
  });

  it("returns the service's fallback sentinel unchanged, as a decoding", async () => {
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

  it('fails on a non-2xx answer, naming the status', async () => {
    for (const status of [400, 404, 422, 500, 503]) {
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

describe('fetchTransactionByHash', () => {
  it('reads the transaction by safeTxHash', async () => {
    const record = { safe: SAFE, nonce: 520, safeTxHash: SAFE_TX_HASH };
    const calls = stubFetch([{ status: 200, body: record }]);
    expect(await new SafeApiClient('ethereum').fetchTransactionByHash(SAFE_TX_HASH)).toEqual(record);
    expect(calls[0]!.url).toBe(`${BASE}/api/v2/multisig-transactions/${SAFE_TX_HASH}/`);
  });

  it('returns null when the service has no such transaction', async () => {
    stubFetch([{ status: 404, body: { detail: 'No MultisigTransaction matches the given query.' } }]);
    expect(await new SafeApiClient('ethereum').fetchTransactionByHash(SAFE_TX_HASH)).toBeNull();
  });

  it('throws on any other failure', async () => {
    stubFetch([{ status: 500, statusText: 'Internal Server Error' }]);
    await expect(new SafeApiClient('ethereum').fetchTransactionByHash(SAFE_TX_HASH)).rejects.toThrow(
      'Safe API request failed: Internal Server Error'
    );
  });
});

describe('fetchQueuedTransactions', () => {
  const tx = (nonce: number | string, isExecuted: boolean) => ({ nonce, isExecuted, safeTxHash: SAFE_TX_HASH });

  it('asks for the queue from the on-chain nonce and keeps only queued transactions', async () => {
    const calls = stubFetch([
      {
        status: 200,
        // A service that ignored the filter would return these. Executed, and
        // not executed but below the on-chain nonce (replaced), are dropped.
        body: {
          count: 4,
          next: null,
          previous: null,
          results: [tx(15, false), tx('14', false), tx(14, true), tx(12, false)],
        },
      },
    ]);
    const queued = await new SafeApiClient('ethereum').fetchQueuedTransactions(SAFE, 13);
    expect(queued.map((t) => Number(t.nonce))).toEqual([15, 14]);
    expect(calls[0]!.url).toBe(
      `${BASE}/api/v1/safes/${SAFE}/multisig-transactions/?executed=false&nonce__gte=13&ordering=-nonce&limit=100&offset=0`
    );
  });

  it('reads further pages while the service reports more', async () => {
    const page = Array.from({ length: 100 }, (_, i) => tx(300 - i, false));
    const calls = stubFetch([
      { status: 200, body: { count: 101, next: 'more', previous: null, results: page } },
      { status: 200, body: { count: 101, next: null, previous: 'back', results: [tx(200, false)] } },
    ]);
    const queued = await new SafeApiClient('ethereum').fetchQueuedTransactions(SAFE, 200);
    expect(queued).toHaveLength(101);
    expect(calls[1]!.url).toContain('&offset=100');
  });

  it('throws when the queue cannot be read', async () => {
    stubFetch([{ status: 503, statusText: 'Service Unavailable' }]);
    await expect(new SafeApiClient('ethereum').fetchQueuedTransactions(SAFE, 13)).rejects.toThrow(
      'Failed to fetch queued transactions: Service Unavailable'
    );
  });
});
