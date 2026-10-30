import { buildCreatePayload } from './job-payload.mjs';

function safeProgress(onProgress, current, total) {
  if (!onProgress) return;
  try {
    onProgress({ stage: 'import', current, total });
  } catch {
    // Progress must not change import results.
  }
}

function planAdmission(pending, userIds, perUserLimit, sharedLimit, validate) {
  const users = userIds.length > 0 ? [...new Set(userIds)].sort() : ['__single_user__'];
  const queues = new Map(users.map((id) => [id, pending.filter((item) => (
    userIds.length === 0 || (item.candidate.matchedUserIds ?? []).includes(id)
  ))]));
  const cursors = new Map(users.map((id) => [id, 0]));
  const slots = new Map(users.map((id) => [id, 0]));
  const selected = new Set();
  const admitted = [];
  let progress = true;

  // Round-robin selection uses listing order within each user queue.
  while (progress) {
    progress = false;
    for (const userId of users) {
      if (slots.get(userId) >= perUserLimit) continue;
      const queue = queues.get(userId);
      let cursor = cursors.get(userId);
      while (cursor < queue.length) {
        const item = queue[cursor];
        cursor += 1;
        if (selected.has(item.index)) continue;
        selected.add(item.index);
        const payload = validate(item);
        if (!payload) continue;
        slots.set(userId, slots.get(userId) + 1);
        admitted.push({ ...item, payload, admissionPool: 'user', sponsoredByUserId: userId });
        progress = true;
        break;
      }
      cursors.set(userId, cursor);
    }
  }

  // Only jobs shared by at least two active users can use the stretch pool.
  let shared = 0;
  if (users.length > 1) {
    for (const item of pending) {
      if (shared >= sharedLimit) break;
      if (selected.has(item.index)) continue;
      const matched = new Set(item.candidate.matchedUserIds ?? []);
      if (users.filter((id) => matched.has(id)).length < 2) continue;
      selected.add(item.index);
      const payload = validate(item);
      if (!payload) continue;
      admitted.push({ ...item, payload, admissionPool: 'shared', sponsoredByUserId: null });
      shared += 1;
    }
  }
  return { admitted, selected, slots, shared };
}

export async function importCandidates(candidates, client, {
  maxCreatesPerUser,
  sharedCreates = 0,
  eligibleUserIds = [],
  requireDescription,
  onProgress = null,
  onResult = null,
} = {}) {
  if (!Number.isSafeInteger(maxCreatesPerUser) || maxCreatesPerUser <= 0) {
    throw new Error('maxCreatesPerUser must be a positive integer');
  }
  if (!Number.isSafeInteger(sharedCreates) || sharedCreates < 0) {
    throw new Error('sharedCreates must be a non-negative integer');
  }
  const results = new Array(candidates.length);
  const pending = [];
  let completed = 0;
  function record(index, output) {
    results[index] = output;
    if (onResult) {
      try {
        onResult(output, index);
      } catch {
        // Run journaling must not change imports.
      }
    }
    completed += 1;
    safeProgress(onProgress, completed, candidates.length);
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    let state = null;
    if (candidate.preflight?.status !== 'ok') {
      state = { status: 'skipped_preflight_error', jobId: null };
    } else if (candidate.preflight.exists && candidate.existingJobId) {
      state = { status: 'existing_preflight', jobId: candidate.existingJobId };
    } else if (candidate.detail?.status === 'unavailable') {
      state = {
        status: 'skipped_detail_unavailable',
        jobId: null,
        responseStatus: candidate.detail.responseStatus ?? null,
      };
    } else if (candidate.locationEligibility?.status === 'ineligible') {
      state = {
        status: 'skipped_location_ineligible',
        jobId: null,
        reason: candidate.locationEligibility.reason ?? null,
        consistency: candidate.locationEligibility.consistency ?? null,
      };
    } else if (requireDescription && (typeof candidate.description !== 'string' || !candidate.description.trim())) {
      state = { status: 'skipped_missing_description', jobId: null };
    }
    if (state) {
      record(index, { ...candidate, import: state });
      continue;
    }
    pending.push({ index, candidate });
  }

  function validate(item) {
    try {
      return buildCreatePayload(item.candidate, { requireDescription });
    } catch (error) {
      record(item.index, {
        ...item.candidate,
        import: {
          status: 'skipped_invalid_payload',
          jobId: null,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return null;
    }
  }

  const plan = planAdmission(
    pending, eligibleUserIds, maxCreatesPerUser, sharedCreates, validate,
  );
  for (const item of plan.admitted) {
    try {
      const result = await client.createJob(item.payload, {
        reconcileUrl: item.candidate.url,
        reconcileIdentity: item.candidate.canonicalIdentity,
      });
      record(item.index, {
        ...item.candidate,
        existingJobId: result.id,
        import: {
          status: result.disposition,
          jobId: result.id,
          reconciled: result.reconciled,
          responseStatus: result.responseStatus,
          payload: item.payload,
          admissionPool: item.admissionPool,
          sponsoredByUserId: item.sponsoredByUserId,
        },
      });
    } catch (error) {
      record(item.index, {
        ...item.candidate,
        import: {
          status: 'error',
          jobId: null,
          payload: item.payload,
          error: error instanceof Error ? error.message : String(error),
          admissionPool: item.admissionPool,
          sponsoredByUserId: item.sponsoredByUserId,
        },
      });
    }
  }
  for (const item of pending) {
    if (plan.selected.has(item.index)) continue;
    record(item.index, {
      ...item.candidate,
      import: { status: 'skipped_user_quota', jobId: null },
    });
  }
  return results;
}
