/**
 * The database console: browse, query and edit a PostgreSQL, MySQL or
 * MariaDB service from the dashboard.
 *
 * Everything here needs the developer role, the same as revealing the
 * service's credentials (which grant the same access). Runs that change
 * something, edited rows, exports and signals to other sessions are
 * audited; reading is not.
 */
import { PassThrough, Readable } from 'node:stream';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  dbActivityActionSchema,
  dbChangesSchema,
  dbExportQuerySchema,
  dbFilterSchema,
  dbObjectQuerySchema,
  dbRowsSchema,
  dbRunSchema,
  dbSessionSchema,
  dbSortSchema,
  dbTableQuerySchema,
  dialectOf,
  hasDbConsole,
} from '@ploy/shared';
import type { Context } from '../../context.ts';
import { exportWriter } from '../../database/export.ts';
import { AppError, errorMessage, notFound } from '../../lib/errors.ts';
import type { ServiceRecord } from '../../store/index.ts';
import { audit, body, query, requireTeam, validate, type Ctx, type Env } from '../core.ts';

const databaseQuery = z.object({ database: z.string().min(1).max(128) });
const exportView = z.object({ filters: z.array(dbFilterSchema).max(20).default([]), sort: z.array(dbSortSchema).max(5).default([]), where: z.string().max(8_000).default('') });

export function registerDatabaseRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;
  const consoles = ctx.dbConsole;

  const load = (c: Ctx): { service: ServiceRecord; userId: string } => {
    const auth = requireTeam(c, 'developer');
    const service = stores.services.getForTeam(auth.teamId, c.req.param('id')!);
    if (service === undefined) throw notFound('Service');
    if (!hasDbConsole(service.type)) throw new AppError('bad_request', 'This service has no database console', { params: { reason: 'unsupported' } });
    return { service, userId: auth.user.id };
  };

  app.get('/api/services/:id/db/overview', async (c) => {
    const { service, userId } = load(c);
    return c.json(await consoles.overview(service, userId));
  });

  app.get('/api/services/:id/db/tree', async (c) => {
    const { service, userId } = load(c);
    const { database } = query(c, databaseQuery);
    return c.json(await consoles.tree(service, userId, database));
  });

  app.get('/api/services/:id/db/table', async (c) => {
    const { service, userId } = load(c);
    const input = query(c, dbTableQuerySchema);
    return c.json(await consoles.table(service, userId, input.database, input.schema ?? null, input.name, c.req.query('fresh') === '1'));
  });

  app.get('/api/services/:id/db/source', async (c) => {
    const { service, userId } = load(c);
    const input = query(c, dbObjectQuerySchema);
    return c.json(await consoles.source(service, userId, input.database, input.schema ?? null, input.name, input.kind, input.detail));
  });

  app.post('/api/services/:id/db/rows', async (c) => {
    const { service, userId } = load(c);
    const input = await body(c, dbRowsSchema);
    return c.json(await consoles.rows(service, userId, input));
  });

  app.post('/api/services/:id/db/changes', async (c) => {
    const { service, userId } = load(c);
    const input = await body(c, dbChangesSchema);
    const result = await consoles.changes(service, userId, input);
    audit(ctx, c, 'service.database_rows_changed', { type: 'service', id: service.id, name: service.name }, { database: input.database, schema: input.schema, table: input.table, ...result });
    return c.json(result);
  });

  app.get('/api/services/:id/db/export', async (c) => {
    const { service, userId } = load(c);
    const input = query(c, dbExportQuerySchema);
    let view: z.infer<typeof exportView> = { filters: [], sort: [], where: '' };
    if (input.view !== undefined && input.view.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.view);
      } catch {
        throw new AppError('bad_request', 'The view must be JSON');
      }
      view = validate(exportView, parsed);
    }
    const dialect = dialectOf(consoles.engine(service).type);
    const out = new PassThrough();
    const write = (text: string): Promise<void> =>
      text.length === 0 || out.write(text) ? Promise.resolve() : new Promise((resolve, reject) => {
        out.once('drain', resolve);
        out.once('close', () => reject(new Error('The download was cancelled')));
      });
    let writer: ReturnType<typeof exportWriter> | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      consoles
        .export(
          service,
          { database: input.database, schema: input.schema ?? null, table: input.table, view },
          userId,
          async (table) => {
            writer = exportWriter(input.format, table, dialect);
            resolve();
            await write(writer.head());
          },
          async (columns, rows) => write(writer!.rows(columns, rows)),
        )
        .then(async (count) => {
          await write(writer?.tail() ?? '');
          out.end();
          audit(ctx, c, 'service.database_exported', { type: 'service', id: service.id, name: service.name }, { database: input.database, table: input.table, format: input.format, rows: count });
        })
        .catch((error: unknown) => {
          reject(error);
          // Headers are gone by now: end the file with the reason rather than a silently short download.
          if (writer !== null) out.end(`\n-- export failed: ${errorMessage(error)}\n`);
          else out.destroy(error instanceof Error ? error : new Error(String(error)));
        });
    });
    await ready;
    const extension = input.format === 'sql' ? 'sql' : input.format;
    const type = input.format === 'csv' ? 'text/csv; charset=utf-8' : input.format === 'json' ? 'application/json; charset=utf-8' : 'application/sql; charset=utf-8';
    const fileName = `${input.table.replace(/[^A-Za-z0-9._-]+/g, '_')}.${extension}`;
    return new Response(Readable.toWeb(out) as ReadableStream, { headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${fileName}"` } });
  });

  app.post('/api/services/:id/db/run', async (c) => {
    const { service, userId } = load(c);
    const input = await body(c, dbRunSchema);
    const { result, writes } = await consoles.run(service, userId, input);
    if (result.newSession) audit(ctx, c, 'service.database_console_opened', { type: 'service', id: service.id, name: service.name }, { database: input.database });
    if (writes.length > 0) {
      audit(ctx, c, 'service.database_query', { type: 'service', id: service.id, name: service.name }, { database: input.database, commands: [...new Set(writes)].slice(0, 20), statements: writes.length, failed: result.error !== null });
    }
    return c.json(result);
  });

  app.post('/api/services/:id/db/cancel', async (c) => {
    const { service, userId } = load(c);
    const { session } = await body(c, dbSessionSchema);
    return c.json({ cancelled: await consoles.cancel(service, userId, session) });
  });

  app.post('/api/services/:id/db/close', async (c) => {
    const { service, userId } = load(c);
    const { session } = await body(c, dbSessionSchema);
    await consoles.close(service, userId, session);
    return c.json({ ok: true });
  });

  app.get('/api/services/:id/db/activity', async (c) => {
    const { service, userId } = load(c);
    return c.json(await consoles.activity(service, userId));
  });

  app.post('/api/services/:id/db/activity', async (c) => {
    const { service, userId } = load(c);
    const input = await body(c, dbActivityActionSchema);
    const done = await consoles.signal(service, userId, input.pid, input.action);
    audit(ctx, c, 'service.database_session_signalled', { type: 'service', id: service.id, name: service.name }, { pid: input.pid, action: input.action, done });
    return c.json({ ok: done });
  });

  app.get('/api/services/:id/db/roles', async (c) => {
    const { service, userId } = load(c);
    return c.json(await consoles.roles(service, userId));
  });
}
