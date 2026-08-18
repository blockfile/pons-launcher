'use strict';

/**
 * A seeded pseudo-random generator, because Math.random cannot be one.
 *
 * The plan is generated once and then lived with for weeks, so the operator has
 * to be able to prove after the fact that nothing re-rolled itself. Storing the
 * seed alongside the campaign makes the whole schedule reproducible: same seed
 * and same parameters regenerate it byte for byte. That is also what lets the
 * commit endpoint regenerate the plan server-side from a seed rather than
 * trusting a transfer list the browser has had its hands on.
 *
 * mulberry32 — small, fast, and good enough for scheduling jitter. This is NOT
 * a source of cryptographic randomness and must never be used to make a key;
 * key generation goes through the keystore, which uses crypto.
 */

const crypto = require('crypto');

/** A fresh seed. Crypto-random because a guessable schedule is a schedule. */
function newSeed() {
  return crypto.randomBytes(16).toString('hex');
}

/** Fold an arbitrary string into the 32-bit state mulberry32 wants. */
function hashSeed(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function make(seed) {
  let a = hashSeed(seed);

  function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], both inclusive. */
  function int(min, max) {
    return min + Math.floor(next() * (max - min + 1));
  }

  function pick(array) {
    return array[int(0, array.length - 1)];
  }

  return { next, int, pick };
}

module.exports = { make, newSeed, _private: { hashSeed } };
