/**
 * The steps of an export or import as the dashboard shows them: each with its
 * status, how far it got and why it was skipped or failed, and one percentage
 * over all of them. Changes reach the row (and the browser) at most a few
 * times a second, however often the work reports.
 */
import type { TransferNoteDto, TransferStepDto, TransferStepKind } from '@ploy/shared';

const FLUSH_MS = 700;

export function note(code: string, message: string, params?: Record<string, string | number>): TransferNoteDto {
  return params === undefined ? { code, message } : { code, params, message };
}

interface StepState extends TransferStepDto {
  weight: number;
}

export class Progress {
  private readonly steps: StepState[];
  readonly warnings: TransferNoteDto[];
  private readonly save: (state: { steps: TransferStepDto[]; percent: number; warnings: TransferNoteDto[] }) => void;
  private timer: NodeJS.Timeout | null = null;
  /** Overrides the weighted sum (an import measures by how far into the archive it is). */
  percentOf: (() => number) | null = null;

  constructor(initial: { steps: TransferStepDto[]; warnings: TransferNoteDto[] }, save: Progress['save']) {
    this.steps = initial.steps.map((step) => ({ ...step, weight: 1 }));
    this.warnings = [...initial.warnings];
    this.save = save;
  }

  has(key: string): boolean {
    return this.steps.some((step) => step.key === key);
  }

  get(key: string): TransferStepDto | undefined {
    return this.steps.find((step) => step.key === key);
  }

  /** Add a step (or find the one a previous attempt added). */
  add(key: string, kind: TransferStepKind, name: string | null, options: { weight?: number; total?: number | null; unit?: 'bytes' | 'items' | null } = {}): string {
    const existing = this.steps.find((step) => step.key === key);
    if (existing !== undefined) {
      existing.weight = options.weight ?? existing.weight;
      return key;
    }
    this.steps.push({ key, kind, name, status: 'pending', done: null, total: options.total ?? null, unit: options.unit ?? null, note: null, weight: options.weight ?? 1 });
    this.changed();
    return key;
  }

  private step(key: string): StepState {
    const step = this.steps.find((candidate) => candidate.key === key);
    if (step === undefined) throw new Error(`No step ${key}`);
    return step;
  }

  start(key: string, total: number | null = null, unit: 'bytes' | 'items' | null = null): void {
    const step = this.step(key);
    step.status = 'running';
    step.done = total === null ? null : 0;
    step.total = total;
    step.unit = unit;
    step.note = null;
    this.changed();
  }

  /** The total became known (or changed) while the step runs. */
  total(key: string, total: number | null, unit: 'bytes' | 'items' | null = 'bytes'): void {
    const step = this.step(key);
    step.total = total;
    step.unit = unit;
    step.done ??= 0;
    this.changed();
  }

  advance(key: string, delta: number): void {
    const step = this.step(key);
    step.done = (step.done ?? 0) + delta;
    this.changed();
  }

  set(key: string, done: number): void {
    const step = this.step(key);
    step.done = done;
    this.changed();
  }

  done(key: string, extra: { note?: TransferNoteDto | null; total?: number | null } = {}): void {
    const step = this.step(key);
    step.status = 'done';
    if (extra.total !== undefined) step.total = extra.total;
    if (step.total !== null) step.done = step.total;
    if (extra.note !== undefined) step.note = extra.note;
    this.changed(true);
  }

  skip(key: string, reason: TransferNoteDto | null = null): void {
    const step = this.step(key);
    step.status = 'skipped';
    step.note = reason;
    this.changed(true);
  }

  fail(key: string, reason: TransferNoteDto): void {
    const step = this.step(key);
    step.status = 'failed';
    step.note = reason;
    this.changed(true);
  }

  /** Steps still pending or running when the work stopped are left as they were, except the running ones, which failed. */
  failRunning(reason: TransferNoteDto): void {
    for (const step of this.steps) if (step.status === 'running') this.fail(step.key, reason);
  }

  warn(warning: TransferNoteDto): void {
    if (this.warnings.some((existing) => existing.code === warning.code && existing.message === warning.message)) return;
    this.warnings.push(warning);
    this.changed(true);
  }

  percent(): number {
    if (this.percentOf !== null) return Math.max(0, Math.min(100, this.percentOf()));
    let total = 0;
    let done = 0;
    for (const step of this.steps) {
      total += step.weight;
      if (step.status === 'done' || step.status === 'skipped') done += step.weight;
      else if (step.status === 'running' && step.total !== null && step.total > 0 && step.done !== null) done += step.weight * Math.min(1, step.done / step.total);
    }
    return total === 0 ? 0 : Math.min(100, (done / total) * 100);
  }

  snapshot(): { steps: TransferStepDto[]; percent: number; warnings: TransferNoteDto[] } {
    return {
      steps: this.steps.map(({ weight: _weight, ...step }) => step),
      percent: Math.round(this.percent() * 10) / 10,
      warnings: [...this.warnings],
    };
  }

  private changed(now = false): void {
    if (now) {
      this.flush();
      return;
    }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.save(this.snapshot());
  }
}
