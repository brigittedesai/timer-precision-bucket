import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrecisionBuckets } from '../src/index.js';

// All time-dependent tests use a fake clock; no test touches Date.now or sleeps.
function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; return t; }, get: () => t };
}

test('constructor rejects non-positive or non-integer interval', () => {
  assert.throws(() => new PrecisionBuckets({ interval: 0, maxBuckets: 3 }), RangeError);
  assert.throws(() => new PrecisionBuckets({ interval: -1, maxBuckets: 3 }), RangeError);
  assert.throws(() => new PrecisionBuckets({ interval: 1.5, maxBuckets: 3 }), RangeError);
});

test('constructor rejects bad maxBuckets', () => {
  assert.throws(() => new PrecisionBuckets({ interval: 100, maxBuckets: 0 }), RangeError);
  assert.throws(() => new PrecisionBuckets({ interval: 100, maxBuckets: 1.5 }), RangeError);
});

test('records a sample into the correct bucket and exposes it via buckets()', () => {
  const clock = makeClock(1500);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 4, now: clock.now });
  assert.strictEqual(b.record(42), true);
  const buckets = b.buckets();
  assert.strictEqual(buckets.length, 1);
  assert.strictEqual(buckets[0].bucketIndex, 1);
  assert.strictEqual(buckets[0].startMs, 1000);
  assert.strictEqual(buckets[0].endMs, 1999);
  assert.strictEqual(buckets[0].sum, 42);
  assert.strictEqual(buckets[0].count, 1);
  assert.strictEqual(buckets[0].mean, 42);
});

test('multiple samples in the same bucket aggregate', () => {
  const clock = makeClock(1500);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 4, now: clock.now });
  b.record(10);
  b.record(30);
  const buckets = b.buckets();
  assert.strictEqual(buckets.length, 1);
  assert.strictEqual(buckets[0].sum, 40);
  assert.strictEqual(buckets[0].count, 2);
  assert.strictEqual(buckets[0].mean, 20);
});

test('samples in different buckets create separate entries', () => {
  const clock = makeClock(500);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 4, now: clock.now });
  b.record(10);              // bucket 0
  clock.advance(1000);
  b.record(20);              // bucket 1
  clock.advance(1000);
  b.record(30);              // bucket 2
  const buckets = b.buckets();
  assert.strictEqual(buckets.length, 3);
  assert.deepStrictEqual(buckets.map(x => x.bucketIndex), [0, 1, 2]);
  assert.deepStrictEqual(buckets.map(x => x.sum), [10, 20, 30]);
});

test('out-of-order samples within the window are recorded into their own bucket', () => {
  const clock = makeClock(3500);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 5, now: clock.now });
  b.record(100, 3500);  // bucket 3 (newest)
  b.record(50, 2500);   // bucket 2 (older but still live)
  b.record(25, 1500);   // bucket 1 (older but still live)
  const buckets = b.buckets();
  assert.strictEqual(buckets.length, 3);
  assert.deepStrictEqual(buckets.map(x => x.bucketIndex), [1, 2, 3]);
  assert.deepStrictEqual(buckets.map(x => x.sum), [25, 50, 100]);
});

test('samples older than the live window are dropped and record returns false', () => {
  const clock = makeClock(0);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 3, now: clock.now });
  b.record(10, 0);       // bucket 0
  // Advance far enough that bucket 0 is out of the 3-wide window.
  // Newest becomes bucket 5 -> window is [3,4,5].
  b.record(99, 5500);
  // Now a sample for bucket 0 is older than oldestBI (3).
  assert.strictEqual(b.record(999, 500), false);
  const buckets = b.buckets();
  assert.strictEqual(buckets.length, 1);
  assert.strictEqual(buckets[0].bucketIndex, 5);
  assert.strictEqual(buckets[0].sum, 99);
});

test('a gap larger than maxBuckets fully resets the window', () => {
  const clock = makeClock(0);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 3, now: clock.now });
  b.record(10, 0);
  b.record(20, 1000);
  b.record(30, 2000);
  assert.strictEqual(b.buckets().length, 3);
  // Gap of 10 buckets fully clears everything.
  b.record(77, 12000);
  const buckets = b.buckets();
  assert.strictEqual(buckets.length, 1);
  assert.strictEqual(buckets[0].bucketIndex, 12);
  assert.strictEqual(buckets[0].sum, 77);
});

test('percentile returns null when no samples recorded', () => {
  const clock = makeClock(0);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 3, now: clock.now });
  assert.strictEqual(b.percentile(50), null);
});

test('percentile rejects out-of-range p', () => {
  const clock = makeClock(0);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 3, now: clock.now });
  assert.throws(() => b.percentile(-1), RangeError);
  assert.throws(() => b.percentile(101), RangeError);
  assert.throws(() => b.percentile(NaN), RangeError);
});

test('percentile uses nearest-rank over bucket means and ignores empty buckets', () => {
  const clock = makeClock(0);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 10, now: clock.now });
  // Bucket 0: mean 10, bucket 1: empty, bucket 2: mean 30, bucket 3: mean 50.
  b.record(10, 0);
  b.record(30, 2500);
  b.record(50, 3500);
  // Live buckets with samples sorted by mean: [10, 30, 50]
  assert.strictEqual(b.percentile(0), 10);
  assert.strictEqual(b.percentile(50), 30);   // ceil(0.5*3)=2 -> index 1 -> 30
  assert.strictEqual(b.percentile(100), 50);
  assert.strictEqual(b.percentile(90), 50);   // ceil(0.9*3)=3 -> index 2 -> 50
});

test('count, sum, mean aggregate across live buckets', () => {
  const clock = makeClock(0);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 4, now: clock.now });
  b.record(10, 0);
  b.record(20, 1000);
  b.record(30, 2000);
  assert.strictEqual(b.count(), 3);
  assert.strictEqual(b.sum(), 60);
  assert.strictEqual(b.mean(), 20);
});

test('mean returns null when empty', () => {
  const clock = makeClock(0);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 4, now: clock.now });
  assert.strictEqual(b.mean(), null);
});

test('drain removes oldest buckets and returns them oldest-first', () => {
  const clock = makeClock(0);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 4, now: clock.now });
  b.record(10, 0);
  b.record(20, 1000);
  b.record(30, 2000);
  const drained = b.drain(2);
  assert.strictEqual(drained.length, 2);
  assert.deepStrictEqual(drained.map(x => x.bucketIndex), [0, 1]);
  const remaining = b.buckets();
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].bucketIndex, 2);
});

test('drain with no argument drains one bucket', () => {
  const clock = makeClock(0);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 4, now: clock.now });
  b.record(10, 0);
  b.record(20, 1000);
  const drained = b.drain();
  assert.strictEqual(drained.length, 1);
  assert.strictEqual(drained[0].bucketIndex, 0);
});

test('draining all buckets leaves the window empty and next record starts fresh', () => {
  const clock = makeClock(0);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 3, now: clock.now });
  b.record(10, 0);
  b.drain(5); // more than live
  assert.strictEqual(b.buckets().length, 0);
  assert.strictEqual(b.count(), 0);
  b.record(99, 1000);
  const buckets = b.buckets();
  assert.strictEqual(buckets.length, 1);
  assert.strictEqual(buckets[0].bucketIndex, 1);
});

test('record rejects non-finite or negative elapsed', () => {
  const clock = makeClock(0);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 3, now: clock.now });
  assert.throws(() => b.record(-1), RangeError);
  assert.throws(() => b.record(NaN), RangeError);
  assert.throws(() => b.record(Infinity), RangeError);
});

test('record with negative timestamp floors into a negative bucket index consistently', () => {
  // Negative timestamps are unusual but legal; floor(-500/1000) = -1.
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 3, now: () => 0 });
  assert.strictEqual(b.record(5, -500), true);
  const buckets = b.buckets();
  assert.strictEqual(buckets.length, 1);
  assert.strictEqual(buckets[0].bucketIndex, -1);
  assert.strictEqual(buckets[0].startMs, -1000);
  assert.strictEqual(buckets[0].endMs, -1);
});

test('window slides correctly when buckets age out one at a time', () => {
  const clock = makeClock(0);
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 3, now: clock.now });
  b.record(1, 0);    // bucket 0
  b.record(2, 1000); // bucket 1
  b.record(3, 2000); // bucket 2 -> window full [0,1,2]
  b.record(4, 3000); // bucket 3 -> window [1,2,3]
  const buckets = b.buckets();
  assert.strictEqual(buckets.length, 3);
  assert.deepStrictEqual(buckets.map(x => x.bucketIndex), [1, 2, 3]);
  assert.deepStrictEqual(buckets.map(x => x.sum), [2, 3, 4]);
  // The aged-out bucket 0 should not reappear.
  assert.strictEqual(b.count(), 3);
});

test('wrapping ring buffer does not corrupt slots after many rotations', () => {
  const b = new PrecisionBuckets({ interval: 1000, maxBuckets: 3, now: () => 0 });
  for (let i = 0; i < 10; i++) {
    b.record(i + 1, i * 1000);
  }
  // After 10 advances with maxBuckets=3, live window is buckets [7,8,9].
  const buckets = b.buckets();
  assert.strictEqual(buckets.length, 3);
  assert.deepStrictEqual(buckets.map(x => x.bucketIndex), [7, 8, 9]);
  assert.deepStrictEqual(buckets.map(x => x.sum), [8, 9, 10]);
});
