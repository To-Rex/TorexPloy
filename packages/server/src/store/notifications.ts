/**
 * Notification channels. The destination (bot token, webhook URL, signing
 * secret) is sealed at rest like every other credential.
 */
import type { Locale, NotificationConfigInput, NotificationEvent, NotificationKind } from '@ploy/shared';
import type { Database } from '../db/database.ts';
import { newId, nowIso } from '../lib/ids.ts';
import type { Secrets } from '../lib/secrets.ts';
import { bool, int01, json, str, strOrNull, type Row } from './util.ts';

export interface NotificationChannelRecord {
  id: string;
  teamId: string;
  name: string;
  kind: NotificationKind;
  config: NotificationConfigInput;
  locale: Locale;
  events: NotificationEvent[];
  enabled: boolean;
  lastStatus: 'ok' | 'failed' | null;
  lastError: string | null;
  lastSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationChannelPatch {
  name?: string;
  locale?: Locale;
  events?: NotificationEvent[];
  enabled?: boolean;
  config?: NotificationConfigInput;
}

export class NotificationStore {
  private readonly db: Database;
  private readonly secrets: Secrets;

  constructor(db: Database, secrets: Secrets) {
    this.db = db;
    this.secrets = secrets;
  }

  private map(row: Row): NotificationChannelRecord {
    return {
      id: str(row.id),
      teamId: str(row.team_id),
      name: str(row.name),
      kind: str(row.kind) as NotificationKind,
      config: this.secrets.openJson<NotificationConfigInput>(str(row.config), 'notification'),
      locale: str(row.locale) as Locale,
      events: json<NotificationEvent[]>(row.events, []),
      enabled: bool(row.enabled),
      lastStatus: strOrNull(row.last_status) as NotificationChannelRecord['lastStatus'],
      lastError: strOrNull(row.last_error),
      lastSentAt: strOrNull(row.last_sent_at),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  create(teamId: string, input: { name: string; locale: Locale; events: NotificationEvent[]; config: NotificationConfigInput }): NotificationChannelRecord {
    const id = newId('ntf');
    const now = nowIso();
    this.db.run(
      `INSERT INTO notification_channels (id, team_id, name, kind, config, locale, events, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      teamId,
      input.name,
      input.config.kind,
      this.secrets.sealJson(input.config, 'notification'),
      input.locale,
      JSON.stringify([...new Set(input.events)]),
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): NotificationChannelRecord | undefined {
    const row = this.db.get('SELECT * FROM notification_channels WHERE id = ?', id);
    return row === undefined ? undefined : this.map(row);
  }

  getForTeam(teamId: string, id: string): NotificationChannelRecord | undefined {
    const row = this.db.get('SELECT * FROM notification_channels WHERE id = ? AND team_id = ?', id, teamId);
    return row === undefined ? undefined : this.map(row);
  }

  listForTeam(teamId: string): NotificationChannelRecord[] {
    return this.db.all('SELECT * FROM notification_channels WHERE team_id = ? ORDER BY created_at', teamId).map((row) => this.map(row));
  }

  /** Enabled channels of a team that want this event. */
  subscribed(teamId: string, event: NotificationEvent): NotificationChannelRecord[] {
    return this.listForTeam(teamId).filter((channel) => channel.enabled && channel.events.includes(event));
  }

  update(id: string, patch: NotificationChannelPatch): NotificationChannelRecord {
    const sets: string[] = [];
    const values: (string | number)[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      values.push(patch.name);
    }
    if (patch.locale !== undefined) {
      sets.push('locale = ?');
      values.push(patch.locale);
    }
    if (patch.events !== undefined) {
      sets.push('events = ?');
      values.push(JSON.stringify([...new Set(patch.events)]));
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      values.push(int01(patch.enabled));
    }
    if (patch.config !== undefined) {
      sets.push('kind = ?', 'config = ?');
      values.push(patch.config.kind, this.secrets.sealJson(patch.config, 'notification'));
    }
    if (sets.length > 0) this.db.run(`UPDATE notification_channels SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...values, nowIso(), id);
    return this.get(id)!;
  }

  recordResult(id: string, error: string | null): void {
    this.db.run('UPDATE notification_channels SET last_status = ?, last_error = ?, last_sent_at = ? WHERE id = ?', error === null ? 'ok' : 'failed', error, nowIso(), id);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM notification_channels WHERE id = ?', id);
  }
}
