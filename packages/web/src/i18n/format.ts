/**
 * Dates, relative times and numbers for the languages browsers format
 * poorly or not at all.
 *
 * Chromium ships without CLDR data for Uzbek, Karakalpak and Turkmen, and
 * what it has for Kazakh, Kyrgyz and Tajik varies between browsers, so `Intl`
 * renders "2026 M10 4" or English words. These formatters follow each
 * language's conventions ("4-okt, 2026, 14:05", "6 daqiqa oldin",
 * "24 қараша, 2026", "12 345,67"), identically in every browser. Russian and
 * English keep using `Intl`, which knows them well.
 */
import type { Locale } from '@ploy/shared';

type Unit = Intl.RelativeTimeFormatUnit;
type Base = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second';

export interface FormatPack {
  months: string[];
  monthsShort: string[];
  /** Sunday first. */
  weekdays: string[];
  dayMonth: (day: number, month: string) => string;
  /** The unit's name, and its form before "after" (the ablative), per unit. */
  units: Record<Base, [name: string, from: string]>;
  past: string;
  future: string;
  yesterday: string;
  today: string;
  tomorrow: string;
  now: string;
}

const uz: FormatPack = {
  months: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'],
  monthsShort: ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'],
  weekdays: ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'],
  dayMonth: (day, month) => `${day}-${month}`,
  units: {
    year: ['yil', 'yildan'],
    quarter: ['chorak', 'chorakdan'],
    month: ['oy', 'oydan'],
    week: ['hafta', 'haftadan'],
    day: ['kun', 'kundan'],
    hour: ['soat', 'soatdan'],
    minute: ['daqiqa', 'daqiqadan'],
    second: ['soniya', 'soniyadan'],
  },
  past: '{n} {unit} oldin',
  future: '{n} {from} keyin',
  yesterday: 'kecha',
  today: 'bugun',
  tomorrow: 'ertaga',
  now: 'hozir',
};

/**
 * The new Latin alphabet: the Latin pack with its letters converted
 * (yakşanba, keça). Written out rather than converted at load, so the first
 * page does not carry the transliteration engine; a test keeps it equal to
 * the converted Latin pack.
 */
const uzNew: FormatPack = {
  ...uz,
  weekdays: ['yakşanba', 'duşanba', 'seşanba', 'çorşanba', 'payşanba', 'juma', 'şanba'],
  units: { ...uz.units, quarter: ['çorak', 'çorakdan'] },
  yesterday: 'keça',
};

const uzCyrl: FormatPack = {
  months: ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'],
  monthsShort: ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
  weekdays: ['якшанба', 'душанба', 'сешанба', 'чоршанба', 'пайшанба', 'жума', 'шанба'],
  dayMonth: (day, month) => `${day}-${month}`,
  units: {
    year: ['йил', 'йилдан'],
    quarter: ['чорак', 'чоракдан'],
    month: ['ой', 'ойдан'],
    week: ['ҳафта', 'ҳафтадан'],
    day: ['кун', 'кундан'],
    hour: ['соат', 'соатдан'],
    minute: ['дақиқа', 'дақиқадан'],
    second: ['сония', 'сониядан'],
  },
  past: '{n} {unit} олдин',
  future: '{n} {from} кейин',
  yesterday: 'кеча',
  today: 'бугун',
  tomorrow: 'эртага',
  now: 'ҳозир',
};

const kaa: FormatPack = {
  months: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentyabr', 'oktyabr', 'noyabr', 'dekabr'],
  monthsShort: ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'],
  weekdays: ['ekshembi', 'dúyshembi', 'siyshembi', 'sárshembi', 'piyshembi', 'juma', 'shembi'],
  dayMonth: (day, month) => `${day}-${month}`,
  units: {
    year: ['jıl', 'jıldan'],
    quarter: ['sherek', 'sherekten'],
    month: ['ay', 'aydan'],
    week: ['hápte', 'hápteden'],
    day: ['kún', 'kúnnen'],
    hour: ['saat', 'saattan'],
    minute: ['minut', 'minuttan'],
    second: ['sekund', 'sekundtan'],
  },
  past: '{n} {unit} burın',
  future: '{n} {from} keyin',
  yesterday: 'keshe',
  today: 'búgin',
  tomorrow: 'erteń',
  now: 'házir',
};

const ky: FormatPack = {
  months: ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'],
  monthsShort: ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
  weekdays: ['жекшемби', 'дүйшөмбү', 'шейшемби', 'шаршемби', 'бейшемби', 'жума', 'ишемби'],
  dayMonth: (day, month) => `${day}-${month}`,
  units: {
    year: ['жыл', 'жылдан'],
    quarter: ['чейрек', 'чейректен'],
    month: ['ай', 'айдан'],
    week: ['апта', 'аптадан'],
    day: ['күн', 'күндөн'],
    hour: ['саат', 'сааттан'],
    minute: ['мүнөт', 'мүнөттөн'],
    second: ['секунд', 'секунддан'],
  },
  past: '{n} {unit} мурун',
  future: '{n} {from} кийин',
  yesterday: 'кечээ',
  today: 'бүгүн',
  tomorrow: 'эртең',
  now: 'азыр',
};

const tg: FormatPack = {
  months: ['январ', 'феврал', 'март', 'апрел', 'май', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'],
  monthsShort: ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
  weekdays: ['якшанбе', 'душанбе', 'сешанбе', 'чоршанбе', 'панҷшанбе', 'ҷумъа', 'шанбе'],
  dayMonth: (day, month) => `${day} ${month}`,
  units: {
    year: ['сол', 'сол'],
    quarter: ['семоҳа', 'семоҳа'],
    month: ['моҳ', 'моҳ'],
    week: ['ҳафта', 'ҳафта'],
    day: ['рӯз', 'рӯз'],
    hour: ['соат', 'соат'],
    minute: ['дақиқа', 'дақиқа'],
    second: ['сония', 'сония'],
  },
  past: '{n} {unit} пеш',
  future: 'баъд аз {n} {from}',
  yesterday: 'дирӯз',
  today: 'имрӯз',
  tomorrow: 'фардо',
  now: 'ҳозир',
};

const kk: FormatPack = {
  months: ['қаңтар', 'ақпан', 'наурыз', 'сәуір', 'мамыр', 'маусым', 'шілде', 'тамыз', 'қыркүйек', 'қазан', 'қараша', 'желтоқсан'],
  monthsShort: ['қаң', 'ақп', 'нау', 'сәу', 'мам', 'мау', 'шіл', 'там', 'қыр', 'қаз', 'қар', 'жел'],
  weekdays: ['жексенбі', 'дүйсенбі', 'сейсенбі', 'сәрсенбі', 'бейсенбі', 'жұма', 'сенбі'],
  dayMonth: (day, month) => `${day} ${month}`,
  units: {
    year: ['жыл', 'жылдан'],
    quarter: ['тоқсан', 'тоқсаннан'],
    month: ['ай', 'айдан'],
    week: ['апта', 'аптадан'],
    day: ['күн', 'күннен'],
    hour: ['сағат', 'сағаттан'],
    minute: ['минут', 'минуттан'],
    second: ['секунд', 'секундтан'],
  },
  past: '{n} {unit} бұрын',
  future: '{n} {from} кейін',
  yesterday: 'кеше',
  today: 'бүгін',
  tomorrow: 'ертең',
  now: 'қазір',
};

const tk: FormatPack = {
  months: ['ýanwar', 'fewral', 'mart', 'aprel', 'maý', 'iýun', 'iýul', 'awgust', 'sentýabr', 'oktýabr', 'noýabr', 'dekabr'],
  monthsShort: ['ýan', 'few', 'mar', 'apr', 'maý', 'iýn', 'iýl', 'awg', 'sen', 'okt', 'noý', 'dek'],
  weekdays: ['ýekşenbe', 'duşenbe', 'sişenbe', 'çarşenbe', 'penşenbe', 'anna', 'şenbe'],
  dayMonth: (day, month) => `${day} ${month}`,
  units: {
    year: ['ýyl', 'ýyldan'],
    quarter: ['çärýek', 'çärýekden'],
    month: ['aý', 'aýdan'],
    week: ['hepde', 'hepdeden'],
    day: ['gün', 'günden'],
    hour: ['sagat', 'sagatdan'],
    minute: ['minut', 'minutdan'],
    second: ['sekunt', 'sekuntdan'],
  },
  past: '{n} {unit} öň',
  future: '{n} {from} soň',
  yesterday: 'düýn',
  today: 'şu gün',
  tomorrow: 'ertir',
  now: 'häzir',
};

/** The hand-written formats, for the languages that need them; null means `Intl` does the work. */
export function formatPack(locale: Locale): FormatPack | null {
  switch (locale) {
    case 'uz':
      return uz;
    case 'uz-new':
      return uzNew;
    case 'uz-cyrl':
      return uzCyrl;
    case 'kaa':
      return kaa;
    case 'ky':
      return ky;
    case 'tg':
      return tg;
    case 'kk':
      return kk;
    case 'tk':
      return tk;
    default:
      return null;
  }
}


const pad = (value: number): string => String(value).padStart(2, '0');

/** The wall-clock fields of `date` in `timeZone` (the browser's zone when omitted). */
export function zonedParts(date: Date, timeZone?: string): { year: number; month: number; day: number; weekday: number; hour: number; minute: number; second: number } {
  if (timeZone === undefined) {
    return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate(), weekday: date.getDay(), hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds() };
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '0';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(read('year')),
    month: Number(read('month')) - 1,
    day: Number(read('day')),
    weekday: Math.max(0, weekdays.indexOf(read('weekday'))),
    hour: Number(read('hour')) % 24,
    minute: Number(read('minute')),
    second: Number(read('second')),
  };
}

export function formatPackDate(pack: FormatPack, date: Date, options: Intl.DateTimeFormatOptions): string {
  const d = zonedParts(date, options.timeZone);
  const hasDate = options.dateStyle !== undefined || options.day !== undefined || options.month !== undefined || options.year !== undefined;
  const hasTime = options.timeStyle !== undefined || options.hour !== undefined || options.minute !== undefined;
  const full = options.dateStyle === 'full' || options.dateStyle === 'long';
  const parts: string[] = [];

  if (hasDate) {
    const month = full || options.month === 'long' ? pack.months[d.month]! : pack.monthsShort[d.month]!;
    const withYear = options.dateStyle !== undefined || options.year !== undefined;
    // A month by itself ("noyabr 2026"), for headings that group by month.
    const monthOnly = options.dateStyle === undefined && options.day === undefined && options.weekday === undefined && options.month !== undefined;
    if (monthOnly) {
      parts.push(withYear ? `${month} ${d.year}` : month);
    } else {
      if (options.dateStyle === 'full' || options.weekday !== undefined) parts.push(pack.weekdays[d.weekday]!);
      parts.push(pack.dayMonth(d.day, month));
      if (withYear) parts.push(String(d.year));
    }
  }
  if (hasTime) {
    const seconds = options.timeStyle === 'medium' || options.timeStyle === 'long' || options.second !== undefined;
    parts.push(`${pad(d.hour)}:${pad(d.minute)}${seconds ? `:${pad(d.second)}` : ''}`);
  }
  return parts.join(', ');
}

const BASE: Record<Unit, Base> = {
  year: 'year',
  years: 'year',
  quarter: 'quarter',
  quarters: 'quarter',
  month: 'month',
  months: 'month',
  week: 'week',
  weeks: 'week',
  day: 'day',
  days: 'day',
  hour: 'hour',
  hours: 'hour',
  minute: 'minute',
  minutes: 'minute',
  second: 'second',
  seconds: 'second',
};

export function formatPackRelative(pack: FormatPack, value: number, unit: Unit): string {
  const base = BASE[unit];
  if (base === 'day' && value === -1) return pack.yesterday;
  if (base === 'day' && value === 1) return pack.tomorrow;
  if (value === 0) return base === 'day' ? pack.today : pack.now;
  const [name, from] = pack.units[base];
  const n = formatGroupedNumber(Math.abs(value));
  return (value < 0 ? pack.past : pack.future).replace('{n}', n).replace('{unit}', name).replace('{from}', from);
}

/** Group with a non-breaking space and use a decimal comma, as CLDR prescribes for all of these languages. */
export function formatGroupedNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat('en-US', options)
    .formatToParts(value)
    .map((part) => (part.type === 'group' ? ' ' : part.type === 'decimal' ? ',' : part.value))
    .join('');
}
