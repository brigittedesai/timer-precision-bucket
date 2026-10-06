/**
 * Groups elapsed milliseconds into time-align buckets and maintains a
 * fixed-length rolling window of those buckets so that percentile-like
 * statistics can be computed cheaply over "the last N intervals".
 *
 * Design decisions, stated plainly:
 *
 *   1. Bucket index is `floor(timestamp / interval)`. A sample with
 *      timestamp 1500 and interval 1000 lands in bucket index 1. This
 *      keeps the math trivially inspectable and avoids a separate epoch
 *      anchor — the bucket boundary is the first multiple of `interval`
 *      at or below the sample's timestamp.
 *
 *   2. The window has a fixed size `maxBuckets`. When the most recent
 *      sample's bucket advances past the oldest bucket by more than
 *      `maxBuckets`, stale buckets are dropped. "Dropped" means their
 *      {sum,count} is zeroed and the window pointer moves forward.
 *
 *   3. Samples that fall inside the current window but older than the
 *      newest bucket are still recorded into their own (possibly
 *      still-live) bucket — out-of-order arrival within the window is
 *      supported. Samples older than the oldest live bucket are ignored
 *      (record() returns false). This is a deliberate trade-off: we keep
 *      the hot path O(1) and bounded, at the cost of silently dropping
 *      very-late samples. Late samples that fit in the window are the
 *      awkward edge; very late samples are not.
 *
 *   4. Percentiles are computed from the bucket *sums*, not individual
 *      samples. That means "p99 latency" here is an approximation: it
 *      answers "what is the 99th-percentile *bucket's* average latency".
 *      This is the entire reason the library is small and fast — you
 *      trade per-sample accuracy for constant memory. If you need
 *      exact percentiles over individual samples, do not use this
 *      library.
 *
 *   5. Time comes from an injectable `now()` function (milliseconds, same
 *      epoch as the samples you record). Default is `Date.now`. Tests must
 *      never depend on the wall clock, so every time-dependent path is
 *      reachable through a fake clock.
 */
export class PrecisionBuckets {
  /**
   * @param {object} opts
   * @param {number} opts.interval       Bucket width in ms. Must be a positive integer.
   * @param {number} opts.maxBuckets     How many buckets to retain. Must be >= 1.
   * @param {() => number} [opts.now]    Clock function returning ms. Defaults to Date.now.
   */
  constructor({ interval, maxBuckets, now }) {
    if (!Number.isInteger(interval) || interval <= 0) {
      throw new RangeError('interval must be a positive integer');
    }
    if (!Number.isInteger(maxBuckets) || maxBuckets < 1) {
      throw new RangeError('maxBuckets must be an integer >= 1');
    }
    this._interval = interval;
    this._maxBuckets = maxBuckets;
    this._now = typeof now === 'function' ? now : Date.now;

    // Ring buffer of live buckets. Each slot: { bucketIndex:number, sum:number, count:number }.
    // We do not store per-sample arrays; that is the whole point.
    this._buckets = new Array(maxBuckets).fill(null);
    this._newest = -1;   // index into _buckets of the newest live bucket, or -1 if empty
    this._oldestBI = -1; // bucketIndex of the oldest live bucket
    this._newestBI = -1; // bucketIndex of the newest live bucket
  }

  /**
   * Map a timestamp to its bucket index.
   * @param {number} t
   * @returns {number}
   */
  _bucketIndex(t) {
    return Math.floor(t / this._interval);
  }

  /**
   * Internal: ensure that `bi` is within the live window, advancing and
   * clearing stale buckets as needed. Returns the slot index for `bi`,
   * or -1 if `bi` is older than the oldest live bucket (a late drop).
   *
   * @param {number} bi target bucket index
   * @returns {number} slot index in _buckets, or -1 if out of window on the old side
   */
  _slotFor(bi) {
    if (this._newest === -1) {
      // First sample ever.
      const slot = 0;
      this._buckets[slot] = { bucketIndex: bi, sum: 0, count: 0 };
      this._newest = slot;
      this._oldestBI = bi;
      this._newestBI = bi;
      return slot;
    }

    // A sample is too old if it falls before the oldest bucket a full window
    // below the newest. When the window isn't full yet this still allows
    // out-of-order arrivals within maxBuckets range of the newest.
    const minLiveBI = this._newestBI - (this._maxBuckets - 1);
    if (bi < minLiveBI) {
      // Too old. The sample is silently dropped by the caller.
      return -1;
    }

    if (bi > this._newestBI) {
      // Advance the window, clearing buckets that fall outside maxBuckets.
      // We may skip multiple buckets at once (gap in arrivals); each
      // skipped bucket must be cleared if it wraps into an old slot.
      const advance = bi - this._newestBI;
      if (advance >= this._maxBuckets) {
        // Total reset: every old slot is stale.
        for (let i = 0; i < this._maxBuckets; i++) {
          this._buckets[i] = null;
        }
        const slot = 0;
        this._buckets[slot] = { bucketIndex: bi, sum: 0, count: 0 };
        this._newest = slot;
        this._oldestBI = bi;
        this._newestBI = bi;
        return slot;
      }
      // Step forward one bucket at a time so each newly-dead slot is
      // cleared before it is reused. This is at most maxBuckets-1 steps.
      for (let step = 0; step < advance; step++) {
        const nextSlot = (this._newest + 1) % this._maxBuckets;
        this._buckets[nextSlot] = null; // whatever was there is now out of window
        this._newest = nextSlot;
        this._newestBI += 1;
        // Oldest tracks the front of the window once it fills.
        if (this._newestBI - this._oldestBI + 1 > this._maxBuckets) {
          this._oldestBI = this._newestBI - (this._maxBuckets - 1);
        }
      }
      // Now _newestBI === bi. Create the fresh bucket.
      const slot = this._newest;
      this._buckets[slot] = { bucketIndex: bi, sum: 0, count: 0 };
      return slot;
    }

    // bi is within [minLiveBI, newestBI]: find its slot by walking back
    // from newest. Distance is newestBI - bi, which is < maxBuckets here.
    const distance = this._newestBI - bi;
    const slot = (this._newest - distance + this._maxBuckets) % this._maxBuckets;
    const entry = this._buckets[slot];
    if (entry && entry.bucketIndex === bi) {
      return slot;
    }
    // The slot may be empty (bucket never filled) or hold a stale entry.
    // Create/reuse it so out-of-order arrivals within the window land here.
    this._buckets[slot] = { bucketIndex: bi, sum: 0, count: 0 };
    if (bi < this._oldestBI) {
      this._oldestBI = bi;
    }
    return slot;
  }

  /**
   * Record an elapsed-time sample.
   *
   * @param {number} elapsedMs The duration to record. Must be a finite, non-negative number.
   * @param {number} [atMs]    Optional timestamp in ms. Defaults to now().
   * @returns {boolean} true if recorded into a live bucket, false if the sample was
   *                    older than the live window and therefore dropped.
   */
  record(elapsedMs, atMs) {
    if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
      throw new RangeError('elapsedMs must be a finite, non-negative number');
    }
    const t = typeof atMs === 'number' ? atMs : this._now();
    if (!Number.isFinite(t)) {
      throw new RangeError('timestamp must be finite');
    }
    const bi = this._bucketIndex(t);
    const slot = this._slotFor(bi);
    if (slot === -1) return false;
    const entry = this._buckets[slot];
    entry.sum += elapsedMs;
    entry.count += 1;
    return true;
  }

  /**
   * Live buckets ordered oldest -> newest. Each entry is a plain object:
   *   { bucketIndex, intervalMs, startMs, endMs, sum, count, mean }
   * `startMs`/`endMs` are inclusive bucket boundaries.
   *
   * @returns {Array<{bucketIndex:number, intervalMs:number, startMs:number, endMs:number, sum:number, count:number, mean:number}>}
   */
  buckets() {
    const out = [];
    if (this._newest === -1) return out;
    // Walk from oldest to newest using bucket indices; for each, derive slot.
    for (let bi = this._oldestBI; bi <= this._newestBI; bi++) {
      const distance = this._newestBI - bi;
      const slot = (this._newest - distance + this._maxBuckets) % this._maxBuckets;
      const e = this._buckets[slot];
      if (e && e.bucketIndex === bi) {
        out.push({
          bucketIndex: bi,
          intervalMs: this._interval,
          startMs: bi * this._interval,
          endMs: (bi + 1) * this._interval - 1,
          sum: e.sum,
          count: e.count,
          mean: e.count > 0 ? e.sum / e.count : 0,
        });
      }
    }
    return out;
  }

  /**
   * Approximate a percentile of the *bucket means*. See the class doc for
   * why this is an approximation, not an exact per-sample percentile.
   *
   * Uses the nearest-rank method over the sorted list of live bucket means.
   * Buckets with zero samples are excluded so that empty trailing buckets
   * don't drag the percentile down.
   *
   * @param {number} p  Percentile in [0, 100].
   * @returns {number|null} The approximate latency in ms, or null if no samples recorded.
   */
  percentile(p) {
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) {
      throw new RangeError('p must be a number in [0, 100]');
    }
    const means = this.buckets()
      .filter((b) => b.count > 0)
      .map((b) => b.mean);
    if (means.length === 0) return null;
    if (means.length === 1) return means[0];
    means.sort((a, b) => a - b);
    // Nearest-rank. p=0 -> first element, p=100 -> last element.
    const rank = Math.max(1, Math.ceil((p / 100) * means.length));
    return means[rank - 1];
  }

  /**
   * Remove and return up to `n` buckets from the oldest end of the window.
   * Useful when you want to drain completed buckets into another store on
   * a schedule without waiting for them to age out.
   *
   * @param {number} [n=1] How many buckets to drain.
   * @returns {Array<object>} Drained buckets, oldest first.
   */
  drain(n = 1) {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError('n must be a non-negative integer');
    }
    const out = [];
    if (this._newest === -1 || n === 0) return out;
    const liveCount = this._newestBI - this._oldestBI + 1;
    const take = Math.min(n, liveCount);
    for (let i = 0; i < take; i++) {
      const bi = this._oldestBI;
      const distance = this._newestBI - bi;
      const slot = (this._newest - distance + this._maxBuckets) % this._maxBuckets;
      const e = this._buckets[slot];
      if (e) {
        out.push({
          bucketIndex: bi,
          intervalMs: this._interval,
          startMs: bi * this._interval,
          endMs: (bi + 1) * this._interval - 1,
          sum: e.sum,
          count: e.count,
          mean: e.count > 0 ? e.sum / e.count : 0,
        });
        this._buckets[slot] = null;
      }
      this._oldestBI += 1;
    }
    if (this._oldestBI > this._newestBI) {
      // Everything drained.
      this._newest = -1;
      this._oldestBI = -1;
      this._newestBI = -1;
    }
    return out;
  }

  /** Total count of samples across all live buckets. */
  count() {
    let c = 0;
    for (const b of this.buckets()) c += b.count;
    return c;
  }

  /** Sum of elapsed across all live buckets. */
  sum() {
    let s = 0;
    for (const b of this.buckets()) s += b.sum;
    return s;
  }

  /** Arithmetic mean of all live samples, or null if empty. */
  mean() {
    const c = this.count();
    if (c === 0) return null;
    return this.sum() / c;
  }
}
