'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { JsonRpcProvider } = require('ethers');

const { RetryJsonRpcProvider, isRateLimited, isTransient } = require('./provider');

/**
 * Swap the parent class's _send for the duration of one call, so the retry
 * logic can be exercised without a network. RetryJsonRpcProvider calls
 * super._send, which resolves to JsonRpcProvider.prototype._send.
 */
async function withParentSend(impl, fn) {
  const proto = JsonRpcProvider.prototype;
  const original = proto._send;
  proto._send = impl;
  try {
    await fn();
  } finally {
    proto._send = original;
  }
}

function newProvider() {
  return new RetryJsonRpcProvider('http://127.0.0.1:1', 4663, { staticNetwork: true });
}

const broadcast = { jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0xraw'] };
const read = { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [] };

test('isRateLimited recognises the refusals that mean "never reached the chain"', () => {
  assert.equal(isRateLimited({ code: -32005, message: 'limit exceeded' }), true);
  assert.equal(isRateLimited({ message: 'Too Many Requests' }), true);
  assert.equal(isRateLimited({ info: { responseStatus: '429 Too Many Requests' } }), true);
  assert.equal(isRateLimited({ message: 'rate limit reached, upgrade your plan' }), true);

  // These say the sequencer DID see it. Retrying would double-broadcast.
  assert.equal(isRateLimited({ code: -32000, message: 'nonce too low' }), false);
  assert.equal(isRateLimited({ message: 'already known' }), false);
  assert.equal(isRateLimited({ message: 'insufficient funds for gas * price + value' }), false);
});

test('a rate-limited broadcast is retried until it lands', async () => {
  let calls = 0;
  await withParentSend(
    async () => {
      calls++;
      return calls < 3
        ? [{ id: 1, error: { code: -32005, message: 'request limit exceeded' } }]
        : [{ id: 1, result: '0xhash' }];
    },
    async () => {
      const p = newProvider();
      const res = await p._send(broadcast);
      assert.equal(calls, 3, 'should have retried twice before succeeding');
      assert.equal(res[0].result, '0xhash');
      p.destroy();
    }
  );
});

test('a broadcast that the chain actually saw is NEVER retried', async () => {
  let calls = 0;
  await withParentSend(
    async () => {
      calls++;
      return [{ id: 1, error: { code: -32000, message: 'nonce too low' } }];
    },
    async () => {
      const p = newProvider();
      await p._send(broadcast);
      // Re-sending a transaction that already landed would look like a failure
      // and could double-broadcast. One attempt, always.
      assert.equal(calls, 1);
      p.destroy();
    }
  );
});

test('an "already known" broadcast is not retried either', async () => {
  let calls = 0;
  await withParentSend(
    async () => {
      calls++;
      throw Object.assign(new Error('already known'), { code: -32000 });
    },
    async () => {
      const p = newProvider();
      await assert.rejects(() => p._send(broadcast), /already known/);
      assert.equal(calls, 1);
      p.destroy();
    }
  );
});

test('reads still retry the transient errors this RPC is known for', async () => {
  let calls = 0;
  await withParentSend(
    async () => {
      calls++;
      return calls < 2
        ? [{ id: 1, error: { code: -32601, message: 'Method not found' } }]
        : [{ id: 1, result: '0x1' }];
    },
    async () => {
      const p = newProvider();
      const res = await p._send(read);
      assert.equal(calls, 2);
      assert.equal(res[0].result, '0x1');
      p.destroy();
    }
  );
});

test('a read retries a thrown network error, as it always did', async () => {
  let calls = 0;
  await withParentSend(
    async () => {
      calls++;
      if (calls < 3) throw new Error('socket hang up');
      return [{ id: 1, result: '0x1' }];
    },
    async () => {
      const p = newProvider();
      const res = await p._send(read);
      assert.equal(calls, 3);
      assert.equal(res[0].result, '0x1');
      p.destroy();
    }
  );
});

test('isTransient still ignores errors that are nobody\'s fault but ours', () => {
  assert.equal(isTransient({ code: -32601, message: 'Method not found' }), true);
  assert.equal(isTransient({ message: 'execution reverted' }), false);
});
