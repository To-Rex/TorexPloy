/**
 * What an attached file says, as text a model can read.
 *
 * Plain text is passed as it is. Office documents are zip archives of XML:
 * the words of a Word file, the cells of a spreadsheet and the lines of a
 * presentation are picked out of them here, without any library and without
 * unpacking anything to disk. Any other archive is described by its list of
 * files. What cannot be read as text (a photo in a format no model takes, a
 * program) is reported as such, never guessed at.
 */
import { open } from 'node:fs/promises';
import { AI_LIMITS } from '@ploy/shared';
import { readZipDirectory, readZipEntry, type ZipEntry } from '../lib/zip.ts';

/** The largest XML part of a document that is read. */
const PART_MAX = 40 * 1024 * 1024;
const SHEET_ROWS_MAX = 3_000;
const SHEETS_MAX = 12;
const SLIDES_MAX = 200;
const LISTING_MAX = 300;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16) || 0xfffd);
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10) || 0xfffd);
    return ENTITIES[name] ?? whole;
  });
}

const strip = (xml: string): string => decodeXml(xml.replace(/<[^>]+>/g, ''));
const tidy = (text: string): string =>
  text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** The text of a Word document: paragraphs, headings, list items, and tables as tab-separated rows. */
export function docxText(xml: string): string {
  const runs = (part: string): string =>
    strip(
      part
        .replace(/<w:tab\b[^>]*\/>/g, '\t')
        .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
        // Deleted text of a tracked change and field codes are not what the document says.
        .replace(/<w:(?:delText|instrText)\b[^>]*>[\s\S]*?<\/w:(?:delText|instrText)>/g, ''),
    );
  const tables = xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, (table) => {
    const rows = [...table.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((row) =>
      [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((cell) => runs(cell[0].replace(/<\/w:p>/g, ' ')).replace(/\s+/g, ' ').trim()).join('\t'),
    );
    return `\n${rows.join('\n')}\n`;
  });
  const body = tables.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph) => {
    const heading = /<w:pStyle\b[^>]*w:val="(?:Heading|heading|Title)(\d)?"/.exec(paragraph);
    const prefix = heading !== null ? `${'#'.repeat(Math.min(6, Number(heading[1] ?? 1) || 1))} ` : /<w:numPr\b/.test(paragraph) ? '- ' : '';
    const text = runs(paragraph);
    return text.trim().length === 0 ? '\n' : `${prefix}${text}\n`;
  });
  return tidy(strip(body));
}

function columnIndex(reference: string): number {
  let index = 0;
  for (const char of reference) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

export function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((item) =>
    // Phonetic guides repeat the text in another script; they are not part of the cell.
    [...item[1]!.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((run) => decodeXml(run[1]!)).join(''),
  );
}

/** One worksheet as tab-separated rows, cells kept in their columns. */
export function sheetText(xml: string, strings: string[]): string {
  const lines: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (lines.length >= SHEET_ROWS_MAX) {
      lines.push('… more rows not shown');
      break;
    }
    const cells: string[] = [];
    for (const cell of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1] ?? '';
      const inner = cell[2] ?? '';
      const reference = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1];
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1];
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 's') value = strings[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((run) => decodeXml(run[1]!)).join('');
      else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
      else if (raw !== undefined) value = decodeXml(raw);
      const column = reference === undefined ? cells.length : columnIndex(reference);
      while (cells.length < column) cells.push('');
      cells[column] = value.replace(/[\t\r\n]+/g, ' ');
    }
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length > 0) lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

const slideNumber = (path: string): number => Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0);

async function officeText(path: string, entries: ZipEntry[]): Promise<string | null> {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const read = async (name: string): Promise<string | null> => {
    const entry = byPath.get(name);
    return entry === undefined ? null : (await readZipEntry(path, entry, PART_MAX)).toString('utf8');
  };

  const word = await read('word/document.xml');
  if (word !== null) return docxText(word);

  if (byPath.has('xl/workbook.xml')) {
    const workbook = (await read('xl/workbook.xml')) ?? '';
    const names = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((match) => decodeXml(match[1]!));
    const strings = sharedStrings((await read('xl/sharedStrings.xml')) ?? '');
    const sheets = entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.path)).sort((a, b) => slideNumber(a.path) - slideNumber(b.path));
    const parts: string[] = [];
    for (const [index, sheet] of sheets.slice(0, SHEETS_MAX).entries()) {
      const text = sheetText((await readZipEntry(path, sheet, PART_MAX)).toString('utf8'), strings);
      parts.push(`## Sheet: ${names[index] ?? `Sheet ${index + 1}`}\n${text.length > 0 ? text : '(empty)'}`);
    }
    if (sheets.length > SHEETS_MAX) parts.push(`… ${sheets.length - SHEETS_MAX} more sheets not shown`);
    return parts.join('\n\n');
  }

  if (byPath.has('ppt/presentation.xml')) {
    const slides = entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.path)).sort((a, b) => slideNumber(a.path) - slideNumber(b.path));
    const parts: string[] = [];
    for (const [index, slide] of slides.slice(0, SLIDES_MAX).entries()) {
      const xml = (await readZipEntry(path, slide, PART_MAX)).toString('utf8');
      const lines = [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map((paragraph) => [...paragraph[0].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((run) => decodeXml(run[1]!)).join('')).filter((line) => line.trim().length > 0);
      parts.push(`## Slide ${index + 1}\n${lines.join('\n')}`);
    }
    return parts.join('\n\n');
  }

  // OpenDocument (LibreOffice): one content.xml for text, spreadsheets and presentations alike.
  if (byPath.has('content.xml') && byPath.has('mimetype')) {
    const xml = (await read('content.xml')) ?? '';
    return tidy(
      strip(
        xml
          .replace(/<text:tab\b[^>]*\/>/g, '\t')
          .replace(/<text:line-break\b[^>]*\/>/g, '\n')
          .replace(/<\/table:table-cell>/g, '\t')
          .replace(/<\/table:table-row>/g, '\n')
          .replace(/<\/text:(?:p|h)>/g, '\n'),
      ),
    );
  }
  return null;
}

function listing(entries: ZipEntry[]): string {
  const files = entries.filter((entry) => !entry.isDirectory && !entry.isSystemFile);
  const total = files.reduce((sum, entry) => sum + entry.size, 0);
  const shown = files.slice(0, LISTING_MAX).map((entry) => `${entry.path}  (${entry.size} bytes)`);
  return `A zip archive of ${files.length} files, ${total} bytes unpacked. Its contents are listed, not read:\n${shown.join('\n')}${files.length > LISTING_MAX ? `\n… ${files.length - LISTING_MAX} more files` : ''}`;
}

function clip(text: string): string {
  const max = AI_LIMITS.attachmentTextMax;
  return text.length > max ? `${text.slice(0, max)}\n… (the rest, ${text.length - max} characters, is not shown)` : text;
}

/** The text of a file on disk, cut to what a model is shown; null when it holds nothing readable as text. */
export async function readableText(path: string): Promise<string | null> {
  const handle = await open(path, 'r');
  let data: Buffer;
  let size: number;
  try {
    size = (await handle.stat()).size;
    // More than a model is shown anyway: a huge log is read from its start.
    const length = Math.min(size, AI_LIMITS.attachmentTextMax * 4 + 4);
    data = Buffer.alloc(length);
    await handle.read(data, 0, length, 0);
  } finally {
    await handle.close();
  }
  if (data.length === 0) return '';

  if (data.length >= 4 && data.readUInt32LE(0) === 0x04034b50) {
    try {
      const entries = await readZipDirectory(path);
      const office = await officeText(path, entries);
      return clip(office ?? listing(entries));
    } catch {
      return null;
    }
  }
  // UTF-16, as Windows tools save text: its byte-order mark says so.
  if (data[0] === 0xff && data[1] === 0xfe) return clip(data.subarray(2, data.length - (data.length % 2)).toString('utf16le'));
  if (data[0] === 0xfe && data[1] === 0xff) {
    const swapped = Buffer.from(data.subarray(2, data.length - (data.length % 2)));
    swapped.swap16();
    return clip(swapped.toString('utf16le'));
  }
  if (data.subarray(0, 8_000).includes(0)) return null;
  const text = data.toString('utf8').replace(/^﻿/, '');
  // Cut in the middle of a character at the end of what was read: the stray half is dropped.
  return clip(size > data.length ? text.replace(/�+$/, '') : text);
}
