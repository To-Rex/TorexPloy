/**
 * Progress of a self-update, as the updater reports it.
 *
 * The updater runs in its own container and only has stdout, so it writes
 * one marker line per step — `::progress {"stage":…,"percent":…,"message":…}`
 * — among its ordinary log lines. The control plane reads the markers back
 * from the container's log (the latest one for the status, all of them when
 * streaming) and the dashboard turns them into a stage rail and a bar.
 */
import { UPDATE_STAGES, type UpdateProgressDto, type UpdateStage } from '@ploy/shared';

export const PROGRESS_MARKER = '::progress ';

/** Where each stage begins on the bar; the next stage's start is where it ends. */
export const STAGE_START: Record<UpdateStage, number> = { fetch: 0, build: 10, replace: 80, health: 92, done: 100 };

/** Updater and Docker both prefix lines with an ISO timestamp (`2026-… text`); strip any number of them. */
export function stripTimestamps(line: string): string {
  let text = line;
  for (;;) {
    const match = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z?\s+/.exec(text);
    if (match === null) return text;
    text = text.slice(match[0].length);
  }
}

export function formatProgress(progress: UpdateProgressDto): string {
  return `${PROGRESS_MARKER}${JSON.stringify(progress)}`;
}

/** The marker on a line, if it carries one. */
export function parseProgress(line: string): UpdateProgressDto | null {
  const text = stripTimestamps(line).trim();
  if (!text.startsWith(PROGRESS_MARKER)) return null;
  try {
    const value = JSON.parse(text.slice(PROGRESS_MARKER.length)) as Partial<UpdateProgressDto>;
    if (typeof value.stage !== 'string' || !(UPDATE_STAGES as readonly string[]).includes(value.stage)) return null;
    const percent = typeof value.percent === 'number' && Number.isFinite(value.percent) ? Math.max(0, Math.min(100, Math.round(value.percent))) : STAGE_START[value.stage as UpdateStage];
    return { stage: value.stage as UpdateStage, percent, message: typeof value.message === 'string' ? value.message : '' };
  } catch {
    return null;
  }
}

/** The last marker in a block of log text. */
export function latestProgress(text: string): UpdateProgressDto | null {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const progress = parseProgress(lines[index]!);
    if (progress !== null) return progress;
  }
  return null;
}

/**
 * Build progress from a BuildKit line (`--progress plain`): `#12 [stage 3/9] RUN …`
 * gives the step's share of the build; `#12 DONE 1.2s` closes it. Returns the
 * fraction of the build stage (0–1) or null for lines that say nothing about it.
 */
export function buildStepFraction(line: string): number | null {
  const step = /^#\d+ \[(?:[^\]\s]+ )?(\d+)\/(\d+)\]/.exec(line.trim());
  if (step === null) return null;
  const index = Number(step[1]);
  const total = Number(step[2]);
  if (!(total > 0) || index < 0) return null;
  return Math.min(1, index / total);
}

/** Percent on the bar for a fraction of one stage. */
export function stagePercent(stage: UpdateStage, fraction: number): number {
  const start = STAGE_START[stage];
  const next = UPDATE_STAGES[UPDATE_STAGES.indexOf(stage) + 1];
  const end = next === undefined ? 100 : STAGE_START[next];
  return Math.round(start + (end - start) * Math.max(0, Math.min(1, fraction)));
}
