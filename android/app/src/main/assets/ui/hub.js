// Page « Agent » (façon app officielle Hermes) : compteurs, écrans natifs MCP et Projets,
// et éditeur de l'âme et de la mémoire.
(function () {
  'use strict';

  const bridge = window.HermesAndroid || null;
  const H = window.HermesApp;
  function $(sel) { return document.querySelector(sel); }

  function toast(text) {
    if (H) H.toast(text);
    else if (bridge && bridge.toast) bridge.toast(text);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function errTitle(e) {
    const msg = e && e.message ? e.message : String(e || '');
    return H ? H.frError(msg).title : msg;
  }

  function openConsole(path) {
    if (H) H.openConsole(path);
  }

  // ── Compteurs (modèle, compétences, plugins, MCP, projets) ──
  function setText(id, text) {
    const node = document.getElementById(id);
    if (node) node.textContent = text == null ? '' : String(text);
  }

  const counts = { skills: null, plugins: null, mcp: null };

  function renderEmptyStats() {
    const parts = [];
    if (counts.plugins != null) parts.push(H.plural(counts.plugins, 'plugin', 'plugins'));
    if (counts.mcp != null) parts.push(counts.mcp + ' MCP');
    if (counts.skills != null) parts.push(H.plural(counts.skills, 'compétence', 'compétences'));
    setText('empty-stats', parts.length ? parts.join(' · ') : 'Sur ce téléphone');
  }

  let refreshing = false;
  let lastRefresh = 0;

  async function refreshCounters(force) {
    if (!H || refreshing) return;
    if (!force && Date.now() - lastRefresh < 15000) return;
    if (!H.gw.open) return;
    refreshing = true;
    lastRefresh = Date.now();
    const jobs = [];
    jobs.push(H.fetchModelOptions(false).then(r => {
      const model = (H.chat.info && H.chat.info.model) || r.model || '';
      const provider = (H.chat.info && H.chat.info.provider) || r.provider || '';
      const row = (r.providers || []).find(p => p.slug === provider || p.name === provider || (p.aliases || []).includes(provider))
        || (r.providers || []).find(p => p.is_current);
      H.setHubModel(r.model || model, r.provider || provider);
      setText('hub-model', H.shortModel(model) || 'Aucun modèle');
      setText('hub-provider', row ? (row.name || row.slug) : (provider || 'À configurer'));
    }).catch(() => { setText('hub-model', '—'); setText('hub-provider', ''); }));
    jobs.push(H.api('/api/skills').then(list => {
      const rows = Array.isArray(list) ? list : (list && list.skills) || [];
      counts.skills = rows.filter(s => s.enabled !== false).length;
      setText('hub-skills', counts.skills);
    }).catch(() => setText('hub-skills', '')));
    jobs.push(H.api('/api/dashboard/plugins/hub').then(data => {
      const rows = (data && data.plugins) || [];
      counts.plugins = rows.length;
      setText('hub-plugins', counts.plugins);
    }).catch(() => setText('hub-plugins', '')));
    jobs.push(H.api('/api/mcp/servers').then(data => {
      const rows = (data && data.servers) || [];
      counts.mcp = rows.filter(s => s.enabled !== false).length;
      setText('hub-mcp', rows.length ? counts.mcp : '');
    }).catch(() => setText('hub-mcp', '')));
    jobs.push(H.gw.request('projects.list', {}, 15000).then(r => {
      const rows = ((r && r.projects) || []).filter(p => !p.archived);
      setText('hub-projects', rows.length || '');
    }).catch(() => setText('hub-projects', '')));
    try { await Promise.all(jobs); } finally { refreshing = false; renderEmptyStats(); }
  }

  // ── Écran MCP natif : liste, ajout, activation, test, suppression ──
  function field(label, input, hint) {
    const wrap = el('label', 'form-field');
    wrap.appendChild(el('span', 'ff-label', label));
    wrap.appendChild(input);
    if (hint) wrap.appendChild(el('small', 'ff-hint', hint));
    return wrap;
  }

  function input(type, placeholder) {
    const i = document.createElement(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') i.type = type;
    if (placeholder) i.placeholder = placeholder;
    i.autocapitalize = 'off';
    i.spellcheck = false;
    return i;
  }

  function parseArgs(text) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(text))) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
    return out;
  }

  function parseEnv(text) {
    const env = {};
    String(text || '').split('\n').forEach(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const i = t.indexOf('=');
      if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    });
    return env;
  }

  async function openMcp() {
    if (!H) return;
    const body = H.openSheet('MCP');
    body.appendChild(el('p', 'sheet-note', 'Les serveurs MCP donnent de nouveaux outils à Hermes. Les changements s’appliquent aux nouvelles conversations.'));
    const list = el('div', 'mcp-list');
    list.appendChild(el('p', 'sheet-note', 'Chargement…'));
    body.appendChild(list);
    const add = H.sheetItem('Ajouter un serveur', H.icons.plus, () => openMcpForm());
    body.appendChild(add);
    body.appendChild(H.sheetItem('Catalogue et options avancées', null, () => { H.closeSheet(); openConsole('/mcp'); }));

    let data;
    try {
      data = await H.api('/api/mcp/servers');
    } catch (e) {
      list.innerHTML = '';
      list.appendChild(el('p', 'sheet-note', 'Liste indisponible : ' + errTitle(e)));
      return;
    }
    const rows = (data && data.servers) || [];
    list.innerHTML = '';
    if (!rows.length) list.appendChild(el('p', 'sheet-note', 'Aucun serveur MCP pour l’instant.'));
    rows.forEach(s => list.appendChild(mcpRow(s)));
  }

  function mcpRow(s) {
    const row = el('div', 'mcp-row' + (s.enabled === false ? ' off' : ''));
    const top = el('div', 'mcp-top');
    const name = el('div', 'mcp-name');
    name.appendChild(el('strong', null, s.name));
    const where = s.url || [s.command].concat(s.args || []).filter(Boolean).join(' ');
    name.appendChild(el('small', null, (s.transport === 'http' ? 'HTTP · ' : s.transport === 'stdio' ? 'Commande · ' : '') + (where || '')));
    if (s.source === 'plugin') name.appendChild(el('small', null, 'Fourni par le plugin ' + (s.plugin || '')));
    top.appendChild(name);
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'switch';
    sw.checked = s.enabled !== false;
    sw.disabled = s.source === 'plugin';
    sw.onchange = async () => {
      try {
        await H.api('/api/mcp/servers/' + encodeURIComponent(s.name) + '/enabled', { method: 'PUT', body: { enabled: sw.checked } });
        row.classList.toggle('off', !sw.checked);
        toast(sw.checked ? 'Serveur activé' : 'Serveur désactivé');
        lastRefresh = 0;
      } catch (e) {
        sw.checked = !sw.checked;
        toast(errTitle(e));
      }
    };
    top.appendChild(sw);
    row.appendChild(top);
    const result = el('div', 'mcp-result');
    const actions = el('div', 'choices');
    const test = el('button', null, 'Tester');
    test.type = 'button';
    test.onclick = async () => {
      test.disabled = true;
      result.textContent = 'Connexion au serveur…';
      try {
        const r = await H.api('/api/mcp/servers/' + encodeURIComponent(s.name) + '/test', { method: 'POST', timeout: 90000 });
        if (r && r.ok) {
          const tools = (r.tools || []).map(t => t.name);
          result.textContent = 'OK · ' + H.plural(tools.length, 'outil', 'outils') + (tools.length ? ' : ' + tools.slice(0, 12).join(', ') + (tools.length > 12 ? '…' : '') : '');
        } else {
          result.textContent = 'Échec : ' + ((r && r.error) || 'inconnu');
        }
      } catch (e) {
        result.textContent = 'Échec : ' + errTitle(e);
      } finally {
        test.disabled = false;
      }
    };
    actions.appendChild(test);
    if (s.source !== 'plugin') {
      const del = el('button', 'danger', 'Supprimer');
      del.type = 'button';
      del.onclick = async () => {
        if (!window.confirm('Supprimer le serveur MCP « ' + s.name + ' » ?')) return;
        try {
          await H.api('/api/mcp/servers/' + encodeURIComponent(s.name), { method: 'DELETE' });
          row.remove();
          toast('Serveur supprimé');
          lastRefresh = 0;
        } catch (e) {
          toast(errTitle(e));
        }
      };
      actions.appendChild(del);
    }
    row.appendChild(actions);
    row.appendChild(result);
    return row;
  }

  function openMcpForm() {
    const body = H.openSheet('Nouveau serveur MCP');
    const form = el('form', 'sheet-form');
    const name = input('text', 'ex. github');
    const kind = el('div', 'seg-choice');
    const kHttp = el('button', 'active', 'URL (HTTP)');
    const kCmd = el('button', null, 'Commande locale');
    kHttp.type = kCmd.type = 'button';
    kind.appendChild(kHttp);
    kind.appendChild(kCmd);
    const url = input('url', 'https://exemple.com/mcp');
    const token = input('password', 'facultatif');
    const command = input('text', 'ex. npx');
    const args = input('text', 'ex. -y @modelcontextprotocol/server-filesystem ~/');
    const env = input('textarea', 'CLE=valeur (une par ligne)');
    env.rows = 3;
    const fUrl = field('Adresse du serveur', url);
    const fTok = field('Jeton d’accès (Bearer)', token, 'Enregistré dans le fichier .env de Hermes, jamais affiché.');
    const fCmd = field('Commande', command);
    const fArgs = field('Arguments', args);
    const fEnv = field('Variables d’environnement', env);
    let mode = 'http';
    const sync = () => {
      kHttp.classList.toggle('active', mode === 'http');
      kCmd.classList.toggle('active', mode === 'cmd');
      fUrl.hidden = fTok.hidden = mode !== 'http';
      fCmd.hidden = fArgs.hidden = fEnv.hidden = mode !== 'cmd';
    };
    kHttp.onclick = () => { mode = 'http'; sync(); };
    kCmd.onclick = () => { mode = 'cmd'; sync(); };
    form.appendChild(field('Nom', name));
    form.appendChild(kind);
    [fUrl, fTok, fCmd, fArgs, fEnv].forEach(f => form.appendChild(f));
    const err = el('div', 'form-error');
    form.appendChild(err);
    const save = el('button', 'primary wide', 'Ajouter');
    save.type = 'submit';
    form.appendChild(save);
    form.onsubmit = async ev => {
      ev.preventDefault();
      err.textContent = '';
      const payload = { name: name.value.trim() };
      if (!payload.name) { err.textContent = 'Donne un nom au serveur.'; return; }
      if (mode === 'http') {
        payload.url = url.value.trim();
        if (!payload.url) { err.textContent = 'Indique l’adresse du serveur.'; return; }
        if (token.value.trim()) { payload.auth = 'header'; payload.bearer_token = token.value.trim(); }
      } else {
        payload.command = command.value.trim();
        if (!payload.command) { err.textContent = 'Indique la commande à lancer.'; return; }
        payload.args = parseArgs(args.value);
        payload.env = parseEnv(env.value);
      }
      save.disabled = true;
      try {
        await H.api('/api/mcp/servers', { method: 'POST', body: payload });
        toast('Serveur « ' + payload.name + ' » ajouté');
        lastRefresh = 0;
        openMcp();
      } catch (e) {
        err.textContent = e.message || 'Ajout impossible';
        save.disabled = false;
      }
    };
    body.appendChild(form);
    sync();
    name.focus();
  }

  // ── Projets (RPC projects.*) ──
  async function openProjects() {
    if (!H) return;
    const body = H.openSheet('Projets');
    body.appendChild(el('p', 'sheet-note', 'Un projet regroupe des dossiers de travail. Le projet actif sert de point de départ aux nouvelles conversations.'));
    const list = el('div', 'proj-list');
    list.appendChild(el('p', 'sheet-note', 'Chargement…'));
    body.appendChild(list);
    const create = H.sheetItem('Nouveau projet', H.icons.plus, async () => {
      const nameText = window.prompt('Nom du projet');
      if (!nameText || !nameText.trim()) return;
      try {
        await H.gw.request('projects.create', { name: nameText.trim(), use: true }, 20000);
        toast('Projet créé');
        lastRefresh = 0;
        openProjects();
      } catch (e) {
        toast(errTitle(e));
      }
    });
    body.appendChild(create);
    body.appendChild(H.sheetItem('Fichiers', H.icons.folder, () => { H.closeSheet(); openConsole('/files'); }));

    let r;
    try {
      r = await H.gw.request('projects.list', {}, 15000);
    } catch (e) {
      list.innerHTML = '';
      const unsupported = e && (e.code === -32601 || /unknown method|not found/i.test(e.message || ''));
      list.appendChild(el('p', 'sheet-note', unsupported ? 'Les projets ne sont pas disponibles avec cette version du moteur.' : 'Liste indisponible : ' + errTitle(e)));
      create.disabled = unsupported;
      return;
    }
    const rows = ((r && r.projects) || []).filter(p => !p.archived);
    list.innerHTML = '';
    if (!rows.length) list.appendChild(el('p', 'sheet-note', 'Aucun projet pour l’instant.'));
    rows.forEach(p => {
      const active = p.id === r.active_id;
      const folders = (p.folders || []).length;
      const b = H.sheetItem(p.name || p.slug, active ? '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' : H.icons.star, async () => {
        try {
          await H.gw.request('projects.set_active', { id: active ? null : p.id }, 15000);
          toast(active ? 'Aucun projet actif' : 'Projet actif : ' + (p.name || p.slug));
          openProjects();
        } catch (e) {
          toast(errTitle(e));
        }
      }, {
        cls: active ? 'active' : '',
        sub: [p.description, folders ? H.plural(folders, 'dossier', 'dossiers') : 'aucun dossier'].filter(Boolean).join(' · '),
        right: active ? 'actif' : '',
      });
      list.appendChild(b);
    });
  }

  // ── Éditeur ──
  const DOCS = {
    soul: {
      title: 'Âme',
      help: 'La personnalité et les consignes permanentes de Hermes (SOUL.md). Prise en compte à la prochaine conversation.',
      files: [{ name: 'SOUL.md', label: 'Âme' }],
    },
    memory: {
      title: 'Mémoire',
      help: 'Ce que Hermes retient de toi et de son travail. Les entrées sont séparées par « § ». Prise en compte à la prochaine conversation.',
      files: [{ name: 'memories/USER.md', label: 'Sur toi' }, { name: 'memories/MEMORY.md', label: 'Notes de Hermes' }],
    },
  };

  let current = null; // { doc, file, original }

  function loadFile(name) {
    try { return bridge ? String(bridge.readAgentFile(name) || '') : ''; } catch (_) { return ''; }
  }

  function dirty() {
    return current && $('#ed-text').value !== current.original;
  }

  function selectFile(doc, idx) {
    const f = DOCS[doc].files[idx];
    const text = loadFile(f.name);
    current = { doc: doc, file: f.name, original: text };
    $('#ed-text').value = text;
    $('#ed-text').placeholder = 'Vide pour l’instant.';
    document.querySelectorAll('#ed-tabs button').forEach(function (b, i) { b.classList.toggle('active', i === idx); });
  }

  function openEditor(doc) {
    const d = DOCS[doc];
    if (!d) return;
    $('#ed-title').textContent = d.title;
    $('#ed-help').textContent = d.help;
    const tabs = $('#ed-tabs');
    tabs.innerHTML = '';
    if (d.files.length > 1) {
      d.files.forEach(function (f, i) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = f.label;
        b.onclick = function () {
          if (dirty() && !window.confirm('Abandonner les modifications non enregistrées ?')) return;
          selectFile(doc, i);
        };
        tabs.appendChild(b);
      });
    }
    selectFile(doc, 0);
    $('#editor').hidden = false;
  }

  function closeEditor(force) {
    if (!force && dirty() && !window.confirm('Abandonner les modifications non enregistrées ?')) return false;
    $('#editor').hidden = true;
    current = null;
    return true;
  }

  function save() {
    if (!current || !bridge) return;
    const text = $('#ed-text').value;
    let ok = false;
    try { ok = !!bridge.writeAgentFile(current.file, text); } catch (_) { ok = false; }
    if (ok) {
      current.original = text;
      toast('Enregistré');
    } else {
      toast('Échec de l’enregistrement');
    }
  }

  function init() {
    if (H) H.native = { mcp: openMcp, projects: openProjects, refresh: refreshCounters };
    document.querySelectorAll('.hub-row').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.console) openConsole(b.dataset.console);
        else if (b.dataset.editor) openEditor(b.dataset.editor);
        else if (b.dataset.native === 'model' && H) H.openModelPicker();
        else if (b.dataset.native === 'mcp') openMcp();
        else if (b.dataset.native === 'projects') openProjects();
        else if (b.dataset.native === 'history' && H) H.showHome('chats');
      });
    });
    $('#ed-back').onclick = function () { closeEditor(false); };
    $('#ed-save').onclick = save;

    document.addEventListener('hermes:connected', function () { refreshCounters(true); });
    document.addEventListener('hermes:model', function () { lastRefresh = 0; refreshCounters(true); });
    document.addEventListener('hermes:view', function (ev) {
      const d = ev.detail || {};
      if ((d.view === 'home' && d.pane === 'agent') || d.view === 'chat') refreshCounters(false);
    });

    // Le bouton Retour d'Android ferme d'abord l'éditeur.
    const prevBack = window.hermesBack;
    window.hermesBack = function () {
      if (!$('#editor').hidden) { closeEditor(false); return true; }
      return prevBack ? prevBack() : false;
    };
  }

  // hub.js est chargé en dernier : le DOM et app.js sont prêts.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
