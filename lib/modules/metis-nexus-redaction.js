'use strict';

// Apply before persistence, then again at delivery after secrets have rotated.
// Secret values are supplied by the server vault, never by browser parameters.
function createRedactor(secretValues = () => []) {
  const sensitive = /^(authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|private[_-]?key|system[_-]?prompt)$/i;
  function text(value) {
    let out = String(value);
    for (const secret of secretValues()) if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[REDACTED]');
    return out.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:nvapi-|ghp_|github_pat_|sk-)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
      .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED]');
  }
  function redact(value, depth = 0) {
    if (depth > 16) return '[REDACTED:DEPTH]';
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? '[REDACTED]' : redact(item, depth + 1)]));
    return value;
  }
  return redact;
}
module.exports = { createRedactor };
