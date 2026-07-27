import { isIP } from 'node:net';

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
]);

function privateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value))) {
    return false;
  }
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 0;
}

export function assertPublicHttpsUrl(rawUrl, label = 'provider URL') {
  let parsed;
  try {
    parsed = rawUrl instanceof URL ? new URL(rawUrl) : new URL(String(rawUrl));
  } catch (error) {
    throw new Error(`${label} is invalid`, { cause: error });
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTPS`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const ipHostname = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (
    BLOCKED_HOSTS.has(hostname)
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
  ) {
    throw new Error(`${label} uses a blocked hostname: ${hostname}`);
  }
  const ipVersion = isIP(ipHostname);
  if (ipVersion === 4 && privateIpv4(hostname)) {
    throw new Error(`${label} uses a private IPv4 address`);
  }
  if (ipVersion === 6) {
    const normalized = ipHostname.toLowerCase();
    const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (
      normalized === '::'
      || normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe80:')
      || normalized.startsWith('::ffff:')
      || (mappedIpv4 && privateIpv4(mappedIpv4))
    ) {
      throw new Error(`${label} uses a private IPv6 address`);
    }
  }
  parsed.hash = '';
  return parsed;
}

export function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}
