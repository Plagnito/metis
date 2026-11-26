'use strict';
// Request-local projections over canonical Atlas records. No stored body or ACL cache.
const crypto=require('node:crypto'),R=require('./metisresearch'),C=require('./metiscollaboration'),F=require('./metis-access-fence');
const M=()=>require('./metisdocs'),P=()=>require('./metiscontinuity');
const NAMES=new Set(['read_passage','read_bundle','prepare_resume']);
const allowed={read_passage:['object_id','expected_revision','section','start_line','line_count','cursor'],read_bundle:['requests','cursor'],prepare_resume:['session_id','work_item_id','note_limit','reference_limit','notes_cursor','cursor']};
const fail=(code,message)=>{throw new R.ContractError(code,message,false);};
const bytes=x=>Buffer.byteLength(JSON.stringify(x));
function normalize(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['object_id','expected_revision','section','start_line','line_count'].includes(k)))fail('INVALID_ARGUMENT','Lecture : objet strict requis.');
 const id=C.text(input.object_id,'object_id',240);if(!/^(document|sigle|project|task|project_note|milestone|project_context|project_checkpoint|project_evidence|project_document):.+/.test(id))fail('INVALID_ARGUMENT','Lecture de passage : référence documentaire ou de projet requise.');
 const section=input.section;if(section!==undefined&&!(Number.isSafeInteger(section)&&section>=1)&&!(typeof section==='string'&&section.trim()&&section.length<=240))fail('INVALID_ARGUMENT','section : numéro positif ou titre exact.');
 return {object_id:id,...(input.expected_revision!==undefined?{expected_revision:R.integer(input.expected_revision,undefined,1,Number.MAX_SAFE_INTEGER,'expected_revision')}:{}),...(section!==undefined?{section}:{}),start_line:R.integer(input.start_line,1,1,1000000,'start_line'),...(input.line_count!==undefined?{line_count:R.integer(input.line_count,undefined,1,200,'line_count')}:{} )};
}
function selection(user,input){
 F.assertReadable(user,input.object_id);const row=R.resource(user,input.object_id);if(!row)fail('NOT_FOUND','Objet absent ou inaccessible.');
 if(input.expected_revision!==undefined&&input.expected_revision!==row.revision)fail('REVISION_CONFLICT','La source ne porte plus la révision attendue.');
 const parsed=M().sections(row.body);let base=0,end=parsed.lignes.length,section=null;
 if(input.section!==undefined){const matches=typeof input.section==='number'?[parsed.sections[input.section-1]].filter(Boolean):parsed.sections.filter(s=>s.titre===input.section.trim());if(matches.length!==1)fail('INVALID_ARGUMENT','Section absente ou ambiguë : utiliser son numéro ou son titre exact.');section=matches[0];base=section.ligne;end=section.fin;}
 const start=base+input.start_line-1;if(start>=end)fail('INVALID_ARGUMENT','start_line hors de la plage sélectionnée.');
 end=Math.min(end,start+(input.line_count??(section?end-start:40)));
 const payload=Buffer.from(parsed.lignes.slice(start,end).join('\n'));
 return {input,title:row.title,reference:{id:row.id,revision:row.revision,content_sha256:R.hash(row),source_url:row.source_url},line_start:start+1,line_end:end,section:section?.titre??null,payload};
}
function position(state,count){if(!Number.isSafeInteger(state.index)||state.index<0||state.index>=count||!Number.isSafeInteger(state.offset)||state.offset<0)fail('INVALID_ARGUMENT','Position de lecture invalide.');}
function readings(user,args,request,name){
 let inputs;
 if(name==='read_passage'){const {cursor,max_bytes,max_tokens,...single}=args;inputs=[normalize(single)];}
 else{if(!Array.isArray(args.requests)||!args.requests.length||args.requests.length>8)fail('INVALID_ARGUMENT','requests : entre 1 et 8 lectures.');inputs=args.requests.map(normalize);}
 const selections=inputs.map(input=>selection(user,input)),signature=R.hash(inputs),manifest_hash=R.hash(selections.map(s=>s.reference)),high=R.high();
 const state=args.cursor?R.decode(args.cursor,'reading',user):{index:0,offset:0};position(state,selections.length);
 if(args.cursor&&(state.signature!==signature||state.manifest_hash!==manifest_hash))fail('STALE_CURSOR','Sélection ou source modifiée ; recommencer la lecture.');
 let index=state.index,offset=state.offset;const items=[];
 const make=()=>{const more=index<selections.length;return R.envelope(request,{items,has_more:more,requested_reads:inputs.length,content_trust:'untrusted_data',consistency:'exact selected source revisions; current ACL on every page'},high,{next_cursor:more?R.cursor({type:'reading',signature,manifest_hash,index,offset},user):null,truncated:more});};
 while(index<selections.length){
  const s=selections[index];if(offset>s.payload.length||offset>0&&offset===s.payload.length)fail('INVALID_ARGUMENT','Offset hors du passage.');
  const original={index,offset};let length=Math.min(4096,s.payload.length-offset),accepted=false;
  do{
   let end=offset+length;while(end<s.payload.length&&(s.payload[end]&0xc0)===0x80)end--;
   if(s.payload.length&&end===offset){length=Math.floor(length/2);continue;}
   const text=s.payload.subarray(offset,end).toString('utf8'),lineStart=s.line_start+s.payload.subarray(0,offset).toString('utf8').split('\n').length-1;
   const item={index,reference:s.reference,title:s.title,section:s.section,passage:{text,offset_bytes:offset,bytes:end-offset,total_bytes:s.payload.length,eof:end===s.payload.length,line_start:lineStart,line_end:lineStart+(text.match(/\n/g)||[]).length-(text.endsWith('\n')?1:0),sha256:crypto.createHash('sha256').update(text).digest('hex')}};
   const nextIndex=end===s.payload.length?index+1:index,nextOffset=end===s.payload.length?0:end;
   items.push(item);index=nextIndex;offset=nextOffset;
   if(bytes(make())<=R.budget(args)){accepted=true;break;}
   items.pop();({index,offset}=original);length=Math.floor(length/2);
  }while(length>0);
  if(!accepted){if(items.length)return make();fail('TRUNCATED','Référence et passage au-delà du budget ; augmenter max_tokens.');}
 }
 return make();
}
function prepare(user,args,request){
 const note_limit=R.integer(args.note_limit,3,1,10,'note_limit'),reference_limit=R.integer(args.reference_limit,3,1,8,'reference_limit');
 const resumed=P().call('resume_work',{...(args.session_id?{session_id:args.session_id}:{}),...(args.work_item_id?{work_item_id:args.work_item_id}:{}),limit:note_limit,...(args.notes_cursor?{cursor:args.notes_cursor}:{}),max_tokens:R.budget(args)},user);
 if(!resumed.ok)throw new R.ContractError(resumed.error.code,resumed.error.message,resumed.error.retryable);
 const data=resumed.data,pins=new Map();
 for(const source of [data.session,data.work,...data.notes.items])for(const pin of [...(source?.resource_refs||[]),...(source?.work_ref?[source.work_ref]:[])]){if(!pins.has(pin.id))pins.set(pin.id,[]);pins.get(pin.id).push(pin);}
 if(pins.size>64)fail('TRUNCATED','Trop de références ; réduire note_limit.');
 const resources=[...pins].map(([id,expected])=>{F.assertReadable(user,id);const current=C.reference(user,id),row=R.resource(user,id);return {reference:current,title:row?.title??null,summary:row?.description?.slice(0,240)??null,excerpt:row?.body?.slice(0,240)??null,expected_revisions:[...new Set(expected.map(p=>p.revision))],changed:expected.some(p=>p.revision!==current.revision||p.content_sha256!==current.content_sha256)};});
 const signature=R.hash({session_id:args.session_id,work_item_id:args.work_item_id,note_limit,notes_cursor:args.notes_cursor}),manifest_hash=R.hash({data,resources}),state=args.cursor?R.decode(args.cursor,'resume_reading',user):null;
 if(state&&(state.signature!==signature||state.manifest_hash!==manifest_hash))fail('STALE_CURSOR','État sauvegardé, notes ou références modifiés ; recommencer.');
 const start=state?.after??0;if(!Number.isSafeInteger(start)||start<0||start>resources.length)fail('INVALID_ARGUMENT','Position de reprise invalide.');
 const selected=resources.slice(start,start+reference_limit),after=start+selected.length,more=after<resources.length;
 const changed=resources.filter(r=>r.changed).map(r=>({id:r.reference.id,expected_revisions:r.expected_revisions,current_revision:r.reference.revision}));
 return R.envelope(request,{...data,freshness:{...data.freshness,valid:data.freshness.valid&&!changed.length,epistemic_state:!data.freshness.valid||changed.length?'stale':data.freshness.epistemic_state,changed_references:changed},context:{items:selected,total:resources.length,has_more:more},notes_next_cursor:resumed.next_cursor??null,next_step:{action:!data.freshness.valid||changed.length?'review_changed_references':data.session?'follow_saved_next_action':'save_explicit_state',automatic_execution:false},memory_scope:'explicit saved records and canonical references only; no hidden history',content_trust:'untrusted_data'},R.high(),{next_cursor:more?R.cursor({type:'resume_reading',signature,manifest_hash,after},user):null,truncated:more});
}
function run(name,args,user,request){return name==='prepare_resume'?prepare(user,args,request):readings(user,args,request,name);}
module.exports={run,NAMES,allowed};
