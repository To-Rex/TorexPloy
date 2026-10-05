/**
 * The guide: how the platform is meant to be used, chapter by chapter. A
 * table of contents follows the reader, a search looks through every
 * section, and each section links to the place in the dashboard it is about.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import {
  Activity,
  Archive,
  ArrowRight,
  BellRing,
  BookOpen,
  CalendarClock,
  Compass,
  Database,
  Download,
  FolderKanban,
  GitBranch,
  Globe,
  Hammer,
  HardDrive,
  History,
  Layers,
  LayoutGrid,
  LayoutPanelLeft,
  Play,
  RefreshCw,
  Rocket,
  ScrollText,
  Search,
  Server,
  Settings,
  Shield,
  Users,
  Variable,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { CopyButton } from '../components/Copy.tsx';
import { Frame } from '../components/Frame.tsx';
import { usePageMeta } from '../components/PageMeta.tsx';
import { Callout, EmptyState, Skeleton } from '../components/ui.tsx';
import { loadGuide, type GuideBlock, type GuideContent, type GuideIcon, type GuideSection } from '../guide/index.ts';
import { useI18n } from '../i18n/index.tsx';

const ICONS: Record<GuideIcon, LucideIcon> = {
  rocket: Rocket,
  compass: Compass,
  layout: LayoutPanelLeft,
  folder: FolderKanban,
  hammer: Hammer,
  play: Play,
  history: History,
  variable: Variable,
  globe: Globe,
  scroll: ScrollText,
  activity: Activity,
  clock: CalendarClock,
  git: GitBranch,
  layers: Layers,
  database: Database,
  archive: Archive,
  'hard-drive': HardDrive,
  grid: LayoutGrid,
  users: Users,
  shield: Shield,
  bell: BellRing,
  server: Server,
  settings: Settings,
  refresh: RefreshCw,
  wrench: Wrench,
  download: Download,
};

/** `**bold**`, `` `code` `` and `[label](/route)` inside guide text. */
const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
const LINK = /^\[([^\]]+)\]\(([^)]+)\)$/;

function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(TOKEN).map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
        if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
        const link = LINK.exec(part);
        if (link !== null) {
          return (
            <Link key={index} to={link[2]!}>
              {link[1]}
            </Link>
          );
        }
        return part;
      })}
    </>
  );
}

/** Everything a section says, for the search. */
function textOf(section: GuideSection): string {
  const pieces = [section.title, section.summary];
  for (const block of section.blocks) {
    if (block.type === 'p' || block.type === 'code') pieces.push(block.text);
    else if (block.type === 'tip') pieces.push(block.title ?? '', block.text);
    else if (block.type === 'list') pieces.push(...block.items);
    else if (block.type === 'steps') for (const step of block.items) pieces.push(step.title, step.text ?? '');
    else if (block.type === 'table') pieces.push(...block.head, ...block.rows.flat());
    else for (const item of block.items) pieces.push(item.q, item.a);
  }
  return pieces.join('\n').toLowerCase();
}

function Block({ block }: { block: GuideBlock }) {
  switch (block.type) {
    case 'p':
      return (
        <p className="guide__p">
          <Rich text={block.text} />
        </p>
      );
    case 'steps':
      return (
        <ol className="guide__steps">
          {block.items.map((step, index) => (
            <li key={index}>
              <span className="guide__step-num" aria-hidden="true">
                {index + 1}
              </span>
              <div>
                <strong>
                  <Rich text={step.title} />
                </strong>
                {step.text !== undefined && (
                  <p>
                    <Rich text={step.text} />
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      );
    case 'list':
      return (
        <ul className="guide__list">
          {block.items.map((item, index) => (
            <li key={index}>
              <Rich text={item} />
            </li>
          ))}
        </ul>
      );
    case 'tip':
      return (
        <Callout tone={block.tone} title={block.title}>
          <Rich text={block.text} />
        </Callout>
      );
    case 'code':
      return (
        <div>
          {block.label !== undefined && <span className="guide__code-label">{block.label}</span>}
          <div className="codeblock">
            {block.text}
            <CopyButton value={block.text} />
          </div>
        </div>
      );
    case 'table':
      return (
        <div className="guide__table-wrap">
          <table className="guide__table">
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index}>{cell}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>
                      <Rich text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'faq':
      return (
        <div className="guide__faq">
          {block.items.map((item, index) => (
            <details key={index} className="guide__faq-item">
              <summary>
                <Rich text={item.q} />
              </summary>
              <p>
                <Rich text={item.a} />
              </p>
            </details>
          ))}
        </div>
      );
  }
}

function SectionView({ section, next, openLabel, nextLabel }: { section: GuideSection; next: GuideSection | undefined; openLabel: string; nextLabel: string }) {
  const Icon = ICONS[section.icon];
  return (
    <article id={section.id} className="guide__section" data-guide-section aria-labelledby={`guide-${section.id}`}>
      <header className="guide__section-head">
        <span className="guide__section-icon" aria-hidden="true">
          <Icon />
        </span>
        <div className="grow" style={{ minWidth: 0 }}>
          <h3 id={`guide-${section.id}`}>{section.title}</h3>
          <p className="guide__summary">
            <Rich text={section.summary} />
          </p>
        </div>
        {section.to !== undefined && (
          <Link className="btn btn--sm guide__open" to={section.to}>
            {openLabel}
            <ArrowRight width={14} height={14} aria-hidden="true" />
          </Link>
        )}
      </header>
      {section.blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
      {next !== undefined && (
        <div className="guide__next">
          <Link to={`/guide/${next.id}`}>
            {nextLabel}: {next.title}
            <ArrowRight width={14} height={14} aria-hidden="true" />
          </Link>
        </div>
      )}
    </article>
  );
}

/** Which section is in view, so the table of contents can follow. */
function useActiveSection(ready: boolean): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    const articles = Array.from(document.querySelectorAll<HTMLElement>('[data-guide-section]'));
    if (articles.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0] !== undefined) setActive(visible[0].target.id);
      },
      { rootMargin: '-15% 0px -70% 0px', threshold: [0, 0.2] },
    );
    for (const article of articles) observer.observe(article);
    return () => observer.disconnect();
  }, [ready]);
  return active;
}

export function GuidePage() {
  const { m, locale, plural } = useI18n();
  const { section: wanted } = useParams();
  usePageMeta([{ label: m.guide.title }]);
  const [content, setContent] = useState<GuideContent | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    void loadGuide(locale).then((loaded) => {
      if (!cancelled) setContent(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const needle = query.trim().toLowerCase();
  const chapters = useMemo(() => {
    if (content === null) return [];
    if (needle.length === 0) return content.chapters;
    return content.chapters.map((chapter) => ({ ...chapter, sections: chapter.sections.filter((section) => textOf(section).includes(needle)) })).filter((chapter) => chapter.sections.length > 0);
  }, [content, needle]);
  const sections = useMemo(() => chapters.flatMap((chapter) => chapter.sections), [chapters]);
  const total = content === null ? 0 : content.chapters.reduce((sum, chapter) => sum + chapter.sections.length, 0);
  const active = useActiveSection(content !== null);

  // Deep links (`/guide/domains`) and table-of-contents clicks scroll to the section.
  useEffect(() => {
    if (content === null || wanted === undefined) return;
    const target = document.getElementById(wanted);
    if (target === null) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }, [content, wanted]);

  let facts: ReactNode = null;
  if (content !== null) {
    facts = (
      <div className="guide__facts" aria-hidden="true">
        <span>{plural(m.guide.chapters, content.chapters.length)}</span>
        <span>{plural(m.guide.sections, total)}</span>
        <span>{m.guide.languages}</span>
      </div>
    );
  }

  return (
    <div className="page page--wide guide">
      <Frame icon={<BookOpen />} title={m.guide.title} description={m.guide.subtitle}>
        {content === null ? (
          <div className="stack" style={{ gap: 16 }}>
            <Skeleton height={60} />
            <Skeleton height={140} />
            <Skeleton height={420} />
          </div>
        ) : (
          <>
            <div className="guide__hero">
              <p className="guide__intro">
                <Rich text={content.intro} />
              </p>
              <label className="guide__search">
                <Search aria-hidden="true" />
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={m.guide.search} aria-label={m.guide.search} />
              </label>
              {facts}
            </div>

            {needle.length === 0 && (
              <section className="guide__quick" aria-label={m.guide.quickStart}>
                <h2>{m.guide.quickStart}</h2>
                <ol className="guide__quick-grid">
                  {content.quickStart.map((step, index) => (
                    <li key={index} className="guide__quick-card">
                      <span className="guide__quick-num" aria-hidden="true">
                        {index + 1}
                      </span>
                      <strong>{step.title}</strong>
                      <p>{step.text}</p>
                      {step.to !== undefined && (
                        <Link className="guide__quick-link" to={step.to}>
                          {m.guide.go}
                          <ArrowRight aria-hidden="true" />
                        </Link>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <div className="guide__layout">
              <nav className="guide__toc" aria-label={m.guide.contents}>
                <div className="guide__toc-title">{m.guide.contents}</div>
                {chapters.map((chapter) => (
                  <div key={chapter.id} className="guide__toc-chapter">
                    <div className="guide__toc-label">{chapter.title}</div>
                    {chapter.sections.map((section) => {
                      const Icon = ICONS[section.icon];
                      return (
                        <Link key={section.id} className="guide__toc-link" to={`/guide/${section.id}`} aria-current={active === section.id ? 'location' : undefined}>
                          <Icon aria-hidden="true" />
                          <span className="truncate">{section.title}</span>
                        </Link>
                      );
                    })}
                  </div>
                ))}
              </nav>
              <div className="guide__body">
                {needle.length > 0 && <p className="guide__count">{plural(m.guide.found, sections.length)}</p>}
                {chapters.length === 0 ? (
                  <EmptyState icon={<Search />}>{m.guide.empty}</EmptyState>
                ) : (
                  chapters.map((chapter, chapterIndex) => (
                    <section key={chapter.id} className="guide__chapter" aria-labelledby={`guide-chapter-${chapter.id}`}>
                      <h2 id={`guide-chapter-${chapter.id}`} className="guide__chapter-title">
                        <span className="guide__chapter-num">{chapterIndex + 1}</span>
                        {chapter.title}
                      </h2>
                      {chapter.sections.map((section) => {
                        const position = sections.indexOf(section);
                        return <SectionView key={section.id} section={section} next={sections[position + 1]} openLabel={m.guide.open} nextLabel={m.guide.next} />;
                      })}
                    </section>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </Frame>
    </div>
  );
}
