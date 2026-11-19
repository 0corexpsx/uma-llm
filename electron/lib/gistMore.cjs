// French, German and Portuguese for englishGist() (gist.cjs): the words Uma's own checks look for,
// put in English, for the checks only. Same method as Italian and Spanish (phrases first, then word
// by word), with one table per language, because the same small word means different things in
// each ("no" is "not" in Spanish and "in the" in Portuguese; "du" is "you" in German and "of the"
// in French). German also puts what was done at the end of the sentence ("Ich habe den Fehler
// behoben"), so its claims are read by the sentence, not by the word.

// A word edge is spelled out with \p{L}, because \b stops at accented letters.
const phrase = (source, english) => [new RegExp('(?<!\\p{L})(?:' + source + ')(?!\\p{L})', 'giu'), english];
// The same for a phrase that leads into the next word: "j'ai " before what was done.
const opening = (source, english) => [new RegExp('(?<!\\p{L})(?:' + source + ')', 'giu'), english];
const words = (object) => new Map(Object.entries(object));
const NOT_DE_RE = /(?<!\p{L})(?:nicht|nichts|kein\p{L}*|nie|niemals|weder)(?!\p{L})/iu;

// ---- French ----

const FR_FILLER = '(?:(?:bien|déjà|aussi|donc|ensuite|maintenant|également|juste|enfin|correctement|tout) )*';
const FR_DONE = [
  [/^(?:corrigé|réparé|résolu|fixé)e?s?$/, 'fixed'], [/^ajoutée?s?$/, 'added'], [/^déplacée?s?$/, 'moved'], [/^changée?s?$/, 'changed'],
  [/^(?:modifié|édité|adapté)e?s?$/, 'modified'], [/^actualisée?s?$/, 'updated'], [/^(?:supprimé|retiré|enlevé|effacé)e?s?$/, 'removed'],
  [/^remplacée?s?$/, 'replaced'], [/^réécrite?s?$/, 'rewrote'], [/^(?:créé|écrit|généré|enregistré|sauvegardé|rédigé)e?s?$/, 'created'],
  [/^insérée?s?$/, 'inserted'], [/^(?:reconstruit|recompilé)e?s?$/, 'rebuilt'], [/^construite?s?$/, 'built'], [/^compilée?s?$/, 'compiled'],
  [/^ouverte?s?$/, 'opened'], [/^(?:lancé|démarré)e?s?$/, 'started'], [/^cliquée?s?$/, 'clicked'], [/^(?:cherché|recherché)e?s?$/, 'searched'],
  [/^jouée?s?$/, 'played'], [/^(?:tapé|saisi)e?s?$/, 'typed'], [/^appuyée?s?$/, 'pressed'], [/^défilée?s?$/, 'scrolled'],
  [/^utilisée?s?$/, 'used'], [/^appelée?s?$/, 'called'], [/^exécutée?s?$/, 'executed'],
];
const FRENCH = {
  marks: new Set(['les', 'des', 'une', 'est', 'et', 'je', 'vous', 'nous', 'pas', 'dans', 'avec', 'sur', 'ce', 'cette', 'mon', 'sont', 'été', 'où', 'voici', 'fichier', 'fichiers',
    'aux', 'au', 'être', 'très', 'aussi', 'ça', 'cela', 'peux', 'veux', 'oui', 'votre', 'notre', 'elle', 'ils', 'suis', 'ont', 'ici', 'maintenant', 'merci', 'bonjour', 'pourquoi', 'quoi',
    'dossier', 'erreur', 'bouton', 'peut', 'faire', 'fait', 'avez', 'cet', 'ces', 'tout', 'quand']),
  shared: new Set(['page', 'code', 'site', 'style', 'mode', 'message', 'test', 'tests', 'module', 'image', 'application', 'a', 'as', 'on', 'or', 'me', 'comment', 'pour', 'si', 'date',
    'point', 'la', 'le', 'l', 'un', 'de', 'd', 'du', 'que', 'tu', 'es', 'son', 'ma', 'ne', 'n', 's', 'c', 'm', 't', 'j', 'qu', 'bug', 'script', 'programme', 'table', 'fonction', 'continue', 'sur']),
  phrases: [
    phrase("qu'est-ce que c'est(?: que)?", 'what is'), phrase("c'est quoi", 'what is'), phrase("qu'est-ce (?:que|qu')", 'what '),
    opening("est-ce (?:que|qu')\\s*(?:tu peux|vous pouvez) ", 'can you '), opening("est-ce (?:que|qu')\\s*", 'does '),
    phrase("s'il (?:te|vous) pla[iî]t", 'please'), opening("j'ai besoin (?:de |d')", 'i need '), phrase("(?:je (?:veux|voudrais|souhaite)|j'aimerais)", 'i want'),
    // the screen, before "can you" and "i can"
    phrase("que vois-tu|que voyez-vous|qu'est-ce que (?:tu vois|vous voyez)", 'what do you see'),
    phrase('(?:peux-tu|pouvez-vous|tu peux|vous pouvez|arrives-tu à|tu arrives à) voir', 'can you see'),
    phrase('voici ce que je vois|voilà ce que je vois', 'here is what i see'),
    phrase('je (?:peux|parviens à|arrive à) voir', 'i can see the'), phrase('je vois', 'i see the'),
    phrase('(?:est|sont) ouverte?s? (?:dans|sur)', 'is open in'), phrase('barre des tâches', 'taskbar'), phrase('gestionnaire des? tâches', 'task manager'),
    phrase('contr[ôo]ler (?:la |ta |votre )?souris', 'control the mouse'), phrase('contr[ôo]ler (?:le |ton |votre )?clavier', 'control the keyboard'),
    phrase("contr[ôo]ler (?:le |l'|ton |votre )?(?:pc|ordinateur)", 'control the computer'), phrase('(?:faire|fais|ferai|faites) (?:un )?clic', 'click'),
    phrase('(?:peux|pourrais)-tu|(?:pouvez|pourriez)-vous|tu (?:peux|pourrais)|vous (?:pouvez|pourriez)', 'can you'),
    opening('(?:as-tu|avez-vous|tu as|vous avez) ', 'did you '),
    // what is, or is not, there
    phrase("(?:je )?n'ai (?:pas|rien) trouvé\\p{L}*", 'not found'), phrase("n'(?:a|ont) pas été trouvé\\p{L}*", 'not found'), phrase('(?:est |sont )?introuvables?', 'not found'),
    phrase("n'existe(?:nt)? pas", 'does not exist'), phrase('(?:est|sont) vides?', 'is empty'), phrase("n'(?:est|sont) pas présent\\p{L}*", 'not present'),
    // what was not done, then what was done
    opening("(?:je n'ai|nous n'avons|on n'a) (?:encore |toujours )?(?:pas|rien|jamais|aucun\\p{L}*)(?: encore)? ", 'i have not '),
    opening("n'(?:a|ont) (?:pas|jamais)(?: encore)? été ", 'has not been '),
    phrase('mise?s? à jour', 'updated'), phrase('(?:met|mets|mettre|mettez|mettons) à jour', 'update'),
    opening("(?:j'ai|nous avons|on a) " + FR_FILLER, 'i '),
    opening('(?:a|ont) ' + FR_FILLER + 'été ' + FR_FILLER, 'has been '),
    phrase('(?:est|sont) (?:maintenant|désormais) (?:corrig|résol|répar)\\p{L}+', 'is now fixed'),
    phrase("(?:la )?(?:compilation|build) (?:a réussi|est réussie|a été effectuée avec succès|s'est (?:bien )?terminée(?: avec succès)?|est un succès)", 'the build succeeded'),
    phrase('compile (?:correctement|sans erreurs?|avec succès)', 'compiles successfully'),
    phrase('(?:la )?tâche est (?:maintenant )?(?:terminée|accomplie|complétée|finie)', 'task is complete'),
    phrase('(?:est )?en (?:cours de )?lecture', 'is now playing'),
    // what cannot be done, or is not working
    phrase('je ne suis pas (?:en mesure|capable) de', 'unable to'), phrase("je n'ai (?:pas d'|aucun )(?:outil|moyen) (?:pour|de)", 'no tool to'),
    phrase('(?:je )?ne (?:peux|peut|parviens|arrive) pas(?: à)?', 'cannot'), phrase('impossible de', 'cannot'),
    phrase('ne (?:fonctionne|marche)(?:nt)? (?:pas|plus)', 'not working'), phrase("ne s'affiche(?:nt)? (?:pas|plus)", 'not showing'),
    phrase("ne s'ouvre(?:nt)? pas", 'not opening'), phrase('ne (?:démarre|se lance) pas', 'not starting'), phrase('ne (?:se )?charge pas', 'not loading'),
    // what comes next, and offers
    opening('(?:veux-tu|voulez-vous|souhaitez-vous|tu veux|vous voulez|vous souhaitez) que je ', 'do you want me to '),
    phrase('(?:dois-je|puis-je) (?:continuer|procéder|poursuivre)', 'shall i proceed'), phrase('dois-je|puis-je', 'shall i'),
    phrase('(?:dis-moi|dites-moi|fais-moi savoir|faites-moi savoir)', 'let me know'),
    phrase('je vais', 'i will'), phrase('nous allons|on va', "let's"), phrase('laisse(?:z)?-moi', 'let me'), phrase('je dois|il faut que je', 'i need to'), phrase('nous devons', 'we need to'),
    phrase('je peux', 'i can'), phrase("d'abord|tout d'abord", 'first'), phrase("l'outil", 'the'), phrase('sur (?:internet|le web)', 'on the web'),
    phrase("d'accord", 'ok'), phrase('vas-y|allez-y', 'go ahead'), phrase('fais-le|faites-le', 'do it'),
    // remembering the chat
    phrase('te souviens-tu|tu te souviens|vous souvenez-vous|vous vous souvenez|de quoi (?:te|vous) souv\\p{L}+', 'do you remember'),
    phrase('résum\\p{L}+ (?:cette|la|notre) (?:conversation|discussion)', 'summarize this chat'),
  ],
  words: words({
    quoi: 'what', que: 'that', comment: 'how', pourquoi: 'why', quand: 'when', 'où': 'where', qui: 'who', quel: 'which', quelle: 'which', quels: 'which', quelles: 'which', combien: 'how many',
    est: 'is', sont: 'are', 'était': 'was', a: 'has', ont: 'have', oui: 'yes', ouais: 'yes', non: 'no', je: 'i', j: 'i', tu: 'you', vous: 'you',
    ce: 'this', cet: 'this', cette: 'this', ces: 'these', mon: 'my', ma: 'my', mes: 'my', notre: 'our', nos: 'our', ton: 'your', ta: 'your', tes: 'your', votre: 'your', vos: 'your',
    le: 'the', la: 'the', les: 'the', l: 'the', un: 'a', une: 'a', de: 'of', d: 'of', du: 'of the', des: 'of the', dans: 'in', sur: 'on', pour: 'for', avec: 'with', et: 'and', ou: 'or', mais: 'but',
    au: 'to the', aux: 'to the', ne: '', n: '', s: '', m: '', t: '', c: 'it', qu: 'that', pas: 'not', jamais: 'never', rien: 'nothing', aucun: 'no', aucune: 'no', si: 'if',
    pourrais: 'could', pourrait: 'could', devrais: 'should', devrait: 'should', encore: 'still', toujours: 'still', 'même': 'same',
    erreur: 'error', erreurs: 'errors', 'problème': 'problem', bogue: 'bug', 'cassé': 'broken', 'cassée': 'broken', faux: 'wrong', fausse: 'wrong', incorrect: 'wrong',
    manque: 'missing', manquent: 'missing', manquant: 'missing', manquante: 'missing', vide: 'empty', blanc: 'white', blanche: 'white', 'échoue': 'fails', lent: 'slow', lente: 'slow', rapide: 'fast',
    fichier: 'file', fichiers: 'files', dossier: 'folder', dossiers: 'folders', 'répertoire': 'folder', projet: 'project', site: 'website', programme: 'program', appli: 'app', application: 'app',
    fonction: 'function', fonctions: 'functions', 'fonctionnalité': 'feature', jeu: 'game', bouton: 'button', boutons: 'buttons', 'paramètres': 'settings', 'réglages': 'settings',
    'sécurité': 'security', performances: 'performance', sombre: 'dark', clair: 'light', 'thème': 'theme', 'données': 'data', tableau: 'table', 'tâche': 'task',
    'écran': 'screen', 'fenêtre': 'window', onglet: 'tab', bureau: 'desktop', navigateur: 'browser', clavier: 'keyboard', souris: 'mouse',
    affiche: 'shows', montre: 'shows', maintenant: 'now', ensuite: 'next', puis: 'next', 'après': 'next', donc: 'so', alors: 'so', voici: 'here is', 'voilà': 'here is',
    continuez: 'continue', continuer: 'continue', poursuis: 'continue', poursuivez: 'continue', lis: 'read', lire: 'read', lisez: 'read', fais: 'make', faire: 'make', faites: 'make',
    veux: 'want', voulez: 'want', peux: 'can', peut: 'can', merci: 'merci', bonjour: 'bonjour', 'très': 'très', aussi: 'aussi',
    'réussi': 'succeeded', 'réussie': 'succeeded', vois: 'see', voyez: 'see', voir: 'see', accord: 'ok', souviens: 'remember', blague: 'blague',
  }),
  done: FR_DONE,
  stems: [
    [/^corrig|^répar|^résou|^résol/, 'fix'], [/^ajout/, 'add'], [/^cré[eéo]|^créer/, 'create'], [/^écri|^rédig/, 'write'], [/^modifi/, 'change'], [/^chang/, 'change', true],
    [/^actualis/, 'update'], [/^amélior/, 'improve'], [/^optimis/, 'optimize', true], [/^supprim|^retir|^enlev|^effac/, 'remove'], [/^renomm/, 'rename'],
    [/^expliqu/, 'explain'], [/^résum/, 'summarize'], [/^analys/, 'analyze', true], [/^vérifi|^contrôl/, 'check'], [/^cherch|^recherch/, 'search'], [/^trouv/, 'find'],
    [/^list/, 'list', true], [/^organis/, 'organize', true], [/^compil/, 'compile', true], [/^document/, 'document', true], [/^test/, 'test', true], [/^refactor|^refactoris/, 'refactor', true],
    [/^nettoy/, 'clean'], [/^install/, 'install', true], [/^enregistr|^sauvegard/, 'save'], [/^exécut|^lanc(?:e|er|ez)$/, 'run'], [/^continu/, 'continue', true], [/^réessa/, 'try again'],
    [/^tradui/, 'translate'], [/^compar/, 'compare', true], [/^cliqu/, 'click'], [/^tap(?:e|er|ez)$/, 'type'], [/^appu(?:ie|yer|yez)$/, 'press'], [/^construi/, 'build'],
  ],
  // "je corrigerai", "j'ajouterai": what the writer is about to do.
  will: /^\p{L}{3,}(?:erai|irai|rrai)$/u,
};

// ---- German ----

// What was done, as it stands at the end of a German sentence.
const DE_DONE = {
  behoben: 'fixed', korrigiert: 'fixed', repariert: 'fixed', gefixt: 'fixed', 'gelöst': 'fixed', berichtigt: 'fixed',
  'hinzugefügt': 'added', 'ergänzt': 'added', 'eingefügt': 'inserted', verschoben: 'moved', 'geändert': 'changed', 'abgeändert': 'changed',
  modifiziert: 'modified', angepasst: 'modified', bearbeitet: 'modified', aktualisiert: 'updated', entfernt: 'removed', 'gelöscht': 'removed', ersetzt: 'replaced',
  umgeschrieben: 'rewrote', erstellt: 'created', angelegt: 'created', geschrieben: 'created', erzeugt: 'created', generiert: 'created', gespeichert: 'created',
  gebaut: 'built', kompiliert: 'compiled', 'geöffnet': 'opened', gestartet: 'started', geklickt: 'clicked', angeklickt: 'clicked', gesucht: 'searched', abgespielt: 'played',
  getippt: 'typed', eingegeben: 'typed', 'gedrückt': 'pressed', gescrollt: 'scrolled', verwendet: 'used', benutzt: 'used', genutzt: 'used', aufgerufen: 'called', 'ausgeführt': 'executed',
};
const DE_PARTICIPLES = Object.keys(DE_DONE).sort((a, b) => b.length - a.length).join('|');
// The words between the two ends of a German verb: to the end of the sentence at most. The dot of
// a file name ("main.cpp") ends nothing.
const MID = '((?:[^.!?\\n]|\\.(?=[\\p{L}\\p{N}])){0,90}?)';
const between = (start, end, flags = 'giu') => new RegExp('(?<!\\p{L})' + start + '(?!\\p{L})' + MID + '(?<!\\p{L})' + end, flags);
const DE_ACTIVE_RE = between('(?:ich habe|ich hab|wir haben|habe ich|hab ich)', '(' + DE_PARTICIPLES + ')(?!\\p{L})');
const DE_PASSIVE_RE = between('(wurde|wurden|ist|sind)', '(' + DE_PARTICIPLES + ')(?!\\p{L})( worden)?');
const DE_ADD_RE = between('füg(?:e|en|t|st)?', 'hinzu(?!\\p{L})');
const DE_SUMMARIZE_RE = between('fass(?:e|en|t)?', 'zusammen(?!\\p{L})');
const DE_RUN_RE = between('führ(?:e|en|t)?', 'aus(?!\\p{L})');
const DE_CAN_SEE_RE = between('(?:kannst du|können sie|könnt ihr)', 'sehen(?!\\p{L})');
const DE_CANNOT_RE = between('(?:ich )?kann', '(?:nicht|keine?n?)(?!\\p{L})');
const GERMAN = {
  marks: new Set(['der', 'und', 'ist', 'nicht', 'ich', 'wir', 'ein', 'eine', 'einen', 'den', 'dem', 'mit', 'für', 'auf', 'von', 'zu', 'im', 'sind', 'habe', 'haben', 'wurde', 'wurden',
    'kann', 'kannst', 'bitte', 'datei', 'dateien', 'wie', 'auch', 'noch', 'nur', 'oder', 'aber', 'wenn', 'dass', 'diese', 'dieser', 'dieses', 'diesen', 'mein', 'meine', 'meiner', 'wird', 'werde',
    'sie', 'fehler', 'jetzt', 'kein', 'keine', 'nichts', 'warum', 'ja', 'danke', 'hast', 'mir', 'mich', 'dich', 'einem', 'zum', 'zur', 'beim', 'nach', 'über']),
  shared: new Set(['was', 'war', 'die', 'hat', 'in', 'so', 'also', 'an', 'am', 'test', 'tests', 'browser', 'desktop', 'code', 'button', 'design', 'tab', 'app', 'problem', 'modul', 'hell',
    'du', 'das', 'des', 'es', 'chat', 'website', 'homepage', 'performance', 'find', 'finde', 'scroll', 'not', 'bug', 'script', 'programm', 'web', 'online', 'internet', 'ok', 'okay']),
  // By the sentence: "Ich habe den Fehler in main.cpp behoben" is "i fixed den Fehler in main.cpp".
  // `keep` sets the English aside, so that the words in between are still read one by one.
  before(text, keep) {
    return text
      .replace(DE_ACTIVE_RE, (_all, middle, done) => `${keep(NOT_DE_RE.test(middle) ? `i have not ${DE_DONE[done.toLowerCase()]}` : `i ${DE_DONE[done.toLowerCase()]}`)}${middle}`)
      // "wurde aktualisiert" says it was done; "ist aktualisiert" only says how it is, unless "worden" follows.
      .replace(DE_PASSIVE_RE, (all, verb, middle, done, worden) => (/^w/i.test(verb) || worden
        ? `${keep(NOT_DE_RE.test(middle) ? `has not been ${DE_DONE[done.toLowerCase()]}` : `has been ${DE_DONE[done.toLowerCase()]}`)}${middle}`
        : all))
      // "Füge der Seite einen Knopf hinzu": the verb is in two parts, at both ends.
      .replace(DE_ADD_RE, (_all, middle) => `${keep('add')}${middle.trimEnd()}`)
      .replace(DE_SUMMARIZE_RE, (_all, middle) => `${keep('summarize')}${middle.trimEnd()}`)
      .replace(DE_RUN_RE, (_all, middle) => `${keep('run')}${middle.trimEnd()}`)
      // "Kannst du meinen Bildschirm sehen?"
      .replace(DE_CAN_SEE_RE, (_all, middle) => `${keep('can you see')}${middle.trimEnd()}`)
      // "Ich kann die Maus nicht steuern", "Ich kann nicht klicken"
      .replace(DE_CANNOT_RE, (_all, middle) => `${keep('cannot')}${middle.trimEnd()}`)
      // "Jetzt lese ich die Datei", "Als Nächstes prüfe ich den Code": the next step, in the present.
      .replace(/(?<!\p{L})(?:jetzt|nun|als n[äa]chstes|zuerst|zun[äa]chst|dann|danach|anschlie[ßs]end)(?!\p{L}),? (\p{L}+e) ich(?!\p{L})/giu, (_all, verb) => `${keep('next i will')} ${verb}`);
  },
  phrases: [
    phrase('ich (?:brauche|benötige)', 'i need'), phrase('ich (?:möchte|will|hätte gern(?:e)?)', 'i want'),
    phrase('was siehst du|was sehen sie|was kannst du sehen', 'what do you see'),
    phrase('(?:hier|das) ist,? was ich sehe|folgendes sehe ich', 'here is what i see'),
    phrase('ich sehe|ich kann sehen', 'i see the'),
    phrase('taskleiste', 'taskbar'), phrase('task-manager', 'task manager'),
    phrase('(?:die |deine |ihre )?maus (?:zu )?(?:steuern|kontrollieren|bedienen)', 'control the mouse'), phrase('(?:die |deine |ihre )?tastatur (?:zu )?(?:steuern|kontrollieren|bedienen)', 'control the keyboard'),
    phrase('(?:den |deinen |ihren )?(?:pc|computer|rechner) (?:zu )?(?:steuern|kontrollieren|bedienen)', 'control the computer'),
    opening('(?:möchtest|willst) du,? dass ich ', 'do you want me to '), opening('(?:möchten|wollen) sie,? dass ich ', 'do you want me to '),
    phrase('(?:soll|sollte|darf) ich (?:fortfahren|weitermachen)', 'shall i proceed'), phrase('(?:soll|sollte|darf) ich', 'shall i'),
    phrase('(?:kannst|könntest) du(?: mir)?|(?:können|könnten) sie(?: mir)?|könnt ihr', 'can you'),
    opening('(?:hast du|haben sie|habt ihr) ', 'did you '),
    phrase('ich bin nicht in der lage', 'unable to'), phrase('ich habe (?:kein (?:werkzeug|tool)|keine möglichkeit)', 'no tool to'),
    phrase('existier(?:t|en) nicht|gibt es nicht', 'does not exist'), phrase('(?:wurde |wurden )?nicht gefunden|nichts gefunden|nicht finden', 'not found'),
    phrase('(?:ist|sind) leer', 'is empty'), phrase('nicht vorhanden', 'not present'),
    phrase('(?:ist|sind) (?:jetzt|nun) (?:behoben|korrigiert|repariert|gelöst)', 'is now fixed'),
    phrase('(?:der |die )?(?:build|kompilierung|erstellung) (?:war erfolgreich|ist erfolgreich|wurde erfolgreich abgeschlossen|hat funktioniert|ist gelungen)', 'the build succeeded'),
    phrase('(?:kompiliert|baut) (?:erfolgreich|ohne fehler|fehlerfrei)', 'compiles successfully'),
    phrase('(?:die )?aufgabe ist (?:jetzt |nun )?(?:erledigt|abgeschlossen|fertig)', 'task is complete'),
    phrase('wird (?:jetzt |gerade )?abgespielt|läuft (?:jetzt|gerade)', 'is now playing'),
    phrase('funktionier(?:t|en) nicht|geht nicht', 'not working'), phrase('wird nicht angezeigt|zeigt nichts an', 'not showing'),
    phrase('öffnet sich nicht|lässt sich nicht öffnen', 'not opening'), phrase('startet nicht', 'not starting'), phrase('lädt nicht', 'not loading'),
    phrase('ich werde', 'i will'), phrase('wir werden|lass uns|lassen sie uns', "let's"), phrase('lass mich|lassen sie mich', 'let me'),
    phrase('ich muss', 'i need to'), phrase('wir müssen', 'we need to'), phrase('ich kann', 'i can'),
    phrase('(?:sag|sagen sie) (?:mir )?(?:einfach )?bescheid|lass (?:es )?mich wissen|lassen sie (?:es )?mich wissen', 'let me know'),
    phrase('im (?:internet|web|netz)', 'on the web'), phrase('das (?:werkzeug|tool)', 'the'), phrase('immer noch', 'still'),
    phrase('mach(?:e|en sie)? weiter|fahr(?:e)? fort', 'continue'), phrase('in ordnung|alles klar|einverstanden', 'ok'), phrase('leg los|nur zu', 'go ahead'), phrase('mach (?:das|es)', 'do it'),
    phrase('erinnerst du dich|erinnern sie sich', 'do you remember'),
    phrase('(?:dieses|diesen|das|den|unser|unseren) (?:gespräch|chat|unterhaltung)', 'this chat'),
  ],
  words: words({
    was: 'what', wie: 'how', warum: 'why', wieso: 'why', weshalb: 'why', wann: 'when', wo: 'where', wer: 'who', welche: 'which', welcher: 'which', welches: 'which', welchen: 'which', wieviele: 'how many',
    ist: 'is', sind: 'are', war: 'was', hat: 'has', habe: 'have', ja: 'yes', nein: 'no', ich: 'i', du: 'you', bitte: 'please',
    dies: 'this', diese: 'this', dieser: 'this', dieses: 'this', diesem: 'this', diesen: 'this', mein: 'my', meine: 'my', meiner: 'my', meinem: 'my', meinen: 'my',
    unser: 'our', unsere: 'our', unserer: 'our', dein: 'your', deine: 'your', deiner: 'your', ihre: 'your',
    der: 'the', die: 'the', das: 'the', den: 'the', dem: 'the', des: 'the', ein: 'a', eine: 'a', einen: 'a', einem: 'a', einer: 'a', von: 'of', im: 'in', auf: 'on', 'für': 'for', mit: 'with',
    und: 'and', oder: 'or', aber: 'but', nicht: 'not', nie: 'never', niemals: 'never', nichts: 'nothing', kein: 'no', keine: 'no', keinen: 'no', wenn: 'if', falls: 'if', ob: 'whether',
    'könnte': 'could', sollte: 'should', noch: 'still', gleiche: 'same', gleichen: 'same', fehler: 'error', kaputt: 'broken', defekt: 'broken', falsch: 'wrong',
    fehlt: 'missing', fehlen: 'missing', fehlend: 'missing', fehlende: 'missing', leer: 'empty', 'weiß': 'white', langsam: 'slow', schnell: 'fast',
    datei: 'file', dateien: 'files', ordner: 'folder', verzeichnis: 'folder', quellcode: 'code', projekt: 'project', webseite: 'website', internetseite: 'website', homepage: 'website',
    seite: 'page', seiten: 'pages', programm: 'program', anwendung: 'app', funktion: 'function', funktionen: 'functions', spiel: 'game', 'schaltfläche': 'button', knopf: 'button',
    einstellungen: 'settings', sicherheit: 'security', leistung: 'performance', stil: 'style', dunkel: 'dark', dunkler: 'dark', dunkles: 'dark', hell: 'light', modus: 'mode', thema: 'theme',
    daten: 'data', tabelle: 'table', nachricht: 'message', aufgabe: 'task', bildschirm: 'screen', fenster: 'window', registerkarte: 'tab', tastatur: 'keyboard', maus: 'mouse',
    zeigt: 'shows', jetzt: 'now', nun: 'now', dann: 'next', danach: 'next', 'anschließend': 'next', zuerst: 'first', 'zunächst': 'first', hier: 'here', weiter: 'continue',
    lies: 'read', lesen: 'read', lest: 'read', danke: 'danke', auch: 'auch', nur: 'nur', liesmich: 'readme', zusammenfassung: 'summary',
    siehst: 'see', sehe: 'see', sehen: 'see', seht: 'see', ordnung: 'ok', erfolgreich: 'successful', erinnerst: 'remember',
  }),
  done: Object.entries(DE_DONE).map(([word, english]) => [new RegExp(`^${word}e?[rsnm]?$`), english]),
  stems: [
    [/^beheb|^korrigier|^reparier|^fix(?:e|en)$|^lös(?:e|en)$/, 'fix'], [/^hinzufüg|^hinzuzufüg|^ergänz/, 'add'], [/^erstell|^erzeug/, 'create'], [/^mach(?:e|en|t)?$/, 'make'],
    [/^bau(?:e|en)$/, 'build'], [/^schreib/, 'write'], [/^änder|^ändr/, 'change'], [/^aktualisier/, 'update'], [/^verbesser/, 'improve'], [/^optimier/, 'optimize'],
    [/^entfern|^lösch/, 'remove'], [/^umbenenn/, 'rename'], [/^erklär|^erläuter/, 'explain'], [/^zusammenfass|^zusammenzufass/, 'summarize'], [/^analysier/, 'analyze'],
    [/^prüf|^überprüf|^kontrollier/, 'check'], [/^such|^durchsuch/, 'search'], [/^find/, 'find', true], [/^auflist/, 'list'], [/^organisier|^sortier/, 'organize'],
    [/^kompilier/, 'compile'], [/^dokumentier/, 'document'], [/^test/, 'test', true], [/^refaktor/, 'refactor'], [/^bereinig|^säuber/, 'clean'], [/^installier/, 'install'],
    [/^speicher/, 'save'], [/^ausführ|^auszuführ|^start(?:e|en)$/, 'run'], [/^fortfahr|^fortsetz/, 'continue'], [/^übersetz/, 'translate'], [/^vergleich/, 'compare'],
    [/^klick/, 'click'], [/^tipp/, 'type'], [/^drück/, 'press'], [/^scroll/, 'scroll', true],
    // German joins words: "Browserfenster", "Anmeldeseite", "Konfigurationsdatei".
    [/datei(?:en)?$/, 'file'], [/ordner$/, 'folder'], [/fenster$/, 'window'], [/seiten?$/, 'page'], [/fehler$/, 'error'], [/bildschirm/, 'screen'], [/schaltfläche/, 'button'],
  ],
  will: null,
};

// ---- Portuguese ----

const PT_FILLER = '(?:(?:já|agora|também|então|depois|ainda|corretamente|apenas|acabei de) )*';
// "corrigi", "atualizei": Portuguese says "I fixed" in one word.
const PT_I_DID = {
  corrigi: 'fixed', consertei: 'fixed', arrumei: 'fixed', resolvi: 'fixed', reparei: 'fixed', adicionei: 'added', acrescentei: 'added', 'incluí': 'added', movi: 'moved',
  mudei: 'changed', alterei: 'changed', troquei: 'changed', modifiquei: 'modified', editei: 'modified', atualizei: 'updated', removi: 'removed', 'excluí': 'removed', apaguei: 'removed',
  deletei: 'removed', eliminei: 'removed', 'substituí': 'replaced', reescrevi: 'rewrote', criei: 'created', escrevi: 'created', gerei: 'created', salvei: 'created', gravei: 'created',
  inseri: 'inserted', 'reconstruí': 'rebuilt', recompilei: 'rebuilt', 'construí': 'built', compilei: 'compiled', abri: 'opened', iniciei: 'started', cliquei: 'clicked',
  pesquisei: 'searched', procurei: 'searched', busquei: 'searched', reproduzi: 'played', toquei: 'played', digitei: 'typed', pressionei: 'pressed', apertei: 'pressed', rolei: 'scrolled',
  usei: 'used', utilizei: 'used', chamei: 'called', executei: 'executed', rodei: 'executed',
};
const PORTUGUESE = {
  // Only words that Spanish and Italian do not have: "preciso", "porque", "pelo", "tela", "posso",
  // "está" and "é" (as Italians often type "è") are left out.
  marks: new Set(['os', 'um', 'uma', 'não', 'são', 'você', 'eu', 'em', 'na', 'nas', 'com', 'isso', 'isto', 'foi', 'arquivo', 'arquivos', 'ficheiro', 'também', 'já', 'agora', 'aqui',
    'meu', 'minha', 'seu', 'ao', 'tem', 'pode', 'estão', 'erro', 'botão', 'obrigado', 'obrigada', 'sim', 'vou', 'fazer', 'quero', 'ainda', 'muito', 'nós', 'vocês',
    'projeto', 'projetos', 'função', 'funções', 'teste', 'testes', 'janela', 'aplicativo', 'desempenho', 'conversa']),
  shared: new Set(['a', 'as', 'o', 'do', 'no', 'e', 'de', 'se', 'como', 'para', 'por', 'que', 'site', 'app', 'mouse', 'problema', 'programa', 'modo', 'tema', 'chat', 'bug', 'script', 'web',
    'online', 'internet', 'ok', 'da', 'dos', 'das', 'tu', 'mais', 'ou', 'me', 'tela', 'data', 'erro', 'pasta', 'rato', 'pode', 'tem', 'mas', 'continua', 'continue']),
  phrases: [
    phrase('por favor', 'please'), phrase('o que (?:é|são)', 'what is'), phrase('por qu[eê]|porqu[eê]', 'why'),
    phrase('o que (?:você vê|vês|você está vendo|estás a ver)', 'what do you see'), phrase('(?:você )?(?:consegue|pode|consegues|podes) ver', 'can you see'),
    phrase('(?:aqui está|eis) o que (?:eu )?vejo', 'here is what i see'), phrase('(?:eu )?(?:posso|consigo) ver', 'i can see the'), phrase('(?:eu )?vejo', 'i see the'),
    phrase('(?:está|estão) abert[oa]s? (?:no|na|em)', 'is open in'), phrase('barra de tarefas', 'taskbar'), phrase('(?:gerenciador|gestor) de tarefas', 'task manager'),
    phrase('área de trabalho', 'desktop'),
    phrase('controlar (?:o |a |seu |teu )*(?:mouse|rato)', 'control the mouse'), phrase('controlar (?:o |a |seu |teu )*teclado', 'control the keyboard'),
    phrase('controlar (?:o |a |seu |teu )*(?:pc|computador)', 'control the computer'), phrase('(?:fazer|faço|farei|faça) clique', 'click'),
    phrase('o que', 'what'),
    opening('(?:você quer|queres|quer|deseja|gostaria) que eu ', 'do you want me to '),
    phrase('(?:posso|devo) (?:continuar|prosseguir)', 'shall i proceed'),
    phrase('me avise|avise-me|diga-me|me diga|me fala|me informe', 'let me know'),
    phrase('(?:você |tu |vocês )?(?:podes?|podem|poderias?|consegues?)(?= (?:me |nos )?\\p{L}+(?:ar|er|ir|or)(?!\\p{L}))', 'can you'),
    opening('(?:você|vocês|tu) (?=\\p{L}+(?:ou|eu|iu|ste|aram|eram|iram)(?!\\p{L}))', 'did you '),
    phrase('(?:eu )?preciso (?:de|que)', 'i need'), phrase('(?:eu )?(?:quero|queria|gostaria de)', 'i want'),
    phrase('não (?:foi |foram )?encontrad\\p{L}+|não (?:achei|encontrei)', 'not found'),
    phrase('não existe(?:m)?', 'does not exist'), phrase('(?:está|estão) vazi[oa]s?', 'is empty'), phrase('não (?:está|estão) presentes?', 'not present'),
    phrase('(?:a |o )?(?:build|compilação) (?:foi (?:bem[- ]sucedid[oa]|concluíd[oa](?: com sucesso)?|um sucesso)|teve sucesso|passou)', 'the build succeeded'),
    phrase('compila (?:corretamente|com sucesso|sem erros)', 'compiles successfully'),
    phrase('(?:a )?tarefa (?:está|foi) (?:agora )?(?:concluída|completa|terminada|finalizada)', 'task is complete'),
    phrase('(?:está )?(?:tocando|reproduzindo|a tocar|em reprodução)', 'is now playing'),
    opening('não (?:foi|foram) ', 'has not been '),
    opening('(?:foi|foram) ' + PT_FILLER + '(?=(?:\\p{L}+(?:ad|id|íd)[oa]s?|escrit[oa]s?|abert[oa]s?|feit[oa]s?|salv[oa]s?)(?!\\p{L}))', 'has been '),
    phrase('(?:está|estão) agora (?:corrigid|resolvid|consertad)\\p{L}+|agora (?:está|estão) (?:corrigid|resolvid|consertad)\\p{L}+', 'is now fixed'),
    phrase('não sou capaz de', 'unable to'), phrase('não tenho (?:nenhuma |uma )?(?:ferramenta|forma|maneira) (?:para|de)', 'no tool to'),
    phrase('não (?:posso|consigo|pode|consegue|dá para)', 'cannot'),
    phrase('não (?:funciona|funcionam|está funcionando)', 'not working'), phrase('não (?:aparece|aparecem|é exibid\\p{L}+)', 'not showing'),
    phrase('não abre', 'not opening'), phrase('não (?:inicia|arranca)', 'not starting'), phrase('não carrega', 'not loading'),
    phrase('(?:eu )?vou', 'i will'), phrase('vamos', "let's"), phrase('deixe-me|deixa-me|deixa eu|me deixe', 'let me'),
    phrase('(?:eu )?(?:preciso|tenho que|tenho de)', 'i need to'), phrase('precisamos|temos que|temos de', 'we need to'), phrase('(?:eu )?posso', 'i can'),
    phrase('a ferramenta', 'the'), phrase('na (?:internet|web)', 'on the web'), phrase('em seguida', 'next'),
    phrase('tá bom|está bem|tudo bem|beleza', 'ok'), phrase('pode ir|vai em frente|vá em frente|manda ver', 'go ahead'), phrase('faça isso|faz isso', 'do it'),
    phrase('(?:tente|tenta|tentar) (?:de novo|novamente)', 'try again'),
    phrase('(?:você )?(?:se )?lembras?(?:-te)?|o que (?:você )?lembra', 'do you remember'), phrase('resum\\p{L}+ (?:esta|a|nossa) conversa', 'summarize this chat'),
  ],
  words: words({
    ...Object.fromEntries(Object.entries(PT_I_DID).map(([word, english]) => [word, `i ${english}`])),
    como: 'how', quando: 'when', onde: 'where', quem: 'who', qual: 'which', quais: 'which', quanto: 'how much', quantos: 'how many', que: 'that',
    'é': 'is', 'são': 'are', foi: 'was', 'está': 'is', 'estão': 'are', tem: 'has', 'você': 'you', tu: 'you', eu: 'i', sim: 'yes', 'não': 'not',
    este: 'this', esta: 'this', esse: 'this', essa: 'this', isto: 'this', isso: 'this', estes: 'these', estas: 'these', meu: 'my', minha: 'my', meus: 'my', minhas: 'my',
    nosso: 'our', nossa: 'our', seu: 'your', teu: 'your', tua: 'your', o: 'the', a: 'the', os: 'the', as: 'the', um: 'a', uma: 'a',
    de: 'of', do: 'of the', da: 'of the', dos: 'of the', das: 'of the', em: 'in', no: 'in the', na: 'in the', nos: 'in the', nas: 'in the', ao: 'to the', para: 'for', pra: 'for', com: 'with',
    e: 'and', ou: 'or', mas: 'but', nunca: 'never', nada: 'nothing', nenhum: 'no', nenhuma: 'no', se: 'if', poderia: 'could', deveria: 'should', ainda: 'still', mesmo: 'same', mesma: 'same',
    erro: 'error', erros: 'errors', problema: 'problem', quebrado: 'broken', quebrada: 'broken', errado: 'wrong', errada: 'wrong', falta: 'missing', faltando: 'missing', faltam: 'missing',
    vazio: 'empty', vazia: 'empty', branco: 'white', branca: 'white', falha: 'fails', lento: 'slow', lenta: 'slow', 'rápido': 'fast',
    arquivo: 'file', arquivos: 'files', ficheiro: 'file', ficheiros: 'files', pasta: 'folder', pastas: 'folders', 'diretório': 'folder', 'código': 'code', projeto: 'project',
    site: 'website', 'sítio': 'website', 'página': 'page', 'páginas': 'pages', programa: 'program', aplicativo: 'app', 'aplicação': 'app', 'função': 'function', 'funções': 'functions',
    funcionalidade: 'feature', recurso: 'feature', 'módulo': 'module', jogo: 'game', 'botão': 'button', 'botões': 'buttons', 'configurações': 'settings', 'definições': 'settings',
    'segurança': 'security', desempenho: 'performance', estilo: 'style', escuro: 'dark', escura: 'dark', claro: 'light', clara: 'light', modo: 'mode', tema: 'theme',
    dados: 'data', tabela: 'table', mensagem: 'message', teste: 'test', testes: 'tests', tarefa: 'task', tela: 'screen', 'ecrã': 'screen', janela: 'window', aba: 'tab', separador: 'tab',
    navegador: 'browser', teclado: 'keyboard', rato: 'mouse', mostra: 'shows', exibe: 'shows', agora: 'now', depois: 'next', 'então': 'so', primeiro: 'first', aqui: 'here',
    tudo: 'tudo', bem: 'bem', lembra: 'remember', lembras: 'remember', 'vê': 'see', ver: 'see',
    'já': '', 'também': 'também', muito: 'muito', obrigado: 'obrigado', obrigada: 'obrigada', continuar: 'continue', continua: 'continue', prossiga: 'continue', ler: 'read', leia: 'read', 'lê': 'read',
  }),
  done: [
    [/^(?:corrigid|consertad|resolvid|arrumad|reparad)[oa]s?$/, 'fixed'], [/^(?:adicionad|acrescentad|incluíd)[oa]s?$/, 'added'], [/^movid[oa]s?$/, 'moved'],
    [/^(?:alterad|mudad|trocad)[oa]s?$/, 'changed'], [/^(?:modificad|editad)[oa]s?$/, 'modified'], [/^atualizad[oa]s?$/, 'updated'],
    [/^(?:removid|excluíd|apagad|eliminad|deletad)[oa]s?$/, 'removed'], [/^substituíd[oa]s?$/, 'replaced'], [/^reescrit[oa]s?$/, 'rewrote'],
    [/^(?:criad|escrit|gerad|gravad)[oa]s?$|^salv[oa]s?$/, 'created'], [/^inserid[oa]s?$/, 'inserted'], [/^(?:reconstruíd|recompilad)[oa]s?$/, 'rebuilt'],
    [/^construíd[oa]s?$/, 'built'], [/^compilad[oa]s?$/, 'compiled'], [/^abert[oa]s?$/, 'opened'], [/^iniciad[oa]s?$/, 'started'], [/^clicad[oa]s?$/, 'clicked'],
    [/^(?:pesquisad|procurad|buscad)[oa]s?$/, 'searched'], [/^reproduzid[oa]s?$/, 'played'], [/^digitad[oa]s?$/, 'typed'], [/^pressionad[oa]s?$/, 'pressed'],
    [/^(?:usad|utilizad)[oa]s?$/, 'used'], [/^chamad[oa]s?$/, 'called'], [/^executad[oa]s?$/, 'executed'],
  ],
  stems: [
    [/^corrij|^corrig|^consert|^arrum|^resolv/, 'fix'], [/^adicion|^acrescent/, 'add'], [/^cri(?:a|e|o|ar|em|amos)$/, 'create'], [/^fa(?:z|ça|zer|çam)$/, 'make'],
    [/^escrev/, 'write'], [/^alter|^mud(?:a|e|ar)$|^modifi/, 'change'], [/^atualiz/, 'update'], [/^melhor/, 'improve'], [/^otimiz/, 'optimize'],
    [/^remov|^exclu|^apag|^delet/, 'remove'], [/^renome/, 'rename'], [/^expli[cq]/, 'explain'], [/^resum/, 'summarize'], [/^analis/, 'analyze'],
    [/^verifi|^confir|^chec/, 'check'], [/^pesquis|^procur|^busc/, 'search'], [/^encontr/, 'find'], [/^list/, 'list', true], [/^organiz/, 'organize', true],
    [/^compil/, 'compile', true], [/^document/, 'document', true], [/^test/, 'test', true], [/^refator/, 'refactor'], [/^limp(?:a|e|ar)$/, 'clean'], [/^instal/, 'install', true],
    [/^salv|^grav(?:a|e|ar)$/, 'save'], [/^execut|^rod(?:a|e|ar)$/, 'run'], [/^continu/, 'continue', true], [/^traduz/, 'translate'], [/^compar/, 'compare', true],
    [/^cliqu|^clic/, 'click'], [/^digit/, 'type'], [/^pression|^apert/, 'press'],
  ],
  // "corrigirei", "adicionarei": what the writer is about to do.
  will: /^\p{L}{3,}(?:arei|erei|irei)$/u,
};

const LANGUAGES = { fr: FRENCH, de: GERMAN, pt: PORTUGUESE };

/** What a word is in English in that language, and whether it shows the language. */
function glossIn(language, word) {
  if (language.words.has(word)) return { english: language.words.get(word), shows: !language.shared.has(word) };
  if (word.length < 4) return null;
  const done = language.done.find(([pattern]) => pattern.test(word));
  if (done) return { english: done[1], shows: true };
  const stem = language.stems.find(([pattern]) => pattern.test(word));
  if (language.will?.test(word)) return { english: stem ? `i will ${stem[1]}` : 'i will', shows: true };
  return stem ? { english: stem[1], shows: !stem[2] } : null;
}

/** How much of a text's words each of the three languages claims: its own small words, and the words it knows. */
function languageScores(list) {
  const scores = {};
  for (const [name, language] of Object.entries(LANGUAGES)) {
    let marks = 0;
    let shown = 0;
    for (const word of list) {
      if (language.marks.has(word) && !language.notMarks?.has(word)) marks += 1;
      if (glossIn(language, word)?.shows) shown += 1;
    }
    scores[name] = { marks, shown };
  }
  return scores;
}

/**
 * The text read as French, German or Portuguese. `english` says whether a word counts as English
 * (gist.cjs); a word the language has itself ("was", "die", "do") does not count against it.
 */
function gistIn(name, source, list, { english, wordRe }) {
  const language = LANGUAGES[name];
  let foreign = 0;
  let plain = 0;
  for (const word of list) {
    if (glossIn(language, word)?.shows) foreign += 1;
    else if (english(word) && !language.words.has(word)) plain += 1;
  }
  if (!foreign || foreign <= plain) return source;
  // English already put in place is set aside while the single words are read.
  const kept = [];
  const keep = (text) => `${kept.push(text) - 1}`;
  let result = source.replace(/[’‘]/g, "'");
  if (language.before) result = language.before(result, keep);
  for (const [pattern, text] of language.phrases) result = result.replace(pattern, () => keep(text));
  return result
    .replace(wordRe, (word) => glossIn(language, word.toLowerCase())?.english ?? word)
    .replace(/(\d+)/g, (_mark, index) => kept[Number(index)])
    // "j'ai" leaves its apostrophe behind, and "l'erreur" is "the error".
    .replace(/(\b(?:i|the|of|that|it|not|has|did you|can you)) ?'(?=\s|\p{L})/giu, '$1 ')
    .replace(/(^|[\s(])'(?=\s|\p{L})/g, '$1')
    .replace(/\b(?:the )+(my|your|our)\b/gi, '$1')
    .replace(/\bthe the\b/gi, 'the')
    .replace(/\bi i\b/gi, 'i')
    .replace(/ {2,}/g, ' ')
    .replace(/ ([.,;!])/g, '$1');
}

module.exports = { languageScores, gistIn };
