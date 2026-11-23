/**
 * Working copies: an application's source, checked out on the control plane
 * for one conversation, so TorexAi can read it, change it and deploy the
 * result.
 *
 * A working copy is a git repository (the application's own clone, or one
 * made around an uploaded archive), so every change is a diff the person can
 * read before anything is deployed, and nothing the model writes can leave
 * its directory. Deploying it packs the tracked files into an archive that
 * the ordinary deployment pipeline builds, exactly as it builds an uploaded
 * folder; pushing it sends the commit to the repository, when the
 * application's credentials allow writing.
 *
 * No command the model writes ever runs here: the only programs started are
 * git, with arguments this module builds.
 */
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { concatZip, createZip, LIMITS, type ZipFile } from '@ploy/shared';
import { checkout, gitEnv, scrub } from '../build/git.ts';
import type { Context } from '../context.ts';
import { pruneUploads, unpackUpload, uploadPath, uploadsDir } from '../deploy/uploads.ts';
import { errorMessage } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { runProcess } from '../lib/process.ts';
import type { ApplicationRecord, DeploymentRecord, UploadInfo } from '../store/index.ts';
import { ToolError } from './files.ts';

/** The commit the working copy started from: diffs are taken against it. */
const BASE_TAG = 'ploy-ai-base';
const IDENTITY = ['-c', 'user.name=TorexAi', '-c', 'user.email=torexai@torexploy.local', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
/** What a deployed working copy may weigh, as files on disk. */
const PACK_MAX_BYTES = 400 * 1024 * 1024;
const DIFF_MAX = 60_000;

export interface Workspace {
  dir: string;
  /** It was just created (false: it already held this conversation's changes). */
  fresh: boolean;
  /** Where the sources came from, in words. */
  origin: string;
}

async function git(dir: string, args: string[], env: Record<string, string> = {}, timeoutMs = 120_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const result = await runProcess('git', [...IDENTITY, ...args], { cwd: dir, env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env }, timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  if (result.timedOut) throw new ToolError(`git ${args[0]} timed out`);
  return { code: result.code, stdout: result.stdout, stderr: scrub(result.stderr) };
}

async function gitOk(dir: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const result = await git(dir, args, env);
  if (result.code !== 0) throw new ToolError(`git ${args[0]} failed: ${result.stderr.trim().split('\n').slice(-3).join(' ')}`);
  return result.stdout;
}

export class CodeWorkspaces {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  private root(chatId: string): string {
    return join(this.ctx.config.dataDir, 'ai', 'workspaces', chatId);
  }

  dir(chatId: string, applicationId: string): string {
    return join(this.root(chatId), applicationId);
  }

  async exists(chatId: string, applicationId: string): Promise<boolean> {
    return (await stat(join(this.dir(chatId, applicationId), '.git')).catch(() => null)) !== null;
  }

  /** The working copy of an application for a conversation, checked out on first use. */
  async open(chatId: string, app: ApplicationRecord): Promise<Workspace> {
    const dir = this.dir(chatId, app.id);
    if (app.kind === 'compose') throw new ToolError('This is a Docker Compose stack: change its compose file with PUT /api/applications/{id}/compose, or its repository directly.');
    if (app.sourceType === 'image') throw new ToolError(`This application runs the image ${app.image ?? ''}; it has no source to edit. Its settings and variables can be changed through the API.`);
    if (app.sourceType === 'raw') throw new ToolError('This application has no source repository.');
    if (await this.exists(chatId, app.id)) return { dir, fresh: false, origin: this.describe(app) };

    await mkdir(this.root(chatId), { recursive: true, mode: 0o700 });
    if (app.sourceType === 'upload') {
      if (app.upload === null) throw new ToolError('Nothing has been uploaded for this application yet.');
      const archive = uploadPath(this.ctx.config.dataDir, app.id, app.upload.id);
      if ((await stat(archive).catch(() => null)) === null) throw new ToolError('The uploaded archive is no longer on the control plane; it has to be uploaded again.');
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await unpackUpload(archive, dir);
      await gitOk(dir, ['init', '--quiet', '-b', 'main']);
    } else {
      const active = app.activeDeploymentId === null ? undefined : this.ctx.stores.deployments.get(app.activeDeploymentId);
      const access = await this.ctx.gitProviders.access(app);
      try {
        await checkout({
          url: access.url,
          branch: app.branch ?? 'main',
          // What is running is what gets edited; a deployment that came from an archive has no commit, so the branch head is used.
          commitSha: active?.commitSha ?? null,
          workDir: dir,
          httpAuth: access.httpAuth,
          deployKey: app.deployKey === null ? null : this.ctx.secrets.open(app.deployKey, 'ssh'),
          timeoutMs: 5 * 60_000,
          onOutput: () => undefined,
        });
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw new ToolError(`Could not fetch the repository: ${errorMessage(error)}`);
      }
    }
    // The starting point is a commit of its own, so "what did TorexAi change" always has an answer.
    await gitOk(dir, ['add', '-A']);
    await git(dir, ['commit', '--quiet', '--allow-empty', '-m', 'Base']);
    await gitOk(dir, ['tag', '-f', BASE_TAG]);
    return { dir, fresh: true, origin: this.describe(app) };
  }

  private describe(app: ApplicationRecord): string {
    if (app.sourceType === 'upload') return `the uploaded archive ${app.upload?.name ?? ''}`.trim();
    return `${app.repository ?? app.gitUrl ?? 'the repository'} (${app.branch ?? 'main'})`;
  }

  /** Everything changed since the working copy was opened, as a stat and a patch. */
  async diff(dir: string): Promise<{ stat: string; patch: string; files: number }> {
    await gitOk(dir, ['add', '-A']);
    const names = (await gitOk(dir, ['diff', '--cached', '--name-only', BASE_TAG])).trim();
    if (names.length === 0) return { stat: '', patch: '', files: 0 };
    const summary = (await gitOk(dir, ['diff', '--cached', '--stat', BASE_TAG])).trim();
    const patch = await gitOk(dir, ['diff', '--cached', BASE_TAG]);
    return { stat: summary, patch: patch.length > DIFF_MAX ? `${patch.slice(0, DIFF_MAX)}\n… the rest of the patch is not shown (${patch.length - DIFF_MAX} more characters)` : patch, files: names.split('\n').length };
  }

  /** The whole patch, for a file the person can download and apply themselves. */
  async patch(dir: string): Promise<string> {
    await gitOk(dir, ['add', '-A']);
    return gitOk(dir, ['diff', '--cached', '--binary', BASE_TAG]);
  }

  /** Record the current state as a commit. Returns its id, or null when nothing changed since the last one. */
  async commit(dir: string, message: string): Promise<string | null> {
    await gitOk(dir, ['add', '-A']);
    const status = (await gitOk(dir, ['status', '--porcelain'])).trim();
    if (status.length === 0) return null;
    await gitOk(dir, ['commit', '--quiet', '-m', message]);
    return (await gitOk(dir, ['rev-parse', 'HEAD'])).trim();
  }

  /** Pack the tracked files and start a deployment built from them. */
  async deploy(app: ApplicationRecord, dir: string, message: string, userId: string): Promise<DeploymentRecord> {
    await this.commit(dir, message);
    const listed = (await gitOk(dir, ['ls-files', '-z'])).split('\0').filter((name) => name.length > 0);
    if (listed.length === 0) throw new ToolError('The working copy holds no files.');
    if (listed.length > LIMITS.uploadFilesMax) throw new ToolError(`The source has ${listed.length} files, more than the ${LIMITS.uploadFilesMax} an archive may hold.`);
    const files: ZipFile[] = [];
    let bytes = 0;
    for (const name of listed) {
      const full = join(dir, name);
      const info = await lstat(full).catch(() => null);
      // Symbolic links and submodule entries have no bytes of their own to pack.
      if (info === null || !info.isFile()) continue;
      bytes += info.size;
      if (bytes > PACK_MAX_BYTES) throw new ToolError('The source is too large to deploy from a working copy; push the change to the repository instead.');
      files.push({ path: name, data: await readFile(full), mode: info.mode & 0o777, mtime: info.mtime });
    }
    const archive = concatZip(await createZip(files));
    const { dataDir } = this.ctx.config;
    const upload: UploadInfo = { id: newId('upl'), name: `TorexAi: ${message}`.slice(0, LIMITS.uploadNameMax), size: archive.length, files: files.length, bytes, uploadedAt: nowIso() };
    await mkdir(uploadsDir(dataDir, app.id), { recursive: true, mode: 0o700 });
    await writeFile(uploadPath(dataDir, app.id, upload.id), archive, { mode: 0o600 });
    const { stores } = this.ctx;
    // An upload application's next "Deploy" should build what is running, so the edited archive becomes its current one.
    if (app.sourceType === 'upload') stores.applications.setUpload(app.id, upload);
    const current = stores.applications.get(app.id) ?? app;
    const pinned = stores.deployments.listOpen().filter((open) => open.applicationId === app.id).map((open) => open.upload?.id);
    await pruneUploads(dataDir, app.id, [upload.id, current.upload?.id, ...pinned]);
    return this.ctx.deployer.enqueue({ app: current, trigger: 'manual', createdBy: userId, commitMessage: `TorexAi: ${message}`, commitAuthor: 'TorexAi', upload });
  }

  /** Send the working copy's commits to a branch of the application's repository. */
  async push(app: ApplicationRecord, dir: string, branch: string, message: string): Promise<{ commit: string; branch: string }> {
    if (app.sourceType === 'upload') throw new ToolError('This application is built from uploads; there is no repository to push to.');
    await this.commit(dir, message);
    const commit = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim();
    const access = await this.ctx.gitProviders.access(app);
    let keyPath: string | null = null;
    if (app.deployKey !== null) {
      keyPath = `${dir}.key`;
      const key = this.ctx.secrets.open(app.deployKey, 'ssh');
      await writeFile(keyPath, key.endsWith('\n') ? key : `${key}\n`, { mode: 0o600 });
    }
    try {
      const result = await git(dir, ['push', access.url, `HEAD:refs/heads/${branch}`], gitEnv({ httpAuth: access.httpAuth }, keyPath), 180_000);
      if (result.code !== 0) {
        const detail = result.stderr.trim().split('\n').slice(-4).join(' ');
        if (/denied|403|not permitted|read-only|unable to access|authentication failed|could not read/i.test(detail)) {
          throw new ToolError(`The repository refused the push: the panel's access to it is read-only. ${detail}\nGive the person the change as a patch file instead (code op=diff, then create_file), or deploy it from the working copy (code op=deploy).`);
        }
        throw new ToolError(`git push failed: ${detail}`);
      }
      return { commit, branch };
    } finally {
      if (keyPath !== null) {
        await rm(keyPath, { force: true });
        await rm(`${keyPath}.known_hosts`, { force: true });
      }
    }
  }

  /** Forget a conversation's working copies. */
  async remove(chatId: string): Promise<void> {
    await rm(this.root(chatId), { recursive: true, force: true });
  }
}
