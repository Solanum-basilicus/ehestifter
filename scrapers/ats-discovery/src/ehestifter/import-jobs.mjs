import { buildCreatePayload } from './job-payload.mjs';

function safeProgress(onProgress, current, total) {
  if (!onProgress) return;
  try {
    onProgress({ stage: 'import', current, total });
  } catch {
    /* Progress is diagnostic and must not affect imports. */
  }
}

export async function importCandidates(
  candidates,
  client,
  {
    maxCreates,
    requireDescription,
    onProgress = null,
  },
) {
  const results = [];
  let createAttempts = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    let output;
    if (candidate.preflight?.status !== 'ok') {
      output = {
        ...candidate,
        import: {
          status: 'skipped_preflight_error',
          jobId: null,
        },
      };
    } else if (candidate.preflight.exists && candidate.existingJobId) {
      output = {
        ...candidate,
        import: {
          status: 'existing_preflight',
          jobId: candidate.existingJobId,
        },
      };
    } else if (candidate.locationEligibility?.status === 'ineligible') {
      output = {
        ...candidate,
        import: {
          status: 'skipped_location_ineligible',
          jobId: null,
          reason: candidate.locationEligibility.reason ?? null,
          consistency: candidate.locationEligibility.consistency ?? null,
        },
      };
    } else if (
      requireDescription
      && (
        typeof candidate.description !== 'string'
        || candidate.description.trim() === ''
      )
    ) {
      output = {
        ...candidate,
        import: {
          status: 'skipped_missing_description',
          jobId: null,
        },
      };
    } else if (createAttempts >= maxCreates) {
      output = {
        ...candidate,
        import: {
          status: 'skipped_create_limit',
          jobId: null,
        },
      };
    } else {
      let payload;
      try {
        payload = buildCreatePayload(candidate, { requireDescription });
      } catch (error) {
        output = {
          ...candidate,
          import: {
            status: 'skipped_invalid_payload',
            jobId: null,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
      if (!output) {
        createAttempts += 1;
        try {
          const result = await client.createJob(
            payload,
            { reconcileUrl: candidate.url },
          );
          output = {
            ...candidate,
            existingJobId: result.id,
            import: {
              status: result.disposition,
              jobId: result.id,
              reconciled: result.reconciled,
              responseStatus: result.responseStatus,
              payload,
            },
          };
        } catch (error) {
          output = {
            ...candidate,
            import: {
              status: 'error',
              jobId: null,
              payload,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
    }
    results.push(output);
    safeProgress(onProgress, index + 1, candidates.length);
  }

  return results;
}
