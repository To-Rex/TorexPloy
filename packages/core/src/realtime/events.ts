/**
 * In-process event bus.
 *
 * Realtime features (build logs, metrics, deployment state changes) all flow
 * through here. It is deliberately small and synchronous: subscribers receive
 * an event in the same tick, and a slow consumer cannot block a producer
 * because delivery failures are contained per subscriber.
 *
 * The bus is not a message queue — durable state lives in SQLite and log
 * files. This is the fan-out layer on top of that state.
 */

export type EventTopic =
  | 'deployment.updated'
  | 'deployment.log'
  | 'application.updated'
  | 'service.updated'
  | 'server.updated'
  | 'metrics.sample'
  | 'job.updated'
  | 'system';

export interface PlatformEvent<T = unknown> {
  topic: EventTopic;
  /** Correlation id, e.g. a deployment or application id. */
  key: string;
  payload: T;
  at: string;
}

export interface DeploymentLogPayload {
  deploymentId: string;
  applicationId: string;
  stream: 'stdout' | 'stderr' | 'system';
  message: string;
  /** Monotonic sequence, used by clients to detect gaps. */
  seq: number;
}

export type Unsubscribe = () => void;

type Handler = (event: PlatformEvent<never>) => void;

export class EventBus {
  private readonly handlers = new Map<EventTopic, Set<Handler>>();
  private readonly global = new Set<Handler>();
  private readonly sequences = new Map<string, number>();

  /** Subscribe to one topic. Returns an unsubscribe function. */
  on(topic: EventTopic, handler: Handler): Unsubscribe {
    let set = this.handlers.get(topic);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** Subscribe to every topic. Used by the platform-wide SSE stream. */
  onAny(handler: Handler): Unsubscribe {
    this.global.add(handler);
    return () => {
      this.global.delete(handler);
    };
  }

  /**
   * Publish an event. A throwing subscriber is isolated so one broken
   * consumer cannot stop the others (or the producer).
   */
  emit<T>(topic: EventTopic, key: string, payload: T): PlatformEvent<T> {
    const event: PlatformEvent<T> = { topic, key, payload, at: new Date().toISOString() };

    for (const handler of this.handlers.get(topic) ?? []) {
      try {
        handler(event as PlatformEvent<never>);
      } catch {
        // Isolated by design.
      }
    }
    for (const handler of this.global) {
      try {
        handler(event as PlatformEvent<never>);
      } catch {
        // Isolated by design.
      }
    }
    return event;
  }

  /**
   * Next sequence number for a key. Clients use it to detect dropped events
   * (for example when a browser tab was suspended).
   */
  nextSequence(key: string): number {
    const next = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, next);
    return next;
  }

  currentSequence(key: string): number {
    return this.sequences.get(key) ?? 0;
  }

  /** Publish a deployment log line with an auto-incrementing sequence. */
  log(entry: Omit<DeploymentLogPayload, 'seq'>): DeploymentLogPayload {
    const payload: DeploymentLogPayload = { ...entry, seq: this.nextSequence(entry.deploymentId) };
    this.emit('deployment.log', entry.deploymentId, payload);
    return payload;
  }

  subscriberCount(topic?: EventTopic): number {
    if (topic === undefined) return this.global.size;
    return (this.handlers.get(topic)?.size ?? 0) + this.global.size;
  }
}
