import {
  buildCreatePayload,
} from './job-payload.mjs';

export async function importCandidates(
  candidates,
  client,
  {
    maxCreates,
    requireDescription,
  },
) {
  const results = [];
  let createAttempts = 0;

  for (const candidate of candidates) {
    if (candidate.preflight?.status !== 'ok') {
      results.push({
        ...candidate,
        import: {
          status: 'skipped_preflight_error',
          jobId: null,
        },
      });

      continue;
    }

    if (
      candidate.preflight.exists
      && candidate.existingJobId
    ) {
      results.push({
        ...candidate,
        import: {
          status: 'existing_preflight',
          jobId: candidate.existingJobId,
        },
      });

      continue;
    }

    if (
      requireDescription
      && (
        typeof candidate.description !== 'string'
        || candidate.description.trim() === ''
      )
    ) {
      results.push({
        ...candidate,
        import: {
          status: 'skipped_missing_description',
          jobId: null,
        },
      });

      continue;
    }

    if (createAttempts >= maxCreates) {
      results.push({
        ...candidate,
        import: {
          status: 'skipped_create_limit',
          jobId: null,
        },
      });

      continue;
    }

    let payload;

    try {
      payload = buildCreatePayload(candidate, {
        requireDescription,
      });
    } catch (error) {
      results.push({
        ...candidate,
        import: {
          status: 'skipped_invalid_payload',
          jobId: null,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
      });

      continue;
    }

    createAttempts += 1;

    try {
      const result = await client.createJob(
        payload,
        {
          reconcileUrl: candidate.url,
        },
      );

      results.push({
        ...candidate,
        existingJobId: result.id,
        import: {
          status: result.disposition,
          jobId: result.id,
          reconciled: result.reconciled,
          responseStatus: result.responseStatus,
          payload,
        },
      });
    } catch (error) {
      results.push({
        ...candidate,
        import: {
          status: 'error',
          jobId: null,
          payload,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
      });
    }
  }

  return results;
}
