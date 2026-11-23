/**
 * Uzbek in Cyrillic and in the new Latin alphabet (2026), from the Latin the
 * interface is written in: the letters, the spelling rules, loanwords, and
 * everything that must come through untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toUzbekCyrillic as cyr, toUzbekNewLatin as nl, transliterateTree } from './transliterate.ts';

test('letters and digraphs', () => {
  assert.equal(cyr('Oʻzbekcha'), 'Ўзбекча');
  assert.equal(cyr('Gʻalaba, shahar, choy, qishloq, xabar, hovli, joy'), 'Ғалаба, шаҳар, чой, қишлоқ, хабар, ҳовли, жой');
  assert.equal(cyr('Yangi yoʻl, yordam, yuklash, yer'), 'Янги йўл, ёрдам, юклаш, ер');
  assert.equal(cyr('OʻCHIRISH'), 'OʻCHIRISH', 'all capitals read as a name, left alone');
  assert.equal(nl('Oʻzbekcha'), 'Özbekça');
  assert.equal(nl('Gʻalaba, shahar, choy, oʻchirish, SHU'), 'Ğalaba, şahar, çoy, öçiriş, SHU');
  // Every way texts write the mark, in both cases: the letters of the 2026 law, precomposed.
  assert.equal(nl("Oʻrin oʻrin O‘rin o'rin Gʻoya gʻoya G‘oya g'oya Shahar Choy"), 'Örin örin Örin örin Ğoya ğoya Ğoya ğoya Şahar Çoy');
  // The tutuq belgisi (ʼ) stays a letter of its own, and s ʼ h never becomes ş.
  assert.equal(nl('maʼlumot, taʼlim, sanʼat, Isʼhoq, mangu'), 'maʼlumot, taʼlim, sanʼat, Isʼhoq, mangu');
  // An English word with an Uzbek ending keeps its letters (dashboard, not daşboard).
  assert.equal(nl('Grafana dashboardlari, push-bildirishnoma'), 'Grafana dashboardlari, push-bildirişnoma');
  assert.equal(cyr('dashboardlar'), 'дашбордлар');
  assert.equal(nl('Oʻzbekcha').normalize('NFC'), nl('Oʻzbekcha'));
  assert.doesNotMatch(nl('Oʻgʻil, toʻgʻri, bogʻ, shoʻx'), /[ōŌḡḠ]|[oOgG][ʻʼ‘']/);
});

test('e, ʼ and the separating mark', () => {
  assert.equal(cyr('eski ekran, kecha, aeroport, poyezd, klient, ierarxik'), 'эски экран, кеча, аэропорт, поезд, клиент, иерархик');
  assert.equal(cyr('maʼlumot, taʼsir, eʼlon'), 'маълумот, таъсир, эълон');
  assert.equal(cyr('Isʼhoq'), 'Исҳоқ');
  assert.equal(nl('maʼlumot, Isʼhoq'), 'maʼlumot, Isʼhoq');
});

test('Russian loanwords get their spelling back', () => {
  assert.equal(cyr('funksiya, operatsiya, integratsiyalar, versiya, sessiya'), 'функция, операция, интеграциялар, версия, сессия');
  assert.equal(cyr('Parol, parolni, Profil, panelda, rollar, obyekt, kompyuter, protsessor'), 'Пароль, паролни, Профиль, панелда, роллар, объект, компьютер, процессор');
  assert.equal(cyr('kutsa, ketsa, ishlatsangiz'), 'кутса, кетса, ишлатсангиз', 'native t+s stays тс');
  assert.equal(cyr('Instansiya administratori'), 'Инстанция администратори');
});

test('brands, acronyms, English terms and their Uzbek endings', () => {
  assert.equal(cyr('Docker’ga ulanish, GitHub’dagi repo, SSH kalit, API’lar'), 'Docker’га уланиш, GitHub’даги репо, SSH калит, API’лар');
  assert.equal(cyr('Webhooklar, deploy qilish, commitni push qiling'), 'Вебхуклар, деплой қилиш, коммитни пуш қилинг');
  assert.equal(cyr('image’lar va volume'), 'image’лар ва volume');
  assert.equal(cyr('bitta ilova, edi, tab’ida'), 'битта илова, эди, таб’ида');
  assert.equal(nl('push qiling, branch’ga, Shift, cache, shell'), 'push qiling, branch’ga, Shift, cache, shell');
  assert.equal(cyr('U ishlaydi, A yozuvi'), 'У ишлайди, A ёзуви');
});

test('placeholders, code, addresses and paths come through untouched', () => {
  assert.equal(cyr('{count} ta ilova, {name}ni oʻchirish'), '{count} та илова, {name}ни ўчириш');
  assert.equal(cyr('Shu `npm run build` buyrugʻi, `sh`/`bash`'), 'Шу `npm run build` буйруғи, `sh`/`bash`');
  assert.equal(cyr('`Tashqi manzil`da'), '`Ташқи манзил`да', 'an Uzbek label in backticks is text');
  assert.equal(cyr('https://example.com/path va /settings/ai, admin@example.com, docker-compose.yml, id_ed25519, --yes, TOREX_URL, S3'), 'https://example.com/path ва /settings/ai, admin@example.com, docker-compose.yml, id_ed25519, --yes, TOREX_URL, S3');
  assert.equal(cyr('[Sozlamalar](/settings/git) sahifasi'), '[Созламалар](/settings/git) саҳифаси');
  assert.equal(cyr('**muhim** — eslatma'), '**муҳим** — эслатма');
  assert.equal(nl('[Sozlamalar](/settings/shell)'), '[Sozlamalar](/settings/shell)');
});

test('a tree keeps its identifiers', () => {
  const tree = { id: 'install', icon: 'rocket', title: 'Oʻrnatish', items: ['Ishga tushirish'], nested: { type: 'steps', text: 'Chiqish' } };
  assert.deepEqual(transliterateTree(tree, cyr, new Set(['id', 'icon', 'type'])), { id: 'install', icon: 'rocket', title: 'Ўрнатиш', items: ['Ишга тушириш'], nested: { type: 'steps', text: 'Чиқиш' } });
});
