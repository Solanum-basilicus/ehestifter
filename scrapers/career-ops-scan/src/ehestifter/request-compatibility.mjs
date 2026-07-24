function safeProgress(onProgress, current, total) {
  if (!onProgress) return;
  try {
    onProgress({ stage: 'compatibility', current, total });
  } catch {
    /* Progress diagnostics must not alter compatibility requests. */
  }
}

async function mapLimit(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let completed = 0;
  async function consume() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
      completed += 1;
      safeProgress(onProgress, completed, items.length);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => consume()),
  );
  return results;
}

function latestDecision(latest, cvVersionId, config) {
  if (!latest) return { request: true, reason: 'missing' };
  const status = String(latest.status ?? '').toLowerCase();
  if (['pending', 'queued', 'leased', 'running'].includes(status)) {
    return { request: false, reason: 'active' };
  }
  if (status === 'succeeded') {
    const latestCv = typeof latest.cvVersionId === 'string'
      ? latest.cvVersionId.toLowerCase()
      : null;
    const currentCv = cvVersionId.toLowerCase();
    if (latestCv === currentCv) {
      return { request: false, reason: 'succeeded_current_cv' };
    }
    if (!latestCv && !config.refreshSucceededWithUnknownCvVersion) {
      return { request: false, reason: 'succeeded_unknown_cv' };
    }
    return { request: true, reason: 'cv_changed' };
  }
  return { request: true, reason: status || 'unknown_status' };
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
}) {
  const allPairs = buildCompatibilityPairs(importResults, discoveryUsers);
  const pairs = allPairs.slice(0, config.maxPairsPerRun);
  const omittedPairs = allPairs.length - pairs.length;

  const checked = await mapLimit(
    pairs,
    config.concurrency,
    async (pair) => {
      try {
        const latest = await client.getLatest(
          pair.jobId,
          pair.userId,
          config.enricherType,
        );
        return {
          ...pair,
          latest,
          decision: latestDecision(latest, pair.cvVersionId, config),
          checkStatus: 'ok',
        };
      } catch (error) {
        return {
          ...pair,
          latest: null,
          decision: { request: false, reason: 'latest_check_error' },
          checkStatus: 'error',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    null,
  );

  const requestable = checked.filter((item) => item.decision.request);
  const requestSet = new Set(
    requestable.slice(0, config.maxRequestsPerRun).map(
      (item) => `${item.jobId.toLowerCase()}:${item.userId.toLowerCase()}`,
    ),
  );

  const results = await mapLimit(
    checked,
    config.concurrency,
    async (item) => {
      if (item.checkStatus === 'error') {
        return { ...item, status: 'error_latest_check' };
      }
      if (!item.decision.request) {
        return { ...item, status: `skipped_${item.decision.reason}` };
      }
      const key = `${item.jobId.toLowerCase()}:${item.userId.toLowerCase()}`;
      if (!requestSet.has(key)) {
        return { ...item, status: 'skipped_request_limit' };
      }
      try {
        const run = await client.createRun(
          item.jobId,
          item.userId,
          config.enricherType,
        );
        return {
          ...item,
          status: 'requested',
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
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    onProgress,
  );

  return {
    schemaVersion: 1,
    enricherType: config.enricherType,
    totalPairs: allPairs.length,
    evaluatedPairs: pairs.length,
    omittedPairs,
    requestLimit: config.maxRequestsPerRun,
    results: results.map(({ latest, decision, checkStatus, ...item }) => ({
      ...item,
      latest: latest ? {
        runId: latest.runId ?? null,
        status: latest.status ?? null,
        cvVersionId: latest.cvVersionId ?? null,
      } : null,
      decisionReason: decision.reason,
    })),
  };
}
