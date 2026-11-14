# Hermes pour Android — v6 (branche `hermes-v6`)

## Nouveautés

- **Navigation façon app officielle** : plus d’onglets en bas. Accueil avec pilule « Conversations / Agent » en haut à gauche, boutons ronds « + » (nouvelle conversation) et ⚙ (Réglages). La conversation a un bouton Retour, l’avatar et le titre centrés (avec le modèle ou « Réflexion… 0:05 »), et un menu « … ».
- **Un seul bloc par réponse** : « A travaillé 14 s · 2 outils », replié par défaut. Déplié, il montre la réflexion, les commentaires intermédiaires et chaque étape avec une coche verte (« A exécuté une commande », « A cherché sur le web »…). Touche une étape pour voir sa sortie.
- **Choix du modèle dans la conversation** : touche le titre en haut ou la pastille du modèle dans le champ de saisie. Liste les fournisseurs configurés (`model.options`), recherche, option « Garder comme modèle par défaut » (`--global`).
- **Champ de saisie** : « + » (pièce jointe), « Message Hermes… », micro (dictée en français), bouton Envoyer, qui devient Stop pendant une réponse (« Message en file d’attente… »).
- **Dictée vocale** : SpeechRecognizer d’Android en fr-FR avec résultats partiels. Si le téléphone n’a pas ce service, l’app ouvre l’écran de dictée du système. La permission micro est demandée au premier usage.
- **Page Agent** : Modèle (modèle et fournisseur actuels), Compétences, Plugins, MCP et Projets avec leur nombre. Section Travail : Projets, Routines, Fichiers, Historique.
- **Écrans natifs MCP** (lister, ajouter en URL ou en commande, activer/désactiver, tester, supprimer) et **Projets** (lister, créer, choisir le projet actif).
- **Erreurs en français clair** : clé refusée, quota gratuit épuisé, crédit épuisé, fournisseur saturé, modèle introuvable, contexte trop long, réseau… Le texte technique reste dans « Détails techniques ».
- « Se connecter » s’appelle maintenant **« Clés et variables »**.

## Corrections

- **Texte en double** : les trames rejouées (reconnexion, second socket, tentative relancée) sont ignorées grâce à `turn_id`/`segment`/`offset`. Un `message.complete` en double ne recrée plus de bulle. `thinking.delta` (animation d’attente) n’est plus copié dans la réflexion, et `reasoning.available` ne la double plus.
- **« Réflexion… » bloqué** : la réponse se termine aussi sur un événement `error` du moteur, sur `session.info running=false`, sur une perte de connexion, et 8 s après un Stop non confirmé.
- **Compétences invisibles sur Android** : le Python du moteur renvoie `sys.platform == "android"`, alors toutes les compétences fournies (déclarées `linux/macos/windows`) étaient filtrées. Un correctif appliqué à la construction (`scripts/patch_engine_android.py`) traite Android comme Linux.

## Moteur

- `runtime.lock` : canal canary, version la plus récente, minimum **0.23.1** (`HERMES_RUNTIME_MIN_VERSION`). Vérifié le 13/11/2026 : `0.23.1~canary.20261113T064447Z-1`.
