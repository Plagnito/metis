'use strict';
// Volatile bounded metrics: no prompts, resource IDs, OAuth tokens or client labels.
const started=new Date().toISOString(),series=new Map();
const {decorate}=require('./metis-recovery');
function observe(user,name,fn){
 if(process.env.METIS_CONTINUITY_ENABLED!=='1')return decorate(fn());
 const start=performance.now();let result;
 try{return result=decorate(fn());}finally{
  const key=Number(user)+':'+name;if(!series.has(key)){if(series.size>=2000)series.delete(series.keys().next().value);series.set(key,{account:Number(user),tool:name,count:0,errors:0,contract_violations:0,samples:[],pagination:{continued:0,budget_exceeded:0,oversize_item:0,cause_unknown:0,no_progress:0}});}
  const s=series.get(key);s.count++;if(result?.ok!==true){s.errors++;s.last_error={code:/^[A-Z][A-Z_]{1,63}$/.test(result?.error?.code||'')?result.error.code:'DEPENDENCY_UNAVAILABLE',at:new Date().toISOString(),retryable:result?.error?.retryable===true};}
  if(result?.ok===true&&(!Object.hasOwn(result,'data')||result.error||!result.request_id||result.schema_version!=='1'))s.contract_violations++;
  if(result?.truncated===true||result?.data?.has_more===true||result?.error?.code==='TRUNCATED'){
   const finding=require('./metis-doctor').observation({result});
   const key={PAGINATED_RESPONSE:'continued',INDIVISIBLE_BUDGET_EXCEEDED:'budget_exceeded',ITEM_EXCEEDS_MAXIMUM_BUDGET:'oversize_item',PAGINATION_NO_PROGRESS:'no_progress'}[finding.code]||'cause_unknown';
   s.pagination[key]++;
  }
  let bytes=null;try{bytes=result?Buffer.byteLength(JSON.stringify(result)):null;}catch{s.contract_violations++;s.serialization_failures=(s.serialization_failures||0)+1;}
  s.samples.push({ms:performance.now()-start,bytes});if(s.samples.length>32)s.samples.shift();
 }
}
function metrics(user,name){const s=series.get(Number(user)+':'+name);if(!s)return {tool:name,samples:0,p50_ms:null,p95_ms:null,response_bytes_max:null,errors:0,contract_violations:0};const times=s.samples.map(x=>x.ms).sort((a,b)=>a-b);return {tool:name,observed_calls:s.count,samples:times.length,p50_ms:times[Math.max(0,Math.ceil(times.length*.5)-1)],p95_ms:times[Math.max(0,Math.ceil(times.length*.95)-1)],response_bytes_max:Math.max(...s.samples.map(x=>x.bytes??0)),errors:s.errors,contract_violations:s.contract_violations,serialization_failures:s.serialization_failures||0,pagination:{...s.pagination}};}
function recentErrors(user,limit=6){return [...series.values()].filter(s=>s.account===Number(user)&&s.last_error).sort((a,b)=>b.last_error.at.localeCompare(a.last_error.at)).slice(0,Math.min(20,limit)).map(s=>({tool:s.tool,...s.last_error}));}
function slowTools(user){return [...series.values()].filter(s=>s.account===Number(user)).map(s=>metrics(user,s.tool)).filter(s=>s.p95_ms>=500).sort((a,b)=>b.p95_ms-a.p95_ms).slice(0,5).map(s=>({tool:s.tool,p95_ms:s.p95_ms,samples:s.samples,threshold_ms:500,classification:s.samples<20?'suspected':'performance_degraded',scope:'synchronous recorded calls only; not end-to-end cost'}));}
module.exports={observe,metrics,recentErrors,slowTools,started};
