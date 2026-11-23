/**
 * A search key that ignores how a word happens to be spelled: case, accents
 * and the Uzbek alphabets' marks. "oʻzgartirish", "o'zgartirish",
 * "ozgartirish" and "özgartiriş" (the 2026 alphabet) give the same key, so a
 * search typed on any keyboard finds the text in either Latin alphabet;
 * Turkmen and Karakalpak words match without their letters' marks too
 * (ýerleşdiriş, yerlesdiris).
 */
export function searchKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ʻʼ'’‘`]/g, '')
    .replace(/ı/g, 'i')
    .replace(/sh/g, 's')
    .replace(/ch/g, 'c');
}
