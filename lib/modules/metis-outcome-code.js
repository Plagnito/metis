'use strict';
// Exact allowlist: never persist arbitrary strings from an error or its message.
const groups = Object.freeze({
  access:['PERMISSION_DENIED','PATH_DENIED','ORIGIN_DENIED','INSUFFICIENT_SCOPE'],
  conflict:['REVISION_CONFLICT','CONFLICT','STALE_CURSOR','IDEMPOTENCY_CONFLICT'],
  validation:['INVALID_ARGUMENT','RPC_PARSE_ERROR','RPC_INVALID_REQUEST','RPC_METHOD_NOT_FOUND','RPC_INVALID_PARAMS'],
  capacity:['RATE_LIMITED','TRUNCATED','QUOTA_EXCEEDED','OUTPUT_LIMIT','RESOURCE_LIMIT'],
  availability:['DEPENDENCY_UNAVAILABLE','LAB_UNAVAILABLE','RENDERER_UNAVAILABLE','CAPTURE_FAILED','CAPTURE_TIMEOUT','RPC_INTERNAL_ERROR'],
  other:['NOT_FOUND','LEGACY_ERROR','CAPTURE_DATA_UNSUPPORTED','UNSUPPORTED_OPERATION','DISABLED'],
});
const codes = new Set(Object.values(groups).flat());
const normalize = code => typeof code === 'string' && codes.has(code) ? code : null;
const rpc = new Map([[-32700,'RPC_PARSE_ERROR'],[-32600,'RPC_INVALID_REQUEST'],[-32601,'RPC_METHOD_NOT_FOUND'],[-32602,'RPC_INVALID_PARAMS'],[-32603,'RPC_INTERNAL_ERROR']]);
function fromResponse(body) {
  if (body?.error) return typeof body.error === 'object' ? rpc.get(body.error.code) || null : null;
  return normalize(body?.result?.structuredContent?.error?.code);
}
function category(code,status) {
  for (const [name,items] of Object.entries(groups)) if (items.includes(normalize(code))) return name;
  if (status === 401) return 'authentication';
  if (status === 403) return 'access';
  if (status === 429) return 'capacity';
  if (status >= 500) return 'availability';
  if ([400,405,413,415,422].includes(status)) return 'validation';
  return 'other';
}
// Canonical code is used first; HTTP is a fallback signal, never a detailed cause.
const categorySql = 'CASE ' + Object.entries(groups).map(([name,items]) => "WHEN result_code IN (" + items.map(x => "'" + x + "'").join(',') + ") THEN '" + name + "'").join(' ')
  + " WHEN status=401 THEN 'authentication' WHEN status=403 THEN 'access' WHEN status=429 THEN 'capacity' WHEN status>=500 THEN 'availability' WHEN status IN (400,405,413,415,422) THEN 'validation' ELSE 'other' END";
module.exports = {normalize,fromResponse,category,categorySql,known:Object.freeze([...codes])};
