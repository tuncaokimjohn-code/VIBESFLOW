/** Non-secret, fixed deployment identity. No env reads or service access. */
export const META_PROJECT = 'mute-breeze-24409409';
export const META_DATABASE = 'vibeflow_quota';
export const META_CAMPAIGN = 'vibeflow-meta-direct-002';
export const META_SCHEMA = 'vibeflow_meta_002';
export const META_RUNTIME_ROLE = 'vibeflow_meta_runtime';
export const META_DEPLOYMENT_GATE = 'QA_APPROVED_META_DIRECT_002';
export const META_PRICE_POLICY = 'meta-direct-2026-11-04-counted-text-v1';
// This snapshot expires rather than silently accepting changed pricing.
export const META_PRICE_EXPIRES_MS = Date.parse('2026-11-11T00:00:00Z');
export const META_PRICE = Object.freeze({ inputMicroUsdPerMillion: 100000,
  outputMicroUsdPerMillion: 200000, maxInputTokens: 4096, maxOutputTokens: 2048 });
export function exactHttpsOrigin(value) {
  if (typeof value !== 'string') return false;
  try { const u = new URL(value); return u.origin === value && u.protocol === 'https:' && !u.username && !u.password &&
    !u.port && !u.hostname.endsWith('.invalid') && u.hostname.includes('.') &&
    !/^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[)/.test(u.hostname); }
  catch { return false; }
}
export function approvedNeonHost(value) {
  return typeof value === 'string' && /^ep-[a-z0-9-]+(?:-pooler)?\.c-[a-z0-9]+\.us-east-1\.aws\.neon\.tech$/.test(value);
}
/** A host is separately pinned after the human verifies the dedicated project.
 * Host syntax alone cannot attest Neon project ownership. Never infer project ID. */
export function validDatabaseUrl(value, host, direct = false) {
  if (typeof value !== 'string' || !approvedNeonHost(host)) return false;
  try { const u = new URL(value); return u.protocol === 'postgresql:' && u.hostname === host &&
    (!direct || !host.includes('-pooler.')) && (!u.port || u.port === '5432') && !u.hash &&
    u.pathname === '/' + META_DATABASE && !!u.username && !!u.password &&
    u.searchParams.getAll('sslmode').length === 1 && u.searchParams.get('sslmode') === 'verify-full' &&
    [...u.searchParams].every(([k, v]) => k === 'sslmode' || k === 'channel_binding' && v === 'require'); }
  catch { return false; }
}
