// Carte « Modèle d'IA » de la page Réglages : clés, choix du modèle, test.
(function () {
  'use strict';

  function $(sel) { return document.querySelector(sel); }
  const H = window.HermesApp;

  function openConsole(path) {
    if (H) H.openConsole(path);
  }

  function init() {
    const keys = $('#ai-oauth');
    const models = $('#ai-models');
    const apiKey = $('#ai-apikey');
    const test = $('#ai-test');

    if (keys) keys.addEventListener('click', function () { openConsole('/env'); });
    // Choix du modèle : le sélecteur natif (fournisseurs configurés), sinon la page Modèles.
    if (models) models.addEventListener('click', function () {
      if (H && H.gw.open) H.openModelPicker();
      else openConsole('/models');
    });
    if (apiKey) apiKey.addEventListener('click', function () { openConsole('/env'); });
    if (test) test.addEventListener('click', function () { if (H) H.showView('chat'); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
