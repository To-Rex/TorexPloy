/**
 * In-process event fan-out.
 *
 * Durable state lives in SQLite and log files; the bus only tells connected
 * dashboards that something changed. Delivery is synchronous and isolated per
 * subscriber, so one broken SSE connection cannot affect a producer or any
 * other subscriber.
 */
import type { LogLine, PlatformEvent } from '@ploy/shared';

type Listener<T> = (value: T) => void;

class Channel<T> {
  private readonly listeners = new Set<Listener<T>>();

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(value: T): void {
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch {
        // A faulty subscriber must never break the producer.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}

export interface TeamEvent {
  teamId: string;
  event: PlatformEvent;
}

/** Recent lines kept per live log, covering the gap between a file write and its flush to disk. */
const RECENT_LINES = 1_000;

export class EventBus {
  private readonly teamEvents = new Channel<TeamEvent>();
  private readonly logChannels = new Map<string, Channel<LogLine | null>>();
  private readonly recent = new Map<string, LogLine[]>();

  emit(teamId: string, event: PlatformEvent): void {
    this.teamEvents.publish({ teamId, event });
  }

  /** Server events are visible to every team that can see the server. */
  onTeamEvent(listener: Listener<TeamEvent>): () => void {
    return this.teamEvents.subscribe(listener);
  }

  /** Publish a log line for `key` (a deployment or cron run id). `null` marks the end of the log. */
  log(key: string, line: LogLine | null): void {
    if (line === null) {
      this.recent.delete(key);
    } else {
      let buffer = this.recent.get(key);
      if (buffer === undefined) {
        buffer = [];
        this.recent.set(key, buffer);
      }
      buffer.push(line);
      if (buffer.length > RECENT_LINES) buffer.splice(0, buffer.length - RECENT_LINES);
    }
    const channel = this.logChannels.get(key);
    if (channel === undefined) return;
    channel.publish(line);
    if (line === null) this.logChannels.delete(key);
  }

  /** Lines of a log that is still being written, newest last. */
  recentLines(key: string): LogLine[] {
    return [...(this.recent.get(key) ?? [])];
  }

  onLog(key: string, listener: Listener<LogLine | null>): () => void {
    let channel = this.logChannels.get(key);
    if (channel === undefined) {
      channel = new Channel();
      this.logChannels.set(key, channel);
    }
    const unsubscribe = channel.subscribe(listener);
    return () => {
      unsubscribe();
      if (channel.size === 0) this.logChannels.delete(key);
    };
  }
}
