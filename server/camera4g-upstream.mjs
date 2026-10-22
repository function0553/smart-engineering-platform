import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';

export function privateConfig(options, envName) {
  if (options.config) return options.config;
  const path = process.env[envName];
  if (!path || !isAbsolute(path)) return null;
  const bytes = readFileSync(path);
  if (bytes.length > 65536) throw new Error('invalid_private_config');
  return JSON.parse(bytes.toString('utf8'));
}

// Addresses come only from the server's private configuration, never a request.
// Cross-host credentials require TLS; loopback HTTP remains useful for local tests.
export function upstreamBase(value, { development = false, loopbackPort } = {}) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid_upstream');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (['0.0.0.0', '::'].includes(host)) throw new Error('invalid_upstream');
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!local && url.protocol !== 'https:') throw new Error('upstream_tls_required');
  if (local && url.protocol === 'http:' && !development && String(loopbackPort) !== url.port) throw new Error('invalid_loopback_port');
  if (!local && !isIP(host) && !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z0-9-]+$/.test(host)) throw new Error('invalid_upstream_host');
  return url;
}
