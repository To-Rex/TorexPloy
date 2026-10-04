/**
 * In-process periodic tasks.
 *
 * Each task runs on its own interval, never overlaps itself, and is isolated:
 * a throwing task is logged and retried on its next tick. Timers are unref'd
 * so they never keep a shutting-down process alive.
 */
import { errorMessage } from '../lib/errors.ts';
import type { Logger } from '../lib/logger.ts';

interface Task {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown> | unknown;
  timer: NodeJS.Timeout | null;
  running: boolean;
}

export class Scheduler {
  private readonly logger: Logger;
  private readonly tasks: Task[] = [];
  private stopped = false;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'scheduler' });
  }

  every(name: string, intervalMs: number, run: Task['run'], initialDelayMs = intervalMs): void {
    const task: Task = { name, intervalMs, run, timer: null, running: false };
    this.tasks.push(task);
    this.arm(task, initialDelayMs);
  }

  private arm(task: Task, delay: number): void {
    if (this.stopped) return;
    task.timer = setTimeout(() => void this.fire(task), delay);
    task.timer.unref();
  }

  private async fire(task: Task): Promise<void> {
    if (task.running || this.stopped) return;
    task.running = true;
    const started = Date.now();
    try {
      await task.run();
    } catch (error) {
      this.logger.warn('Scheduled task failed', { task: task.name, error: errorMessage(error) });
    } finally {
      task.running = false;
      const elapsed = Date.now() - started;
      if (elapsed > task.intervalMs) this.logger.debug('Scheduled task overran its interval', { task: task.name, elapsedMs: elapsed });
      this.arm(task, Math.max(1_000, task.intervalMs - elapsed));
    }
  }

  stop(): void {
    this.stopped = true;
    for (const task of this.tasks) if (task.timer !== null) clearTimeout(task.timer);
  }
}
