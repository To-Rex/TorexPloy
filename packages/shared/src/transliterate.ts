/**
 * Uzbek in its other two alphabets, from the Latin text the interface is
 * written in.
 *
 * - Cyrillic (`toUzbekCyrillic`): the 1940–1995 alphabet still read by many.
 *   oʻ → ў, gʻ → ғ, sh → ш, ch → ч, ya/yo/yu/ye → я/ё/ю/е, e → э at the
 *   start of a word or after a vowel, ʼ → ъ, h → ҳ, x → х, q → қ; Russian
 *   loanwords get their Russian spelling back (funksiya → функция,
 *   parol → пароль).
 * - New Latin (`toUzbekNewLatin`): the 2021 alphabet. oʻ → ō, gʻ → ḡ,
 *   sh → ş, ch → ç; nothing else changes.
 *
 * What is not Uzbek stays as is: placeholders (`{name}`), code in
 * backticks, addresses and paths, brand and product names, acronyms, and
 * English words the Uzbek text uses as they are (in Cyrillic, the usual IT
 * words take their Russian-style spelling: deploy → деплой, commit → коммит).
 * A suffix after such a word (`Docker’ga`) is still Uzbek and is converted.
 */

/** Letters of the Uzbek Latin alphabet's "oʻ"/"gʻ" mark, in the forms texts use. */
const TURNED = 'ʻ‘\'`';

/** Spans that are never converted: placeholders, code, links' targets, addresses, paths, e-mails, file names. */
const PROTECTED = new RegExp(
  [
    '\\{\\w+\\}',
    'owner/repo',
    '`[^`]*`',
    '\\]\\([^)]*\\)',
    'https?://[^\\s)\\]»”"]+',
    '[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+',
    '(?<![\\wʻʼ’])(?:~|\\.{0,2})/[\\w./:{}*?=&%~+-]*',
    '(?<![\\wʻʼ’])[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)+(?:/[^\\s)\\]»”"]*)?(?![\\wʻʼ])',
    '(?<=^|\\s)--?[a-z][\\w-]*',
    '\\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\\b',
    '\\b[A-Za-z]+\\d[\\w-]*\\b',
  ].join('|'),
  'g',
);

/** Words kept exactly as written: brands, products, acronyms, commands, external interfaces' labels. */
const KEEP = new Set(
  `
  a ab access account actions activity add advanced aegis aes agile ai airdrop airtable algolia alpine already amazon analytics
  analyze and another ansible anthropic apache api app apps apt archive atlassian authenticator authorization authorized auto
  avatars aws b bash backblaze backend bad bell bitbucket bitwarden body botfather buildpacks buildx by caddy caldav carddav cascade
  cat cd check checklist chrome ci claude cleanup cli clickhouse cline clock cloud cloudflare cmd cms code codex compass compose
  concepts confluence connection connector connectors container cookie cors cpu crash create created crm cron css csv ctrl curl
  cursor custom data database db dbeaver ddl ddos debian debug declined deepseek default desktop detail developer devops diff
  discord dist django dns docker dockerfile domains download drive drop dump edit email embedding encrypt enter enum env erp esc
  etf event events excel exclude explain f fa faq files filestore firefox firewall foreign fork fssl full gantt gb ghcr git gitea
  github gitlab globe go google gpt gpu grafana grid grok group guide gz hammer harbor hard headless health help heroku history
  hmac hook hostname hr html http https hub hugo iana icloud id image imagine incoming increment info insert install ip issue java
  joplin js json k kb key keys latest layers layout let’s lifecycle lines linux list livesync llm localhost loop low mac macos
  maintainer make manga mariadb markdown marketing mb mcp merge merged minimalist minio mode modules mongodb ms multipart mysql n
  native navigation net netlify network newbot nextcloud nexus nginx nixpacks node not notifications notion now npm null oauth
  obsidian ocr office oidc ollama open openai openrouter openssh optimize owner p packages paketo passkey password path pdf pem
  personal pgadmin php pin pkce play playwright ploy policy postgres postgresql powerpoint pr presigned primary private privileged
  procfile production project projects public pull puppeteer put python qr r rabbitmq rag railpack railway ram rawdatabot rclone
  reachable read readme recreate redis refresh refused reindex repositories repository request requests rocket roles rolling root
  rsa rss ruby run rust salesforce saml schedules scopes scout scroll sdk seaweedfs secret security send sensor sentry services
  settings sh sha shell shield shift signature sigv skill slack smtp sock source spa space sparkles sql sqlite ssh ssl sso steps
  stdio storefront streamable subsonic sudo table tar target tb team telegram templates terraform timeout title tls torex torexai
  torexbuilder torexploy totp trace traefik transfer transfers trello trigger troubleshooting truncate tz ubuntu unique update
  updated updater updates upload uploads url used user userinfobot users utc v vacuum var variable versioning vite volume vs
  vscode webdav webhooks webui where wildcard windows windsurf with word wordpress work worker workspace wrench write x xai
  youtube zapier zed zerossl zip
`.split(/\s+/).filter(Boolean),
);

/** English words the Uzbek text uses as its own: kept in the new Latin, spelled as Russian IT does in Cyrillic. */
const CYRILLIC_WORDS: Record<string, string> = {
  backup: 'бэкап',
  backups: 'бэкаплар',
  branch: 'бранч',
  bucket: 'бакет',
  build: 'билд',
  builder: 'билдер',
  buildpack: 'билдпак',
  cache: 'кэш',
  commit: 'коммит',
  config: 'конфиг',
  console: 'консоль',
  deploy: 'деплой',
  endpoint: 'эндпоинт',
  host: 'хост',
  preview: 'превью',
  previews: 'превьюлар',
  proxy: 'прокси',
  push: 'пуш',
  release: 'релиз',
  stack: 'стек',
  style: 'стиль',
  webhook: 'вебхук',
};

/** Russian loanwords whose Cyrillic spelling the Latin does not carry (soft signs, ц, ъ). */
const LOANWORDS: Record<string, string> = {
  avtomobil: 'автомобиль',
  detal: 'деталь',
  distansiya: 'дистанция',
  eksponensial: 'экспоненциал',
  instansiya: 'инстанция',
  inyeksiya: 'инъекция',
  kompyuter: 'компьютер',
  konferensiya: 'конференция',
  konsol: 'консоль',
  kontrol: 'контроль',
  litsenziya: 'лицензия',
  model: 'модель',
  obyekt: 'объект',
  panel: 'панель',
  parol: 'пароль',
  potensial: 'потенциал',
  protsedura: 'процедура',
  protsess: 'процесс',
  protsessor: 'процессор',
  protsent: 'процент',
  retsept: 'рецепт',
  sotsial: 'социал',
  spetsifikatsiya: 'спецификация',
  prinsip: 'принцип',
  profil: 'профиль',
  rol: 'роль',
  stil: 'стиль',
  subyekt: 'субъект',
  yanvar: 'январь',
  fevral: 'февраль',
  aprel: 'апрель',
  iyun: 'июнь',
  iyul: 'июль',
  sentabr: 'сентябрь',
  oktabr: 'октябрь',
  noyabr: 'ноябрь',
  dekabr: 'декабрь',
};

/** Uzbek endings that may follow a word (`webhook·lar·ni`), so a known word is still found under them. */
const SUFFIX = /^(?:lar|ler)?(?:imiz|ingiz|lari|i|si|im|ing|ni)?(?:ning|ni|ga|ka|qa|da|ta|dan|tan|dagi|dagilar|gacha|cha|dek|day|siz|li|lik|lash|langan|chi)?$/;

/** Vowels after which e is written э (аэропорт, поэзия); after и it stays е (клиент, иерархия). */
const VOWELS = 'aeouAEOUаеоуўэяёюАЕОУЎЭЯЁЮ';

const SINGLE: Record<string, string> = {
  a: 'а', b: 'б', c: 'ц', d: 'д', f: 'ф', g: 'г', h: 'ҳ', i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п',
  q: 'қ', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'х', y: 'й', z: 'з',
};

const isUpper = (char: string): boolean => char !== char.toLowerCase() && char === char.toUpperCase();

/** Words that look foreign: letters Uzbek does not use, spellings it does not have, CamelCase, acronyms. */
/** Uzbek words the examples write in capitals (`KALIT=qiymat`): converted like any other. */
const UZBEK_CAPITALS = new Set(['KALIT', 'QIYMAT', 'NOM']);

function looksForeign(word: string): boolean {
  if (/[A-Z]{2,}/.test(word) && word === word.toUpperCase()) return !UZBEK_CAPITALS.has(word);
  if (/[a-z][A-Z]/.test(word)) return true;
  return /c(?!h)|w|th|ph|ck|ee|oo/i.test(word);
}

/** A known foreign word, possibly with Uzbek endings after it: its parts, or null. */
function knownStem(word: string): { stem: string; rest: string } | null {
  const lower = word.toLowerCase();
  for (let end = lower.length; end >= 2; end -= 1) {
    const stem = lower.slice(0, end);
    if (!(KEEP.has(stem) || stem in CYRILLIC_WORDS || stem in LOANWORDS)) continue;
    const rest = lower.slice(end);
    if (rest.length === 0 || SUFFIX.test(rest)) return { stem: word.slice(0, end), rest: word.slice(end) };
  }
  return null;
}

/** Give `text` the capitalisation of `like` (all caps, first capital, or as is). */
function caseLike(text: string, like: string): string {
  if (like.length > 1 && like === like.toUpperCase() && like !== like.toLowerCase()) return text.toUpperCase();
  if (isUpper(like[0] ?? '')) return text.charAt(0).toUpperCase() + text.slice(1);
  return text;
}

/** An Uzbek Latin word, letter by letter, in Cyrillic. */
function cyrillicLetters(word: string): string {
  let out = '';
  const at = (index: number): string => word[index] ?? '';
  for (let index = 0; index < word.length; index += 1) {
    const char = at(index);
    const lower = char.toLowerCase();
    const next = at(index + 1);
    const nextLower = next.toLowerCase();
    const upper = isUpper(char);
    const emit = (cyr: string) => {
      out += upper ? cyr.toUpperCase() : cyr;
    };
    if ((lower === 'o' || lower === 'g') && TURNED.includes(next) && next !== '') {
      emit(lower === 'o' ? 'ў' : 'ғ');
      index += 1;
      continue;
    }
    if ((lower === 's' || lower === 'c') && nextLower === 'h') {
      emit(lower === 's' ? 'ш' : 'ч');
      index += 1;
      continue;
    }
    if (lower === 'y' && 'aoue'.includes(nextLower) && nextLower !== '') {
      // "yoʻ" is y + oʻ: "йў".
      if (nextLower === 'o' && TURNED.includes(at(index + 2)) && at(index + 2) !== '') {
        emit('й');
        continue;
      }
      emit({ a: 'я', o: 'ё', u: 'ю', e: 'е' }[nextLower]!);
      index += 1;
      continue;
    }
    if (lower === 'e') {
      const previous = out.at(-1) ?? '';
      emit(previous === '' || VOWELS.includes(previous) || previous === 'ъ' || previous === 'Ъ' ? 'э' : 'е');
      continue;
    }
    if (char === 'ʼ') {
      // The mark that keeps s and h apart (Isʼhoq) is not written in Cyrillic; elsewhere it is ъ.
      const previous = at(index - 1).toLowerCase();
      if ((previous === 's' || previous === 'c') && nextLower === 'h') continue;
      out += 'ъ';
      continue;
    }
    const mapped = SINGLE[lower];
    if (mapped === undefined) {
      out += char;
      continue;
    }
    emit(mapped);
  }
  // Russian loanwords keep ц: -tsiya, -ksiya, -tsion, -ksion.
  return out
    .replace(/тсия/g, 'ция')
    .replace(/ТСИЯ/g, 'ЦИЯ')
    .replace(/ксия/g, 'кция')
    .replace(/КСИЯ/g, 'КЦИЯ')
    .replace(/тсион/g, 'цион')
    .replace(/ксион/g, 'кцион')
    .replace(/^Тс(?=и)/, 'Ц')
    .replace(/^тс(?=и)/, 'ц');
}

function cyrillicWord(word: string): string {
  if (KEEP.has(word.toLowerCase())) return word;
  // A word with an apostrophe before its ending (Docker’ga): the word as it is, the ending converted.
  const split = /^(.+?)(’)(.+)$/.exec(word);
  if (split !== null) {
    const [, stem, mark, tail] = split;
    const lower = stem!.toLowerCase();
    if (lower in CYRILLIC_WORDS) return `${caseLike(CYRILLIC_WORDS[lower]!, stem!)}${cyrillicLetters(tail!)}`;
    if (KEEP.has(lower) || looksForeign(stem!) || stem!.length === 1) return `${stem}${mark}${cyrillicLetters(tail!)}`;
    return `${cyrillicWord(stem!)}${mark}${cyrillicLetters(tail!)}`;
  }
  // A capital letter on its own is a name (an A record, Ctrl+K); "U" (he, that) is a word.
  if (word.length === 1 && /[A-Z]/.test(word) && word !== 'U') return word;
  const known = knownStem(word);
  if (known !== null) {
    const lower = known.stem.toLowerCase();
    const tail = known.rest.length === 0 ? '' : cyrillicLetters(known.rest);
    if (lower in LOANWORDS) {
      const spelled = LOANWORDS[lower]!;
      // The soft sign stays at the end of the word only (пароль, паролни).
      return caseLike(known.rest.length === 0 ? spelled : spelled.replace(/ь$/, ''), known.stem) + tail;
    }
    if (lower in CYRILLIC_WORDS) return caseLike(CYRILLIC_WORDS[lower]!, known.stem) + tail;
    return known.rest.length === 0 ? known.stem : `${known.stem}’${tail}`;
  }
  if (looksForeign(word)) return word;
  return cyrillicLetters(word);
}

function newLatinLetters(word: string): string {
  let out = '';
  for (let index = 0; index < word.length; index += 1) {
    const char = word[index]!;
    const next = word[index + 1] ?? '';
    const lower = char.toLowerCase();
    const upper = isUpper(char);
    if ((lower === 'o' || lower === 'g') && next !== '' && TURNED.includes(next)) {
      out += lower === 'o' ? (upper ? 'Ō' : 'ō') : upper ? 'Ḡ' : 'ḡ';
      index += 1;
      continue;
    }
    if ((lower === 's' || lower === 'c') && next.toLowerCase() === 'h') {
      out += lower === 's' ? (upper ? 'Ş' : 'ş') : upper ? 'Ç' : 'ç';
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

function newLatinWord(word: string): string {
  if (KEEP.has(word.toLowerCase())) return word;
  const split = /^(.+?)(’)(.+)$/.exec(word);
  if (split !== null) {
    const [, stem, mark, tail] = split;
    const foreign = KEEP.has(stem!.toLowerCase()) || stem!.toLowerCase() in CYRILLIC_WORDS || looksForeign(stem!);
    return `${foreign ? stem : newLatinWord(stem!)}${mark}${newLatinLetters(tail!)}`;
  }
  const known = knownStem(word);
  if (known !== null && !(known.stem.toLowerCase() in LOANWORDS)) return known.stem + newLatinLetters(known.rest);
  if (looksForeign(word)) return word;
  return newLatinLetters(word);
}

const WORD = /[A-Za-zʻʼ‘’'`]+/g;

/** Convert the words of `text` that are Uzbek, leaving every protected span and foreign word alone. */
function convert(text: string, word: (value: string) => string): string {
  let out = '';
  let last = 0;
  const words = (part: string): string =>
    part.replace(WORD, (match) => {
      // Quotes around a word are punctuation, not the oʻ/gʻ mark.
      const lead = /^['‘’`]+/.exec(match)?.[0] ?? '';
      const core = match.slice(lead.length);
      const trail = /['‘’`]+$/.exec(core)?.[0] ?? '';
      const body = core.slice(0, core.length - trail.length);
      if (body.length === 0) return match;
      // A trailing ʻ belongs to the word only after o/g (yoʻ, boʻ…); otherwise it is a closing quote.
      return `${lead}${word(body)}${trail}`;
    });
  for (const match of text.matchAll(PROTECTED)) {
    out += words(text.slice(last, match.index));
    out += uzbekLabel(match[0]) ? words(match[0]) : match[0];
    last = match.index + match[0].length;
  }
  return out + words(text.slice(last));
}

/**
 * A span in backticks that is a label of the interface written in Uzbek (`Tashqi manzil`), not code: Uzbek words
 * only, at least one sound Uzbek writes that English does not, and nothing that code is made of.
 */
function uzbekLabel(span: string): boolean {
  if (!span.startsWith('`') || !span.endsWith('`')) return false;
  const inner = span.slice(1, -1);
  if (inner.length === 0 || /[^A-Za-zʻʼ‘’ ]/.test(inner)) return false;
  const words = inner.split(' ').filter(Boolean);
  // One lowercase word in backticks is a command or a name (`bash`); a label is a phrase or a capitalised word.
  if (words.length === 1 && !/^[A-ZʻʼО]/.test(inner)) return false;
  const uzbek = words.every((word) => !looksForeign(word) && knownStem(word) === null && !KEEP.has(word.toLowerCase()));
  return uzbek && /[ʻʼ]|sh|ch|q|x/i.test(inner);
}

export function toUzbekCyrillic(text: string): string {
  return convert(text, cyrillicWord);
}

export function toUzbekNewLatin(text: string): string {
  return convert(text, newLatinWord);
}

/** Every string of a tree converted; `skip` names keys whose values are identifiers, not text. */
export function transliterateTree<T>(value: T, convertText: (text: string) => string, skip: ReadonlySet<string> = new Set()): T {
  if (typeof value === 'string') return convertText(value) as T;
  if (Array.isArray(value)) return value.map((item) => transliterateTree(item, convertText, skip)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = skip.has(key) ? item : transliterateTree(item, convertText, skip);
    return out as T;
  }
  return value;
}
