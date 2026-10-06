# Timer Precision Bucket

Groups elapsed milliseconds into fixed-width time-aligned buckets and keeps a rolling window of them so you can compute approximate percentiles over "the last N intervals" without retaining every individual sample.

## Usage

```js
import { PrecisionBuckets } from 'timer-precision-bucket';

const buckets = new PrecisionBuckets({
  interval: 1000,    // bucket width in ms
  maxBuckets: 60,    // keep the last 60 seconds
});

buckets.record(42);              // record a 42ms duration at the current time
buckets.record(88, Date.now());  // ...or at an explicit timestamp

const p99 = buckets.percentile(99);  // approximate, see below
const recent = buckets.buckets();    // oldest -> newest, each with sum/count/mean
const drained = buckets.drain(5);    // pull the 5 oldest buckets out of the window
```

## Why this exists

You have a high-volume latency stream and want p50/p99 over a rolling window, but you cannot afford to keep every sample in memory. This library keeps at most `maxBuckets` `{sum, count}` pairs in a ring buffer, so memory is constant and `record()` is O(1) amortised. The trade-off: percentiles are computed over **bucket means**, not individual samples. `percentile(99)` answers "what is the 99th-percentile *bucket's* average latency", which is close to the true p99 when buckets are small relative to the spread of your data, and wrong when they are not. If you need exact per-sample percentiles, use a structure that retains samples.

## The awkward edge

**Late samples.** A sample whose timestamp falls inside the live window but is older than the newest bucket is still recorded into its correct bucket — out-of-order arrival within the window is fine. A sample older than the oldest live bucket is silently dropped and `record()` returns `false`. We do not attempt to resurrect expired buckets, because that would make the hot path unbounded. If late arrival is common in your system, widen `maxBuckets` or drain on a schedule into a colder store.

## API summary

- `new PrecisionBuckets({ interval, maxBuckets, now? })` — `interval` and `maxBuckets` must be positive integers; `now` defaults to `Date.now`.
- `record(elapsedMs, atMs?)` → `boolean` (true if recorded, false if dropped as too old).
- `buckets()` → array of `{ bucketIndex, intervalMs, startMs, endMs, sum, count, mean }`, oldest first.
- `percentile(p)` → `number | null` (nearest-rank over non-empty bucket means; `p` in `[0, 100]`).
- `drain(n?)` → array of drained buckets, oldest first; removed from the window.
- `count()`, `sum()`, `mean()` → aggregates over live buckets (`mean()` is `null` when empty).
