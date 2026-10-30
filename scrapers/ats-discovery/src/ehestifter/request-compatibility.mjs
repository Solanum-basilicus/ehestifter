function safeProgress(onProgress, current, total) {
  if (!onProgress) return;
  try {
    onProgress({ stage: 'compatibility', current, total });
  } catch {
    /* Progress diagnostics must not alter compatibility requests. */
  }
}

async function mapLimit(items, limit, worker, onProgress, onResult = null) {
  const results = new Array(items.length);
  let next = 0;
  let completed = 0;
  async function consume() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
      if (onResult) {
        try {
          onResult(results[index], index);
        } catch {
          /* Run journaling must never alter compatibility requests. */
        }
      }
      completed += 1;
      safeProgress(onProgress, completed, items.length);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => consume()),
  );
  return results;
}

export function buildCompatibilityPairs(importResults, discoveryUsers) {
  const userMap = new Map(discoveryUsers.map((user) => [user.userId, user]));
  const pairs = [];
  const seen = new Set();
  for (const candidate of importResults) {
    const jobId = candidate.import?.jobId ?? candidate.existingJobId ?? null;
    if (!jobId) continue;
    for (const userId of candidate.matchedUserIds ?? []) {
      const user = userMap.get(userId);
      if (!user) continue;
      const key = `${jobId.toLowerCase()}:${userId.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({
        jobId,
        userId,
        cvVersionId: user.cvVersionId,
        candidateUrl: candidate.url,
        sourceProvider: candidate.sourceProvider,
      });
    }
  }
  return pairs;
}

export async function requestCompatibilityForMatches({
  importResults,
  discoveryUsers,
  client,
  config,
  onProgress = null,
  onResult = null,
}) {
  const allPairs = buildCompatibilityPairs(importResults, discoveryUsers);
  const pairs = allPairs;

  const results = await mapLimit(
    pairs,
    config.concurrency,
    async (item) => {
      try {
        const run = await client.createRun(
          item.jobId,
          item.userId,
          config.enricherType,
        );
        const decision = run?.decision ?? 'created';
        return {
          ...item,
          status: decision === 'created' ? 'requested' : `skipped_${decision}`,
          decisionReason: decision,
          requestedRun: {
            runId: run?.runId ?? null,
            status: run?.status ?? null,
            cvVersionId: run?.cvVersionId ?? null,
          },
        };
      } catch (error) {
        return {
          ...item,
          status: 'error_request',
          httpStatus: Number.isInteger(error?.status) ? error.status : null,
          attempts: Number.isInteger(error?.attempts) ? error.attempts : null,
          retriesExhausted: error?.retriesExhausted === true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    onProgress,
    onResult,
  );

  return {
    schemaVersion: 1,
    enricherType: config.enricherType,
    totalPairs: allPairs.length,
    evaluatedPairs: pairs.length,
    omittedPairs: 0,
    results,
  };
}
