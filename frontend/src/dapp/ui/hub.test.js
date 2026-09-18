import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from './hub.js';

test('on / emit / off', () => {
  const hub = createHub();
  const got = [];
  const off = hub.on('bar', (d) => got.push(d));
  hub.emit('bar', 1);
  hub.emit('other', 2);
  off();
  hub.emit('bar', 3);
  assert.deepEqual(got, [1]);
});

test('a throwing listener does not stop the others', () => {
  const hub = createHub();
  const got = [];
  const original = console.error;
  console.error = () => {};
  try {
    hub.on('x', () => {
      throw new Error('boom');
    });
    hub.on('x', (d) => got.push(d));
    hub.emit('x', 'ok');
  } finally {
    console.error = original;
  }
  assert.deepEqual(got, ['ok']);
});
