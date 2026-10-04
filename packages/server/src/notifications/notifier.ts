/**
 * Outgoing notifications: Telegram, Discord, Slack and signed webhooks.
 *
 * Callers report what happened (a deployment finished, an app is crashing);
 * the notifier finds the team's channels subscribed to that event, renders
 * the message in each channel's language and format, and delivers it in the
 * background. Delivery never blocks or fails the operation that triggered
 * it; the last result is stored on the channel so a broken channel is
 * visible in settings. Repeating alarms (crash loops, a flapping server) are
 * collapsed so a channel is not flooded.
 */
import { createHmac } from 'node:crypto';
import type { NotificationEvent } from '@ploy/shared';
import type { Context } from '../context.ts';
import { publicBaseUrl } from '../github/app.ts';
import { errorMessage } from '../lib/errors.ts';
import type { ApplicationRecord, NotificationChannelRecord, ServerRecord, ServiceRecord } from '../store/index.ts';
import { fill, MESSAGES, type MessageTexts } from './messages.ts';

export interface Message {
  title: string;
  lines: string[];
  /** Technical detail (an error message), shown as code. */
  detail: string | null;
  /** Panel path to open, made absolute when the panel has a public URL. */
  path: string | null;
}

type Render = (texts: MessageTexts) => Message;

const TIMEOUT_MS = 10_000;
/** Do not repeat the same alarm for the same resource within this window. */
const REPEAT_WINDOW_MS = 30 * 60_000;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Render one message for one channel kind. Pure; exported for tests. */
export function renderFor(kind: NotificationChannelRecord['kind'], message: Message, url: string | null, openLabel: string): { body: Record<string, unknown> } {
  const detail = message.detail === null ? null : clip(message.detail, 600);
  switch (kind) {
    case 'telegram': {
      const parts = [`<b>${escapeHtml(message.title)}</b>`, ...message.lines.map(escapeHtml)];
      if (detail !== null) parts.push(`<pre>${escapeHtml(detail)}</pre>`);
      if (url !== null) parts.push(`<a href="${escapeHtml(url)}">${escapeHtml(openLabel)}</a>`);
      return { body: { text: parts.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true } };
    }
    case 'discord': {
      const parts = [`**${message.title}**`, ...message.lines];
      if (detail !== null) parts.push(`\`\`\`\n${detail.replace(/```/g, "'''")}\n\`\`\``);
      if (url !== null) parts.push(`[${openLabel}](<${url}>)`);
      // Never ping anyone from text that may contain user-controlled names.
      return { body: { content: clip(parts.join('\n'), 1_900), allowed_mentions: { parse: [] } } };
    }
    case 'slack': {
      const parts = [`*${message.title}*`, ...message.lines];
      if (detail !== null) parts.push(`\`\`\`${detail.replace(/```/g, "'''")}\`\`\``);
      if (url !== null) parts.push(`<${url}|${openLabel}>`);
      return { body: { text: parts.join('\n') } };
    }
    case 'webhook':
      return { body: { title: message.title, lines: message.lines, detail, url } };
  }
}

export class Notifier {
  private readonly ctx: Context;
  private readonly recent = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  // ----------------------------------------------------------------- events

  deploymentFinished(deploymentId: string): void {
    const { stores } = this.ctx;
    const deployment = stores.deployments.get(deploymentId);
    if (deployment === undefined || (deployment.status !== 'succeeded' && deployment.status !== 'failed')) return;
    const app = stores.applications.get(deployment.applicationId);
    if (app === undefined) return;
    // Self-healing restarts are routine; only their failures are news.
    if (deployment.status === 'succeeded' && deployment.trigger === 'restart' && deployment.createdBy === null) return;
    const project = stores.projects.get(app.projectId)?.name ?? '';
    const commit = deployment.commitSha === null ? null : `${deployment.commitSha.slice(0, 7)}${deployment.commitMessage === null ? '' : ` ${clip(deployment.commitMessage.split('\n')[0]!, 120)}`}`;
    if (deployment.status === 'succeeded') {
      this.dispatch(app.teamId, 'deployment.succeeded', null, (texts) => ({
        title: fill(texts.deploySucceeded, { app: app.name }),
        lines: [fill(texts.project, { project }), ...(commit === null ? [] : [commit])],
        detail: null,
        path: `/deployments/${deployment.id}`,
      }));
      return;
    }
    const serving = stores.applications.get(app.id)?.activeDeploymentId != null;
    this.dispatch(app.teamId, 'deployment.failed', null, (texts) => {
      const reason = deployment.errorCode === null ? undefined : texts.reasons[deployment.errorCode];
      return {
        title: fill(texts.deployFailed, { app: app.name }),
        lines: [fill(texts.project, { project }), ...(commit === null ? [] : [commit]), ...(reason === undefined ? [] : [reason]), ...(serving ? [texts.previousServing] : [])],
        detail: deployment.errorMessage,
        path: `/deployments/${deployment.id}`,
      };
    });
  }

  appCrashed(app: ApplicationRecord): void {
    const project = this.ctx.stores.projects.get(app.projectId)?.name ?? '';
    this.dispatch(app.teamId, 'application.crashed', `crash:${app.id}`, (texts) => ({
      title: fill(texts.appCrashed, { app: app.name }),
      lines: [fill(texts.project, { project }), texts.crashedHint],
      detail: null,
      path: `/apps/${app.id}/logs`,
    }));
  }

  backupFailed(service: ServiceRecord, error: string): void {
    const project = this.ctx.stores.projects.get(service.projectId)?.name ?? '';
    this.dispatch(service.teamId, 'backup.failed', null, (texts) => ({
      title: fill(texts.backupFailed, { service: service.name }),
      lines: [fill(texts.project, { project })],
      detail: error,
      path: `/services/${service.id}/backups`,
    }));
  }

  serverOffline(server: ServerRecord, message: string | null): void {
    this.dispatch(server.teamId, 'server.offline', `offline:${server.id}`, (texts) => ({
      title: fill(texts.serverOffline, { server: server.name }),
      lines: [],
      detail: message,
      path: `/servers/${server.id}`,
    }));
  }

  serverRecovered(server: ServerRecord): void {
    this.recent.delete(`offline:${server.id}`);
    this.dispatch(server.teamId, 'server.offline', null, (texts) => ({ title: fill(texts.serverRecovered, { server: server.name }), lines: [], detail: null, path: `/servers/${server.id}` }));
  }

  /** Send a test message right now; resolves with the delivery error, or null on success. */
  async test(channel: NotificationChannelRecord): Promise<string | null> {
    const texts = MESSAGES[channel.locale];
    return this.deliver(channel, { title: texts.testTitle, lines: [texts.testText], detail: null, path: '/settings/notifications' }, 'test');
  }

  /** Wait for deliveries in flight (shutdown, tests). */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  // --------------------------------------------------------------- delivery

  /** `teamId` null means a shared server: every team hears about it. */
  private dispatch(teamId: string | null, event: NotificationEvent, dedupeKey: string | null, render: Render): void {
    const now = Date.now();
    if (dedupeKey !== null) {
      const last = this.recent.get(dedupeKey);
      if (last !== undefined && now - last < REPEAT_WINDOW_MS) return;
      this.recent.set(dedupeKey, now);
      if (this.recent.size > 5_000) for (const [key, at] of this.recent) if (now - at > REPEAT_WINDOW_MS) this.recent.delete(key);
    }
    const { stores } = this.ctx;
    const teams = teamId !== null ? [teamId] : stores.db.all('SELECT id FROM teams').map((row) => String(row.id));
    for (const team of teams) {
      for (const channel of stores.notifications.subscribed(team, event)) {
        const task = this.deliver(channel, render(MESSAGES[channel.locale]), event).then(() => undefined);
        this.pending.add(task);
        void task.finally(() => this.pending.delete(task));
      }
    }
  }

  private async deliver(channel: NotificationChannelRecord, message: Message, event: NotificationEvent | 'test'): Promise<string | null> {
    const base = publicBaseUrl(this.ctx);
    const url = base === null || message.path === null ? null : `${base}${message.path}`;
    const { body } = renderFor(channel.kind, message, url, MESSAGES[channel.locale].open);
    let error: string | null = null;
    try {
      await this.post(channel, event, body);
    } catch (caught) {
      error = clip(errorMessage(caught), 300);
      this.ctx.logger.warn('Notification delivery failed', { channelId: channel.id, kind: channel.kind, event, error });
    }
    try {
      this.ctx.stores.notifications.recordResult(channel.id, error);
    } catch {
      // The channel was deleted meanwhile, or the database is closing.
    }
    return error;
  }

  private async post(channel: NotificationChannelRecord, event: NotificationEvent | 'test', body: Record<string, unknown>): Promise<void> {
    const config = channel.config;
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const json = (payload: unknown, headers: Record<string, string> = {}) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `TorexPloy/${this.ctx.config.version}`, ...headers },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      signal,
      redirect: 'error' as const,
    });

    if (config.kind === 'telegram') {
      const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, json({ chat_id: config.chatId, ...body }));
      if (!response.ok) {
        const reply = (await response.json().catch(() => ({}))) as { description?: string };
        throw new Error(`Telegram: ${reply.description ?? `HTTP ${response.status}`}`);
      }
      return;
    }
    if (config.kind === 'webhook') {
      const payload = JSON.stringify({ event, sentAt: new Date().toISOString(), ...body });
      const headers: Record<string, string> = { 'x-ploy-event': event };
      if (config.secret !== undefined) headers['x-ploy-signature'] = `sha256=${createHmac('sha256', config.secret).update(payload).digest('hex')}`;
      const response = await fetch(config.url, json(payload, headers));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await response.body?.cancel();
      return;
    }
    const response = await fetch(config.url, json(body));
    if (!response.ok) throw new Error(`${config.kind === 'discord' ? 'Discord' : 'Slack'}: HTTP ${response.status}`);
    await response.body?.cancel();
  }
}

/** A short, secret-free description of where a channel delivers. */
export function channelTarget(channel: Pick<NotificationChannelRecord, 'config'>): string {
  const config = channel.config;
  if (config.kind === 'telegram') return `chat ${config.chatId}`;
  try {
    const url = new URL(config.url);
    const tail = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    return `${url.host}${tail.length > 0 ? `/…/${tail.slice(-4)}` : ''}`;
  } catch {
    return config.kind;
  }
}
