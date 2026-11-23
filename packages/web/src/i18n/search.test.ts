/** Searching finds the text whichever alphabet or keyboard the words were typed in. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchKey } from './search.ts';

test('a search key ignores the alphabet and the keyboard', () => {
  const same = (...values: string[]) => assert.deepEqual(new Set(values.map(searchKey)).size, 1, values.join(' / '));
  same('Oʻzgartirish', "o'zgartirish", 'ozgartirish', 'özgartiriş', 'ÖZGARTIRIŞ');
  same('Gʻalaba', "g'alaba", 'Ğalaba', 'galaba');
  same('Bildirishnomalar', 'bildirişnomalar', 'bildirisnomalar');
  same('Choy', 'çoy', 'Çoy');
  same('Ýerleşdirişler', 'yerlesdirisler');
  same('Qosımshalar', 'qosimshalar', 'qosımşalar');
  assert.ok(searchKey('Joylaştirişlar va bildirişnomalar').includes(searchKey('bildirish')));
  assert.equal(searchKey('Жойлаштириш'), 'жойлаштириш'.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''), 'Cyrillic only loses case and marks');
});
