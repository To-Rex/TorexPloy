/**
 * Uzbek in its other two alphabets: the Latin catalogue converted letter by
 * letter (see `transliterate.ts` in shared), once, when first asked for. Every
 * string the Latin interface has, these have too, the moment it is written.
 */
import { toUzbekCyrillic, toUzbekNewLatin, transliterateTree } from '@ploy/shared/transliterate';
import { uz, type Messages } from './uz.ts';

let cyrillic: Messages | null = null;
let newLatin: Messages | null = null;

export function uzCyrillic(): Messages {
  cyrillic ??= transliterateTree(uz, toUzbekCyrillic);
  return cyrillic;
}

export function uzNewLatin(): Messages {
  newLatin ??= transliterateTree(uz, toUzbekNewLatin);
  return newLatin;
}
