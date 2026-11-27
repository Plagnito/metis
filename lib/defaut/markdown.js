'use strict';

// =============================================================================
//  Rendu Markdown par défaut de Métis (hôte autonome)
// -----------------------------------------------------------------------------
//  Sous-ensemble suffisant pour des publications : titres (## à ####), listes,
//  tableaux, citations, code, liens, images, gras, italique. Sans dépendance.
//  Même contrat que l'entrée d'hôte `rendu` : rendre(md) → { html, sommaire },
//  ancre(titre), echapper(texte), enLigne(texte).
//
//  ⚠️ Images : SOURCE LOCALE UNIQUEMENT (chemin « / » ou adresse de l'instance).
//  Une image distante est une requête que le navigateur du lecteur envoie à un
//  tiers, qui apprend son adresse IP, l'heure et la page lue : un pixel espion.
//  Une source refusée retombe sur son texte de remplacement, visible.
// =============================================================================

const host = require('../host');

function echapper(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// L'adresse est-elle celle de l'instance (ou un chemin local) ?
function locale(url) {
  if (/^\//.test(url) && !/^\/\//.test(url)) return true;
  const base = host.publicUrl();
  if (!base) return false;
  try { return new URL(url).origin === new URL(base).origin; } catch { return false; }
}

function enLigne(src) {
  // Le code littéral est mis de côté AVANT l'échappement : sans ça, `<div>` écrit
  // dans un exemple ressortirait échappé deux fois.
  const codes = [];
  let s = String(src).replace(/`([^`]+)`/g, (m, c) => {
    codes.push(c); return '\u0000C' + (codes.length - 1) + '\u0000';
  });
  s = echapper(s);
  // Images AVANT les liens, sinon « ![…](…) » serait lu comme « ! » suivi d'un lien.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
    if (!locale(url)) return '<span class="img-refusee">' + (alt || 'image') + ' (source distante refusée)</span>';
    return '<img src="' + url + '" alt="' + alt + '" loading="lazy" decoding="async">';
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, texte, url) => {
    if (/^\s*(javascript|data|vbscript):/i.test(url)) url = '#';
    const externe = /^https?:\/\//i.test(url) && !locale(url);
    const attrs = externe ? ' rel="noopener nofollow" target="_blank"' : '';
    return '<a href="' + url + '"' + attrs + '>' + texte + '</a>';
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\u0000C(\d+)\u0000/g, (m, i) => '<code>' + echapper(codes[Number(i)]) + '</code>');
  return s;
}

// Identifiant d'ancre stable, lisible, sans accents : il permet de pointer un
// paragraphe précis depuis une réponse d'assistant.
function ancre(texte) {
  return String(texte).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
}

function rendre(md) {
  const lignes = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const sommaire = [];
  let i = 0;
  const ancresVues = new Set();
  const ancreUnique = (t) => {
    let a = ancre(t); let n = 2;
    while (ancresVues.has(a)) a = ancre(t) + '-' + (n++);
    ancresVues.add(a); return a;
  };

  while (i < lignes.length) {
    const l = lignes[i];

    if (/^```/.test(l)) {
      const lang = l.slice(3).trim();
      const buf = [];
      i++;
      while (i < lignes.length && !/^```/.test(lignes[i])) buf.push(lignes[i++]);
      i++;
      out.push('<pre class="code"' + (lang ? ' data-lang="' + echapper(lang) + '"' : '') + '><code>'
        + echapper(buf.join('\n')) + '</code></pre>');
      continue;
    }

    const mt = /^(#{2,4})\s+(.*)$/.exec(l);
    if (mt) {
      const niveau = mt[1].length;
      const texte = mt[2].trim();
      const a = ancreUnique(texte);
      if (niveau <= 3) sommaire.push({ niveau, texte, ancre: a });
      out.push('<h' + niveau + ' id="' + a + '">' + enLigne(texte)
        + ' <a class="lien-ancre" href="#' + a + '" aria-label="Lien vers cette section">#</a></h' + niveau + '>');
      i++; continue;
    }

    if (/^---+\s*$/.test(l)) { out.push('<hr>'); i++; continue; }

    // `> ⚠️ …` devient un encadré d'avertissement, `> ✅` ou `> 💡` une astuce.
    if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lignes.length && /^>\s?/.test(lignes[i])) buf.push(lignes[i++].replace(/^>\s?/, ''));
      const contenu = buf.join('\n');
      const type = /^\s*(⚠️|❗)/.test(contenu) ? 'attention' : (/^\s*(✅|💡)/.test(contenu) ? 'astuce' : 'note');
      out.push('<blockquote class="enc enc-' + type + '">' + rendre(contenu).html + '</blockquote>');
      continue;
    }

    if (/^\|/.test(l) && i + 1 < lignes.length && /^\|[\s:|-]+\|?\s*$/.test(lignes[i + 1])) {
      const cellules = (ligne) => ligne.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const entete = cellules(l);
      i += 2;
      const corps = [];
      while (i < lignes.length && /^\|/.test(lignes[i])) corps.push(cellules(lignes[i++]));
      out.push('<div class="table-wrap"><table><thead><tr>'
        + entete.map((c) => '<th>' + enLigne(c) + '</th>').join('') + '</tr></thead><tbody>'
        + corps.map((r) => '<tr>' + r.map((c) => '<td>' + enLigne(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table></div>');
      continue;
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const numerotee = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lignes.length && /^\s*([-*]|\d+\.)\s+/.test(lignes[i])) {
        const indent = /^(\s*)/.exec(lignes[i])[1].length;
        items.push({ indent, texte: lignes[i].replace(/^\s*([-*]|\d+\.)\s+/, '') });
        i++;
      }
      const base = Math.min(...items.map((x) => x.indent));
      const html = [];
      let ouvert = false;
      for (const it of items) {
        if (it.indent > base) {
          if (!ouvert) { html.push('<ul class="imbrique">'); ouvert = true; }
        } else if (ouvert) { html.push('</ul>'); ouvert = false; }
        html.push('<li>' + enLigne(it.texte) + '</li>');
      }
      if (ouvert) html.push('</ul>');
      out.push('<' + (numerotee ? 'ol' : 'ul') + '>' + html.join('') + '</' + (numerotee ? 'ol' : 'ul') + '>');
      continue;
    }

    if (!l.trim()) { i++; continue; }

    const buf = [];
    while (i < lignes.length && lignes[i].trim()
      && !/^(#{2,4}\s|```|>|\||\s*([-*]|\d+\.)\s|---+\s*$)/.test(lignes[i])) buf.push(lignes[i++]);
    if (buf.length) out.push('<p>' + enLigne(buf.join(' ')) + '</p>');
  }

  return { html: out.join('\n'), sommaire };
}

module.exports = { rendre, enLigne, echapper, ancre };
