'use strict';

// Evidence classification only. No repair execution, network or database access.
const quantiles = values => {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
  const q = p => sorted.length ? sorted[Math.ceil(sorted.length*p)-1] : null;
  return {samples:sorted.length,p50_ms:q(.5),p95_ms:q(.95),method:'nearest rank'};
};
function observation(value) {
  const finding = (classification, code, evidence, recommendation) => ({classification,code,evidence,recommendation,
    repair:{automatic:false,authorization_required:true,verification:'rerun the isolated suite and compare evidence',rollback:'restore only the reviewed patch; retain historical reports'}});
  if(Object.hasOwn(value,'result')){try{JSON.stringify(value.result);}catch{return finding('error','RESPONSE_SERIALIZATION_FAILED',{},'Correct the response serializer; a larger page budget cannot repair invalid JSON serialization.');}}
  if(value.kind === 'context_delta') return finding(value.delta_bytes<value.full_bytes?'expected':'suspected','CONTEXT_TRANSFER_MEASUREMENT',
    {full_bytes:value.full_bytes,delta_bytes:value.delta_bytes,saved_bytes:value.full_bytes-value.delta_bytes,scope:'UTF-8 JSON bytes of one isolated fixture; tokenizer and database reads unmeasured'},
    'Keep primary evidence and verify current source references before reusing omitted excerpts.');
  if(value.kind === 'latency') {
    const stats = value.stats || quantiles(value.values || []), threshold = value.threshold_ms ?? 500;
    if(stats.p95_ms === null || stats.samples < 20) return finding('suspected','INSUFFICIENT_LATENCY_SAMPLE',{...stats,threshold_ms:threshold},'Collect at least 20 comparable observations before confirming degradation.');
    return finding(stats.p95_ms >= threshold ? 'performance_degraded' : 'expected','LATENCY',{...stats,threshold_ms:threshold,scope:value.scope || 'isolated synchronous calls'},'Compare identical fixtures and environments; no production inference.');
  }
  const r = value.result || {}, more = r.data?.has_more === true;
  if(more && (!r.next_cursor || r.next_cursor === value.previous_cursor)) return finding('error','PAGINATION_NO_PROGRESS',{has_more:true,cursor_present:!!r.next_cursor},'Fix continuation generation before consuming more pages.');
  if(r.ok === true && r.truncated === true) return finding(r.next_cursor ? 'expected' : 'suspected',r.next_cursor ? 'PAGINATED_RESPONSE' : 'PARTIAL_WITHOUT_CONTINUATION',{has_cursor:!!r.next_cursor},'Follow every continuation; a partial impact graph may instead require a narrower selection.');
  if(r.error?.code === 'TRUNCATED') {
    const d = r.error.details || {};
    const known = Number.isSafeInteger(d.required_bytes) && Number.isSafeInteger(d.effective_budget_bytes) && d.required_bytes > d.effective_budget_bytes;
    if(known&&d.fits_maximum_budget===false)return finding('suspected','ITEM_EXCEEDS_MAXIMUM_BUDGET',
      {required_bytes:d.required_bytes,effective_budget_bytes:d.effective_budget_bytes,maximum_budget_bytes:d.maximum_budget_bytes},
      'Narrow the indivisible selection or inspect its encoding size; increasing the budget past the maximum is not a recovery.');
    return finding(known ? 'expected' : 'suspected',known ? 'INDIVISIBLE_BUDGET_EXCEEDED' : 'TRUNCATION_CAUSE_UNKNOWN',
      Object.fromEntries(['required_bytes','effective_budget_bytes','maximum_budget_bytes','fits_maximum_budget'].filter(k=>Object.hasOwn(d,k)).map(k=>[k,d[k]])),
      known ? 'Adjust the documented byte budget or narrow the selection; do not retry unchanged.' : 'Reproduce with the exact selection in an isolated fixture; no cause can be inferred from the code alone.');
  }
  if(value.expected_error && r.ok === false && r.error?.code === value.expected_error) return finding('expected','GUARD_REFUSAL',{code:r.error.code},'Keep this negative contract check.');
  return finding(r.ok === true ? 'expected' : 'error',r.ok === true ? 'CONTRACT_OK' : 'UNEXPECTED_RESULT',{code:r.error?.code || null},'Inspect the isolated reproduction and its source digest.');
}
function report(suites, observations = [], baseline = null) {
  const findings = observations.map(observation);
  for(const suite of suites.filter(s=>!s.ok)) findings.push({classification:suite.failure_kind === 'environment' ? 'suspected' : 'error',code:suite.error_code,
    evidence:{suite:suite.file,exit_code:suite.exit_code,output_sha256:suite.output_sha256,failure_signature:suite.failure_signature||null,failure_location:suite.failure_location||null},recommendation:suite.failure_kind === 'environment' ? 'Restore the test prerequisites, then rerun; this does not establish a product regression.' : 'Reproduce the failing suite before proposing a reviewed patch.',
    repair:{automatic:false,authorization_required:true,verification:suite.reproduction.command,rollback:'revert only the reviewed patch; retain historical evidence'}});
  const counts = Object.fromEntries(['error','expected','performance_degraded','suspected'].map(k=>[k,findings.filter(f=>f.classification===k).length]));
  return {version:'2',scope:'isolated contracts and supplied observations; no automatic production probes',counts,findings,
    comparison:baseline ? {baseline_generated_at:baseline.generated_at,baseline_source_sha256:baseline.source_sha256,
      previous_failed:baseline.totals.failed,current_failed:suites.filter(s=>!s.ok).length,
      comparable_latency:false,reason:'Suite membership and environment may differ; no speedup inferred.'} : null,
    repairs_applied:0};
}
module.exports = {observation,quantiles,report};
