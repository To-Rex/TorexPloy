/**
 * The in-app guide: a handful of chapters, each a list of sections made of
 * plain blocks. Text uses a tiny inline markup — `**bold**`, `` `code` `` and
 * `[label](/route)` links into the dashboard — rendered by the guide page.
 */
export type GuideIcon =
  | 'rocket'
  | 'compass'
  | 'layout'
  | 'folder'
  | 'hammer'
  | 'play'
  | 'history'
  | 'variable'
  | 'globe'
  | 'scroll'
  | 'activity'
  | 'clock'
  | 'git'
  | 'layers'
  | 'database'
  | 'archive'
  | 'hard-drive'
  | 'grid'
  | 'users'
  | 'shield'
  | 'bell'
  | 'server'
  | 'settings'
  | 'refresh'
  | 'wrench'
  | 'download';

export interface GuideStep {
  title: string;
  text?: string;
}

export type GuideBlock =
  | { type: 'p'; text: string }
  /** A real sequence: do this, then that. */
  | { type: 'steps'; items: GuideStep[] }
  | { type: 'list'; items: string[] }
  | { type: 'tip'; tone: 'info' | 'ok' | 'work' | 'bad'; title?: string; text: string }
  | { type: 'code'; text: string; label?: string }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'faq'; items: { q: string; a: string }[] };

export interface GuideSection {
  id: string;
  icon: GuideIcon;
  title: string;
  summary: string;
  /** Where in the dashboard this happens; shown as a button. */
  to?: string;
  blocks: GuideBlock[];
}

export interface GuideChapter {
  id: string;
  title: string;
  sections: GuideSection[];
}

export interface GuideContent {
  intro: string;
  quickStart: { title: string; text: string; to?: string }[];
  chapters: GuideChapter[];
}
