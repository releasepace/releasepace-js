/**
 * Canonical rollout bucketing.
 *
 * Every SDK and the API MUST produce identical buckets for identical
 * input. If they diverge, the same user is enabled in the browser and
 * disabled in the backend — a bug that presents as a race condition
 * and is miserable to trace.
 *
 * Algorithm: MurmurHash3 x86 32-bit, seed 0.
 * Chosen because it is synchronous (no crypto.subtle await on the hot
 * path), dependency-free, and trivially portable to Python, Java and Go.
 *
 * The conformance fixture in ../../../scripts/bucketing-vectors.json is
 * the source of truth. Every SDK asserts against it in CI.
 */

/** MurmurHash3 x86 32-bit. Returns an unsigned 32-bit integer. */
export function murmur3_32(key: string, seed = 0): number {
  const data = new TextEncoder().encode(key);
  const len = data.length;
  const nblocks = len >> 2;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  let h1 = seed >>> 0;

  for (let i = 0; i < nblocks; i++) {
    const j = i * 4;
    let k1 =
      (data[j] | (data[j + 1] << 8) | (data[j + 2] << 16) | (data[j + 3] << 24)) >>> 0;

    k1 = Math.imul(k1, c1) >>> 0;
    k1 = ((k1 << 15) | (k1 >>> 17)) >>> 0;
    k1 = Math.imul(k1, c2) >>> 0;

    h1 = (h1 ^ k1) >>> 0;
    h1 = ((h1 << 13) | (h1 >>> 19)) >>> 0;
    h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
  }

  let k1 = 0;
  const tail = nblocks * 4;

  switch (len & 3) {
    case 3:
      k1 ^= data[tail + 2] << 16;
    // falls through
    case 2:
      k1 ^= data[tail + 1] << 8;
    // falls through
    case 1:
      k1 ^= data[tail];
      k1 = Math.imul(k1 >>> 0, c1) >>> 0;
      k1 = ((k1 << 15) | (k1 >>> 17)) >>> 0;
      k1 = Math.imul(k1, c2) >>> 0;
      h1 = (h1 ^ k1) >>> 0;
  }

  h1 = (h1 ^ len) >>> 0;
  h1 = (h1 ^ (h1 >>> 16)) >>> 0;
  h1 = Math.imul(h1, 0x85ebca6b) >>> 0;
  h1 = (h1 ^ (h1 >>> 13)) >>> 0;
  h1 = Math.imul(h1, 0xc2b2ae35) >>> 0;
  h1 = (h1 ^ (h1 >>> 16)) >>> 0;

  return h1 >>> 0;
}

/**
 * Deterministic 0–99 bucket for a flag/entity pair.
 *
 * The flag key is part of the hash input on purpose. Hashing the
 * entity alone would put the same unlucky cohort in the first N% of
 * every flag forever; salting per flag re-scatters the population
 * independently for each rollout.
 */
export function bucketOf(flagKey: string, entityId: string): number {
  return murmur3_32(`${flagKey}:${entityId}`) % 100;
}

/**
 * Whether an entity falls inside a rollout percentage.
 *
 * Ramping only ever adds people: an entity in bucket 7 stays enabled
 * as the rollout goes 20 → 50 → 80, so nobody loses a feature they
 * have already started using.
 */
export function inRollout(flagKey: string, entityId: string, rolloutPct: number): boolean {
  if (rolloutPct <= 0) return false;
  if (rolloutPct >= 100) return true;
  return bucketOf(flagKey, entityId) < rolloutPct;
}
