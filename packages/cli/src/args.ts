/**
 * Reading the command line: words, `--flag value`, `--flag=value`, `-f`,
 * `--no-flag`, and everything after `--` kept as it is.
 */

export interface Parsed {
  /** Words that are not flags, in order: the command, its subcommand, its arguments. */
  words: string[];
  flags: Map<string, string | true>;
  /** What came after `--`. */
  rest: string[];
}

/** Flags that take a value; every other flag is a switch. */
export const VALUE_FLAGS = new Set([
  'url',
  'token',
  'profile',
  'app',
  'project',
  'server',
  'tail',
  'since',
  'service',
  'deployment',
  'data',
  'query',
  'access',
  'name',
  'port',
  'chat',
  'model',
  'team',
  'use',
  'file',
  'passphrase',
  'output',
  's3',
]);

const SHORT: Record<string, string> = { f: 'follow', h: 'help', v: 'version', y: 'yes', n: 'tail', a: 'app', d: 'data', q: 'query', p: 'profile', o: 'output' };

export function parseArgs(argv: readonly string[]): Parsed {
  const words: string[] = [];
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') {
      rest.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const equals = arg.indexOf('=');
      const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
      if (equals !== -1) {
        flags.set(name, arg.slice(equals + 1));
      } else if (name.startsWith('no-')) {
        flags.set(name.slice(3), 'false');
      } else if (VALUE_FLAGS.has(name) && index + 1 < argv.length) {
        index += 1;
        flags.set(name, argv[index]!);
      } else {
        flags.set(name, true);
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      const letters = arg.slice(1);
      for (let position = 0; position < letters.length; position += 1) {
        const name = SHORT[letters[position]!] ?? letters[position]!;
        if (VALUE_FLAGS.has(name) && position === letters.length - 1 && index + 1 < argv.length) {
          index += 1;
          flags.set(name, argv[index]!);
        } else {
          flags.set(name, true);
        }
      }
      continue;
    }
    words.push(arg);
  }
  return { words, flags, rest };
}

export function flag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function on(parsed: Parsed, name: string): boolean {
  const value = parsed.flags.get(name);
  return value === true || value === 'true' || value === '1';
}

export function off(parsed: Parsed, name: string): boolean {
  return parsed.flags.get(name) === 'false';
}

/** `10m`, `2h`, `1d`, `30s` or plain seconds → seconds. */
export function seconds(value: string): number {
  const match = /^(\d+)\s*([smhd]?)$/i.exec(value.trim());
  if (match === null) throw new Error(`"${value}" is not a duration (try 30s, 10m, 2h or 1d)`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  return amount * (unit === 'm' ? 60 : unit === 'h' ? 3_600 : unit === 'd' ? 86_400 : 1);
}
