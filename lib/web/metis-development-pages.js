'use strict';
const D = require('../modules/metisdevelopment'), P = require('../modules/metisprojects'), F = require('../modules/metis-access-fence');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const styles = '<style>.development-view{max-width:1050px;margin:auto}.development-view h1{font-family:var(--serif);font-size:clamp(34px,5vw,58px);font-weight:500}.development-intro{color:var(--texte2);line-height:1.7}.development-status{display:flex;gap:14px;flex-wrap:wrap;margin:24px 0}.development-status>div{border:1px solid var(--ligne);border-radius:10px;padding:18px;flex:1;min-width:150px}.development-status b{display:block;margin-bottom:8px}.development-entry{padding:20px;border:1px solid var(--ligne);border-radius:12px;margin:16px 0;background:var(--carte);min-width:0}.development-entry h2{font-size:20px;margin:8px 0 15px}.development-entry small{color:var(--texte2);overflow-wrap:anywhere}.development-entry pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:440px;overflow:auto;font:inherit;font-size:13px;line-height:1.7}.development-nav{display:flex;gap:18px;flex-wrap:wrap}.development-next{display:block;padding:16px;border:1px solid var(--ligne);border-radius:9px;margin:24px 0}@media(max-width:550px){.development-status>div{min-width:100px}.development-entry{padding:15px}}</style>';
const kinds = { project: 'Programme', overview: 'Vue d’ensemble', invariant: 'Règle du projet', task: 'Tâche', dependency: 'Dépendance', module: 'Module', command: 'Commande de validation', document: 'Document indexé', reference: 'Référence', decision: 'Décision', risk: 'Risque', session: 'Note de reprise', checkpoint: 'Point de reprise', attempt: 'Approche déjà essayée' };
const freshness = { unknown_checkout: 'Checkout local à vérifier', no_checkpoint: 'Premier point de reprise à enregistrer', matching_reported_checkout: 'Version déclarée correspondante', changed_checkout: 'Version du code différente', changed_task_contract: 'Contrat de tâche modifié' };
const bullets=items=>items?.length?'<ul>'+items.map(item=>'<li>'+esc(typeof item==='string'?item:item.title)+'</li>').join('')+'</ul>':'';
function entryBody(item){
  let body=item.body?'<pre>'+esc(item.body)+'</pre>':'';
  if(item.kind==='task')body+=(item.expected_result?'<p><strong>Résultat attendu</strong> — '+esc(item.expected_result)+'</p>':'')+bullets(item.acceptance_criteria)+(item.paths?.length?'<p>Fichiers : '+item.paths.map(esc).join(', ')+'</p>':'');
  if(item.kind==='module')body+='<p>Chemins : '+(item.paths||[]).map(esc).join(', ')+'</p>'+bullets(item.documents);
  if(item.kind==='command')body+='<pre>'+esc(item.argv.join(' '))+'</pre>';
  if(item.kind==='checkpoint')body+='<p><strong>À poursuivre</strong> — '+esc(item.next_action)+'</p>'+bullets(item.changes)+(item.blockers?.length?'<p><strong>Blocages</strong></p>'+bullets(item.blockers):'')+'<p>'+esc(item.source?.branch)+' · '+esc(item.source?.commit?.slice(0,12))+' · '+(item.source?.dirty?'modifications non committées':'arbre propre déclaré')+'</p>';
  if(item.kind==='attempt')body+='<p><strong>'+esc(item.approach)+'</strong></p><p>'+esc(({succeeded:'Réussi',failed:'Échoué',inconclusive:'Non concluant',abandoned:'Abandonné'})[item.result]||item.result)+' — '+esc(item.reason)+'</p><p>À réexaminer : '+esc(item.reconsider_when)+'</p>';
  if(item.kind==='dependency')body+='<p>État : '+esc(item.state)+'</p><p>'+esc(item.outcome)+'</p>';
  if(item.kind==='context_fragment')body+='<p>Source volumineuse, transmise en fragments vérifiables. Continuer les pages puis utiliser le pont local pour l’assemblage complet.</p>';
  return body+'<details><summary>Versions et informations techniques</summary><pre>'+esc(JSON.stringify(item,null,2))+'</pre></details>';
}
function render(project, result, overview, query = {}) {
  const data = result.data, base = '/metis/projets/' + encodeURIComponent(project.id);
  const next = result.next_cursor ? new URLSearchParams({ ...(query.task_id ? { task_id: query.task_id } : {}), cursor: result.next_cursor }).toString() : null;
  return styles + '<div class="development-view"><header><p class="development-intro">Métis · Reprise de développement</p><h1>' + esc(P.summary(project).title) + '</h1><p class="development-intro">Retrouver le programme, ses contraintes et la prochaine étape depuis une nouvelle session. Le code réellement ouvert reste à inspecter dans votre harness.</p><nav class="development-nav"><a href="' + base + '">← Projet et tâches</a><a href="' + base + '/reprise.json">Version JSON</a><a href="'+base+'/bridge.cjs">Pont local</a></nav></header>'
    + '<div class="development-status"><div><b>Contexte</b>' + esc(freshness[data.freshness] || data.freshness) + '</div><div><b>Points de reprise</b>' + esc(overview.checkpoints) + '</div><div><b>Écriture</b>' + esc(({ available: 'Disponible', active: 'Session active', expired: 'Reprise explicite nécessaire', busy_other_project: 'Session sur un autre projet', expired_other_project: 'Ancienne session à reprendre' })[overview.session.state] || overview.session.state) + '</div></div>'
    + (data.setup_required ? '<section class="development-entry"><h2>Relier le dépôt une première fois</h2><p>Demandez à votre harness de configurer les dépôts, modules et commandes avec <code>projets_configurer_contexte</code>, puis de préparer le manifeste avec <code>projets_adaptateur</code>. Les projets et notes déjà présents restent disponibles ci-dessous.</p></section>' : '')
    + '<section class="development-entry"><h2>Prochaine action</h2><pre>' + esc(data.next_action || 'Choisir une tâche et définir sa prochaine étape.') + '</pre><details><summary>Version du contexte</summary><small>' + esc(data.context_digest) + ' · révision de configuration ' + esc(data.context_revision) + '</small></details></section>'
    + data.items.map(item => '<section class="development-entry"><small>' + esc(kinds[item.kind] || item.kind) + (item.path?' · '+esc(item.path):'') + '</small><h2>' + esc(item.title || kinds[item.kind] || item.kind) + '</h2>'+entryBody(item)+'</section>').join('')
    + (next ? '<a class="development-next" href="' + base + '/reprise?' + esc(next) + '">Continuer la lecture du contexte →</a>' : '<p class="development-intro">Fin de cette sélection. Les extraits restent des données versionnées ; les validations rapportées ne constituent pas une exécution certifiée par le serveur.</p>') + '</div>';
}
function mount(router, { garde, envoyer, pasTrouve, compteDe }) {
  router.get('/projets/:id/bridge.cjs',(req,res,next)=>{const account=garde(req,res);if(!account)return;if(!D.enabled())return pasTrouve(res,account);try{P.get(account.id,req.params.id);const file=require('node:path').join(__dirname,'../../tools/metis-context/bridge.cjs');const bytes=require('node:fs').readFileSync(file);res.set('Content-Type','text/plain; charset=utf-8').set('Content-Disposition','attachment; filename="metis-bridge.cjs"').set('X-Content-SHA256',require('node:crypto').createHash('sha256').update(bytes).digest('hex')).send(bytes);}catch(e){if(['NOT_FOUND','PERMISSION_DENIED'].includes(e.code))return pasTrouve(res,account);next(e);}});
  for (const suffix of ['reprise', 'reprise.json']) router.get('/projets/:id/' + suffix, (req, res, next) => {
    const account = garde(req, res); if (!account) return;
    if (!D.enabled()) return pasTrouve(res, account);
    try {
      const project = P.get(account.id, req.params.id);
      const args = { project_id: project.id, ...(req.query.task_id ? { task_id: req.query.task_id } : {}), ...(req.query.cursor ? { cursor: req.query.cursor } : {}), max_tokens: 12000 };
      const result = D.call('projets_contexte', args, account.id);
      if (!result.ok) return ['NOT_FOUND', 'PERMISSION_DENIED'].includes(result.error.code) ? pasTrouve(res, account) : res.status(result.error.code === 'STALE_CURSOR' ? 409 : 400).json(result);
      const html = suffix === 'reprise' ? render(project, result, D.overview(account.id, project.id), args) : null;
      return F.deliver({ structuredContent: result }, checked => !checked.structuredContent.ok ? pasTrouve(res, account) : html ? envoyer(res, account, 'Reprise — ' + P.summary(project).title, html, { actif: 'projets', fil: [['Métis', '/metis'], ['Autres projets', '/metis/projets'], [P.summary(project).title, '/metis/projets/' + encodeURIComponent(project.id)], ['Reprise', null]] }) : res.json(result), () => !compteDe || compteDe(req)?.id === account.id);
    } catch (e) { if (['NOT_FOUND', 'INVALID_ARGUMENT', 'PERMISSION_DENIED'].includes(e.code)) return pasTrouve(res, account); next(e); }
  });
}
module.exports = { mount, render };
