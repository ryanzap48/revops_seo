// lib/jobs.js
// A crawl takes far longer than a request should, and proxies (Render's included)
// cut connections at ~100s. So a crawl is started as a job and polled: the POST
// returns an id immediately, and the client asks for progress until it is done.
//
// In-memory and single-instance, matching the rate limiter. Results expire so a
// long-running process cannot accumulate report payloads indefinitely.

import crypto from 'node:crypto';

export function createJobStore({ ttlMs = 15 * 60 * 1000, sweepMs = 60 * 1000 } = {}) {
  const jobs = new Map();

  function create(ownerKey, meta = {}) {
    const id = crypto.randomBytes(9).toString('base64url');
    const job = {
      id,
      ownerKey,
      meta,
      status: 'running',
      progress: { crawled: 0, discovered: 0, queued: 0, target: meta.maxPages ?? 0 },
      result: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    jobs.set(id, job);
    return job;
  }

  const get = (id) => jobs.get(id) || null;

  function update(id, patch) {
    const job = jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: Date.now() });
    return job;
  }

  /** How many crawls this caller already has running — one is plenty. */
  function activeCountFor(ownerKey) {
    let count = 0;
    for (const job of jobs.values()) if (job.ownerKey === ownerKey && job.status === 'running') count++;
    return count;
  }

  function activeCount() {
    let count = 0;
    for (const job of jobs.values()) if (job.status === 'running') count++;
    return count;
  }

  // A job that stops reporting progress is treated as dead, so a crash inside a
  // crawl cannot leave a caller permanently blocked by their own zombie job.
  const STALE_MS = 5 * 60 * 1000;
  function sweep() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.status === 'running' && now - job.updatedAt > STALE_MS) {
        Object.assign(job, { status: 'error', error: 'The crawl stopped responding and was abandoned.', updatedAt: now });
      }
      if (job.status !== 'running' && now - job.updatedAt > ttlMs) jobs.delete(id);
    }
  }

  const timer = setInterval(sweep, sweepMs);
  timer.unref?.(); // never hold the process open

  return { create, get, update, activeCountFor, activeCount, sweep, size: () => jobs.size };
}
