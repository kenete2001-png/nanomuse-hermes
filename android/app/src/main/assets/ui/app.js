// Hermes for Android — mobile shell.
// Talks to the on-device Hermes dashboard over the same JSON-RPC WebSocket the
// official desktop app uses (/api/ws), and embeds the dashboard for settings.
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const bridge = window.HermesAndroid || null;
  const MD = window.HermesMarkdown;
  const LAST_SESSION_KEY = 'hermes.android.lastSession';

  // ───────────────────────────── helpers ─────────────────────────────

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function toast(text) {
    if (bridge) bridge.toast(String(text));
    else console.log('[toast]', text);
  }

  function copy(text) {
    if (bridge) { bridge.copyText(text); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Copié'));
  }

  function textOf(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value.map(part => (typeof part === 'string' ? part : (part && (part.text || part.content)) || '')).join('');
    }
    if (typeof value === 'object') return value.text || value.content || JSON.stringify(value);
    return String(value);
  }

  function clip(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '\n… (tronqué)' : s;
  }

  function relTime(sec) {
    if (!sec) return '';
    const d = Date.now() / 1000 - sec;
    if (d < 60) return 'à l’instant';
    if (d < 3600) return Math.floor(d / 60) + ' min';
    if (d < 86400) return Math.floor(d / 3600) + ' h';
    if (d < 86400 * 7) return Math.floor(d / 86400) + ' j';
    const t = new Date(sec * 1000);
    return t.getDate() + '/' + (t.getMonth() + 1);
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        resolve({ dataUrl: url, base64: url.slice(url.indexOf(',') + 1) });
      };
      reader.onerror = () => reject(reader.error || new Error('Lecture du fichier impossible'));
      reader.readAsDataURL(file);
    });
  }

  // ───────────────────────────── runtime status ─────────────────────────────

  let status = { phase: 'idle', port: 0, token: '' };

  async function fetchStatus() {
    const res = await fetch('/__android/status.json', { cache: 'no-store' });
    return res.json();
  }

  // ───────────────────────────── gateway client ─────────────────────────────

  class Gateway {
    constructor() {
      this.ws = null;
      this.nextId = 0;
      this.pending = new Map();
      this.eventListeners = new Set();
      this.stateListeners = new Set();
      this.requestHandler = null;
      this.state = 'closed';
      this.pingTimer = null;
    }

    setState(state) {
      this.state = state;
      this.stateListeners.forEach(fn => fn(state));
    }

    connect(url) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        this.ws = ws;
        this.setState('connecting');
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { ws.close(); } catch (_) { /* ignore */ }
          reject(new Error('Délai de connexion dépassé'));
        }, 15000);
        ws.onopen = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.setState('open');
          resolve();
        };
        ws.onerror = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error('Impossible de joindre Hermes'));
        };
        ws.onclose = ev => {
          if (this.ws !== ws) return;
          this.ws = null;
          this.stopPing();
          for (const call of this.pending.values()) {
            clearTimeout(call.timer);
            call.reject(new Error('Connexion à Hermes perdue'));
          }
          this.pending.clear();
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error('Connexion fermée (' + ev.code + ')'));
          }
          this.setState('closed');
        };
        ws.onmessage = ev => this.onFrame(ev.data);
      });
    }

    close() {
      const ws = this.ws;
      this.ws = null;
      this.stopPing();
      if (ws) { try { ws.close(); } catch (_) { /* ignore */ } }
      this.setState('closed');
    }

    get open() {
      return !!this.ws && this.ws.readyState === 1;
    }

    send(frame) {
      if (!this.open) throw new Error('Non connecté à Hermes');
      this.ws.send(JSON.stringify(frame));
    }

    request(method, params, timeoutMs) {
      const timeout = timeoutMs == null ? 120000 : timeoutMs;
      return new Promise((resolve, reject) => {
        if (!this.open) { reject(new Error('Non connecté à Hermes')); return; }
        const id = 'm' + (++this.nextId);
        const timer = timeout > 0 ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('Délai dépassé : ' + method));
        }, timeout) : null;
        this.pending.set(id, { resolve, reject, timer });
        try {
          this.send({ jsonrpc: '2.0', id, method, params: params || {} });
        } catch (e) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(e);
        }
      });
    }

    respond(id, result) {
      try { this.send({ jsonrpc: '2.0', id, result }); } catch (_) { /* socket gone */ }
    }

    fail(id, code, message) {
      try { this.send({ jsonrpc: '2.0', id, error: { code, message } }); } catch (_) { /* socket gone */ }
    }

    onFrame(data) {
      let frame;
      try { frame = JSON.parse(data); } catch (_) { return; }
      if (!frame || typeof frame !== 'object') return;
      if (frame.method === 'event' && frame.params) {
        const ev = frame.params;
        if (ev.type === 'gateway.ready' && ev.payload && ev.payload.heartbeat) this.startPing();
        this.eventListeners.forEach(fn => {
          try { fn(ev); } catch (e) { console.error(e); }
        });
        return;
      }
      if (frame.method && frame.id != null) {
        const req = { id: frame.id, method: frame.method, params: frame.params || {} };
        let handled = false;
        try {
          handled = !!(this.requestHandler && this.requestHandler(req) !== false);
        } catch (e) {
          console.error(e);
          this.fail(frame.id, -32603, String(e && e.message || e));
          return;
        }
        if (!handled) this.fail(frame.id, -32601, 'Action pas encore prise en charge sur Android');
        return;
      }
      if (frame.id != null && this.pending.has(frame.id)) {
        const call = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        clearTimeout(call.timer);
        if (frame.error) {
          const err = new Error(frame.error.message || 'La requête à Hermes a échoué');
          err.code = frame.error.code;
          err.data = frame.error.data;
          call.reject(err);
        } else {
          call.resolve(frame.result);
        }
      }
    }

    startPing() {
      this.stopPing();
      this.pingTimer = setInterval(() => {
        try {
          this.send({ jsonrpc: '2.0', id: 'hb' + Date.now(), method: 'gateway.ping', params: {} });
        } catch (_) { /* reconnect logic handles it */ }
      }, 15000);
    }

    stopPing() {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  const gw = new Gateway();

  // ───────────────────────────── extra helpers ─────────────────────────────

  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' s';
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ' min' + (r ? ' ' + String(r).padStart(2, '0') + ' s' : '');
  }

  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function plural(n, one, many) {
    return n + ' ' + (n > 1 ? many : one);
  }

  // « deepseek/deepseek-v4.1-flash » → « deepseek-v4.1-flash »
  function shortModel(model) {
    const m = String(model || '').trim();
    if (!m) return '';
    const i = m.lastIndexOf('/');
    return i >= 0 && i < m.length - 1 ? m.slice(i + 1) : m;
  }

  // Erreurs des fournisseurs et du moteur → français clair (le texte brut reste consultable).
  const ERROR_RULES = [
    [/free[_ -]?tier|included allowance|token harbor|harbor pass|upgrade (your|to)|subscribe to/i,
      'Quota gratuit épuisé pour ce modèle', 'Choisis un autre modèle (touche le nom du modèle en haut) ou passe à une offre payante chez ce fournisseur.'],
    [/\b402\b|insufficient[_ ](credit|balance|funds|quota)|payment required|exceeded your current quota|out of credits|billing/i,
      'Crédit épuisé chez le fournisseur', 'Recharge ton compte chez le fournisseur ou choisis un autre modèle.'],
    [/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid[_ ]api[_ ]key|incorrect api key|invalid x-api-key|authentication|no auth credentials|api key.*(invalid|expired|revoked)/i,
      'Clé API refusée par le fournisseur', 'Vérifie ta clé dans Agent › Clés et variables, puis réessaie.'],
    [/no (llm |ai )?provider|provider_configured|no api key|missing api key|api key (is )?(not set|missing|required)|no model configured/i,
      'Aucun modèle configuré', 'Ajoute une clé dans Agent › Clés et variables, puis choisis un modèle.'],
    [/\b429\b|rate[_ ]?limit|too many requests|overloaded|over capacity|capacity exceeded|resource[_ ]exhausted/i,
      'Le fournisseur est saturé (trop de requêtes)', 'Réessaie dans un instant ou change de modèle.'],
    [/context[_ ]length|maximum context|context window|too many tokens|prompt is too long|token limit|reduce the length/i,
      'Conversation trop longue pour ce modèle', 'Commence une nouvelle conversation, ou utilise « Compresser la conversation » dans le menu « … ».'],
    [/model[^.\n]{0,40}(not found|does not exist|not available|unavailable|unsupported)|no such model|unknown model|invalid model|\b404\b/i,
      'Modèle introuvable chez ce fournisseur', 'Choisis un modèle disponible (touche le nom du modèle en haut).'],
    [/content[_ ]?(filter|policy|management)|safety|moderation|flagged/i,
      'Réponse bloquée par le filtre du fournisseur', 'Reformule ta demande ou essaie un autre modèle.'],
    [/timed? ?out|timeout|deadline exceeded|read timeout/i,
      'Le fournisseur ne répond pas (délai dépassé)', 'Vérifie ta connexion internet, puis réessaie.'],
    [/connection (error|refused|reset|aborted)|network|unreachable|name resolution|getaddrinfo|dns|econn|ssl|certificate|failed to connect|could not connect/i,
      'Impossible de joindre le fournisseur', 'Vérifie la connexion internet du téléphone, puis réessaie.'],
    [/\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout|upstream/i,
      'Erreur côté fournisseur', 'Le service du fournisseur a un souci passager. Réessaie dans un moment.'],
    [/delegation owner exited|outcome unknown|batch did not complete/i,
      'Une sous-tâche déléguée s’est arrêtée sans résultat', 'Relance la demande ; si cela se répète, choisis un modèle plus stable.'],
    [/context injection refused/i,
      'Fichier ou dossier référencé refusé', 'Les références « @ » doivent rester dans le dossier de travail.'],
    [/requires a live session|agent (is )?still starting|agent initialization failed/i,
      'Hermes démarre encore', 'Patiente quelques secondes, puis réessaie.'],
    [/connexion à hermes perdue|non connecté à hermes|impossible de joindre hermes/i,
      'Connexion à Hermes perdue', 'L’app se reconnecte toute seule. Renvoie ton message si la réponse ne revient pas.'],
  ];

  function frError(raw) {
    const text = String(raw == null ? '' : (typeof raw === 'object' ? (raw.message || JSON.stringify(raw)) : raw)).trim();
    for (const [re, title, hint] of ERROR_RULES) {
      if (re.test(text)) return { title, hint, raw: text };
    }
    return { title: 'Erreur pendant la réponse', hint: 'Réessaie, ou change de modèle si l’erreur se répète.', raw: text };
  }

  function errorCard(raw) {
    const e = frError(raw);
    const box = el('div', 'err-card');
    box.appendChild(el('div', 'err-title', e.title));
    if (e.hint) box.appendChild(el('div', 'err-hint', e.hint));
    if (e.raw && e.raw !== e.title) {
      const det = document.createElement('details');
      det.appendChild(el('summary', null, 'Détails techniques'));
      det.appendChild(el('pre', null, clip(e.raw, 4000)));
      box.appendChild(det);
    }
    return box;
  }

  // Messages types (anglais) renvoyés tels quels par le moteur.
  const CANNED = [
    [/^your request was not processed\.? send it again if you still want me to carry it out\.?$/i,
      'Ta demande n’a pas été traitée. Renvoie-la si tu veux toujours que je m’en occupe.'],
    [/^\(?no response\)?\.?$/i, '(Aucune réponse)'],
  ];

  function frCanned(text) {
    const t = String(text || '').trim();
    for (const [re, fr] of CANNED) if (re.test(t)) return fr;
    return text;
  }

  // Libellés des étapes (nom d'outil → phrase), façon « Ran command » de l'app officielle.
  const TOOL_LABELS = [
    [/^(terminal|shell|bash|run_command|process)$/, 'A exécuté une commande', 'Exécute une commande'],
    [/^execute_code$|^python/, 'A exécuté du code', 'Exécute du code'],
    [/^web_search|search_web|^search$/, 'A cherché sur le web', 'Cherche sur le web'],
    [/^web_extract|^web_fetch|^fetch|crawl|scrape/, 'A lu une page web', 'Lit une page web'],
    [/^browser/, 'A utilisé le navigateur', 'Utilise le navigateur'],
    [/^read_file|^view_file|^cat$/, 'A lu un fichier', 'Lit un fichier'],
    [/^write_file|^create_file/, 'A écrit un fichier', 'Écrit un fichier'],
    [/^patch|^edit_file|^apply_patch|^str_replace/, 'A modifié un fichier', 'Modifie un fichier'],
    [/^search_files|^grep|^find_files|^list_dir|^ls$/, 'A parcouru les fichiers', 'Parcourt les fichiers'],
    [/^skill/, 'A consulté une compétence', 'Consulte une compétence'],
    [/^memory/, 'A mis à jour la mémoire', 'Met à jour la mémoire'],
    [/^session_search/, 'A cherché dans l’historique', 'Cherche dans l’historique'],
    [/^todo/, 'A mis à jour les tâches', 'Met à jour les tâches'],
    [/^delegate|^subagent|^spawn/, 'A délégué une tâche', 'Délègue une tâche'],
    [/^cron/, 'A programmé une routine', 'Programme une routine'],
    [/^vision|analy[sz]e_image/, 'A analysé une image', 'Analyse une image'],
    [/^image_gen|generate_image/, 'A généré une image', 'Génère une image'],
    [/^text_to_speech|^tts/, 'A généré de l’audio', 'Génère de l’audio'],
    [/^clarify/, 'A posé une question', 'Pose une question'],
    [/^send_message/, 'A envoyé un message', 'Envoie un message'],
    [/^mcp_/, 'A utilisé un serveur MCP', 'Utilise un serveur MCP'],
  ];

  function toolLabel(name, running) {
    const n = String(name || '').toLowerCase();
    for (const [re, done, now] of TOOL_LABELS) if (re.test(n)) return running ? now + '…' : done;
    return (running ? 'Utilise ' : 'A utilisé ') + (name || 'un outil');
  }

  // Appels REST au tableau de bord local (même origine, jeton de session).
  async function api(path, opts) {
    const o = Object.assign({ method: 'GET' }, opts || {});
    const headers = Object.assign({}, o.headers || {});
    if (status.token) headers['X-Hermes-Session-Token'] = status.token;
    let body = o.body;
    if (body != null && typeof body !== 'string') {
      body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), o.timeout || 30000) : null;
    try {
      const res = await fetch(path, { method: o.method, headers, body, cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      let data = null;
      const type = res.headers.get('content-type') || '';
      if (type.includes('json')) { try { data = await res.json(); } catch (_) { data = null; } }
      if (!res.ok) {
        let detail = data && (data.detail || data.error || data.message);
        if (detail && typeof detail !== 'string') detail = JSON.stringify(detail);
        const err = new Error(detail || ('HTTP ' + res.status));
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('Délai dépassé');
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ───────────────────────────── chat state & rendering ─────────────────────────────

  const hubState = { model: '', provider: '', providerName: '' };
  const dictation = { active: false, base: '', discard: false };
  let currentView = 'chat';
  let homePane = 'agent';

  const chat = {
    sid: null,        // live (runtime) session id
    storedId: null,   // stored session id (survives restarts)
    title: '',
    info: null,
    running: false,
    runningSince: 0,
    turnLive: false,  // the backend accepted the current turn (message.start seen)
    turn: null,
    attachments: [],
    completedTurns: new Set(), // turn_id déjà terminés : leurs trames rejouées sont ignorées
    lastCompletedText: '',
    settleTimer: null,
    carry: null,      // identité de flux d'un tour coupé par une question
  };

  const ui = {
    messages: $('#messages'),
    empty: $('#empty'),
    input: $('#input'),
    send: $('#btn-send'),
    mic: $('#btn-mic'),
    composer: $('#composer'),
    chip: $('#model-chip-text'),
    title: $('#title'),
    connDot: $('#conn-dot'),
    connText: $('#conn-text'),
    connPill: $('#conn-pill'),
    banner: $('#banner'),
    attachments: $('#attachments'),
    file: $('#file'),
  };

  const ICON_STEPS = '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>';
  const ICON_CHEV = '<svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const ICON_FAIL = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>';

  function nearBottom() {
    const m = ui.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
  }

  function scrollToBottom(force) {
    if (force || stickToBottom) ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  let stickToBottom = true;
  ui.messages.addEventListener('scroll', () => { stickToBottom = nearBottom(); }, { passive: true });

  function append(node) {
    ui.empty.hidden = true;
    ui.messages.appendChild(node);
    scrollToBottom();
    return node;
  }

  function stopTicker(turn) {
    if (turn && turn.ticker) { clearInterval(turn.ticker); turn.ticker = null; }
  }

  function clearMessages() {
    if (chat.turn) stopTicker(chat.turn);
    for (const child of Array.from(ui.messages.children)) {
      if (child !== ui.empty) child.remove();
    }
    ui.empty.hidden = false;
    chat.turn = null;
    chat.carry = null;
  }

  function setTitle(title) {
    chat.title = title || '';
    ui.title.textContent = chat.title || 'Hermes';
  }

  function currentModel() {
    return (chat.info && chat.info.model) || hubState.model || '';
  }

  function updateChip() {
    const m = shortModel(currentModel());
    ui.chip.textContent = m || 'Modèle';
  }

  function updateSubtitle() {
    const connected = gw.state === 'open';
    ui.connDot.className = 'dot ' + (connected ? (chat.running ? 'busy' : 'ok') : (status.phase === 'error' ? 'err' : 'busy'));
    if (!connected) {
      ui.connText.textContent = status.phase === 'running' ? 'Connexion…' : phaseLabel(status.phase);
    } else if (chat.running) {
      ui.connText.textContent = 'Réflexion… ' + fmtClock(Date.now() - (chat.runningSince || Date.now()));
    } else {
      ui.connText.textContent = shortModel(currentModel()) || 'Connecté';
    }
    // Pastille « Connexion à Hermes… » au-dessus du champ, comme l'app officielle.
    const showPill = status.phase === 'running' && !connected;
    ui.connPill.hidden = !showPill;
    updateChip();
  }

  function hasDraft() {
    return ui.input.value.trim().length > 0 || chat.attachments.length > 0;
  }

  function updateSendButton() {
    const hasText = hasDraft();
    const stopMode = chat.running && !hasText;
    ui.send.classList.toggle('stop', stopMode);
    ui.send.setAttribute('aria-label', stopMode ? 'Arrêter' : 'Envoyer');
    ui.send.hidden = !hasText && !chat.running;
    ui.send.disabled = !gw.open && !stopMode;
    // Micro : bouton principal quand le champ est vide, discret quand il y a du texte.
    ui.mic.hidden = stopMode && !dictation.active;
    ui.mic.classList.toggle('primary', !hasText && !chat.running);
    ui.composer.classList.toggle('expanded', hasText || document.body.classList.contains('typing'));
    ui.input.placeholder = chat.running ? 'Message en file d’attente…' : 'Message Hermes…';
  }

  let clockTimer = null;

  function setRunning(running) {
    if (running && !chat.running) chat.runningSince = Date.now();
    chat.running = running;
    if (!running) chat.turnLive = false;
    clearInterval(clockTimer);
    clockTimer = running ? setInterval(updateSubtitle, 1000) : null;
    updateSendButton();
    updateSubtitle();
  }

  function addUser(text) {
    const wrap = el('div', 'msg user');
    wrap.appendChild(el('div', 'bubble', text));
    stickToBottom = true;
    return append(wrap);
  }

  function addSystem(text) {
    return append(el('div', 'msg system', text));
  }

  function addError(raw) {
    const wrap = el('div', 'msg error');
    wrap.appendChild(errorCard(raw));
    return append(wrap);
  }

  function renderMarkdownInto(node, text, streaming) {
    node.innerHTML = MD.render(text);
    node.classList.toggle('cursor', !!streaming);
  }

  // Un tour = une réponse de l'assistant : UN bloc repliable « A travaillé X s · N outils »
  // (réflexion, étapes, commentaires intermédiaires) puis la bulle de réponse.
  function beginTurn(opts) {
    if (chat.turn) return chat.turn;
    const live = !(opts && opts.history);
    const wrap = el('div', 'msg assistant');
    const work = el('div', 'work');
    const head = el('button', 'work-head');
    head.type = 'button';
    head.innerHTML = '<span class="work-ic">' + ICON_STEPS + '</span><span class="work-label"></span>' + ICON_CHEV;
    const body = el('div', 'work-body');
    body.hidden = true;
    head.onclick = () => {
      const open = body.hidden;
      body.hidden = !open;
      work.classList.toggle('open', open);
    };
    work.appendChild(head);
    work.appendChild(body);
    const bubble = el('div', 'abubble');
    bubble.hidden = true;
    wrap.appendChild(work);
    wrap.appendChild(bubble);
    append(wrap);
    const turn = {
      wrap, work, workBody: body, workLabel: head.querySelector('.work-label'), bubble,
      seg: null, segText: '', lastSeg: null, allText: [],
      reason: null, reasonText: '',
      tools: new Map(), toolCount: 0,
      startedAt: live ? (chat.runningSince || Date.now()) : 0,
      live, done: false, statusText: '', renderQueued: false,
      turnId: null, applied: new Map(), sealedSegs: new Set(),
      ticker: null,
    };
    if (live && chat.carry) {
      // Suite d'un tour coupé par une question : même identité de flux (déduplication).
      turn.turnId = chat.carry.turnId;
      turn.applied = chat.carry.applied;
      turn.sealedSegs = chat.carry.sealedSegs;
    }
    chat.carry = null;
    chat.turn = turn;
    if (live) turn.ticker = setInterval(() => updateWorkLabel(turn), 1000);
    updateWorkLabel(turn);
    return turn;
  }

  function updateWorkLabel(turn) {
    if (!turn) return;
    const tools = turn.toolCount ? ' · ' + plural(turn.toolCount, 'outil', 'outils') : '';
    let label;
    let visible;
    if (!turn.done && turn.live) {
      const secs = Date.now() - turn.startedAt;
      label = (turn.statusText || (turn.toolCount ? 'Travail en cours' : 'Réflexion')) + ' · ' + fmtDuration(secs) + tools;
      visible = true;
    } else if (turn.live && turn.startedAt) {
      label = 'A travaillé ' + fmtDuration((turn.endedAt || Date.now()) - turn.startedAt) + tools;
      visible = true;
    } else {
      label = turn.toolCount ? 'A utilisé ' + plural(turn.toolCount, 'outil', 'outils') : 'Réflexion';
      visible = turn.toolCount > 0 || !!turn.reasonText;
    }
    turn.work.classList.toggle('running', !turn.done && turn.live);
    turn.work.hidden = !visible;
    turn.workLabel.textContent = label;
  }

  function scheduleRender(turn) {
    if (turn.renderQueued) return;
    turn.renderQueued = true;
    requestAnimationFrame(() => {
      turn.renderQueued = false;
      if (turn.seg) renderMarkdownInto(turn.seg, turn.segText, true);
      scrollToBottom();
    });
  }

  function sealSegment(turn) {
    if (turn.seg) {
      if (turn.segText.trim()) {
        renderMarkdownInto(turn.seg, turn.segText, false);
        turn.allText.push(turn.segText);
        turn.lastSeg = turn.seg;
      } else {
        turn.seg.remove();
      }
    }
    turn.seg = null;
    turn.segText = '';
    turn.reason = null;
  }

  function appendText(text) {
    if (!text) return;
    const turn = beginTurn();
    if (!turn.seg) {
      turn.seg = el('div', 'body');
      turn.bubble.appendChild(turn.seg);
      turn.bubble.hidden = false;
    }
    turn.segText += text;
    scheduleRender(turn);
  }

  // Le commentaire écrit juste avant un outil va dans le bloc « A travaillé », pas dans la bulle.
  function moveLastSegmentToWork(turn) {
    const node = turn.lastSeg;
    if (!node || node.parentNode !== turn.bubble) return;
    node.classList.add('work-note');
    turn.workBody.appendChild(node);
    turn.allText.pop();
    turn.lastSeg = null;
    if (!turn.bubble.querySelector('.body')) turn.bubble.hidden = true;
  }

  function appendReasoning(text, replace) {
    if (!text) return;
    const turn = beginTurn();
    if (replace && turn.reasonText) return; // reasoning.available répète ce qui a déjà été diffusé
    if (!turn.reason) {
      const box = el('div', 'work-think');
      box.appendChild(el('div', 'think-label', 'Réflexion'));
      box.appendChild(el('div', 'rtext'));
      turn.workBody.appendChild(box);
      turn.reason = box;
    }
    turn.reasonText += text;
    const rtext = turn.reason.querySelector('.rtext');
    rtext.textContent = (rtext.textContent || '') + text;
    updateWorkLabel(turn);
  }

  function argsPreview(p) {
    if (p.context) return p.context;
    if (p.preview) return p.preview;
    if (p.args_text) return p.args_text;
    if (p.args && typeof p.args === 'object') {
      const vals = Object.values(p.args).filter(v => typeof v === 'string');
      if (vals.length) return vals[0];
    }
    return '';
  }

  function stepRow(name, context, running) {
    const row = el('div', 'step' + (running ? ' running' : ' done'));
    const head = el('button', 'step-head');
    head.type = 'button';
    const ic = el('span', 'step-ic');
    ic.innerHTML = running ? '' : ICON_CHECK;
    head.appendChild(ic);
    head.appendChild(el('span', 'step-name', toolLabel(name, running)));
    head.appendChild(el('span', 'step-ctx', String(context || '').split('\n')[0]));
    head.onclick = () => {
      const pre = row.querySelector('pre');
      if (pre) pre.hidden = !pre.hidden;
    };
    row.appendChild(head);
    row.dataset.tool = name || '';
    return row;
  }

  function setStepResult(row, text, failed) {
    row.classList.remove('running');
    row.classList.add(failed ? 'failed' : 'done');
    row.querySelector('.step-ic').innerHTML = failed ? ICON_FAIL : ICON_CHECK;
    row.querySelector('.step-name').textContent = failed ? 'Échec : ' + toolLabel(row.dataset.tool, false).replace(/^A /, '') : toolLabel(row.dataset.tool, false);
    let pre = row.querySelector('pre');
    if (text) {
      if (!pre) { pre = el('pre'); pre.hidden = true; row.appendChild(pre); }
      pre.textContent = clip(text, 6000);
    }
  }

  function addStep(turn, name, context, running) {
    sealSegment(turn);
    moveLastSegmentToWork(turn);
    const row = stepRow(name, context, running);
    turn.workBody.appendChild(row);
    turn.toolCount += 1;
    updateWorkLabel(turn);
    return row;
  }

  function onToolStart(p) {
    const turn = beginTurn();
    if (p.tool_id && turn.tools.has(p.tool_id)) return; // trame rejouée
    const row = addStep(turn, p.name, argsPreview(p), true);
    if (p.tool_id) turn.tools.set(p.tool_id, row);
    scrollToBottom();
  }

  function onToolComplete(p) {
    const turn = beginTurn();
    let row = p.tool_id ? turn.tools.get(p.tool_id) : null;
    if (row && !row.classList.contains('running')) return; // déjà terminé (trame rejouée)
    if (!row) {
      row = addStep(turn, p.name, argsPreview(p), false);
      if (p.tool_id) turn.tools.set(p.tool_id, row);
    }
    const result = p.summary || p.result_text || (p.result != null ? textOf(p.result) : '');
    const failed = p.result && typeof p.result === 'object' && (p.result.error || p.result.success === false);
    let body = result;
    if (p.inline_diff) body = (body ? body + '\n\n' : '') + p.inline_diff;
    setStepResult(row, body, !!failed);
  }

  function onStatus(p) {
    if (!chat.running || !chat.turn) return;
    chat.turn.statusText = String(p.text || '').slice(0, 60);
    updateWorkLabel(chat.turn);
  }

  // ── déduplication des trames (rejeu après reconnexion, second socket, tentative relancée) ──
  // Le moteur numérote chaque delta (turn_id, segment, offset en unités UTF-16 = longueur JS).
  function dedupeDelta(turn, p) {
    let text = p.text;
    if (typeof text !== 'string' || !text) return '';
    if (p.turn_id && chat.completedTurns.has(p.turn_id)) return '';
    if (p.turn_id && turn.turnId && p.turn_id !== turn.turnId) {
      // Nouveau tour sans message.start reçu : on suit le nouvel identifiant.
      turn.turnId = p.turn_id;
      turn.applied = new Map();
      turn.sealedSegs = new Set();
    }
    if (p.turn_id && !turn.turnId) turn.turnId = p.turn_id;
    if (typeof p.offset !== 'number' || p.segment == null) return text;
    const key = String(p.segment);
    if (turn.sealedSegs.has(key)) return '';
    const applied = turn.applied.get(key) || 0;
    const end = p.offset + text.length;
    if (end <= applied) return '';
    if (p.offset < applied) text = text.slice(applied - p.offset);
    turn.applied.set(key, Math.max(applied, end));
    return text;
  }

  function finishTurnMeta(turn, p) {
    const meta = el('div', 'meta');
    const full = turn.allText.join('\n\n');
    if (full) {
      const copyBtn = el('button', null, 'Copier');
      copyBtn.type = 'button';
      copyBtn.onclick = () => copy(full);
      meta.appendChild(copyBtn);
      if (bridge) {
        const shareBtn = el('button', null, 'Partager');
        shareBtn.type = 'button';
        shareBtn.onclick = () => bridge.shareText(full);
        meta.appendChild(shareBtn);
      }
    }
    const usage = p && p.usage;
    if (usage && (usage.total_tokens || usage.output_tokens)) {
      meta.appendChild(el('span', null, (usage.total_tokens || ((usage.input_tokens || 0) + (usage.output_tokens || 0))) + ' jetons'));
    }
    if (meta.childNodes.length) turn.wrap.appendChild(meta);
  }

  function onComplete(p) {
    p = p || {};
    clearTimeout(chat.settleTimer);
    if (!chat.turn && chat.carry && p.turn_id && p.turn_id === chat.carry.turnId) chat.carry = null;
    if (!chat.turn) {
      // Trame de fin rejouée ou en retard : ne recrée pas une bulle avec le même texte.
      const finalText = textOf(p.text).trim();
      const isError = p.status === 'error';
      if ((p.turn_id && chat.completedTurns.has(p.turn_id)) ||
          (!isError && (!finalText || finalText === chat.lastCompletedText.trim()))) {
        setRunning(false);
        return;
      }
    }
    const turn = beginTurn();
    if (!turn.segText && !turn.allText.length) {
      const finalText = textOf(p.text);
      if (finalText) appendText(frCanned(finalText));
    }
    if (p.reasoning && !turn.reasonText) appendReasoning(textOf(p.reasoning));
    sealSegment(turn);
    // Étapes encore « en cours » : le tour est fini, on arrête leurs indicateurs.
    turn.workBody.querySelectorAll('.step.running').forEach(row => setStepResult(row, '', false));
    turn.done = true;
    turn.endedAt = Date.now();
    stopTicker(turn);
    turn.statusText = '';
    updateWorkLabel(turn);
    if (p.status === 'error') {
      turn.wrap.appendChild(errorCard(p.error || p.failure_reason || p.warning || 'Erreur pendant cette réponse'));
    } else if (p.status === 'interrupted') {
      turn.wrap.appendChild(el('div', 'meta', 'Interrompu'));
    } else if (p.warning) {
      turn.wrap.appendChild(el('div', 'meta warn', frError(p.warning).title === 'Erreur pendant la réponse' ? p.warning : frError(p.warning).title));
    }
    if (!turn.bubble.querySelector('.body')) turn.bubble.hidden = true;
    finishTurnMeta(turn, p);
    if (turn.turnId) chat.completedTurns.add(turn.turnId);
    if (p.turn_id) chat.completedTurns.add(p.turn_id);
    chat.lastCompletedText = turn.allText.join('\n\n') || textOf(p.text) || '';
    chat.turn = null;
    setRunning(false);
    scrollToBottom();
  }

  // Fin de tour sans message.complete (erreur du moteur, session arrêtée, connexion perdue) :
  // le statut « Réflexion… » ne doit jamais rester bloqué.
  function abortTurn(errorText) {
    if (chat.turn) {
      onComplete(errorText ? { status: 'error', error: errorText } : {});
    } else {
      if (errorText) addError(errorText);
      setRunning(false);
    }
  }

  // Rebuild a transcript returned by session.resume / session.create.
  function renderHistory(messages) {
    clearMessages();
    chat.completedTurns.clear();
    chat.lastCompletedText = '';
    const closeTurn = () => {
      const t = chat.turn;
      if (!t) return;
      sealSegment(t);
      t.done = true;
      updateWorkLabel(t);
      if (!t.bubble.querySelector('.body')) t.bubble.hidden = true;
      chat.turn = null;
    };
    for (const m of messages || []) {
      if (!m || m.display_kind === 'hidden') continue;
      const text = m.text != null ? m.text : textOf(m.content);
      if (m.role === 'user') {
        closeTurn();
        if (text) addUser(text);
      } else if (m.role === 'assistant') {
        const turn = beginTurn({ history: true });
        if (m.reasoning) {
          appendReasoning(textOf(m.reasoning));
          turn.reason = null;
        }
        if (text) {
          appendText(frCanned(text));
          sealSegment(turn);
        }
      } else if (m.role === 'tool') {
        const turn = beginTurn({ history: true });
        const row = addStep(turn, m.name, m.context || '', false);
        setStepResult(row, clip(text, 4000), false);
      }
    }
    closeTurn();
    requestAnimationFrame(() => scrollToBottom(true));
  }

  // ───────────────────────────── gateway events ─────────────────────────────

  const GLOBAL_EVENTS = new Set(['gateway.ready', 'skin.changed', 'setup.ready', 'sessions.changed', 'notification.show']);

  gw.eventListeners.add(ev => {
    const type = ev.type;
    const p = ev.payload || {};
    if (!GLOBAL_EVENTS.has(type) && ev.session_id && ev.session_id !== chat.sid) {
      if (type === 'session.title' && p.session_id === chat.storedId) setTitle(p.title);
      return;
    }
    switch (type) {
      case 'message.start': {
        if (p.turn_id && chat.completedTurns.has(p.turn_id)) break;
        clearTimeout(chat.settleTimer);
        if (!chat.running) setRunning(true);
        chat.turnLive = true;
        const turn = beginTurn();
        if (p.turn_id && !turn.turnId) turn.turnId = p.turn_id;
        break;
      }
      case 'message.delta': {
        if (p.turn_id && chat.completedTurns.has(p.turn_id)) break;
        if (typeof p.text !== 'string' || !p.text) break; // null = frontière de segment
        if (!chat.running) setRunning(true);
        const turn = beginTurn();
        const text = dedupeDelta(turn, p);
        if (text) appendText(text);
        break;
      }
      case 'reasoning.delta':
        if (p.turn_id && chat.completedTurns.has(p.turn_id)) break;
        appendReasoning(textOf(p.text));
        break;
      case 'reasoning.available':
        appendReasoning(textOf(p.text), true);
        break;
      case 'thinking.delta':
        // Animation d'attente du moteur (kaomoji) : jamais dans la transcription.
        break;
      case 'message.interim': {
        if (p.turn_id && chat.completedTurns.has(p.turn_id)) break;
        const turn = beginTurn();
        const key = p.segment != null ? String(p.segment) : null;
        if (key != null && turn.sealedSegs.has(key)) break;
        if (!p.already_streamed && p.text && !turn.segText) appendText(textOf(p.text));
        if (key != null) turn.sealedSegs.add(key);
        sealSegment(turn);
        break;
      }
      case 'message.complete':
        onComplete(p);
        break;
      case 'tool.start':
        onToolStart(p);
        break;
      case 'tool.complete':
        onToolComplete(p);
        break;
      case 'tool.generating':
        onStatus({ text: 'Prépare ' + (p.name || 'un outil') });
        break;
      case 'status.update':
        onStatus(p);
        break;
      case 'error':
        if (chat.running || chat.turn) abortTurn(p.message || 'Une erreur est survenue');
        else addError(p.message || 'Une erreur est survenue');
        break;
      case 'notice':
        if (p.message) addSystem(p.message);
        break;
      case 'notification.show':
        if (p.text && (p.level === 'error' || p.level === 'warn')) toast(frError(p.text).title);
        break;
      case 'session.title':
        if (!p.session_id || p.session_id === chat.storedId) setTitle(p.title);
        break;
      case 'session.info':
        chat.info = Object.assign({}, chat.info || {}, p);
        if (p.title) setTitle(p.title);
        if (typeof p.running === 'boolean' && !p.running && chat.running && chat.turnLive) {
          // Le moteur dit que le tour est fini : on laisse 1,5 s à un message.complete tardif.
          clearTimeout(chat.settleTimer);
          chat.settleTimer = setTimeout(() => {
            if (chat.running || chat.turn) abortTurn('');
          }, 1500);
        }
        updateSubtitle();
        break;
      case 'request.cancel':
        cancelAsk(p.id);
        break;
      case 'sessions.changed':
        if (homePane === 'chats' && currentView === 'home') loadSessions();
        break;
      default:
        break;
    }
  });
  // ───────────────────────────── server → client questions ─────────────────────────────

  const asks = new Map();

  function cancelAsk(id) {
    const card = asks.get(id);
    if (card) {
      card.classList.add('done');
      asks.delete(id);
      settleAsk(card);
    }
  }

  // Une question en attente s'affiche en bas du fil ; une fois répondue, elle rejoint le bloc
  // « A travaillé » de son tour, pour garder un seul bloc par réponse.
  function placeAsk(card) {
    if (chat.turn) {
      sealSegment(chat.turn);
      card.turnRef = chat.turn;
    }
    append(card);
    scrollToBottom(true);
  }

  function settleAsk(card) {
    const turn = card.turnRef;
    card.turnRef = null;
    if (turn && turn.workBody && turn.wrap.isConnected) {
      card.classList.add('in-work');
      turn.workBody.appendChild(card);
    }
  }

  function askCard(req, title) {
    const card = el('div', 'ask');
    card.appendChild(el('div', 'ask-title', title));
    asks.set(req.id, card);
    return card;
  }

  function finishAsk(req, card, result, label) {
    gw.respond(req.id, result);
    card.classList.add('done');
    if (label) card.appendChild(el('div', 'muted', label));
    asks.delete(req.id);
    settleAsk(card);
  }

  const APPROVAL_LABELS = { once: 'Autoriser une fois', session: 'Autoriser pour cette conversation', always: 'Toujours autoriser', deny: 'Refuser' };

  function showApproval(req) {
    const p = req.params;
    const card = askCard(req, 'Ta confirmation est nécessaire');
    if (p.description) card.appendChild(el('div', null, p.description));
    if (p.command) card.appendChild(el('pre', null, p.command));
    const choices = el('div', 'choices');
    const offered = (p.choices && p.choices.length) ? p.choices : ['once', 'deny'];
    for (const choice of offered) {
      const b = el('button', choice === 'once' ? 'primary' : '', APPROVAL_LABELS[choice] || choice);
      b.type = 'button';
      b.onclick = () => finishAsk(req, card, { choice }, 'Choisi : ' + (APPROVAL_LABELS[choice] || choice));
      choices.appendChild(b);
    }
    card.appendChild(choices);
    placeAsk(card);
  }

  function questionBlock(q, onAnswer) {
    const box = el('div');
    box.appendChild(el('div', null, q.question));
    const input = document.createElement('textarea');
    input.rows = 2;
    input.placeholder = 'Ta réponse…';
    const choices = el('div', 'choices');
    for (const c of q.choices || []) {
      const b = el('button', null, c);
      b.type = 'button';
      b.onclick = () => {
        if (q.multi_select) {
          b.classList.toggle('primary');
        } else {
          onAnswer(c);
        }
      };
      choices.appendChild(b);
    }
    box.appendChild(choices);
    box.appendChild(input);
    box.value = () => {
      if (q.multi_select) {
        const picked = Array.from(choices.querySelectorAll('button.primary')).map(b => b.textContent);
        if (picked.length) return picked.join(', ');
      }
      return input.value.trim();
    };
    return box;
  }

  function showClarify(req) {
    const p = req.params;
    const card = askCard(req, 'Hermes demande une confirmation');
    const actions = el('div', 'choices');
    if (Array.isArray(p.questions) && p.questions.length) {
      const blocks = p.questions.map(q => {
        const block = questionBlock(q, () => {});
        card.appendChild(block);
        return { q, block };
      });
      const submit = el('button', 'primary', 'Envoyer');
      submit.type = 'button';
      submit.onclick = () => {
        const answers = {};
        for (const { q, block } of blocks) answers[q.qid] = block.value();
        finishAsk(req, card, { answers }, 'Répondu');
      };
      actions.appendChild(submit);
    } else {
      const block = questionBlock({ question: p.question || '', choices: p.choices, multi_select: p.multi_select },
        answer => finishAsk(req, card, { answer }, 'Répondu : ' + answer));
      card.appendChild(block);
      const submit = el('button', 'primary', 'Répondre');
      submit.type = 'button';
      submit.onclick = () => finishAsk(req, card, { answer: block.value() }, 'Répondu');
      actions.appendChild(submit);
    }
    const skip = el('button', null, 'Ignorer');
    skip.type = 'button';
    skip.onclick = () => finishAsk(req, card, Array.isArray(p.questions) ? {} : { answer: '' }, 'Ignoré');
    actions.appendChild(skip);
    card.appendChild(actions);
    placeAsk(card);
  }

  function showValuePrompt(req, title, hint, secret) {
    const card = askCard(req, title);
    if (hint) card.appendChild(el('div', null, hint));
    const input = document.createElement('input');
    input.type = secret ? 'password' : 'text';
    card.appendChild(input);
    const actions = el('div', 'choices');
    const ok = el('button', 'primary', 'Envoyer');
    ok.type = 'button';
    ok.onclick = () => finishAsk(req, card, { value: input.value }, 'Envoyé');
    const skip = el('button', null, 'Ignorer');
    skip.type = 'button';
    skip.onclick = () => finishAsk(req, card, { value: '' }, 'Ignoré');
    actions.appendChild(ok);
    actions.appendChild(skip);
    card.appendChild(actions);
    placeAsk(card);
  }

  gw.requestHandler = req => {
    const p = req.params || {};
    switch (req.method) {
      case 'approval':
        showApproval(req);
        return true;
      case 'clarify':
        showClarify(req);
        return true;
      case 'secret':
        showValuePrompt(req, 'À renseigner : ' + (p.env_var || 'clé'), p.prompt, true);
        return true;
      case 'vault.unlock_prompt':
        showValuePrompt(req, 'Déverrouiller ' + (p.display_name || p.backend || 'coffre'), '', true);
        return true;
      case 'vault.code':
        showValuePrompt(req, 'Code de vérification requis', p.prompt || '', false);
        return true;
      case 'vault.save_login':
        gw.respond(req.id, { value: '' });
        return true;
      case 'sudo':
        addSystem('Pas de sudo sur Android : commande administrateur ignorée.');
        gw.respond(req.id, { value: '' });
        return true;
      // Desktop-only bridges (terminal pane, preview pane, window capture, guided tour).
      case 'terminal.read':
      case 'preview.read':
      case 'window.read':
      case 'preview.act':
      case 'tour':
        gw.respond(req.id, { value: '' });
        return true;
      default:
        return false;
    }
  };


  // ───────────────────────────── sessions ─────────────────────────────

  function rememberSession() {
    try {
      if (chat.storedId) localStorage.setItem(LAST_SESSION_KEY, chat.storedId);
      else localStorage.removeItem(LAST_SESSION_KEY);
    } catch (_) { /* storage may be unavailable */ }
  }

  function lastSession() {
    try { return localStorage.getItem(LAST_SESSION_KEY); } catch (_) { return null; }
  }

  function adoptSnapshot(r, fallbackStoredId) {
    chat.sid = r.session_id;
    chat.storedId = r.stored_session_id || (r.info && r.info.stored_session_id) || fallbackStoredId || null;
    chat.info = r.info || null;
    setTitle((r.info && r.info.title) || '');
    rememberSession();
    updateSubtitle();
  }

  async function ensureSession() {
    if (chat.sid) return chat.sid;
    const r = await gw.request('session.create', {}, 60000);
    adoptSnapshot(r);
    return chat.sid;
  }

  async function openSession(storedId, quiet) {
    try {
      const r = await gw.request('session.resume', { session_id: storedId }, 90000);
      adoptSnapshot(r, storedId);
      renderHistory(r.messages);
      setRunning(!!r.running);
      if (r.running) chat.turnLive = true;
      for (const open of r.open_requests || []) {
        gw.requestHandler({ id: open.id, method: open.method, params: open.params || {} });
      }
      return true;
    } catch (e) {
      if (!quiet) toast('Impossible d’ouvrir la conversation : ' + frError(e.message).title);
      return false;
    }
  }

  function newChat(focus) {
    const old = chat.sid;
    if (old && !chat.running) {
      gw.request('session.close', { session_id: old }, 10000).catch(() => {});
    }
    chat.sid = null;
    chat.storedId = null;
    chat.info = null;
    setTitle('');
    rememberSession();
    clearMessages();
    setRunning(false);
    showView('chat');
    if (focus) ui.input.focus();
  }

  async function loadSessions() {
    const list = $('#session-list');
    if (!gw.open) {
      list.innerHTML = '';
      list.appendChild(el('div', 'sess-empty', 'Hermes non connecté'));
      return;
    }
    try {
      const r = await gw.request('session.list', { limit: 80 }, 20000);
      list.innerHTML = '';
      const rows = (r && r.sessions) || [];
      if (!rows.length) list.appendChild(el('div', 'sess-empty', 'Aucune conversation'));
      for (const row of rows) {
        const b = el('button', 'sess' + (row.id === chat.storedId ? ' active' : ''));
        b.type = 'button';
        b.appendChild(el('div', 'st', row.title || row.preview || 'Conversation sans titre'));
        b.appendChild(el('div', 'sp', [relTime(row.last_active || row.started_at), row.title ? row.preview : ''].filter(Boolean).join(' · ')));
        b.onclick = async () => {
          showView('chat');
          if (row.id !== chat.storedId) await openSession(row.id);
        };
        list.appendChild(b);
      }
    } catch (e) {
      list.innerHTML = '';
      list.appendChild(el('div', 'sess-empty', 'Chargement impossible : ' + frError(e.message).title));
    }
  }

  // ───────────────────────────── bottom sheet ─────────────────────────────

  const sheet = { root: $('#sheet'), title: $('#sheet-title'), body: $('#sheet-body'), onClose: null };

  function openSheet(title, onClose) {
    if (sheet.onClose) { const fn = sheet.onClose; sheet.onClose = null; try { fn(); } catch (_) { /* ignore */ } }
    sheet.title.textContent = title || '';
    sheet.body.innerHTML = '';
    sheet.onClose = onClose || null;
    sheet.root.hidden = false;
    return sheet.body;
  }

  function closeSheet() {
    if (sheet.root.hidden) return false;
    sheet.root.hidden = true;
    sheet.body.innerHTML = '';
    if (sheet.onClose) { const fn = sheet.onClose; sheet.onClose = null; try { fn(); } catch (_) { /* ignore */ } }
    return true;
  }

  sheet.root.querySelectorAll('[data-close]').forEach(b => { b.onclick = closeSheet; });

  function sheetItem(label, icon, onClick, opts) {
    const b = el('button', 'sheet-item' + (opts && opts.cls ? ' ' + opts.cls : ''));
    b.type = 'button';
    if (icon) { const ic = el('span', 'si-ic'); ic.innerHTML = icon; b.appendChild(ic); }
    const lab = el('span', 'si-label', label);
    if (opts && opts.sub) lab.appendChild(el('small', null, opts.sub));
    b.appendChild(lab);
    if (opts && opts.right) b.appendChild(el('span', 'si-right', opts.right));
    if (opts && opts.disabled) b.disabled = true;
    b.onclick = onClick;
    return b;
  }

  // ───────────────────────────── model picker ─────────────────────────────

  async function fetchModelOptions(refresh) {
    const params = { explicit_only: true };
    if (chat.sid) params.session_id = chat.sid;
    if (refresh) params.refresh = true;
    const r = await gw.request('model.options', params, refresh ? 60000 : 30000);
    if (r && !((r.providers || []).some(p => (p.models || []).length))) {
      // Rien d'« explicite » : on montre aussi les fournisseurs détectés (clé dans .env, etc.).
      try {
        const all = await gw.request('model.options', Object.assign({}, params, { explicit_only: false }), 30000);
        if (all && (all.providers || []).some(p => (p.models || []).length)) return all;
      } catch (_) { /* garde la première réponse */ }
    }
    return r;
  }

  function providerLabel(r, slug) {
    const row = ((r && r.providers) || []).find(p => p.slug === slug || p.name === slug || (p.aliases || []).includes(slug));
    return row ? (row.name || row.slug) : (slug || '');
  }

  async function switchModel(model, provider, makeDefault) {
    const value = model + (provider ? ' --provider ' + provider : '') + (makeDefault ? ' --global' : '');
    const sid = await ensureSession();
    let res = await gw.request('config.set', { session_id: sid, key: 'model', value }, 90000);
    if (res && res.confirm_required) {
      const msg = res.confirm_message || 'Ce modèle est coûteux. Continuer ?';
      if (!window.confirm(msg)) return false;
      res = await gw.request('config.set', { session_id: sid, key: 'model', value, confirm_expensive_model: true }, 90000);
    }
    chat.info = Object.assign({}, chat.info || {}, { model, provider });
    hubState.model = model;
    hubState.provider = provider;
    updateSubtitle();
    if (res && res.warning) toast(frError(res.warning).title === 'Erreur pendant la réponse' ? res.warning : frError(res.warning).title);
    else if (res && res.deferred) toast('Modèle appliqué au prochain message : ' + shortModel(model));
    else toast('Modèle : ' + shortModel(model));
    document.dispatchEvent(new CustomEvent('hermes:model', { detail: { model, provider } }));
    return true;
  }

  async function openModelPicker() {
    const body = openSheet('Modèle');
    if (!gw.open) {
      body.appendChild(el('p', 'sheet-note', 'Hermes n’est pas encore connecté.'));
      return;
    }
    const cur = el('div', 'model-current');
    body.appendChild(cur);
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'sheet-search';
    search.placeholder = 'Rechercher un modèle…';
    body.appendChild(search);
    const keep = el('label', 'switch-row compact');
    keep.innerHTML = '<span>Garder comme modèle par défaut<small>Sinon, le choix vaut pour cette conversation</small></span><input type="checkbox">';
    body.appendChild(keep);
    const list = el('div', 'model-list');
    list.appendChild(el('p', 'sheet-note', 'Chargement des modèles…'));
    body.appendChild(list);
    const foot = el('div', 'sheet-foot');
    foot.appendChild(sheetItem('Fournisseurs et modèles', null, () => { closeSheet(); openConsole('/models'); }));
    foot.appendChild(sheetItem('Clés et variables', null, () => { closeSheet(); openConsole('/env'); }));
    body.appendChild(foot);

    let data;
    try {
      data = await fetchModelOptions(false);
    } catch (e) {
      list.innerHTML = '';
      list.appendChild(errorCard(e.message));
      return;
    }
    const curModel = currentModel() || data.model || '';
    const curProvider = (chat.info && chat.info.provider) || data.provider || '';
    cur.innerHTML = '';
    cur.appendChild(el('div', 'mc-name', shortModel(curModel) || 'Aucun modèle'));
    cur.appendChild(el('div', 'mc-prov', providerLabel(data, curProvider) || 'Fournisseur inconnu'));

    const render = () => {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      const providers = (data.providers || []).filter(p => (p.models || []).length);
      if (!providers.length) {
        list.appendChild(el('p', 'sheet-note', 'Aucun fournisseur configuré. Ajoute une clé API dans « Clés et variables ».'));
        return;
      }
      let shown = 0;
      for (const p of providers) {
        const models = (p.models || []).filter(m => !q || String(m).toLowerCase().includes(q) || String(p.name || '').toLowerCase().includes(q));
        if (!models.length) continue;
        const group = el('div', 'model-group');
        const isCur = p.is_current || p.slug === curProvider;
        group.appendChild(el('div', 'mg-title', (p.name || p.slug) + (isCur ? ' · actuel' : '')));
        const max = q ? 80 : 40;
        for (const m of models.slice(0, max)) {
          const active = isCur && m === curModel;
          const b = sheetItem(shortModel(m), active ? ICON_CHECK : null, async () => {
            b.disabled = true;
            try {
              const ok = await switchModel(m, p.slug, keep.querySelector('input').checked);
              if (ok) closeSheet();
            } catch (e) {
              toast(frError(e.message).title);
              b.disabled = false;
            }
          }, { cls: active ? 'active' : '', sub: m !== shortModel(m) ? m : '' });
          group.appendChild(b);
          shown++;
        }
        if (models.length > max) group.appendChild(el('p', 'sheet-note', (models.length - max) + ' autres modèles : affine la recherche.'));
        list.appendChild(group);
      }
      if (!shown) list.appendChild(el('p', 'sheet-note', 'Aucun modèle ne correspond.'));
    };
    search.addEventListener('input', render);
    render();
  }

  // ───────────────────────────── menu « … » ─────────────────────────────

  const IC = {
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    chip: '<svg viewBox="0 0 24 24"><path d="M7 7h10v10H7zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><path d="M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 6h6l2 2h10v11H3z"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M3 6h6l2 2h10v11H3zM12 11l1 2.2 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3z"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
    compress: '<svg viewBox="0 0 24 24"><path d="M4 9h16M4 15h16M12 3v4l-2-2M12 7l2-2M12 21v-4l-2 2M12 17l2 2"/></svg>',
    grid: '<svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>',
  };

  function openChatMenu() {
    const body = openSheet('Conversation');
    const native = window.HermesApp && window.HermesApp.native || {};
    body.appendChild(sheetItem('Nouvelle conversation', IC.plus, () => { closeSheet(); newChat(true); }));
    body.appendChild(sheetItem('Changer de modèle', IC.chip, () => openModelPicker(), { right: shortModel(currentModel()) }));
    body.appendChild(sheetItem('Compresser la conversation', IC.compress, () => { closeSheet(); compressSession(); }, { disabled: !chat.sid || chat.running }));
    body.appendChild(sheetItem('Copier la conversation', IC.copy, () => { closeSheet(); copy(transcriptText()); }, { disabled: !chat.sid }));
    body.appendChild(el('div', 'sheet-sep'));
    body.appendChild(sheetItem('Routines', IC.clock, () => { closeSheet(); openConsole('/cron'); }));
    body.appendChild(sheetItem('Projets', IC.star, () => { if (native.projects) native.projects(); }));
    body.appendChild(sheetItem('Fichiers', IC.folder, () => { closeSheet(); openConsole('/files'); }));
    body.appendChild(sheetItem('Conversations', IC.list, () => { closeSheet(); showHome('chats'); }));
    body.appendChild(el('div', 'sheet-sep'));
    body.appendChild(sheetItem('Tableau de bord', IC.grid, () => { closeSheet(); openConsole('/'); }));
    body.appendChild(sheetItem('Réglages', IC.gear, () => { closeSheet(); showView('status'); }));
  }

  async function compressSession() {
    if (!chat.sid) return;
    toast('Compression de la conversation…');
    try {
      await gw.request('session.compress', { session_id: chat.sid }, 180000);
      toast('Conversation compressée');
    } catch (e) {
      toast(frError(e.message).title);
    }
  }

  function transcriptText() {
    const out = [];
    ui.messages.querySelectorAll('.msg').forEach(m => {
      if (m.classList.contains('user')) out.push('Moi : ' + m.textContent.trim());
      else if (m.classList.contains('assistant')) {
        const t = Array.from(m.querySelectorAll('.abubble .body')).map(b => b.innerText.trim()).join('\n\n');
        if (t) out.push('Hermes : ' + t);
      }
    });
    return out.join('\n\n');
  }

  // ───────────────────────────── composer ─────────────────────────────

  function renderAttachments() {
    ui.attachments.innerHTML = '';
    chat.attachments.forEach((file, i) => {
      const chip = el('div', 'chip');
      chip.appendChild(el('span', null, file.name));
      const x = el('button', null, '×');
      x.type = 'button';
      x.onclick = () => {
        chat.attachments.splice(i, 1);
        renderAttachments();
        updateSendButton();
      };
      chip.appendChild(x);
      ui.attachments.appendChild(chip);
    });
  }

  async function uploadAttachments(sid) {
    const refs = [];
    for (const file of chat.attachments) {
      const data = await fileToBase64(file);
      const type = file.type || '';
      if (type.startsWith('image/')) {
        await gw.request('image.attach_bytes', { session_id: sid, content_base64: data.base64, filename: file.name }, 60000);
      } else if (type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        await gw.request('pdf.attach', { session_id: sid, content_base64: data.base64, filename: file.name }, 120000);
      } else {
        const r = await gw.request('file.attach', { session_id: sid, data_url: data.dataUrl, name: file.name }, 60000);
        if (r && r.ref_text) refs.push(r.ref_text);
      }
    }
    return refs;
  }

  function interrupt() {
    if (!chat.sid) { setRunning(false); return; }
    gw.request('session.interrupt', { session_id: chat.sid }, 15000).catch(e => {
      toast(frError(e.message).title);
      abortTurn('');
    });
    // Si le moteur ne confirme pas l'arrêt, on libère l'interface quand même.
    clearTimeout(chat.settleTimer);
    chat.settleTimer = setTimeout(() => { if (chat.running) abortTurn(''); }, 8000);
  }

  async function submit(textOverride) {
    if (dictation.active && bridge && bridge.stopDictation) {
      dictation.discard = true; // le texte déjà envoyé ne doit pas revenir dans le champ
      bridge.stopDictation();
    }
    const text = (textOverride != null ? textOverride : ui.input.value).trim();
    const files = chat.attachments.slice();
    if (!text && !files.length) {
      if (chat.running) interrupt();
      return;
    }
    if (!gw.open) {
      toast('Hermes n’est pas encore connecté');
      return;
    }
    showView('chat');
    if (textOverride == null) {
      ui.input.value = '';
      dictation.base = '';
      autosize();
    }
    chat.attachments = [];
    renderAttachments();
    const shown = files.length ? (text + (text ? '\n' : '') + files.map(f => '📎 ' + f.name).join('\n')) : text;
    addUser(shown);
    try {
      const sid = await ensureSession();
      const refs = files.length ? await uploadAttachments(sid) : [];
      const finalText = [text].concat(refs).filter(Boolean).join('\n\n') || 'Voir la pièce jointe';
      if (!chat.running) setRunning(true);
      const r = await gw.request('prompt.submit', { session_id: sid, text: finalText }, 60000);
      if (r && r.status === 'queued') addSystem('En file d’attente, traité après la réponse en cours');
      else if (r && (r.status === 'steered' || r.status === 'redirected')) addSystem('Message transmis à la tâche en cours');
    } catch (e) {
      abortTurn('');
      addError('Échec de l’envoi : ' + e.message);
    }
  }

  function autosize() {
    ui.input.style.height = 'auto';
    ui.input.style.height = Math.min(ui.input.scrollHeight, window.innerHeight * 0.4) + 'px';
    updateSendButton();
  }

  ui.composer.addEventListener('submit', ev => {
    ev.preventDefault();
    submit();
  });
  ui.input.addEventListener('input', autosize);
  ui.input.addEventListener('focus', () => { document.body.classList.add('typing'); updateSendButton(); });
  ui.input.addEventListener('blur', () => setTimeout(() => { document.body.classList.remove('typing'); updateSendButton(); }, 150));
  $('#btn-attach').onclick = () => ui.file.click();
  $('#model-chip').onclick = openModelPicker;
  $('#chat-head').onclick = openModelPicker;
  $('#btn-menu').onclick = openChatMenu;
  ui.file.addEventListener('change', () => {
    for (const f of Array.from(ui.file.files || [])) {
      if (f.size > 25 * 1024 * 1024) { toast(f.name + ' dépasse 25 Mo'); continue; }
      chat.attachments.push(f);
    }
    ui.file.value = '';
    renderAttachments();
    updateSendButton();
  });
  document.querySelectorAll('#empty [data-prompt]').forEach(b => {
    b.addEventListener('click', () => submit(b.getAttribute('data-prompt')));
  });
  ui.messages.addEventListener('click', ev => {
    const btn = ev.target.closest && ev.target.closest('.code .copy');
    if (btn) {
      const code = btn.closest('.code').querySelector('code');
      copy(code ? code.textContent : '');
    }
  });

  // ── dictée vocale (SpeechRecognizer Android, fr-FR) ──
  function joinDictation(base, text) {
    const b = String(base || '');
    const t = String(text || '').trim();
    if (!t) return b;
    return b && !/\s$/.test(b) ? b + ' ' + t : b + t;
  }

  ui.mic.addEventListener('click', () => {
    if (!bridge || typeof bridge.startDictation !== 'function') {
      toast('Dictée indisponible sur cet appareil');
      return;
    }
    if (dictation.active) {
      bridge.stopDictation();
      return;
    }
    dictation.base = ui.input.value;
    bridge.startDictation('fr-FR');
  });

  // Appelé par MainActivity : { type: start|partial|final|error|end, text?, message? }
  window.hermesDictation = function (evt) {
    let e = evt;
    if (typeof e === 'string') { try { e = JSON.parse(e); } catch (_) { e = {}; } }
    e = e || {};
    switch (e.type) {
      case 'start':
        dictation.active = true;
        ui.mic.classList.add('rec');
        ui.mic.setAttribute('aria-label', 'Arrêter la dictée');
        break;
      case 'partial':
        if (dictation.discard) break;
        ui.input.value = joinDictation(dictation.base, e.text);
        autosize();
        break;
      case 'final':
        if (dictation.discard) break;
        ui.input.value = joinDictation(dictation.base, e.text);
        dictation.base = ui.input.value;
        autosize();
        break;
      case 'error':
        if (e.message) toast(e.message);
        // falls through
      case 'end':
        dictation.active = false;
        dictation.discard = false;
        ui.mic.classList.remove('rec');
        ui.mic.setAttribute('aria-label', 'Dicter');
        updateSendButton();
        break;
      default:
        break;
    }
  };

  // ───────────────────────────── connection management ─────────────────────────────

  let reconnectTimer = null;
  let reconnectDelay = 800;
  let connectedToken = '';
  let setupChecked = false;

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureConnected();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  }

  async function ensureConnected() {
    if (status.phase !== 'running' || !status.token) return;
    if (gw.open && connectedToken === status.token) return;
    if (gw.state === 'connecting') return;
    if (gw.open) gw.close();
    const url = 'ws://' + location.host + '/api/ws?token=' + encodeURIComponent(status.token);
    try {
      await gw.connect(url);
      connectedToken = status.token;
      reconnectDelay = 800;
      await onConnected();
    } catch (e) {
      console.warn('gateway connect failed', e);
      scheduleReconnect();
    }
  }

  async function onConnected() {
    console.log('HERMES_GATEWAY_CONNECTED');
    updateSubtitle();
    updateSendButton();
    const target = chat.storedId || lastSession();
    if (target) {
      const ok = await openSession(target, true);
      if (!ok) newChat(false);
    }
    if (!setupChecked) {
      setupChecked = true;
      checkSetup();
      syncConsoleTheme(false);
    }
    document.dispatchEvent(new CustomEvent('hermes:connected'));
  }

  // ── themes ──
  // The app ships matching console themes (android-<name>) in HERMES_HOME/dashboard-themes.
  // We only steer the console's theme while it is one we set (or a stock default), so a
  // theme the user picked inside the console wins.
  function currentTheme() {
    return 'nuit';
  }

  async function syncConsoleTheme(force) {
    if (status.phase !== 'running' || !status.token) return;
    const want = 'android-' + currentTheme();
    try {
      const data = await api('/api/dashboard/themes');
      if (!data) return;
      const active = data.active || 'default';
      const ours = active === 'default' || active === 'nous-blue' || active.startsWith('android-');
      if (active === want || (!ours && !force)) return;
      if (!(data.themes || []).some(t => t.name === want)) return;
      await api('/api/dashboard/theme', { method: 'PUT', body: { name: want } });
      localStorage.setItem('hermes-dashboard-theme', want);
      const frame = $('#console-frame');
      if (frame.getAttribute('src')) frame.contentWindow.location.reload();
    } catch (_) { /* not critical */ }
  }

  async function checkSetup() {
    try {
      const r = await gw.request('setup.status', {}, 20000);
      console.log('HERMES_SETUP_STATUS provider_configured=' + (r && r.provider_configured));
      if (r && r.provider_configured === false) {
        ui.banner.innerHTML = '';
        const text = el('div', 'banner-text');
        text.appendChild(el('strong', null, 'Aucun modèle configuré'));
        text.appendChild(el('span', null, 'Ajoute un fournisseur et ta clé API pour commencer à discuter'));
        ui.banner.appendChild(text);
        const go = el('button', 'primary', 'Configurer');
        go.type = 'button';
        go.onclick = () => { openConsole('/env'); ui.banner.hidden = true; };
        ui.banner.appendChild(go);
        const x = el('button', 'banner-close', '×');
        x.type = 'button';
        x.setAttribute('aria-label', 'Fermer');
        x.onclick = () => { ui.banner.hidden = true; };
        ui.banner.appendChild(x);
        ui.banner.hidden = false;
      } else {
        ui.banner.hidden = true;
      }
    } catch (_) { /* older backends: skip the hint */ }
  }

  gw.stateListeners.add(state => {
    updateSubtitle();
    updateSendButton();
    if (state === 'closed') {
      // Connexion perdue en plein tour : on ne laisse pas « Réflexion… » affiché.
      // À la reconnexion, session.resume réaffiche l'état réel de la conversation.
      if (chat.running || chat.turn) abortTurn('Connexion à Hermes perdue');
      if (status.phase === 'running') scheduleReconnect();
    }
  });

  // ───────────────────────────── boot overlay & status page ─────────────────────────────

  function phaseLabel(phase) {
    return ({
      idle: 'Non démarré',
      installing: 'Installation',
      starting: 'Démarrage',
      running: 'Actif',
      stopping: 'Arrêt',
      stopped: 'Arrêté',
      error: 'Erreur',
    })[phase] || phase || '—';
  }

  const boot = {
    root: $('#boot'),
    title: $('#boot-title'),
    text: $('#boot-text'),
    progress: $('#boot-progress'),
    action: $('#boot-action'),
  };

  function setProgress(node, value) {
    if (value >= 0) {
      node.classList.remove('indeterminate');
      node.firstElementChild.style.width = Math.round(value * 100) + '%';
    } else {
      node.classList.add('indeterminate');
      node.firstElementChild.style.width = '';
    }
  }

  function renderBoot() {
    const phase = status.phase;
    if (phase === 'running' || currentView === 'status') {
      boot.root.hidden = true;
      return;
    }
    boot.root.hidden = false;
    boot.action.hidden = true;
    $('#boot-logs').hidden = phase !== 'error';
    boot.progress.hidden = false;
    if (phase === 'installing') {
      boot.title.textContent = 'Premier lancement : installation du moteur';
      boot.text.textContent = (status.message || '') + ' (1 à 3 minutes, une seule fois)';
      setProgress(boot.progress, status.progress);
    } else if (phase === 'starting') {
      boot.title.textContent = 'Démarrage de Hermes';
      boot.text.textContent = 'Le premier démarrage prépare Python, cela peut prendre une ou deux minutes';
      setProgress(boot.progress, -1);
    } else if (phase === 'error') {
      boot.title.textContent = 'Hermes ne tourne pas correctement';
      boot.text.textContent = status.message || '';
      boot.progress.hidden = true;
      boot.action.hidden = false;
      boot.action.textContent = 'Redémarrer';
      boot.action.onclick = () => bridge && bridge.restart();
    } else {
      boot.title.textContent = phase === 'stopping' ? 'Arrêt…' : 'Hermes arrêté';
      boot.text.textContent = 'L’agent tourne localement sur ce téléphone';
      boot.progress.hidden = phase !== 'stopping';
      setProgress(boot.progress, -1);
      if (phase !== 'stopping') {
        boot.action.hidden = false;
        boot.action.textContent = 'Démarrer Hermes';
        boot.action.onclick = () => bridge && bridge.start();
      }
    }
  }

  function renderStatusPage() {
    $('#st-phase').textContent = phaseLabel(status.phase);
    const dot = $('#st-dot');
    dot.className = 'dot big-dot ' + (status.phase === 'running' ? 'ok' : status.phase === 'error' ? 'err' : 'busy');
    $('#st-message').textContent = status.message && status.message !== phaseLabel(status.phase) ? status.message : '';
    const prog = $('#st-progress');
    prog.hidden = status.phase !== 'installing';
    if (!prog.hidden) setProgress(prog, status.progress);
    $('#st-addr').textContent = status.port ? '127.0.0.1:' + status.port : '—';
    $('#st-pid').textContent = status.pid ? String(status.pid) : '—';
    $('#st-payload').textContent = status.payloadId || '—';
    $('#st-app').textContent = status.appVersion || '—';
    $('#st-device').textContent = bridge ? bridge.deviceInfo() : navigator.userAgent;
    const running = status.phase === 'running' || status.phase === 'starting' || status.phase === 'installing';
    $('#btn-start').disabled = running;
    $('#btn-stop').disabled = !running;
    if (bridge) {
      $('#opt-awake').checked = bridge.keepAwake();
      $('#opt-autostart').checked = bridge.autoStart();
      const optimized = bridge.batteryOptimized();
      $('#battery-text').textContent = optimized ? 'Limitée par le système : Hermes peut être mis en pause en arrière-plan' : 'Désactivée : fonctionnement en arrière-plan plus stable';
      $('#btn-battery').hidden = !optimized;
    }
  }

  async function refreshLog() {
    try {
      const r = await (await fetch('/__android/log.json?n=500', { cache: 'no-store' })).json();
      const pre = $('#log');
      const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
      pre.textContent = (r.lines || []).join('\n');
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    } catch (_) { /* ignore */ }
  }

  let lastPhase = '';

  async function pollStatus() {
    try {
      status = await fetchStatus();
    } catch (_) {
      status = { phase: 'idle' };
    }
    if (status.phase !== lastPhase) {
      lastPhase = status.phase;
      if (status.phase !== 'running' && gw.open) gw.close();
    }
    renderBoot();
    if (currentView === 'status') renderStatusPage();
    if (currentView === 'console') syncConsole();
    updateSubtitle();
    if (status.phase === 'running') ensureConnected();
    const delay = status.phase === 'running' ? 3000 : 800;
    clearTimeout(pollStatus.timer);
    pollStatus.timer = setTimeout(pollStatus, delay);
  }

  // ───────────────────────────── views & navigation ─────────────────────────────

  let logTimer = null;
  const navStack = [];

  const CONSOLE_TITLES = {
    '/': 'Tableau de bord', '/skills': 'Compétences', '/plugins': 'Plugins', '/mcp': 'MCP', '/channels': 'Connexions',
    '/webhooks': 'Webhooks', '/cron': 'Routines', '/files': 'Fichiers', '/env': 'Clés et variables', '/models': 'Modèles',
    '/analytics': 'Utilisation', '/profiles': 'Profils', '/config': 'Configuration', '/logs': 'Journaux',
    '/sessions': 'Historique', '/system': 'Système',
  };

  function syncConsole(path) {
    const frame = $('#console-frame');
    const offline = $('#console-offline');
    const running = status.phase === 'running';
    offline.classList.toggle('show', !running);
    if (running && (path || !frame.getAttribute('src'))) {
      frame.setAttribute('src', path || '/');
    }
  }

  function showView(name, consolePath, opts) {
    if (name !== currentView && !(opts && opts.noPush)) {
      if (name === 'home' || name === 'chat') navStack.length = 0;
      else navStack.push(currentView);
    }
    currentView = name;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    clearInterval(logTimer);
    if (name === 'console') {
      if (consolePath) $('#console-title').textContent = CONSOLE_TITLES[consolePath] || 'Tableau de bord';
      syncConsole(consolePath);
    }
    if (name === 'status') {
      renderStatusPage();
      refreshLog();
      logTimer = setInterval(refreshLog, 2000);
    }
    if (name === 'home' && homePane === 'chats') loadSessions();
    renderBoot();
    document.dispatchEvent(new CustomEvent('hermes:view', { detail: { view: name, pane: homePane } }));
  }

  function showHome(pane) {
    if (pane) homePane = pane;
    document.querySelectorAll('.home-top .seg button').forEach(b => b.classList.toggle('active', b.dataset.home === homePane));
    $('#home-chats').hidden = homePane !== 'chats';
    $('#home-agent').hidden = homePane !== 'agent';
    showView('home');
  }

  function openConsole(path) {
    try { localStorage.setItem('hermes-locale', 'fr'); } catch (_) { /* ignore */ }
    showView('console', path || '/');
  }

  function goBack() {
    if (currentView === 'home' || currentView === 'chat') {
      if (currentView === 'chat') { showHome(); return true; }
      return false;
    }
    const prev = navStack.pop();
    if (prev) showView(prev, null, { noPush: true });
    else showHome();
    return true;
  }

  document.querySelectorAll('.home-top .seg button').forEach(b => {
    b.addEventListener('click', () => showHome(b.dataset.home));
  });
  document.querySelectorAll('[data-back]').forEach(b => { b.onclick = goBack; });
  $('#btn-back').onclick = () => showHome();
  $('#btn-new').onclick = () => newChat(true);
  $('#btn-settings').onclick = () => showView('status');
  $('#btn-console-reload').onclick = () => {
    const frame = $('#console-frame');
    try { frame.contentWindow.location.reload(); } catch (_) { frame.setAttribute('src', frame.getAttribute('src') || '/'); }
  };

  $('#btn-start').onclick = () => bridge && bridge.start();
  $('#btn-stop').onclick = () => bridge && bridge.stop();
  $('#btn-restart').onclick = () => bridge && bridge.restart();
  $('#btn-battery').onclick = () => bridge && bridge.requestBatteryExemption();
  $('#opt-awake').onchange = ev => bridge && bridge.setKeepAwake(ev.target.checked);
  $('#opt-autostart').onchange = ev => bridge && bridge.setAutoStart(ev.target.checked);
  $('#btn-log-refresh').onclick = refreshLog;
  $('#boot-logs').onclick = () => showView('status');
  $('#btn-log-copy').onclick = () => copy($('#log').textContent);

  // Hooks called by MainActivity.
  window.hermesBack = function () {
    if (closeSheet()) return true;
    if (currentView === 'console') {
      const frame = $('#console-frame');
      try {
        const loc = frame.contentWindow.location;
        const start = frame.getAttribute('src') || '/';
        if (loc.pathname && loc.pathname !== start && frame.contentWindow.history.length > 1) {
          frame.contentWindow.history.back();
          return true;
        }
      } catch (_) { /* cross-origin: fall through */ }
    }
    return goBack();
  };

  window.hermesShared = function () {
    if (!bridge) return;
    const text = bridge.takeSharedText();
    if (text) {
      showView('chat');
      ui.input.value = ui.input.value ? ui.input.value + '\n' + text : text;
      autosize();
      ui.input.focus();
    }
  };

  window.hermesResume = function () {
    pollStatus();
  };

  // API partagée avec hub.js et model_setup.js.
  window.HermesApp = {
    gw, chat, api, toast, el, frError, errorCard, shortModel, plural,
    showView, showHome, openConsole, openSheet, closeSheet, sheetItem,
    openModelPicker, fetchModelOptions, newChat, ensureSession,
    hubState, icons: IC,
    get status() { return status; },
    native: {},
    setHubModel(model, provider) {
      hubState.model = model || hubState.model;
      hubState.provider = provider || hubState.provider;
      updateSubtitle();
    },
  };

  // ───────────────────────────── start ─────────────────────────────

  // The console is same-origin, so its labels are translated from here on every load.
  $('#console-frame').addEventListener('load', () => {
    try { $('#console-frame').contentWindow.localStorage.setItem('hermes-locale', 'fr'); } catch (_) { /* même origine */ }
  });

  updateSendButton();
  pollStatus();
  window.hermesShared();
})();
