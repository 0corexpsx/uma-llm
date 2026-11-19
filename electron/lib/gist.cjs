// Uma decides what a request is (a question, a task on the user's files, a web lookup), which skills
// fit it, and whether a reply says something that did not happen ("I fixed it" with no edit) by
// looking for English words. Text in Italian, Spanish, French, German, Portuguese, Chinese or
// Japanese has none: a request was
// treated as small talk, and an invented "ho corretto il bug" went through unchecked.
// englishGist() rewrites the words those checks look for in English, for the checks only. The model
// always gets the user's own words, and the user always sees the model's.

const { languageScores, gistIn } = require('./gistMore.cjs');

// ---- Italian and Spanish: word by word (French, German and Portuguese: gistMore.cjs) ----

// Phrases are replaced first. A word edge is spelled out with \p{L}, because \b stops at accented letters.
const phrase = (source, english) => [new RegExp('(?<!\\p{L})(?:' + source + ')(?!\\p{L})', 'giu'), english];
// The same for a phrase that leads into the next word: "ho " before what was done.
const opening = (source, english) => [new RegExp('(?<!\\p{L})(?:' + source + ')', 'giu'), english];
// What was done looks like this in both languages: "aggiornato", "rimossa", "actualizado".
const DONE_NEXT = '(?=\\p{L}+(?:at|it|ut|ss|tt|rt|lt|ad|id)[oaie]s?(?!\\p{L}))';
// Small words that may stand between "ho" and what was done: "ho già corretto", "è stato appena aggiornato".
const FILLER = '(?:(?:appena|già|ora|adesso|anche|quindi|poi|infine|così|ya|también|recién|correttamente|correctamente) )*';
const PHRASES = [
  phrase('che cosa', 'what'), phrase("cos'\\s*[eè]", 'what is'), phrase("com'\\s*[eè]", 'how is'),
  phrase("non c'\\s*[eè]", 'is not there'), phrase("c'\\s*[eè]", 'there is'),
  phrase('per (?:favore|piacere|cortesia)', 'please'), phrase('por favor', 'please'),
  phrase('(?:ho|abbiamo) bisogno', 'i need'), phrase('mi serv[eo]', 'i need'),
  // "non ho trovato" is about what is there, and comes before "ho" as what was done
  phrase('non (?:è stat[oa] |sono stat[ie] |ho )?trovat\\p{L}+', 'not found'), phrase('no (?:se )?(?:encontr\\p{L}+|he encontrado)', 'not found'),
  // what was done
  opening('(?:ho|abbiamo|he|hemos) ' + FILLER, 'i '),
  // "è stato aggiornato" says it was done; "è aggiornato" only says how it is.
  opening('(?:(?:è|e\'|sono) stat[oaie]|ha sido|han sido|fue|fueron|se han?) ' + FILLER + DONE_NEXT, 'has been '),
  phrase('(?:è|sono|está|están) (?:ora|adesso|ahora) (?:corrett|risolt|sistemat|arreglad|corregid)\\p{L}+', 'is now fixed'),
  phrase('(?:ora|adesso|ahora) (?:è|sono|está|están) (?:corrett|risolt|sistemat|arreglad|corregid)\\p{L}+', 'is now fixed'),
  phrase('(?:la )?(?:build|compilazione|compilación) (?:è |se )?(?:riuscita|completata|andata a buon fine|terminata con successo|fue exitosa|completó|exitosa)', 'the build succeeded'),
  phrase('compila (?:correttamente|con successo|senza errori|correctamente|sin errores)', 'compiles successfully'),
  phrase('(?:il |la |el )?(?:compito|attività|tarea) (?:è |está )?(?:ora |ahora )?(?:complet|terminad|finit)\\p{L}+', 'task is complete'),
  phrase('(?:è |sta |está )?(?:ora |adesso |ahora )?(?:in riproduzione|suonando|riproducendo|reproduciendo|sonando)', 'is now playing'),
  // what is, or is not, there
  phrase('non esist\\p{L}+', 'does not exist'), phrase('no exist\\p{L}+', 'does not exist'),
  phrase('non (?:è|sono) present\\p{L}+', 'not present'), phrase('(?:è|sono|está|están) vuot\\p{L}+', 'is empty'), phrase('(?:está|están) vací\\p{L}+', 'is empty'),
  // what cannot be done, or is not working
  phrase('non sono in grado di', 'unable to'), phrase('no soy capaz de', 'unable to'),
  phrase('non ho (?:(?:uno|alcuno|nessuno) )?(?:strumento|modo) per', 'no tool to'), phrase('no tengo (?:ninguna |una )?(?:herramienta|forma) (?:para|de)', 'no tool to'),
  phrase('non (?:riesco|posso|riesce|pu[oò])(?: a)?', 'cannot'), phrase('no (?:puedo|puede)', 'cannot'),
  phrase('non (?:funziona|va|funzionano)', 'not working'), phrase('no funciona', 'not working'),
  phrase('non si (?:vede|vedono)', 'not showing'), phrase('non (?:si )?apre', 'not opening'),
  phrase('non (?:parte|si avvia)', 'not starting'), phrase('non (?:si )?carica', 'not loading'),
  // the screen, the mouse and the keyboard
  phrase('cosa vedi', 'what do you see'), phrase('qu[eé] ves', 'what do you see'),
  phrase('(?:riesci a|puoi) vedere', 'can you see'), phrase('(?:riesco a|posso) vedere', 'i can see the'), phrase('puedo ver', 'i can see the'),
  phrase('ecco (?:che )?cosa vedo', 'here is what i see'), phrase('esto es lo que veo', 'here is what i see'),
  phrase('(?:è|sono|está|están) apert[oaie] (?:in|su|con|nel|nella|sul)', 'is open in'), phrase('(?:está|están) abiert[oa]s? en', 'is open in'),
  phrase('barra delle applicazioni', 'taskbar'), phrase('barra de tareas', 'taskbar'), phrase('gestione attività', 'task manager'), phrase('administrador de tareas', 'task manager'),
  phrase('controllare (?:il |la |lo |tuo |tua )*mouse', 'control the mouse'), phrase('controllare (?:il |la |lo |tuo |tua )*tastiera', 'control the keyboard'),
  phrase('controllare (?:il |la |lo |tuo |tua )*(?:pc|computer)', 'control the computer'),
  phrase('controlar (?:el |la |tu )*ratón', 'control the mouse'), phrase('controlar (?:el |la |tu )*teclado', 'control the keyboard'), phrase('controlar (?:el |la |tu )*(?:pc|ordenador)', 'control the computer'),
  phrase('(?:fare|faccio|far[oò]|hacer|hago|har[eé]|haz) clic', 'click'),
  // what comes next, and offers
  phrase('v(?:ai|a) avanti', 'continue'), phrase('por qu[eé]', 'why'), phrase('su internet', 'on the web'),
  phrase('sto per', 'i will'), phrase('procedo (?:a|con|ad)', 'i will'), phrase('voy a', 'i will'), phrase('vamos a', "let's"),
  phrase('lascia(?:mi| che)', 'let me'), phrase('d[eé]jame', 'let me'),
  phrase('(?:tengo|tenemos) que', 'i need to'), phrase('così che', 'so that'),
  opening('(?:vuoi|desideri|preferisci|vuole|volete|quieres|deseas|quiere) que? ?(?:che )?(?:io |yo )?', 'do you want me to '),
  phrase('(?:posso|devo) procedere', 'shall i proceed'), phrase('(?:puedo|debo) continuar', 'shall i proceed'),
  phrase('(?:fammi sapere|dimmi|hazme saber|dime)(?: solo)?', 'let me know'),
  phrase('(?:lo strumento|il tool|la funzione|la herramienta)', 'the'),
  // remembering the chat
  phrase('qu[eé] recuerdas|te acuerdas|recuerdas', 'do you remember'),
  phrase('resum\\p{L}+ (?:esta|la|nuestra) (?:conversación|charla|chat)', 'summarize this chat'),
];

const WORDS = new Map(Object.entries({
  // questions and requests
  cosa: 'what', come: 'how', 'perché': 'why', 'perchè': 'why', perche: 'why', quando: 'when', dove: 'where', chi: 'who', quale: 'which', quali: 'which', qual: 'which',
  quanto: 'how much', quanta: 'how much', quanti: 'how many', quante: 'how many', 'cuánto': 'how much', 'cuántos': 'how many', cual: 'which',
  'è': 'is', sono: 'are', hai: 'did you', ha: 'has', avevi: 'had', era: 'was', 'está': 'is', 'están': 'are', fue: 'was',
  exitoso: 'successful', exitosa: 'successful', compilazione: 'build', 'compilación': 'build',
  puoi: 'can you', potresti: 'could you', riesci: 'can you', potete: 'can you', vorrei: 'i want', voglio: 'i want',
  'qué': 'what', que: 'that', 'cómo': 'how', como: 'how', 'cuándo': 'when', 'dónde': 'where', 'quién': 'who', 'cuál': 'which',
  es: 'is', son: 'are', puedes: 'can you', 'podrías': 'could you', quiero: 'i want', necesito: 'i need',
  // agreeing
  'sí': 'yes', 'sì': 'yes', vale: 'ok', dale: 'go ahead', adelante: 'go ahead', hazlo: 'do it',
  vuoi: 'do you want', quieres: 'do you want', quiere: 'do you want',
  // words that only show the language: they stay as they are
  anche: 'anche', 'già': 'già', 'più': 'più', molto: 'molto', grazie: 'grazie', gracias: 'gracias', 'también': 'también', muy: 'muy', 'aquí': 'aquí', hay: 'hay',
  // whose it is
  questo: 'this', questa: 'this', questi: 'these', queste: 'these', quest: 'this', quello: 'that', quella: 'that',
  mio: 'my', mia: 'my', miei: 'my', mie: 'my', nostro: 'our', nostra: 'our', tuo: 'your', tua: 'your', tuoi: 'your', tue: 'your', tus: 'your',
  il: 'the', lo: 'the', la: 'the', gli: 'the', le: 'the', l: 'the', i: 'the', un: 'a', una: 'a', uno: 'a',
  el: 'the', los: 'the', las: 'the', este: 'this', esta: 'this', estos: 'these', ese: 'that', esa: 'that', mi: 'my', mis: 'my', nuestro: 'our',
  di: 'of', del: 'of the', della: 'of the', dello: 'of the', dei: 'of the', delle: 'of the', dell: 'of the', de: 'of',
  nel: 'in the', nella: 'in the', nei: 'in the', nelle: 'in the', nell: 'in the', al: 'to the', alla: 'to the', allo: 'to the', alle: 'to the', all: 'to the',
  sul: 'on the', sullo: 'on the', sulla: 'on the', sui: 'on the', sulle: 'on the', sull: 'on the',
  per: 'for', para: 'for', con: 'with', che: 'that', e: 'and', ed: 'and', y: 'and', o: 'or', ma: 'but', pero: 'but',
  // something is wrong, or is not so
  non: 'not', no: 'not', mai: 'never', nunca: 'never', nulla: 'nothing', niente: 'nothing', nada: 'nothing',
  potrei: 'could', potrebbe: 'could', 'podría': 'could', dovrei: 'should', dovrebbe: 'should', 'debería': 'should',
  ancora: 'still', 'todavía': 'still', 'aún': 'still', stesso: 'same', stessa: 'same', mismo: 'same',
  errore: 'error', errori: 'errors', problema: 'problem', rotto: 'broken', rotta: 'broken', roto: 'broken',
  sbagliato: 'wrong', sbagliata: 'wrong', manca: 'missing', mancano: 'missing', mancante: 'missing', falta: 'missing',
  vuoto: 'empty', vuota: 'empty', 'vacío': 'empty', bianco: 'white', bianca: 'white',
  fallisce: 'fails', falla: 'fails', lento: 'slow', lenta: 'slow', veloce: 'fast', 'rápido': 'fast',
  // what is made or changed
  crea: 'create', creare: 'create', creami: 'create', crei: 'create', creo: 'create', creiamo: 'create', crear: 'create',
  fai: 'make', fammi: 'make', fare: 'make', facciamo: 'make', haz: 'make', hazme: 'make', hacer: 'make',
  sito: 'website', siti: 'websites', sitio: 'website', pagina: 'page', pagine: 'pages', 'página': 'page', 'páginas': 'pages',
  codice: 'code', 'código': 'code', archivo: 'file', archivos: 'files', documento: 'document', documenti: 'documents',
  programma: 'program', programmi: 'programs', programa: 'program', 'funzionalità': 'feature', funcionalidad: 'feature',
  modulo: 'module', moduli: 'modules', gioco: 'game', giochi: 'games', juego: 'game',
  bottone: 'button', bottoni: 'buttons', 'botón': 'button', ajustes: 'settings', configurazione: 'settings', 'configuración': 'settings',
  sicurezza: 'security', seguridad: 'security', rendimiento: 'performance', stile: 'style', stili: 'styles', estilo: 'style',
  grafica: 'design', 'diseño': 'design', scuro: 'dark', scura: 'dark', oscuro: 'dark', chiaro: 'light', chiara: 'light', claro: 'light',
  'modalità': 'mode', modo: 'mode', tema: 'theme', leggimi: 'readme', dati: 'data', datos: 'data', tabella: 'table', tabla: 'table',
  messaggio: 'message', mensaje: 'message', prueba: 'test', pruebas: 'tests', prova: 'test', sigue: 'continue', 'continúa': 'continue', continua: 'continue', continuare: 'continue',
  compito: 'task', tarea: 'task',
  // the screen, the mouse and the keyboard
  vedo: 'i see the', veo: 'i see the', vedere: 'see', ver: 'see', guarda: 'look at', mira: 'look at', mostra: 'shows', visualizza: 'shows', muestra: 'shows',
  schermo: 'screen', schermata: 'screen', pantalla: 'screen', finestra: 'window', ventana: 'window', scheda: 'tab', 'pestaña': 'tab',
  escritorio: 'desktop', navegador: 'browser', sfondo: 'wallpaper', interfaccia: 'interface', interfaz: 'interface',
  tastiera: 'keyboard', teclado: 'keyboard', 'ratón': 'mouse', invio: 'enter',
  premere: 'press', premo: 'i press', premi: 'press', 'premerò': 'i will press', pulsar: 'press', pulso: 'i press', presionar: 'press',
  scorrere: 'scroll', scorro: 'i scroll', scrollare: 'scroll', desplazar: 'scroll', usare: 'use', uso: 'i use', usar: 'use',
  clicco: 'i click', digito: 'i type', leer: 'read', lee: 'read',
  // what comes next
  ora: 'now', adesso: 'now', ahora: 'now', poi: 'next', dopo: 'next', luego: 'next', 'después': 'next', quindi: 'so', entonces: 'so',
  innanzitutto: 'first', primero: 'first', vediamo: "let's", procediamo: "let's", devo: 'i need to', debo: 'i need to', dobbiamo: 'we need to', debemos: 'we need to',
  posso: 'i can', puedo: 'i can', ecco: 'here is',
}));

// What was done: "corretto", "aggiunta", "actualizado". Checked before the word beginnings below.
const DONE = [
  [/^(?:corrett|sistemat|riparat|risolt|aggiustat)[oaie]$|^(?:corregid|arreglad|solucionad|reparad)[oa]s?$/, 'fixed'],
  [/^aggiunt[oaie]$|^(?:añadid|agregad)[oa]s?$/, 'added'],
  [/^spostat[oaie]$|^movid[oa]s?$/, 'moved'],
  [/^cambiat[oaie]$|^cambiad[oa]s?$/, 'changed'],
  [/^modificat[oaie]$|^modificad[oa]s?$/, 'modified'],
  [/^aggiornat[oaie]$|^actualizad[oa]s?$/, 'updated'],
  [/^(?:rimoss|eliminat|tolt|cancellat)[oaie]$|^(?:eliminad|borrad|quitad)[oa]s?$/, 'removed'],
  [/^sostituit[oaie]$|^(?:reemplazad|sustituid)[oa]s?$/, 'replaced'],
  [/^riscritt[oaie]$|^reescrit[oa]s?$/, 'rewrote'],
  [/^(?:creat|scritt|generat|salvat)[oaie]$|^(?:cread|escrit|generad|guardad)[oa]s?$/, 'created'],
  [/^inserit[oaie]$|^insertad[oa]s?$/, 'inserted'],
  [/^ricostruit[oaie]$|^reconstruid[oa]s?$/, 'rebuilt'],
  [/^costruit[oaie]$|^construid[oa]s?$/, 'built'],
  [/^compilat[oaie]$|^compilad[oa]s?$/, 'compiled'],
  [/^apert[oaie]$|^abiert[oa]s?$/, 'opened'],
  [/^avviat[oaie]$|^iniciad[oa]s?$/, 'started'],
  [/^cliccat[oaie]$/, 'clicked'], [/^cercat[oaie]$|^buscad[oa]s?$/, 'searched'], [/^riprodott[oaie]$|^reproducid[oa]s?$/, 'played'],
  [/^digitat[oaie]$|^teclead[oa]s?$/, 'typed'], [/^premut[oaie]$|^pulsad[oa]s?$|^presionad[oa]s?$/, 'pressed'], [/^scrollat[oaie]$/, 'scrolled'],
  [/^(?:usat|utilizzat)[oaie]$|^(?:usad|utilizad)[oa]s?$/, 'used'], [/^chiamat[oaie]$|^llamad[oa]s?$/, 'called'], [/^eseguit[oaie]$|^ejecutad[oa]s?$/, 'executed'],
];

// Word beginnings: Italian and Spanish verbs change their endings ("aggiungi", "aggiungere").
// `plain` marks the ones an English word also begins with: they do not show the language.
const STEMS = [
  [/^aggiun|^añad|^agreg/, 'add'],
  [/^corregg|^corrett|^sistem|^ripar|^risolv|^risolt|^aggiust|^arregl|^corrig|^corrij|^correg|^solucion/, 'fix'],
  [/^realizz|^costruisc|^costruir|^construy/, 'build'],
  [/^scriv|^scritt|^escrib/, 'write'],
  [/^modific/, 'change', true], [/^cambi/, 'change'],
  [/^aggiorn|^actualiz/, 'update'],
  [/^miglior|^mejor/, 'improve'],
  [/^ottimizz|^velocizz/, 'optimize'], [/^optimiz/, 'optimize', true],
  [/^rimuov|^rimoss|^togli|^borra/, 'remove'], [/^elimin/, 'remove', true], [/^cancell/, 'delete', true],
  [/^rinomin|^renombr/, 'rename'],
  [/^spieg/, 'explain'], [/^explica/, 'explain'],
  [/^riassum|^riassunt/, 'summarize'],
  [/^analizz/, 'analyze'], [/^analiza/, 'analyze'],
  [/^controll/, 'check', true], [/^verific/, 'check', true], [/^revision|^revisa/, 'review', true],
  [/^cerc[ah]|^busc/, 'search'], [/^trov|^encuentr/, 'find'],
  [/^legg[ei]/, 'read'], [/^elenc/, 'list'],
  [/^organizz|^riordin/, 'organize'], [/^organiz/, 'organize', true],
  [/^compil/, 'compile', true], [/^document/, 'document', true], [/^test/, 'test', true],
  [/^rifattorizz|^refactoriz/, 'refactor'], [/^ridisegn|^rediseñ/, 'redesign'],
  [/^pulisc|^pulir|^limpia/, 'clean'], [/^instal/, 'install', true], [/^salv[ai]/, 'save', true],
  [/^esegu|^avvi[ao]|^ejecut/, 'run'], [/^continu/, 'continue', true], [/^prosegu/, 'continue'], [/^riprov/, 'try again'],
  [/^traduc|^tradur|^tradott/, 'translate'], [/^confront/, 'compare', true], [/^compar/, 'compare', true],
  [/^progett|^proyecto/, 'project'], [/^cartell|^carpeta/, 'folder'],
  [/^applicazion|^aplicaci/, 'app'], [/^funzion[ei]$/, 'function'], [/^class[ei]$/, 'class', true], [/^component[ei]$/, 'component'],
  [/^pulsant/, 'button'], [/^impostazion/, 'settings'], [/^prestazion/, 'performance'], [/^immagin[ei]$|^imagen/, 'image'], [/^contatt|^contacto/, 'contact'],
  [/^clicc/, 'click'], [/^digit(?:are|o|i|a|erò|ando)$|^teclea/, 'type'],
];
// "aggiungerò", "leggerò", "crearé": what the writer is about to do.
const WILL_RE = /^\p{L}{3,}(?:erò|irò|arò|rrò|aré|eré|iré)$/u;

// Words English shares with Italian or Spanish: they do not show which language a text is in.
// ("in" is left out of the English words below for the same reason: "correggi il bug in main.cpp".)
const SHARED = new Set(['come', 'como', 'dove', 'chi', 'i', 'il', 'no', 'es', 'son', 'ha', 'era', 'le', 'la', 'lo', 'los', 'las', 'mi', 'mis', 'mia', 'e', 'o', 'y', 'un', 'uno', 'de', 'di', 'del', 'al', 'all', 'l',
  'per', 'con', 'que', 'ma', 'ese', 'esa', 'el', 'dell', 'nell', 'sull', 'quest', 'tema', 'modo', 'modulo', 'fare', 'problema', 'programa', 'nada', 'lento', 'stile', 'claro', 'tabla',
  'ver', 'mira', 'mostra', 'uso', 'usar', 'ora', 'poi', 'tus', 'tue', 'mai', 'pulso', 'premi', 'lee']);
const ENGLISH = new Set(('the this that these those my our your is are was were do does did has have had with for and of to you please it what how why when where which who can '
  + 'could would should will not on at from into make create add fix write change update remove delete').split(' '));
// Spanish, as against Italian: "se" is "if" in one and part of the verb in the other.
const SPANISH = new Set(['el', 'los', 'las', 'y', 'he', 'hemos', 'han', 'está', 'están', 'para', 'por', 'qué', 'cómo', 'pero', 'también', 'ya', 'archivo', 'archivos', 'página', 'código', 'este', 'esto',
  'muy', 'más', 'aquí', 'ahora', 'sí', 'hay', 'puedo', 'quiero', 'necesito', 'hacer', 'sitio', 'en', 'es', 'una', 'del', 'con']);
const ITALIAN = new Set(['il', 'gli', 'della', 'delle', 'dello', 'nel', 'nella', 'non', 'è', 'sono', 'ho', 'hai', 'questo', 'questa', 'che', 'anche', 'già', 'più', 'perché', 'sito', 'pagina', 'codice',
  'di', 'per', 'ora', 'adesso', 'ecco', 'posso', 'voglio', 'vorrei', 'fare', 'ed', 'una', 'del', 'con', 'e']);

function gloss(word) {
  if (WORDS.has(word)) return { english: WORDS.get(word), shows: !SHARED.has(word) };
  if (word.length < 4) return null;
  const done = DONE.find(([pattern]) => pattern.test(word));
  if (done) return { english: done[1], shows: true };
  const stem = STEMS.find(([pattern]) => pattern.test(word));
  if (WILL_RE.test(word)) return { english: stem ? `i will ${stem[1]}` : 'i will', shows: true };
  return stem ? { english: stem[1], shows: !stem[2] } : null;
}

// A word standing on its own: not part of a file name, a path, or an identifier.
const WORD_RE = /(?<![\p{L}\p{N}_.\\/-])\p{L}+(?![\p{L}\p{N}_\\/-]|\.[\p{L}\p{N}])/gu;

function latinGist(source) {
  let foreign = 0;
  let english = 0;
  let spanish = 0;
  let italian = 0;
  const list = [];
  for (const match of source.toLowerCase().matchAll(WORD_RE)) {
    const word = match[0];
    list.push(word);
    if (SPANISH.has(word)) spanish += 1;
    if (ITALIAN.has(word)) italian += 1;
    if (ENGLISH.has(word)) english += 1;
    else if (gloss(word)?.shows) foreign += 1;
  }
  // French joins a verb to what follows with a dash ("vois-tu", "dis-moi"); a word before a dash is
  // otherwise left alone, as part of a name ("my-file").
  for (const match of source.toLowerCase().matchAll(/(?<![\p{L}\p{N}_.\\/-])(\p{L}+)-(?:tu|vous|je|moi|nous|ils?|elles?|le|la|les)(?![\p{L}\p{N}_-])/gu)) list.push(match[1]);
  // French, German or Portuguese, when the text has more of that language's own small words than
  // of Italian's or Spanish's; with as many (a short text often has none), more words it knows.
  const [other, best] = Object.entries(languageScores(list)).sort((a, b) => b[1].marks - a[1].marks || b[1].shown - a[1].shown)[0];
  const mine = Math.max(spanish, italian);
  if (best.marks > mine || (best.marks === mine && best.shown > foreign)) {
    const read = gistIn(other, source, list, { english: (word) => ENGLISH.has(word), wordRe: WORD_RE });
    if (read !== source) return read;
  }
  if (!foreign || foreign <= english) return source;
  // A phrase already put in English is set aside while the single words are read: its "i" is not
  // the Italian article.
  const kept = [];
  let result = source.replace(/[¿¡]/g, '');
  for (const [pattern, english] of PHRASES) result = result.replace(pattern, () => `\uE000${kept.push(english) - 1}\uE001`);
  const isSpanish = spanish > italian;
  return result
    .replace(WORD_RE, (word) => {
      const lower = word.toLowerCase();
      if (lower === 'se') return isSpanish ? '' : 'if';
      if (lower === 'si') return isSpanish ? 'if' : word;
      return gloss(lower)?.english ?? word;
    })
    .replace(/\uE000(\d+)\uE001/g, (_mark, index) => kept[Number(index)])
    // "il mio sito" is "my website", not "the my website".
    .replace(/\b(?:the )+(my|your|our)\b/gi, '$1')
    .replace(/\bthe the\b/gi, 'the')
    .replace(/ {2,}/g, ' ');
}

// ---- Chinese and Japanese: no spaces between words, so the words are looked for inside the text ----

const CJK = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff々';
const HAS_CJK_RE = new RegExp(`[${CJK}]`);
const CJK_REST_RE = new RegExp(`[${CJK}]+`, 'g');

// What was done, by the verb: "已修复", "我添加了", "修正しました", "更新されました".
const ZH_DONE = {
  修复: 'fixed', 修復: 'fixed', 修正: 'fixed', 解决: 'fixed', 解決: 'fixed', 修好: 'fixed', 添加: 'added', 增加: 'added', 新增: 'added', 加入: 'added',
  移动: 'moved', 移動: 'moved', 更改: 'changed', 修改: 'modified', 更新: 'updated', 删除: 'removed', 刪除: 'removed', 移除: 'removed',
  替换: 'replaced', 替換: 'replaced', 重写: 'rewrote', 重寫: 'rewrote', 创建: 'created', 創建: 'created', 新建: 'created', 建立: 'created', 生成: 'created',
  编写: 'created', 編寫: 'created', 写入: 'created', 寫入: 'created', 保存: 'updated', 儲存: 'updated', 插入: 'inserted',
  重新构建: 'rebuilt', 重新構建: 'rebuilt', 构建: 'built', 構建: 'built', 编译: 'compiled', 編譯: 'compiled',
  打开: 'opened', 打開: 'opened', 播放: 'played', 点击: 'clicked', 點擊: 'clicked', 搜索: 'searched', 搜尋: 'searched', 启动: 'started', 啟動: 'started',
  使用: 'used', 调用: 'called', 調用: 'called', 运行: 'ran', 運行: 'ran', 执行: 'executed', 執行: 'executed',
  输入: 'typed', 輸入: 'typed', 按下: 'pressed', 滚动: 'scrolled', 滾動: 'scrolled',
};
const JA_DONE = {
  修正: 'fixed', 修復: 'fixed', 直し: 'fixed', 解決: 'fixed', 追加: 'added', 移動: 'moved', 変更: 'changed', 更新: 'updated', 削除: 'removed',
  置き換え: 'replaced', 置換: 'replaced', 書き換え: 'rewrote', 書き直し: 'rewrote', 作成: 'created', 生成: 'created', 保存: 'updated', 挿入: 'inserted',
  再ビルド: 'rebuilt', ビルド: 'built', コンパイル: 'compiled', 開き: 'opened', 再生: 'played', クリック: 'clicked', 検索: 'searched', 起動: 'started', 開始: 'started',
  使用: 'used', 使い: 'used', 呼び出し: 'called', 実行: 'executed', 入力: 'typed', 押し: 'pressed', スクロール: 'scrolled',
};
const byLength = (words) => Object.keys(words).sort((a, b) => b.length - a.length).join('|');
const ZH_VERBS = byLength(ZH_DONE);
const JA_VERBS = byLength(JA_DONE);

// Checked in this order on each sentence; the English goes to the front of the sentence, where the
// checks expect a question word ("这个项目是什么" is "what … this project"), and the match is removed.
// A third pattern, when given, must also be found in the sentence.
const LEADS = [
  // remembering the chat
  [/(?:你|您)?(?:还|還)?(?:记得|記得)[^.?!]*|覚えて(?:い)?(?:ますか|る)[^.?!]*/, 'do you remember'],
  [/(?:总结|總結|概括)[^.?!]*(?:对话|對話|聊天|会话|會話)|(?:会話|チャット|やり取り)[^.?!]*(?:要約|まとめ)[^.?!]*/, 'summarize this chat'],
  // the screen
  [/(?:能|可以)?(?:看到|看见|看見)了?(?:什么|什麼)|何が見え(?:ますか|る|ていますか)/, 'what do you see'],
  [/見え(?:ますか|ていますか)|見られますか/, 'can you see'],
  // why, how, what
  [/为什么|為什麼|为何|為何|なぜ|どうして/, 'why'],
  [/怎么样|怎麼樣|怎么|怎麼|如何|怎样|怎樣|どうやって|どのように|どうすれば|どう(?=し|す|や|な)/, 'how'],
  [/什么时候|什麼時候|何时|何時|いつ(?=.*か)/, 'when'],
  [/哪里|哪裡|在哪|どこ/, 'where'],
  [/哪个|哪個|哪些|どれ|どの|どちら/, 'which'],
  [/谁|誰|だれ/, 'who'],
  [/多少|几个|幾個|いくつ/, 'how many'],
  [/是什么|是什麼|什么|什麼|は何(?:です)?か?|何です?か|何を|何が|なにを/, 'what'],
  // "can you …?", offers, and yes-or-no questions
  [/(?:你|您)?(?:能不能|可不可以|能否|可以|(?<![性功可智技本才效職职])能)(?=[^.!]*(?:吗|嗎|\?))|(?:でき|もらえ|くれ|いただけ)(?:ますか|ませんか|る\?)/, 'can you'],
  [/(?:し|いたし)ましょうか|よろしい(?:です|でしょう)か|(?:して|しても)(?:も)?(?:いい|よい|良い)ですか/, 'shall i'],
  [/了(?:吗|嗎|没有|沒有|没|沒)(?=\s*\?|\s*$)|(?:し|き|り|い|え|っ|け|げ|べ|め|ち|み|ぎ|れ|せ|て)?ましたか|たのですか/, 'did you'],
  [/(?:吗|嗎|呢)(?=\s*\?|\s*$)|是否|有没有|有沒有|是不是|(?:です|ます|でしょう|の)か(?=\s*\?|\s*$)/, 'is'],
  // statements whose key word comes last in Japanese
  [/(?:することが|ことが|は)?(?:でき(?:ません|ない)|出来(?:ません|ない)|不可能です)/, 'cannot'],
  [/(?:が|を|は)?(?:見えます|見えています|見ています|確認できます)/, 'i see the'],
  [/(?:に|には|上に|上には|で|では)?[^.!?]*?(?:表示されて(?:い)?ます|映って(?:い)?ます)/, 'the screen shows', /画面|スクリーン|デスクトップ|ウィンドウ|ページ|ブラウザ/],
  [/(?:してみます|していきます|しましょう)(?=\s*[.!]?\s*$)/, 'i will'],
  // "〜します" is also how Japanese says what a thing does ("この関数は画面を更新します"): it is a
  // next step only in a sentence that starts like one.
  [/(?<!お願い|お願いいた|ありがとうござい)(?:いたします|します|する必要があります|必要があります)(?=\s*[.!]?\s*$)/, 'i will', /^\s*(?:次に|まず|最初に|では|それでは|これから|今から|続いて)/],
];

// Replaced before the single words: a claim is told from a plan by what stands around the verb.
const CJK_PATTERNS = [
  // "read_file を使用しました": the tool comes first in Japanese.
  [/([a-z][a-z_]+)\s*(?:ツール)?を(?:使用し|使い|実行し|呼び出し)ました/g, ' i used $1 '],
  [/(?:构建|構建|编译|編譯|建置)(?:已经|已經|已)?(?:成功|完成|通过|通過)|ビルド(?:に|が|は)?(?:成功|完了)(?:しました)?|コンパイル(?:に|が|は)?成功(?:しました)?/g, ' the build succeeded '],
  [/(?:任务|任務)(?:已经|已經|已|现在|現在)*完成了?|タスク(?:は|が)?完了(?:しました)?/g, ' task is complete '],
  [/正在播放|再生中(?:です)?|再生して(?:い)?ます/g, ' is now playing '],
  [/不存在|並不存在|存在しません|存在しない/g, ' does not exist '],
  [/未找到|找不到|没有找到|沒有找到|没找到|沒找到|見つかりません(?:でした)?|見つからない/g, ' not found '],
  [/为空|為空|是空的|空です|空になっています/g, ' is empty '],
  // "我已经修复了", "已更新", "我添加了": said as done. "i fixed" is what every check accepts.
  [new RegExp(`(?:我们|我們|我)?(?:已经|已經|已|刚刚|剛剛|刚才|剛才|刚|剛)(?:成功)?(${ZH_VERBS})(?:了|好了|完成|完毕|完畢)?`, 'g'), (_all, verb) => ` i ${ZH_DONE[verb]} `],
  [new RegExp(`(?:我们|我們|我)(?:成功)?(${ZH_VERBS})(?:了|好了|完成了)`, 'g'), (_all, verb) => ` i ${ZH_DONE[verb]} `],
  [new RegExp(`(${ZH_VERBS})(?:完成|完毕|完畢|好了)`, 'g'), (_all, verb) => ` has been ${ZH_DONE[verb]} `],
  [new RegExp(`(${JA_VERBS})(?:を)?(?:さ)?れ(?:ました|ています)`, 'g'), (_all, verb) => ` has been ${JA_DONE[verb]} `],
  [new RegExp(`(${JA_VERBS})(?:を)?(?:し|いたし)?(?:ました|済みです|済み|完了しました|終わりました)`, 'g'), (_all, verb) => ` i ${JA_DONE[verb]} `],
  // offers and what comes next
  [/是否需要我|需不需要我|要不要我|需要我|你想让我|你想讓我|您希望我|你希望我|要我/g, ' do you want me to '],
  [/让我们|讓我們|我们来|我們來/g, " let's "],
  [/让我|讓我/g, ' let me '],
  [/我们需要|我們需要/g, ' we need to '],
  [/我需要|我得|需要先/g, ' i need to '],
  [/接下来我|接下來我|现在我|現在我|我来|我來|我将|我將|我会|我會|我要|我打算/g, ' i will '],
  [/告诉我|告訴我|教えてください/g, ' let me know '],
  // seeing the screen
  [/我(?:可以|能)?(?:看到|看见|看見)了?/g, ' i see the '],
  [/(?:屏幕|螢幕|页面|頁面|窗口|視窗|截图|截圖|桌面)上?(?:显示|顯示)/g, ' the screen shows '],
  [/(?:看看|看一下|查看|看)(?=我的)|を見て(?:ください)?/g, ' look at '],
  [/控制(?:你的|您的|我的)?(鼠标|滑鼠|键盘|鍵盤|电脑|電腦)/g, ' control the $1 '],
];

const CJK_WORDS = {
  // what to do
  修复: 'fix', 修復: 'fix', 修正: 'fix', 解决: 'fix', 解決: 'fix', 修好: 'fix', 直し: 'fix', 直す: 'fix', 直して: 'fix',
  添加: 'add', 增加: 'add', 加上: 'add', 新增: 'add', 加入: 'add', 追加: 'add', 足し: 'add',
  创建: 'create', 創建: 'create', 新建: 'create', 建立: 'create', 生成: 'create', 制作: 'create', 製作: 'create', 做一个: 'make', 做一個: 'make', 做个: 'make', 做個: 'make',
  作成: 'create', 作って: 'make', 作り: 'make', 作る: 'make', 作っ: 'make',
  编写: 'write', 編寫: 'write', 撰写: 'write', 撰寫: 'write', 写: 'write', 寫: 'write', 書い: 'write', 書き: 'write', 書く: 'write', 記述: 'write',
  修改: 'change', 更改: 'change', 改成: 'change', 改为: 'change', 改為: 'change', 变更: 'change', 變更: 'change', 変更: 'change', 変え: 'change',
  更新: 'update', アップデート: 'update', 改进: 'improve', 改進: 'improve', 改善: 'improve', 改良: 'improve', 优化: 'optimize', 優化: 'optimize', 最適化: 'optimize',
  删除: 'remove', 刪除: 'remove', 移除: 'remove', 去掉: 'remove', 削除: 'remove', 消し: 'remove', 重命名: 'rename', リネーム: 'rename',
  解释: 'explain', 解釋: 'explain', 说明: 'explain', 說明: 'explain', 讲解: 'explain', 説明: 'explain', 解説: 'explain',
  总结: 'summarize', 總結: 'summarize', 概括: 'summarize', 摘要: 'summarize', 要約: 'summarize', まとめ: 'summarize',
  分析: 'analyze', 解析: 'analyze', 检查: 'check', 檢查: 'check', 查看: 'check', 看看: 'check', 確認: 'check', チェック: 'check', 調べ: 'check',
  审查: 'review', 審查: 'review', 评审: 'review', レビュー: 'review',
  搜索: 'search', 搜尋: 'search', 查找: 'search', 查询: 'search', 查詢: 'search', 検索: 'search', 探し: 'search',
  找到: 'find', 找出: 'find', 寻找: 'find', 尋找: 'find', 見つけ: 'find',
  读取: 'read', 讀取: 'read', 阅读: 'read', 閱讀: 'read', 読ん: 'read', 読み: 'read', 読む: 'read',
  列出: 'list', 一覧: 'list', 列挙: 'list', 整理: 'organize',
  编译: 'compile', 編譯: 'compile', コンパイル: 'compile', 构建: 'build', 構建: 'build', 建置: 'build', ビルド: 'build',
  测试: 'test', 測試: 'test', テスト: 'test', 重构: 'refactor', 重構: 'refactor', リファクタ: 'refactor',
  重新设计: 'redesign', 重新設計: 'redesign', 再設計: 'redesign', リデザイン: 'redesign', 清理: 'clean', クリーンアップ: 'clean',
  安装: 'install', 安裝: 'install', インストール: 'install', 保存: 'save', 儲存: 'save',
  运行: 'run', 運行: 'run', 执行: 'run', 執行: 'run', 実行: 'run', 起動: 'run',
  继续: 'continue', 繼續: 'continue', 接着: 'continue', 続け: 'continue', 続き: 'continue', 続行: 'continue',
  重试: 'try again', 重試: 'try again', 再试: 'try again', 再試: 'try again', もう一度: 'try again', 再試行: 'try again', やり直: 'try again',
  翻译: 'translate', 翻譯: 'translate', 翻訳: 'translate', 比较: 'compare', 比較: 'compare', 对比: 'compare', 對比: 'compare', 比べ: 'compare',
  打开: 'open', 打開: 'open', 開い: 'open', 開き: 'open', 開く: 'open', 開け: 'open', 下载: 'download', 下載: 'download', ダウンロード: 'download',
  移动: 'move', 移動: 'move', 替换: 'replace', 替換: 'replace', 置き換え: 'replace', 置換: 'replace', 插入: 'insert', 挿入: 'insert',
  重写: 'rewrite', 重寫: 'rewrite', 書き換え: 'rewrite', 書き直: 'rewrite', 提交: 'commit', コミット: 'commit',
  调试: 'debug', 調試: 'debug', 除错: 'debug', 偵錯: 'debug', デバッグ: 'debug', 实现: 'implement', 實現: 'implement', 实作: 'implement', 實作: 'implement', 実装: 'implement',
  使用: 'use', 调用: 'call', 調用: 'call',
  // what it is about
  网站: 'website', 網站: 'website', 网页: 'web page', 網頁: 'web page', ウェブサイト: 'website', サイト: 'website', ホームページ: 'website',
  页面: 'page', 頁面: 'page', ウェブページ: 'web page', ページ: 'page',
  项目: 'project', 專案: 'project', 工程: 'project', プロジェクト: 'project',
  文件夹: 'folder', 資料夾: 'folder', 目录: 'folder', 目錄: 'folder', フォルダー: 'folder', フォルダ: 'folder', ディレクトリ: 'folder',
  文件: 'file', 檔案: 'file', ファイル: 'file', 文档: 'document', 文檔: 'document', 文書: 'document', ドキュメント: 'document',
  代码: 'code', 代碼: 'code', 程式碼: 'code', 源码: 'code', 原始碼: 'code', コード: 'code', ソース: 'code',
  应用程序: 'app', 應用程式: 'app', 应用: 'app', 應用: 'app', 程序: 'program', 程式: 'program', 软件: 'program', 軟體: 'program',
  アプリケーション: 'app', アプリ: 'app', プログラム: 'program',
  函数: 'function', 函數: 'function', 函式: 'function', 関数: 'function', メソッド: 'function', 模块: 'module', 模組: 'module', モジュール: 'module',
  组件: 'component', 組件: 'component', 元件: 'component', コンポーネント: 'component',
  游戏: 'game', 遊戲: 'game', ゲーム: 'game', 按钮: 'button', 按鈕: 'button', ボタン: 'button',
  设置: 'settings', 設置: 'settings', 設定: 'settings', 设定: 'settings', 配置: 'settings',
  安全: 'security', セキュリティ: 'security', 性能: 'performance', 效能: 'performance', パフォーマンス: 'performance',
  图片: 'image', 圖片: 'image', 图像: 'image', 圖像: 'image', 画像: 'image', 样式: 'style', 樣式: 'style', スタイル: 'style',
  设计: 'design', 設計: 'design', デザイン: 'design', 深色: 'dark', 暗色: 'dark', 暗黑: 'dark', ダーク: 'dark', 浅色: 'light', 淺色: 'light', 亮色: 'light', ライト: 'light',
  模式: 'mode', モード: 'mode', 主题: 'theme', 主題: 'theme', テーマ: 'theme',
  数据库: 'database', 資料庫: 'database', データベース: 'database', 数据: 'data', 數據: 'data', データ: 'data', 表格: 'table', テーブル: 'table',
  消息: 'message', 訊息: 'message', メッセージ: 'message', 脚本: 'script', 腳本: 'script', 指令碼: 'script', スクリプト: 'script',
  错误: 'error', 錯誤: 'error', 报错: 'error', 報錯: 'error', エラー: 'error', 漏洞: 'bug', 缺陷: 'bug', バグ: 'bug', 不具合: 'bug',
  崩溃: 'crash', 崩潰: 'crash', 闪退: 'crash', 當機: 'crash', クラッシュ: 'crash', 问题: 'problem', 問題: 'problem',
  仓库: 'repository', 倉庫: 'repository', リポジトリ: 'repository', 自述文件: 'readme', 单元测试: 'unit test', 單元測試: 'unit test',
  对话: 'chat', 對話: 'chat', 聊天: 'chat', 会話: 'chat', チャット: 'chat', 任务: 'task', 任務: 'task', タスク: 'task',
  // the screen, the mouse and the keyboard
  屏幕: 'the screen', 螢幕: 'the screen', 画面: 'the screen', スクリーン: 'the screen', 桌面: 'the desktop', デスクトップ: 'the desktop',
  窗口: 'the window', 視窗: 'the window', ウィンドウ: 'the window', 浏览器: 'the browser', 瀏覽器: 'the browser', ブラウザー: 'the browser', ブラウザ: 'the browser',
  标签页: 'the tab', 分頁: 'the tab', タブ: 'the tab', 显示器: 'the monitor', 顯示器: 'the monitor', モニター: 'the monitor', ディスプレイ: 'the display',
  任务栏: 'taskbar', 工作列: 'taskbar', タスクバー: 'taskbar', 壁纸: 'wallpaper', 桌布: 'wallpaper', 壁紙: 'wallpaper',
  界面: 'interface', 介面: 'interface', 截图: 'the screenshot', 截圖: 'the screenshot', スクリーンショット: 'the screenshot',
  鼠标: 'mouse', 滑鼠: 'mouse', マウス: 'mouse', 键盘: 'keyboard', 鍵盤: 'keyboard', キーボード: 'keyboard',
  电脑: 'computer', 電腦: 'computer', パソコン: 'computer', コンピューター: 'computer', コンピュータ: 'computer',
  看到: 'see', 看见: 'see', 看見: 'see', 点击: 'click', 點擊: 'click', クリック: 'click', 输入: 'type', 輸入: 'type', 键入: 'type', 打字: 'type', 入力: 'type',
  按下: 'press', 按键: 'press', 押し: 'press', 押す: 'press', 滚动: 'scroll', 滾動: 'scroll', スクロール: 'scroll', 显示: 'shows', 顯示: 'shows',
  // whose it is, and how it is asked
  这个: 'this', 這個: 'this', 这些: 'these', 這些: 'these', 这: 'this', 這: 'this', 那个: 'that', 那個: 'that',
  我们的: 'our', 我們的: 'our', 我的: 'my', 你的: 'your', 您的: 'your',
  この: 'this', これ: 'this', こちら: 'this', その: 'that', それ: 'that', 私たちの: 'our', 私の: 'my', 自分の: 'my', 僕の: 'my', あなたの: 'your',
  请: 'please', 請: 'please', 麻烦: 'please', 麻煩: 'please', 帮我: 'please', 幫我: 'please', 帮忙: 'please', 幫忙: 'please',
  してください: 'please', て下さい: 'please', ください: 'please', お願いします: 'please', お願い: 'please',
  我想要: 'i want', 我希望: 'i want', 我想: 'i want', したい: 'i want', 欲しい: 'i want', ほしい: 'i want', 必要です: 'i need',
  好的: 'ok', 是的: 'yes', 没问题: 'ok', 沒問題: 'ok', はい: 'yes', ええ: 'yes', どうぞ: 'go ahead',
  // something is wrong, or is not so
  无法: 'cannot', 無法: 'cannot', 不能: 'cannot', 没法: 'cannot', 沒法: 'cannot', 没办法: 'cannot', 沒辦法: 'cannot',
  不工作: 'not working', 不起作用: 'not working', 没反应: 'not working', 沒反應: 'not working', 動きません: 'not working', 動かない: 'not working', 動作しない: 'not working', 機能しない: 'not working',
  不显示: 'not showing', 不顯示: 'not showing', 看不到: 'not showing', 看不见: 'not showing', 表示されない: 'not showing', 表示されません: 'not showing', 見えない: 'not showing', 見えません: 'not showing',
  打不开: 'not opening', 打不開: 'not opening', 開かない: 'not opening', 開きません: 'not opening',
  还是: 'still', 還是: 'still', 仍然: 'still', 依然: 'still', まだ: 'still', 同样的: 'same', 同樣的: 'same', 一样的: 'same', 一樣的: 'same', 同じ: 'same',
  坏了: 'broken', 壞了: 'broken', 壊れ: 'broken', 错了: 'wrong', 錯了: 'wrong', 不对: 'wrong', 不對: 'wrong', 間違: 'wrong', おかしい: 'wrong',
  缺少: 'missing', 缺失: 'missing', 丢失: 'missing', 足りない: 'missing', 欠け: 'missing', 不足: 'missing', 空白: 'blank',
  失败: 'failed', 失敗: 'failed', 很慢: 'slow', 遅い: 'slow',
  没有: 'not', 沒有: 'not', 尚未: 'not', 并未: 'not', 並未: 'not', 从未: 'never', 從未: 'never', 还没: 'not', 還沒: 'not', 未: 'not',
  していません: 'not', しておりません: 'not', ていない: 'not', しない: 'not', ません: 'not', なかった: 'not',
  如果: 'if', 假如: 'if', もし: 'if', 場合: 'if', かどうか: 'whether',
  首先: 'first', まず: 'first', 然后: 'next', 然後: 'next', 接下来: 'next', 接下來: 'next', 次に: 'next', 现在: 'now', 現在: 'now',
  // on the web
  上网: 'online', 上網: 'online', 在线: 'online', 線上: 'online', 网上: 'online', 網上: 'online', オンライン: 'online', ネットで: 'online',
  互联网: 'internet', 網際網路: 'internet', インターネット: 'internet', 谷歌: 'google', グーグル: 'google', 最新: 'latest',
};
const CJK_WORDS_RE = new RegExp(Object.keys(CJK_WORDS).sort((a, b) => b.length - a.length).join('|'), 'g');

function cjkSentence(sentence) {
  let lead = '';
  let rest = sentence;
  for (const [pattern, english, also] of LEADS) {
    if (!pattern.test(rest) || (also && !also.test(rest))) continue;
    lead = english;
    rest = rest.replace(pattern, ' ');
    break;
  }
  for (const [pattern, english] of CJK_PATTERNS) rest = rest.replace(pattern, english);
  rest = rest.replace(CJK_WORDS_RE, (word) => ` ${CJK_WORDS[word]} `).replace(CJK_REST_RE, ' ');
  const space = rest.match(/^\s*/)[0];
  return lead ? `${space}${lead} ${rest.slice(space.length)}` : rest;
}

function cjkGist(source) {
  const text = source
    .replace(/[。．]/g, '. ').replace(/！/g, '! ').replace(/？/g, '? ').replace(/[，、]/g, ', ').replace(/[：]/g, ': ').replace(/；/g, '; ')
    .replace(/（/g, ' (').replace(/）/g, ') ').replace(/[「」『』]/g, '"');
  // A sentence ends at a mark followed by a space: the dot in "main.cpp" ends nothing.
  return text.split(/(?<=[.!?](?=\s|$)|\n)/).map(cjkSentence).join('')
    .replace(/\bthe the\b/g, 'the').replace(/[ \t]{2,}/g, ' ').replace(/ ([.,!?;:])/g, '$1').trim();
}

// ---- both ----

// Code is not prose: what stands between ``` fences is left as it is.
const FENCE_RE = /(```[\s\S]*?(?:```|$))/;
let last = { source: '', result: '' };

/**
 * The text with the words Uma's checks look for in English: "correggi il bug in main.cpp" becomes
 * "fix the bug in main.cpp", "我已经修复了" becomes "i fixed". English text, and text in a language
 * not covered, comes back as it is. The result is for Uma's own checks, never for the model or the user.
 */
function englishGist(text) {
  const source = String(text || '');
  if (!source || !/\p{L}/u.test(source)) return source;
  // One reply is checked many times in a row.
  if (source === last.source) return last.result;
  const result = source.split(FENCE_RE).map((part, index) => {
    if (index % 2) return part;
    return HAS_CJK_RE.test(part) ? cjkGist(part) : latinGist(part);
  }).join('');
  last = { source, result };
  return result;
}

/** The text as it was written, and its gist when that differs: what a check should be tried on. */
function readings(text) {
  const source = String(text || '');
  const gist = englishGist(source);
  return gist === source ? [source] : [source, gist];
}

module.exports = { englishGist, readings };
