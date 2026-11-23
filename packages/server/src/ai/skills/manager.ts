/**
 * TorexAi's skills: finding the right one for a job, installing it, and
 * handing its playbook to the model.
 *
 * Three places hold skills: the library shipped with the panel (written for
 * this platform), the public repositories the instance administrator trusts,
 * and the skills written on this instance. A message is matched against all
 * of them before the model sees it, so the model is told which playbooks fit
 * what was asked; it can also search by itself. A skill it decides to use is
 * installed on the spot when it comes from a trusted place and nothing in
 * its text needs a person's eye; anything else waits for the administrator.
 *
 * A skill is advice, never authority. Loading one changes nothing about what
 * the assistant may do: every command it suggests still passes through the
 * same approval, the same role check and the same handling of secrets.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_SKILL_LIMITS, type AiSkillAuto, type AiSkillDetailDto, type AiSkillDto, type AiSkillFlag, type AiSkillSource, type AiSkillSourceDto, type AiSkillsDto } from '@ploy/shared';
import type { Context } from '../../context.ts';
import { AppError, errorMessage } from '../../lib/errors.ts';
import type { CatalogRecord, SkillRecord, SkillSourceRecord } from '../../store/index.ts';
import { keepsFile, parseSkill, scanSkill, skillHash, SkillError } from './format.ts';
import { fetchRepositorySkills, type Fetcher } from './registry.ts';

/** A skill wherever it is: in the library, in a registry's catalog, or installed. */
export interface SkillEntry {
  /** `builtin:<name>`, `<owner>/<repo>:<name>` or, for a custom skill, its name. */
  ref: string;
  name: string;
  description: string;
  body: string;
  files: Record<string, string>;
  metadata: Record<string, string>;
  hash: string;
  flags: AiSkillFlag[];
  source: AiSkillSource;
  origin: string | null;
}

export interface SkillMatch {
  entry: SkillEntry;
  score: number;
  installed: SkillRecord | undefined;
  /** How many words of the question it answered to, and whether one of them is a word it listens for. */
  words: number;
  triggered: boolean;
}

const LIBRARY_DIR = fileURLToPath(new URL('./library/', import.meta.url));
const SYNC_EVERY_MS = 24 * 3_600_000;
const STOP = new Set(
  'the a an and or of to in on for with from by at as is are be it this that my our your how what why can could should please help me need want make do does not use using about into out up all any some va bilan uchun ham bu shu men menga mening qil qiling ber bering kerak qanday nega nima bor emas yoki agar и в на для с по как что это не мне мой надо нужно сделай помоги или если'.split(' '),
);

/** Words of a text, lowercased, without the apostrophes Uzbek spells oʻ and gʻ with (so "oʻchir" and "ochir" are one word). */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[ʻʼ'`‘’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !STOP.has(word));
}

interface Indexed {
  entry: SkillEntry;
  name: string[];
  triggers: string[];
  described: Set<string>;
}

/** Parts of skill names that say what kind of work it is, not what it is about: "check" alone does not make a question about intruders. */
const GENERIC_NAME_PARTS = new Set('and the for with check review audit scan scanner drill tuning recovery response investigation diagnosis monitoring troubleshooting performance analysis analyzer helper tool tools guide best practices skill skills creator builder testing test tests design writer writing basics advanced'.split(' '));

function index(entry: SkillEntry): Indexed {
  const titles = Object.entries(entry.metadata)
    .filter(([key]) => key.startsWith('title') || key.startsWith('summary'))
    .map(([, value]) => value)
    .join(' ');
  return {
    entry,
    name: entry.name.split('-').filter((part) => part.length >= 3 && !GENERIC_NAME_PARTS.has(part)),
    triggers: words((entry.metadata.triggers ?? '').replace(/,/g, ' ')),
    described: new Set(words(`${entry.description} ${entry.name.replace(/-/g, ' ')} ${titles}`)),
  };
}

/**
 * How well one word of a question speaks for a skill: its name most, then the
 * words it listens for, then its description. Triggers are stems ("xaker"
 * answers to "xakerlardan", "взлом" to "взломали"); a stem of three letters or
 * fewer is a whole word ("log" is not "login", "ssl" is not "sslip").
 */
function wordScore(word: string, skill: Indexed): number {
  // A name part of four letters or fewer is a whole word: "yara" is not "yarat".
  if (skill.name.some((part) => part === word || (Math.min(part.length, word.length) >= 5 && (part.startsWith(word) || word.startsWith(part))))) return 5;
  if (skill.triggers.some((stem) => (stem.length <= 3 ? word === stem : word.startsWith(stem) || (word.length >= 6 && stem.startsWith(word))))) return 4;
  if (skill.described.has(word)) return 2;
  if (word.length >= 5) for (const other of skill.described) if (other.length >= 5 && (other.startsWith(word) || word.startsWith(other))) return 1.5;
  return 0;
}

export class SkillManager {
  private readonly ctx: Context;
  private readonly library = new Map<string, SkillEntry>();
  private fetcher: Fetcher = fetch;
  private readonly syncing = new Map<string, Promise<void>>();
  private indexed: { revision: number; skills: Indexed[] } | null = null;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.loadLibrary();
  }

  /** Tests answer in place of GitHub. */
  useFetcher(fetcher: Fetcher): void {
    this.fetcher = fetcher;
  }

  // ----------------------------------------------------------------- library

  private loadLibrary(): void {
    let folders: string[] = [];
    try {
      folders = readdirSync(LIBRARY_DIR).filter((name) => statSync(join(LIBRARY_DIR, name)).isDirectory());
    } catch {
      // A build without the library still runs; it only has no built-in skills.
    }
    for (const folder of folders.sort()) {
      const dir = join(LIBRARY_DIR, folder);
      try {
        const parsed = parseSkill(readFileSync(join(dir, 'SKILL.md'), 'utf8'), folder);
        const files: Record<string, string> = {};
        const walk = (current: string): void => {
          for (const name of readdirSync(current).sort()) {
            const full = join(current, name);
            const info = statSync(full);
            if (info.isDirectory()) walk(full);
            else if (name !== 'SKILL.md' && keepsFile(name, info.size)) files[relative(dir, full).split(sep).join('/')] = readFileSync(full, 'utf8');
          }
        };
        walk(dir);
        this.library.set(parsed.name, { ref: `builtin:${parsed.name}`, ...parsed, files, hash: skillHash(parsed.body, files), flags: [], source: 'builtin', origin: null });
      } catch (error) {
        this.ctx.logger.warn('A built-in skill could not be read', { skill: folder, error: errorMessage(error) });
      }
    }
  }

  // ----------------------------------------------------------------- catalog

  private auto(): AiSkillAuto {
    return this.ctx.ai.settings.get().skillsAuto;
  }

  private fromCatalog(record: CatalogRecord, repo: string): SkillEntry {
    return { ref: `${repo}:${record.name}`, name: record.name, description: record.description, body: record.body, files: record.files, metadata: record.metadata, hash: record.hash, flags: record.flags, source: 'registry', origin: `${repo}:${record.path}` };
  }

  /** What an installed skill says now: a built-in one always speaks with the text this version of the panel ships. */
  private fromInstalled(record: SkillRecord): SkillEntry {
    const shipped = record.source === 'builtin' ? this.library.get(record.name) : undefined;
    if (shipped !== undefined) return shipped;
    return { ref: record.name, name: record.name, description: record.description, body: record.body, files: record.files, metadata: record.metadata, hash: record.hash, flags: record.flags, source: record.source, origin: record.origin };
  }

  /** Every skill there is to choose from: installed ones first, then the library, then the registries in the order they were added. */
  entries(): SkillEntry[] {
    const { skills } = this.ctx.stores;
    const out: SkillEntry[] = [];
    const taken = new Set<string>();
    for (const record of skills.list()) {
      out.push(this.fromInstalled(record));
      taken.add(record.name);
    }
    for (const entry of this.library.values()) {
      if (taken.has(entry.name)) continue;
      out.push(entry);
      taken.add(entry.name);
    }
    const repos = new Map(skills.sources().map((source) => [source.id, source.repo]));
    for (const record of skills.catalog()) {
      // A name already taken by something nearer (installed, built in, an earlier registry) keeps its meaning.
      if (taken.has(record.name)) continue;
      out.push(this.fromCatalog(record, repos.get(record.sourceId) ?? record.sourceId));
      taken.add(record.name);
    }
    return out;
  }

  /** Every skill, ready to be searched; built again whenever anything was installed, removed or read from a registry. */
  private index(): Indexed[] {
    const { revision } = this.ctx.stores.skills;
    if (this.indexed === null || this.indexed.revision !== revision) this.indexed = { revision, skills: this.entries().map(index) };
    return this.indexed.skills;
  }

  /** The skill a reference names: an installed name, `builtin:<name>`, `<owner>/<repo>:<name>`, or just a name. */
  resolve(ref: string): SkillEntry | undefined {
    const { skills } = this.ctx.stores;
    const wanted = ref.trim();
    const colon = wanted.lastIndexOf(':');
    if (colon > 0) {
      const from = wanted.slice(0, colon);
      const name = wanted.slice(colon + 1).toLowerCase();
      if (from === 'builtin') return this.library.get(name);
      const source = skills.sourceByRepo(from);
      const record = source === undefined ? undefined : skills.catalogEntry(source.id, name);
      return record === undefined || source === undefined ? undefined : this.fromCatalog(record, source.repo);
    }
    const name = wanted.toLowerCase();
    const installed = skills.get(name);
    if (installed !== undefined) return this.fromInstalled(installed);
    return this.index().find((skill) => skill.entry.name === name)?.entry;
  }

  // ------------------------------------------------------------------ search

  /** Skills that answer a question, best first. Words that most skills answer to ("server") count for little. */
  search(query: string, limit = 8): SkillMatch[] {
    const asked = [...new Set(words(query))];
    const all = this.index();
    if (asked.length === 0 || all.length === 0) return [];
    const { skills } = this.ctx.stores;
    const installed = new Map(skills.list().map((record) => [record.name, record]));
    const perWord = asked.map((word) => all.map((skill) => wordScore(word, skill)));
    const weights = perWord.map((scores) => {
      // How common a word is among the skills: a name or a trigger counts fully, a mention in a description half.
      const strong = scores.filter((score) => score >= 4).length;
      const weak = scores.filter((score) => score > 0 && score < 4).length;
      const share = (strong + weak / 2) / all.length;
      if (share > 0.5) return 0.2;
      if (share > 0.3) return 0.5;
      // The one skill a word clearly points at.
      return strong === 1 ? 1.25 : 1;
    });
    const matches: SkillMatch[] = [];
    all.forEach((skill, position) => {
      let score = 0;
      let matched = 0;
      let triggered = false;
      perWord.forEach((scores, word) => {
        const own = scores[position]!;
        if (own === 0) return;
        score += own * weights[word]!;
        // A word that only shares a beginning with one in the description is a hint, not evidence.
        if (own >= 2) matched += 1;
        if (own === 4) triggered = true;
      });
      if (score <= 0) return;
      const record = installed.get(skill.entry.name);
      // Between equals: what is already here, then what was written for this platform.
      score += record !== undefined ? 0.6 : skill.entry.source === 'builtin' ? 0.4 : 0;
      matches.push({ entry: skill.entry, score, installed: record, words: matched, triggered });
    });
    matches.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
    return matches.slice(0, limit);
  }

  /**
   * The skills worth naming to the model for a message: the few that clearly
   * fit, and only ones it can actually load (installed and enabled, or
   * installable by itself). A skill's subject named alone ("deploy it",
   * "add a domain") is not a reason: it takes a word the skill listens for,
   * or two words of the message that point at it.
   */
  suggest(message: string): SkillMatch[] {
    const found = this.search(message, 12).filter((match) => (match.triggered || match.words >= 2) && (match.installed !== undefined ? match.installed.enabled : this.installsItself(match.entry)));
    const best = found[0]?.score ?? 0;
    if (best < 5) return [];
    return found.filter((match) => match.score >= 5 && match.score >= best * 0.65).slice(0, 3);
  }

  /** Whether TorexAi may install this skill without a person: from a trusted place, with nothing in it that needs reading first. */
  installsItself(entry: SkillEntry): boolean {
    return this.auto() === 'trusted' && entry.flags.length === 0 && entry.source !== 'custom';
  }

  // ----------------------------------------------------------------- install

  install(entry: SkillEntry, by: { auto: boolean; userId: string | null }): SkillRecord {
    const { skills } = this.ctx.stores;
    const existing = skills.get(entry.name);
    if (existing === undefined && skills.count() >= AI_SKILL_LIMITS.installedMax) throw new AppError('conflict', `At most ${AI_SKILL_LIMITS.installedMax} skills can be installed; remove some first`);
    const record = skills.put({ name: entry.name, description: entry.description, body: entry.body, files: entry.files, metadata: entry.metadata, source: entry.source, origin: entry.origin, hash: entry.hash, flags: entry.flags, auto: by.auto, installedBy: by.userId });
    return record;
  }

  /** Write or rewrite a skill of this instance's own. */
  saveCustom(input: { name: string; description: string; body: string }, userId: string): SkillRecord {
    const { skills } = this.ctx.stores;
    const existing = skills.get(input.name);
    if ((existing !== undefined && existing.source !== 'custom') || (existing === undefined && this.library.has(input.name))) {
      throw new AppError('conflict', `A skill called ${input.name} already exists; choose another name`);
    }
    const body = input.body.trim();
    return this.install({ ref: input.name, name: input.name, description: input.description.replace(/\s+/g, ' ').trim(), body, files: {}, metadata: {}, hash: skillHash(body, {}), flags: scanSkill(body), source: 'custom', origin: null }, { auto: false, userId });
  }

  setEnabled(name: string, enabled: boolean): void {
    this.ctx.stores.skills.setEnabled(name, enabled);
  }

  remove(name: string): void {
    this.ctx.stores.skills.remove(name);
  }

  /** The playbook as the model is given it, counted as a use. */
  use(record: SkillRecord): SkillEntry {
    this.ctx.stores.skills.used(record.name);
    return this.fromInstalled(record);
  }

  // ----------------------------------------------------------------- sources

  addSource(repo: string, ref: string | null): SkillSourceRecord {
    const { skills } = this.ctx.stores;
    if (skills.sourceByRepo(repo) !== undefined) throw new AppError('conflict', `${repo} is already a source`);
    if (skills.sources().length >= AI_SKILL_LIMITS.sourcesMax) throw new AppError('conflict', `At most ${AI_SKILL_LIMITS.sourcesMax} sources`);
    const source = skills.addSource(repo, ref);
    void this.sync(source.id);
    return source;
  }

  removeSource(id: string): void {
    this.ctx.stores.skills.removeSource(id);
  }

  /** Read a repository again. Never throws: what went wrong is kept on the source for the administrator to see. */
  sync(id: string): Promise<void> {
    const running = this.syncing.get(id);
    if (running !== undefined) return running;
    const { skills } = this.ctx.stores;
    const task = (async () => {
      const source = skills.source(id);
      if (source === undefined) return;
      try {
        const found = await fetchRepositorySkills(source.repo, source.ref, `TorexPloy/${this.ctx.config.version}`, this.fetcher);
        if (skills.source(id) === undefined) return;
        if (found.skills.length === 0) throw new SkillError('No SKILL.md was found in the repository');
        skills.setCatalog(id, found.commit, found.skills);
      } catch (error) {
        if (skills.source(id) !== undefined) skills.setSourceError(id, errorMessage(error).slice(0, 400));
        if (!(error instanceof SkillError)) this.ctx.logger.warn('A skill source could not be read', { repo: source.repo, error: errorMessage(error) });
      }
    })().finally(() => this.syncing.delete(id));
    this.syncing.set(id, task);
    return task;
  }

  /**
   * Read again the repositories that have not been read for a day. Only when
   * TorexAi is in use and may install by itself: an instance that does not
   * want that makes no request of its own.
   */
  async syncDue(): Promise<void> {
    if (this.auto() !== 'trusted' || this.ctx.ai.settings.models().length === 0) return;
    for (const source of this.ctx.stores.skills.sources()) {
      if (this.syncing.has(source.id) || (source.syncedAt !== null && Date.now() - Date.parse(source.syncedAt) < SYNC_EVERY_MS)) continue;
      await this.sync(source.id);
    }
  }

  // -------------------------------------------------------------------- DTOs

  dto(entry: SkillEntry, record: SkillRecord | undefined = this.ctx.stores.skills.get(entry.name)): AiSkillDto {
    const titles: Record<string, string> = {};
    const summaries: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.metadata)) {
      const language = /^(title|summary)[._-]([a-z]{2,3})$/.exec(key);
      if (language !== null) (language[1] === 'title' ? titles : summaries)[language[2]!] = value;
    }
    const installed = record !== undefined && record.name === entry.name;
    // A registry skill is pinned to the text that was installed; the catalog may have moved on since.
    const latest = installed && record.source === 'registry' && record.origin !== null ? this.resolve(`${record.origin.split(':')[0]}:${record.name}`) : undefined;
    return {
      ref: installed ? record.name : entry.ref,
      name: entry.name,
      description: entry.description,
      titles,
      summaries,
      source: entry.source,
      origin: entry.origin,
      installed,
      enabled: installed ? record.enabled : false,
      auto: installed ? record.auto : false,
      flags: entry.flags,
      files: Object.keys(entry.files).sort(),
      bytes: entry.body.length + Object.values(entry.files).reduce((sum, text) => sum + text.length, 0),
      uses: installed ? record.uses : 0,
      lastUsedAt: installed ? record.lastUsedAt : null,
      installedAt: installed ? record.createdAt : null,
      updateAvailable: latest !== undefined && latest.hash !== record!.hash,
    };
  }

  detail(entry: SkillEntry): AiSkillDetailDto {
    return { ...this.dto(entry), body: entry.body };
  }

  sourceDto(source: SkillSourceRecord, counts = this.ctx.stores.skills.catalogCounts()): AiSkillSourceDto {
    return { id: source.id, repo: source.repo, ref: source.ref, skills: counts.get(source.id) ?? 0, commit: source.commit, syncedAt: source.syncedAt, error: source.error, syncing: this.syncing.has(source.id) };
  }

  overview(): AiSkillsDto {
    const { skills } = this.ctx.stores;
    const counts = skills.catalogCounts();
    return {
      auto: this.auto(),
      sources: skills.sources().map((source) => this.sourceDto(source, counts)),
      installed: skills.list().map((record) => this.dto(this.fromInstalled(record), record)),
      available: this.entries().length,
    };
  }

  /** The catalog for the settings page: everything, or what answers a search. */
  browse(query: string | undefined, limit = 80): AiSkillDto[] {
    const { skills } = this.ctx.stores;
    const installed = new Map(skills.list().map((record) => [record.name, record]));
    const chosen = query === undefined || query.length === 0 ? this.entries() : this.search(query, limit).map((match) => match.entry);
    return chosen.slice(0, limit).map((entry) => this.dto(entry, installed.get(entry.name)));
  }
}
