import { describe, it, expect } from 'vitest';
import { checkProposalNonce, recommendedProposalNonce } from './proposal-nonce.js';

describe('recommendedProposalNonce', () => {
  it('is the on-chain nonce when nothing is queued', () => {
    expect(recommendedProposalNonce(604, [])).toBe(604);
  });

  it('is one past the highest queued nonce when the queue runs past the on-chain nonce', () => {
    expect(recommendedProposalNonce(13, [13, 14])).toBe(15);
    expect(recommendedProposalNonce(13, [14, 13])).toBe(15);
  });

  it('never goes below the on-chain nonce', () => {
    expect(recommendedProposalNonce(20, [3, 4])).toBe(20);
  });
});

describe('checkProposalNonce', () => {
  it('flags a nonce below the on-chain nonce as used', () => {
    expect(checkProposalNonce(12n, 13, [13, 14])).toEqual({ used: true, queued: false });
  });

  it('flags a nonce a queued transaction already uses', () => {
    expect(checkProposalNonce(14n, 13, [13, 14])).toEqual({ used: false, queued: true });
  });

  it('flags nothing for the next free nonce', () => {
    expect(checkProposalNonce(15n, 13, [13, 14])).toEqual({ used: false, queued: false });
  });

  it('compares nonces past 2^53 exactly', () => {
    expect(checkProposalNonce(9007199254740993n, 13, [])).toEqual({ used: false, queued: false });
  });
});
