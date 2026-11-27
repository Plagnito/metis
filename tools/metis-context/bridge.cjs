'use strict';
// Portable client-side bridge. Built-ins only. No OAuth store access or server-side execution.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const VERSION = 1;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify((function order(v) { return Array.isArray(v) ? v.map(order) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, order(v[k])])) : v; })(value));
function git(root, args, binary = false) { return cp.execFileSync('git', ['-C', root, ...args], { encoding: binary ? undefined : 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
function rootOf(value = process.cwd()) { return fs.realpathSync(git(path.resolve(value), ['rev-parse', '--show-toplevel']).trim()); }
function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split(/[\\/]/).includes('..')) throw Error('Relative path required');
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw Error('Path leaves repository');
  let cursor = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('Symlink path refused'); } catch(e) { if(e.code!=='ENOENT')throw e; }
  }
  return target;
}
function atomic(root, relative, bytes, expected) {
  const target = inside(root, relative), prior = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (expected !== undefined && (prior ? sha(prior) : null) !== expected) throw Error('File changed; inspect before writing');
  fs.mkdirSync(path.dirname(target), { recursive: true }); inside(root, relative);
  const temporary = target + '.tmp-' + crypto.randomUUID();
  fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
  const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if ((current ? sha(current) : null) !== (prior ? sha(prior) : null)) { fs.unlinkSync(temporary); throw Error('Concurrent edit detected'); }
  fs.renameSync(temporary, target);
}
function managed(root, relative, body) {
  const target = inside(root, relative), original = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const begin = '<!-- METIS-CONTEXT-BEGIN -->', end = '<!-- METIS-CONTEXT-END -->';
  const a = original.indexOf(begin), b = original.indexOf(end);
  if ((a < 0) !== (b < 0) || b >= 0 && b < a || a >= 0 && original.indexOf(begin, a + 1) >= 0) throw Error('Ambiguous managed block');
  const block = begin + '\n' + body + '\n' + end;
  const next = a < 0 ? original + (original && !original.endsWith('\n') ? '\n' : '') + '\n' + block + '\n' : original.slice(0, a) + block + original.slice(b + end.length);
  if (next === original) return;
  if (original) atomic(root, '.metis/backups/' + sha(original) + '-' + path.basename(relative), original);
  atomic(root, relative, next, fs.existsSync(target) ? sha(original) : null);
}
function generated(root,relative,bytes){const file=inside(root,relative);if(fs.existsSync(file)){if(!fs.readFileSync(file).equals(Buffer.from(bytes)))throw Error('Generated file modified; inspect before upgrading: '+relative);return;}atomic(root,relative,bytes,null);}
function canonicalRemote(value) {
  const ssh = value.match(/^git@([^:]+):(.+)$/);
  if (ssh) return 'https://' + ssh[1].toLowerCase() + '/' + ssh[2].replace(/\.git\/?$/, '').replace(/\/$/, '');
  const u = new URL(value);
  if (!['https:', 'ssh:'].includes(u.protocol) || u.password || u.protocol === 'https:' && u.username || u.search || u.hash) throw Error('Remote with credentials or unsupported protocol refused');
  return 'https://' + u.hostname.toLowerCase() + u.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '');
}
function manifest(root) {
  const file = inside(root, '.metis/project.json');
  if (fs.statSync(file).size > 24000) throw Error('Manifest too large');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (m.schema_version !== VERSION || !/^project:[a-f0-9-]{36}$/.test(m.project_id) || !Array.isArray(m.repositories) || !m.repositories.length || m.repositories.length > 8) throw Error('Invalid project manifest');
  for (const r of m.repositories) { if (!r.id || !r.url || !r.subdir) throw Error('Invalid repository definition'); canonicalRemote(r.url); if (r.subdir !== '.') inside(root, r.subdir); }
  return m;
}
function pending(root,projectId){const directory=inside(root,'.metis/reports');if(!fs.existsSync(directory))return [];return fs.readdirSync(directory).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).sort().filter(n=>!fs.existsSync(inside(root,'.metis/reports/'+n+'.ack.json'))).slice(-20).map(n=>{const relative='.metis/reports/'+n;try{const file=inside(root,relative);if(fs.statSync(file).size>64000)throw Error('Too large');const r=JSON.parse(fs.readFileSync(file,'utf8'));return r.project_id===projectId?{path:relative,task_id:r.task_id||null,criterion_ids:r.report?.criterion_ids||[],executed_at:r.report?.executed_at||null,exit_code:r.report?.exit_code??null}:null;}catch{return {path:relative,state:'unreadable_report'};}}).filter(Boolean);}
function inspect(root, repositoryId) {
  root = rootOf(root); const m = manifest(root);
  const remote = git(root, ['remote', 'get-url', 'origin']).trim();
  const matches = m.repositories.filter(r => canonicalRemote(r.url) === canonicalRemote(remote) && (!repositoryId || r.id === repositoryId));
  if (matches.length !== 1) throw Error('Remote does not identify exactly one registered repository; specify --repository-id');
  const repository = matches[0];
  const commit = git(root, ['rev-parse', 'HEAD']).trim();let branch;try{branch=git(root,['symbolic-ref','--quiet','--short','HEAD']).trim();}catch{branch='(detached)';}
  const modified = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const files = [...new Set([...modified, ...untracked])].filter(f => !/^\.metis\/(?:cache|reports|backups)\//.test(f)).sort();
  if (files.length > 5000) throw Error('Dirty checkout exceeds 5000 files');
  let bytes = 0;
  const hashes = files.map(relative => {
    const file = inside(root, relative);
    if (!fs.existsSync(file)) return [relative, 'deleted'];
    if (!fs.statSync(file).isFile()) throw Error('Non-file checkout entry');
    const n = fs.statSync(file).size; bytes += n;
    if (n > 8 * 1024 * 1024 || bytes > 64 * 1024 * 1024) throw Error('Dirty source fingerprint exceeds configured bound; commit or scope the work');
    return [relative, sha(fs.readFileSync(file))];
  });
  const diff = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'], true);
  const dirty = files.length > 0 || diff.length > 0;
  const checkout = { repository_id: repository.id, commit, branch, dirty, dirty_hash: dirty ? sha(Buffer.concat([Buffer.from(stable(hashes)), diff])) : null,
    workspace_key: sha(fs.realpathSync(root) + '\0' + repository.id), repository_sha256: sha(stable(repository)) };
  const reports=pending(root,m.project_id);
  return { schema_version: VERSION, project_id: m.project_id, checkout, changed_paths: files.slice(0,20).map(p=>p.length>300?p.slice(0,300)+'…':p),changed_paths_count:files.length,changed_paths_truncated:files.length>20||files.some(p=>p.length>300),pending_reports:reports.slice(-5).map(r=>({...r,criterion_ids:(r.criterion_ids||[]).slice(0,5)})),pending_reports_truncated:reports.length>5,environment:{platform:process.platform,arch:process.arch,observer_runtime:process.version}, observed_at: new Date().toISOString(), observation: 'local git and file bytes; no remote repository fetched' };
}
function instructions(projectId) {
  return [
    '## Reprise de développement Métis',
    'Projet : `' + projectId + '`. Préserver les autres instructions du dépôt.',
    'Un seul agent actif ; aucun sous-agent ou worker autonome.',
    'Au démarrage et après réduction du contexte : exécuter `node .metis/bridge.cjs inspect`, puis appeler `projets_ouvrir` avec le project_id et le checkout observés. Lire les pages utiles et les fichiers concernés.',
    'Consulter `projets_session` et acquérir le bail avant de modifier. Un bail expiré exige la reprise explicite et l’inspection des fichiers non committés.',
    'Exécuter les validations pertinentes. `node .metis/bridge.cjs run --command-id ID --criteria CRITERE -- COMMANDE ARGUMENTS` produit un rapport local ; le transmettre via `projets_preuve_ajouter` sans prétendre à une certification serveur.',
    'Après une étape, un test ou un commit : `projets_checkpoint` avec résultats, blocages et prochaine action. Avant de quitter : checkpoint puis libération du bail.',
    'Pour le secours local : exporter toutes les pages JSON de `projets_exporter_contexte`, puis utiliser `cache --input FICHIER` et `offline`. Le cache est une donnée datée ; il n’accorde aucun droit supplémentaire et ne permet pas de prendre un bail hors ligne.',
  ].join('\n');
}
function unwrap(value) { return value.structuredContent || value.result?.structuredContent || value; }
function assemble(items){
 const output=[],groups=new Map();
 for(const item of items){if(item.kind!=='context_fragment'){output.push(item);continue;}if(!groups.has(item.record_id))groups.set(item.record_id,[]);groups.get(item.record_id).push(item);}
 for(const [id,parts] of groups){parts.sort((a,b)=>a.offset_bytes-b.offset_bytes);let offset=0;const pieces=[];for(const p of parts){if(p.offset_bytes!==offset||p.record_sha256!==parts[0].record_sha256||p.total_bytes!==parts[0].total_bytes||sha(p.fragment)!==p.fragment_sha256)throw Error('Invalid or missing context fragment');pieces.push(p.fragment);offset+=Buffer.byteLength(p.fragment);}const serialized=pieces.join('');if(offset!==parts[0].total_bytes||sha(serialized)!==parts[0].record_sha256)throw Error('Incomplete context record');const record=JSON.parse(serialized);if(record.id!==id)throw Error('Fragment record identity mismatch');const {content_sha256,...body}=record;if(content_sha256&&sha(stable(body))!==content_sha256)throw Error('Reassembled content hash mismatch');output.push(record);}
 return output;
}
function fragmentItems(items){return items.flatMap(record=>{const serialized=stable(record),bytes=Buffer.from(serialized);if(bytes.length<=4000)return [record];const fragments=[];let offset=0;while(offset<bytes.length){let end=Math.min(bytes.length,offset+2000);while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;const fragment=bytes.subarray(offset,end).toString('utf8'),entry={id:record.id+':fragment:'+offset,kind:'context_fragment',record_id:record.id,record_kind:record.kind||'record',offset_bytes:offset,total_bytes:bytes.length,record_sha256:sha(serialized),fragment,fragment_sha256:sha(fragment)};fragments.push({...entry,content_sha256:sha(stable(entry))});offset=end;}return fragments;});}
function install(root, options) {
  root = rootOf(root);
  const harnesses = (options.harness || 'generic').split(',');
  if (harnesses.some(h => !['generic', 'codex', 'claude', 'opencode'].includes(h))) throw Error('Unknown harness');
  if(options.adapter&&fs.statSync(options.adapter).size>64000)throw Error('Adapter input too large');
  const supplied=options.adapter?unwrap(JSON.parse(fs.readFileSync(options.adapter,'utf8'))):null,adapter=supplied?.data||supplied;
  const m = adapter?.manifest || { schema_version: VERSION, project_id: options.project_id, repositories: [{ id: options.repository_id || 'main', url: options.remote, subdir: '.', default_branch: 'main' }], documents: [] };
  if (!/^project:[a-f0-9-]{36}$/.test(m.project_id) || !m.repositories?.length) throw Error('Project ID and repository remote required');
  m.repositories.forEach(r => canonicalRemote(r.url));
  const location = inside(root, '.metis/project.json');
  if (fs.existsSync(location)) {
    const original = fs.readFileSync(location), previous = JSON.parse(original);
    if (previous.project_id !== m.project_id) throw Error('Repository already attached to another project');
    if (stable(previous) !== stable(m) && options.expected_manifest_sha !== sha(original)) throw Error('Manifest differs; inspect and provide --expected-manifest-sha');
    if (stable(previous) !== stable(m)) atomic(root, '.metis/project.json', JSON.stringify(m, null, 2) + '\n', sha(original));
  } else atomic(root, '.metis/project.json', JSON.stringify(m, null, 2) + '\n', null);
  managed(root, 'AGENTS.md', instructions(m.project_id));
  const gitignore = inside(root, '.gitignore'), prior = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  const patterns = ['.metis/cache/', '.metis/reports/', '.metis/backups/'];
  const missing = patterns.filter(s => !prior.split(/\r?\n/).includes(s));
  if (missing.length) atomic(root, '.gitignore', prior + (prior && !prior.endsWith('\n') ? '\n' : '') + '\n# Private generated Metis context\n' + missing.join('\n') + '\n', fs.existsSync(gitignore) ? sha(prior) : null);
  if (harnesses.includes('claude')) managed(root, 'CLAUDE.md', '@AGENTS.md');
  if (harnesses.includes('opencode')) {
    managed(root, '.opencode/commands/reprise-metis.md', 'Reprends le projet de .metis/project.json. Inspecte Git avec node .metis/bridge.cjs inspect puis appelle projets_ouvrir. Objectif : $ARGUMENTS. Respecte le bail et les critères de validation.');
    // L'adresse du MCP vient de l'instance (sortie de projets_adaptateur), sinon de --mcp-url,
    // sinon d'un Métis local par défaut : le pont tourne chez le client, sans connaître l'hôte.
    const mcpUrl = adapter?.remote_configuration?.mcp?.servers?.metis?.url || options.mcp_url || 'http://127.0.0.1:4747/mcp';
    generated(root, '.metis/adapters/opencode.example.json', JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { servers: { metis: { type: 'remote', url: mcpUrl } } } }, null, 2) + '\n');
  }
  if (fs.realpathSync(__filename) !== path.resolve(root,'.metis/bridge.cjs')) generated(root, '.metis/bridge.cjs', fs.readFileSync(__filename));
  return { installed: true, project_id: m.project_id, harnesses, global_configuration_changed: false, oauth: 'Use native harness sign-in; no credential was read or copied', manifest_sha256: sha(fs.readFileSync(location)) };
}
function sourceHash(v) { return sha(stable({ repository_id: v.repository_id, repository_sha256: v.repository_sha256 || null, commit: v.commit, branch: v.branch, dirty: v.dirty, dirty_hash: v.dirty_hash })); }
function cache(root, input) {
  root = rootOf(root); const m = manifest(root);if(fs.statSync(input).size>16*1024*1024)throw Error('Context cache input exceeds 16 MiB');const parsed = JSON.parse(fs.readFileSync(input, 'utf8'));
  const pages = (Array.isArray(parsed) ? parsed : [parsed]).map(unwrap); let offset = 0;
  const first = pages[0]?.data;
  if (!first || first.project_id !== m.project_id || !first.context_digest) throw Error('Context does not match project');
  if(first.unchanged){const previous=JSON.parse(fs.readFileSync(inside(root,'.metis/cache/context.json'),'utf8'));if(pages.length!==1||first.has_more||first.items.length||previous.project_id!==m.project_id||previous.context_digest!==first.context_digest||sha(stable(previous.items))!==previous.content_sha256)throw Error('Delta requires the complete matching local cache');return {cached:true,unchanged:true,items:previous.items.length,context_digest:previous.context_digest};}
  const items = [];
  for (const page of pages) {
    const d = page.data;
    if (!page.ok || d.project_id !== m.project_id || d.context_digest !== first.context_digest || d.offset !== offset || !Array.isArray(d.items)) throw Error('Inconsistent or missing context page');
    for (const item of d.items) {
      const { content_sha256, ...body } = item;
      if (!content_sha256 || sha(stable(body)) !== content_sha256) throw Error('Context fragment hash mismatch; JSON export required');
      items.push(item); offset++;
    }
  }
  if (pages.at(-1).data.has_more || offset !== first.total_items || new Set(items.map(i => i.id)).size !== items.length) throw Error('Context export incomplete');
  let assembled=assemble(items);
  if(first.delta){const previous=JSON.parse(fs.readFileSync(inside(root,'.metis/cache/context.json'),'utf8'));if(previous.project_id!==m.project_id||previous.context_digest!==first.previous_digest||sha(stable(previous.items))!==previous.content_sha256)throw Error('Delta base cache missing or changed');const originals=new Map(previous.items.map(i=>[i.id,i]));assembled=assembled.map(item=>{if(item.kind!=='context_reference')return item;const original=originals.get(item.id);if(!original||original.content_sha256!==item.retained_content_sha256)throw Error('Retained context source missing or changed');return original;});}
  const saved = { schema_version: VERSION, project_id: m.project_id, context_digest: first.context_digest, source: first.source, saved_at: new Date().toISOString(), items:assembled, content_sha256: sha(stable(assembled)) };
  atomic(root, '.metis/cache/context.json', JSON.stringify(saved, null, 2) + '\n');
  atomic(root, '.metis/cache/REPRISE.md', '# Contexte Métis exporté\n\nDonnées datées, droits et sources distantes non revérifiés hors ligne.\n\n' + assembled.map(i => '## ' + (i.title || i.kind) + '\n\n' + (i.body || JSON.stringify(i, null, 2))).join('\n\n'));
  return { cached: true, items: assembled.length, context_digest: first.context_digest };
}
function offline(root, repositoryId, options={}) {
  root = rootOf(root); const m = manifest(root), saved = JSON.parse(fs.readFileSync(inside(root, '.metis/cache/context.json'), 'utf8'));
  if (saved.project_id !== m.project_id || sha(stable(saved.items)) !== saved.content_sha256) throw Error('Invalid cached context');
  const current = inspect(root, repositoryId), age = Math.max(0, Date.now() - Date.parse(saved.saved_at));
  const {items,...meta}=saved,filtered=fragmentItems(options.query?items.filter(i=>stable(i).toLocaleLowerCase().includes(String(options.query).toLocaleLowerCase())):items);
  const start=Number(options.offset||0),budget=Number(options.budget||12000);if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(budget)||budget<2048||budget>15000)throw Error('Invalid offline pagination or budget');
  const out={ ...meta, freshness: !saved.source ? 'unknown_checkout' : sourceHash(current.checkout) === sourceHash(saved.source) ? age > 86400000 ? 'old_matching_checkout' : 'matching_checkout_only' : 'changed_checkout', age_ms: age, authorization_rechecked: false, remote_sources_rechecked: false, lease_available_offline: false,pending_reports:current.pending_reports,offset:start,total_items:filtered.length,items:[],has_more:false,next_offset:null };
  if(Buffer.byteLength(JSON.stringify(out))>budget)throw Error('Offline metadata exceeds budget; increase --budget');
  let offset=start;while(offset<filtered.length){out.items.push(filtered[offset]);out.has_more=offset+1<filtered.length;out.next_offset=out.has_more?offset+1:null;if(Buffer.byteLength(JSON.stringify(out))>budget){out.items.pop();if(offset===start){out.item_too_large=filtered[offset].id;break;}break;}offset++;}
  out.has_more=offset<filtered.length;out.next_offset=out.has_more?offset:null;return out;
}
function acknowledge(root,input,evidenceFile){root=rootOf(root);const m=manifest(root),file=path.resolve(input);if(!file.startsWith(inside(root,'.metis/reports')+path.sep)||fs.lstatSync(file).isSymbolicLink())throw Error('Report must be a local generated report');const request=JSON.parse(fs.readFileSync(file,'utf8')),response=unwrap(JSON.parse(fs.readFileSync(evidenceFile,'utf8'))),evidence=response.data?.evidence;if(!response.ok||request.project_id!==m.project_id||!evidence||evidence.project_id!==m.project_id||evidence.task_id!==request.task_id||evidence.submitted_report_sha256!==sha(stable(request.report)))throw Error('Evidence receipt does not match report');atomic(root,path.relative(root,file)+'.ack.json',JSON.stringify({evidence_id:evidence.id,report_sha256:sha(stable(request.report)),acknowledged_at:new Date().toISOString()})+'\n');return {acknowledged:true,evidence_id:evidence.id};}
function index(root, files, moduleId, repositoryId) {
  root = rootOf(root); const state = inspect(root, repositoryId);
  if (!files.length || files.length > 2) throw Error('Index one or two explicit files at a time');
  return { project_id: state.project_id, expected_revision: 0, idempotency_key: crypto.randomUUID(), documents: files.map(relative => {relative=relative.replaceAll('\\','/');
    if (/(^|\/)(?:\.env(?:\..*)?|\.git|\.ssh|credentials?|secrets?|node_modules)(\/|$)|\.(?:pem|key|db|sqlite(?:3)?)$/i.test(relative)) throw Error('Sensitive path refused');
    const file = inside(root, relative);
    if (fs.statSync(file).size > 20000) throw Error('Document too large; select an explicit excerpt outside sensitive files');
    const body = fs.readFileSync(file, 'utf8'); if (body.length > 6000) throw Error('Document exceeds 6000 characters');
    return { repository_id: state.checkout.repository_id, ...(moduleId ? { module_id: moduleId } : {}), path: relative.replaceAll('\\', '/'), title: path.basename(relative), body, sha256: sha(body), source: state.checkout };
  }) };
}
function run(root, argv, options) {
  root = rootOf(root); if (!argv.length || /\.(?:cmd|bat)$/i.test(argv[0])) throw Error('Explicit executable required; invoke Node/Python directly instead of a shell batch');
  if(!(options.criteria||'').split(',').filter(Boolean).length||!options.command_id)throw Error('--criteria and --command-id required');
  const before = inspect(root, options.repository_id), started = new Date().toISOString(), tick = performance.now();
  const result = cp.spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false });
  const after = inspect(root, options.repository_id), log = (result.stdout || '') + '\n' + (result.stderr || '') + (result.error ? '\n' + result.error.code : '');
  const id = crypto.randomUUID(), logPath = '.metis/reports/' + id + '.log'; atomic(root, logPath, log);
  const report = { kind: 'test', criterion_ids: (options.criteria || '').split(',').filter(Boolean), source: before.checkout, source_after: after.checkout,environment:before.environment, command_id: options.command_id, argv,
    exit_code: result.status === null ? 32768 : result.status, executed_at: started, duration_ms: Math.round(performance.now() - tick), artifacts: [{ path: logPath, sha256: sha(log) }], note: 'Observed by local bridge; server must treat as a client report, not independent attestation.' };
  if (!report.criterion_ids.length || !report.command_id) throw Error('--criteria and --command-id required');
  const request = { project_id: before.project_id, task_id: options.task_id, expected_revision: 0, idempotency_key: id, report };
  atomic(root, '.metis/reports/' + id + '.json', JSON.stringify(request, null, 2) + '\n');
  return { request, report_path: '.metis/reports/' + id + '.json', source_changed: sourceHash(before.checkout) !== sourceHash(after.checkout), actual_exit_code: result.status, process_error: result.error?.code || null };
}
function main(argv) {
  const command = argv.shift(), options = {}, separator = argv.indexOf('--'), processArgs = separator < 0 ? [] : argv.slice(separator + 1), flags = separator < 0 ? argv : argv.slice(0, separator);
  for (let i = 0; i < flags.length; i++) { if (!flags[i].startsWith('--') || !flags[i + 1]) throw Error('Named options require a value'); options[flags[i].slice(2).replaceAll('-', '_')] = flags[++i]; }
  const root = options.root || process.cwd();
  const result = command === 'init' ? install(root, options) : command === 'inspect' ? inspect(root, options.repository_id) : command === 'cache' ? cache(root, options.input) : command === 'offline' ? offline(root, options.repository_id,options) : command === 'ack' ? acknowledge(root,options.input,options.evidence) : command === 'index' ? index(root, (options.files || '').split(',').filter(Boolean), options.module_id, options.repository_id) : command === 'run' ? run(root, processArgs, options) : (() => { throw Error('Commands: init, inspect, index, run, cache, offline, ack'); })();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { process.stderr.write(e.message + '\n'); process.exitCode = 1; } }
module.exports = { VERSION, instructions, sha, stable, rootOf, inside, atomic, managed, canonicalRemote, manifest, inspect, install, sourceHash, cache, offline, index, run, assemble,fragmentItems,acknowledge, main };
