import { composeLeverDescription } from '../providers/lever.mjs';
import { plainTextToSafeHtml } from '../text/html.mjs';

const HOSTS = new Map([
  ['jobs.lever.co', 'api.lever.co'],
  ['jobs.eu.lever.co', 'api.eu.lever.co'],
]);

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export function parseLeverPostingUrl(value) {
  const sourceUrl = requiredString(value, 'postingUrl');
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error(`Invalid Lever posting URL: ${sourceUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Lever posting URL must use HTTPS');
  }
  const apiHost = HOSTS.get(parsed.hostname);
  if (!apiHost) {
    throw new Error(`Unsupported Lever posting host: ${parsed.hostname}`);
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) {
    throw new Error('Lever posting URL must have /<site>/<posting-id> shape');
  }
  const [site, postingId] = segments;
  return {
    sourceUrl: parsed.href,
    site,
    postingId,
    apiUrl: `https://${apiHost}/v0/postings/${encodeURIComponent(site)}/${encodeURIComponent(postingId)}`,
  };
}

function existingDescription(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return '';
  const value = job.Description ?? job.description;
  return typeof value === 'string' ? value : '';
}

export async function repairLeverDescription({
  postingUrl,
  apply = false,
  jobsClient,
  fetchJson,
}) {
  if (!jobsClient || typeof jobsClient !== 'object') {
    throw new Error('jobsClient is required');
  }
  for (const method of ['existsByUrl', 'getJob', 'updateJobDescription']) {
    if (typeof jobsClient[method] !== 'function') {
      throw new Error(`jobsClient.${method} is required`);
    }
  }
  if (typeof fetchJson !== 'function') throw new Error('fetchJson is required');

  const target = parseLeverPostingUrl(postingUrl);
  const posting = await fetchJson(target.apiUrl, { redirect: 'error' });
  if (!posting || typeof posting !== 'object' || Array.isArray(posting)) {
    throw new Error('Lever posting endpoint returned invalid JSON');
  }

  const sourceDescription = composeLeverDescription(posting);
  const description = plainTextToSafeHtml(sourceDescription);
  if (description === '') {
    throw new Error('Lever posting has no usable description');
  }

  const identity = await jobsClient.existsByUrl(target.sourceUrl);
  if (!identity.exists || !identity.id) {
    throw new Error('No existing Ehestifter job matches this Lever URL');
  }
  if (identity.identity?.provider !== 'lever') {
    throw new Error(`Jobs identity provider is not lever: ${identity.identity?.provider ?? 'missing'}`);
  }
  if (
    String(identity.identity.providerTenant ?? '').toLowerCase()
    !== target.site.toLowerCase()
  ) {
    throw new Error('Jobs identity tenant does not match the Lever URL');
  }
  if (identity.identity.externalId !== target.postingId) {
    throw new Error('Jobs identity externalId does not match the Lever URL');
  }

  const job = await jobsClient.getJob(identity.id);
  const before = existingDescription(job);
  const changed = before !== description;
  let applied = false;

  if (apply && changed) {
    await jobsClient.updateJobDescription(identity.id, description);
    applied = true;
  }

  return {
    postingUrl: target.sourceUrl,
    leverApiUrl: target.apiUrl,
    jobId: identity.id,
    title: typeof posting.text === 'string' ? posting.text : null,
    dryRun: !apply,
    changed,
    applied,
    beforeDescriptionLength: before.length,
    afterDescriptionLength: description.length,
    sourcePlainTextLength: sourceDescription.length,
  };
}
