// Menu « Agent » (façon app officielle Hermes) et éditeur de l'âme et de la mémoire.
(function () {
  'use strict';

  const bridge = window.HermesAndroid || null;
  function $(sel) { return document.querySelector(sel); }

  function toast(text) {
    if (bridge && bridge.toast) bridge.toast(text);
  }

  // Ouvre une page du tableau de bord officiel dans l'onglet « Tableau ».
  function openConsole(path) {
    try { localStorage.setItem('hermes-locale', 'fr'); } catch (_) { /* ignore */ }
    const tab = $('#tabs button[data-view="console"]');
    if (tab) tab.click();
    window.setTimeout(function () {
      const frame = $('#console-frame');
      const offline = $('#console-offline');
      if (frame && !(offline && offline.classList.contains('show'))) frame.setAttribute('src', path);
    }, 30);
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

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.hub-row').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.console) openConsole(b.dataset.console);
        else if (b.dataset.editor) openEditor(b.dataset.editor);
      });
    });
    $('#ed-back').onclick = function () { closeEditor(false); };
    $('#ed-save').onclick = save;

    // Le bouton Retour d'Android ferme d'abord l'éditeur.
    const prevBack = window.hermesBack;
    window.hermesBack = function () {
      if (!$('#editor').hidden) { closeEditor(false); return true; }
      return prevBack ? prevBack() : false;
    };
  });
})();
