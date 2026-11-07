import { mkdir, readFile, writeFile, readdir, lstat, readlink, symlink, unlink, rename, chmod, realpath } from 'node:fs/promises';
import { resolve, relative, join, dirname, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assert, validId, SectionError } from './section-model.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const defaults = ['.browser-profile', '.npm-cache', 'test-results'];
export class CheckpointStore {
  constructor(directory, { excludes = defaults } = {}) { this.directory = resolve(directory); this.excludes = excludes; }
  async initialize() { await mkdir(join(this.directory, 'blobs'), { recursive: true }); await mkdir(join(this.directory, 'manifests'), { recursive: true }); }
  async root(workspace) {
    const root = await realpath(workspace);
    assert(root !== this.directory, 'Checkpoint storage cannot be the workspace root.');
    return root;
  }
  excluded(path) {
    const parts = path.split('/'), base = parts.at(-1);
    return parts.some(part => part === '.git' || part === 'node_modules') ||
      (base.startsWith('.env') && base !== '.env.example') ||
      this.excludes.some(item => path === item || path.startsWith(item + '/'));
  }
  async safePath(root, path) {
    assert(typeof path === 'string' && path && !path.includes('\\') && !isAbsolute(path) && !path.split('/').some(part => !part || part === '.' || part === '..'), 'Invalid checkpoint path.');
    const target = resolve(root, ...path.split('/'));
    assert(relative(root, target) && !relative(root, target).startsWith('..' + sep), 'Checkpoint path escapes the workspace.');
    let parent = root;
    for (const part of path.split('/').slice(0, -1)) {
      parent = join(parent, part);
      try { assert(!(await lstat(parent)).isSymbolicLink(), `Cannot restore through a symbolic-link directory: ${path}`, 409); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return target;
  }
  async entry(root, path, { storeBlob = false } = {}) {
    const target = await this.safePath(root, path); let stat;
    try { stat = await lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) return { kind: 'symlink', target: await readlink(target) };
    assert(stat.isFile(), `Unsupported checkpoint object: ${path}`, 409);
    const bytes = await readFile(target), hash = digest(bytes);
    if (storeBlob) {
      try { await writeFile(join(this.directory, 'blobs', hash), bytes, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return { kind: 'file', hash, mode: stat.mode & 0o777 };
  }
  async capture(workspace, metadata = {}) {
    await this.initialize(); const root = await this.root(workspace), entries = {}, omitted = [];
    const storePath = relative(root, this.directory).split(sep).join('/');
    const appDataPath = relative(root, dirname(this.directory)).split(sep).join('/');
    const excludeAppData = appDataPath && !appDataPath.startsWith('../') && appDataPath !== '..';
    const walk = async (directory, prefix = '') => {
      for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = prefix ? `${prefix}/${item.name}` : item.name;
        if (this.excluded(path) || (excludeAppData && (path === appDataPath || path.startsWith(appDataPath + '/'))) || path === storePath || path.startsWith(storePath + '/')) { omitted.push(path); continue; }
        if (item.isDirectory()) await walk(join(directory, item.name), path);
        else entries[path] = await this.entry(root, path, { storeBlob: true });
      }
    };
    await walk(root);
    const id = randomUUID(), manifest = { id, workspace: root, createdAt: Date.now(), metadata, excludes: [...this.excludes, ...(excludeAppData ? [appDataPath] : [])], omitted, entries };
    const temp = join(this.directory, 'manifests', `${id}.tmp`), path = join(this.directory, 'manifests', `${id}.json`);
    await writeFile(temp, JSON.stringify(manifest, null, 2)); await rename(temp, path); return manifest;
  }
  async get(id) { assert(validId(id), 'Invalid checkpoint ID.'); return JSON.parse(await readFile(join(this.directory, 'manifests', `${id}.json`), 'utf8')); }
  async excerpt(entry) {
    if (!entry) return { text: '', truncated: false };
    if (entry.kind === 'symlink') return { text: `Symbolic link → ${entry.target}`, truncated: false };
    const bytes = await readFile(join(this.directory, 'blobs', entry.hash));
    if (bytes.includes(0)) return { binary: true };
    return { text: bytes.subarray(0, 12000).toString('utf8'), truncated: bytes.length > 12000 };
  }
  async preview(beforeId, afterId) {
    const before = await this.get(beforeId), after = await this.get(afterId);
    assert(before.workspace === after.workspace, 'Cannot compare checkpoints from different workspaces.');
    const changes = [], conflicts = [], current = {};
    for (const path of [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])].sort()) {
      if (equal(before.entries[path], after.entries[path])) continue;
      current[path] = await this.entry(before.workspace, path);
      const matchesAfter = equal(current[path], after.entries[path]), alreadyReverted = equal(current[path], before.entries[path]);
      if (!matchesAfter && !alreadyReverted) conflicts.push(path);
      changes.push({ path, before: before.entries[path] ?? null, after: after.entries[path] ?? null, alreadyReverted, beforeContent: await this.excerpt(before.entries[path]), afterContent: await this.excerpt(after.entries[path]) });
    }
    return { beforeId, afterId, workspace: before.workspace, changes, conflicts, signature: digest(JSON.stringify(current)),
      excludes: before.excludes, externalEffectsReversible: false };
  }
  async writeEntry(root, path, entry) {
    const target = await this.safePath(root, path);
    const existing = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    assert(!existing?.isDirectory(), `A directory replaced a file at ${path}; resolve it manually.`, 409);
    if (!entry) { if (existing) await unlink(target); return; }
    await mkdir(dirname(target), { recursive: true });
    if (entry.kind === 'symlink') { if (existing) await unlink(target); await symlink(entry.target, target); return; }
    assert(entry.kind === 'file' && /^[a-f0-9]{64}$/.test(entry.hash), 'Invalid checkpoint blob.');
    const bytes = await readFile(join(this.directory, 'blobs', entry.hash));
    assert(digest(bytes) === entry.hash, 'Checkpoint blob integrity check failed.', 500);
    const temp = join(dirname(target), `.pi-restore-${randomUUID()}.tmp`);
    await writeFile(temp, bytes); await chmod(temp, entry.mode); await rename(temp, target);
  }
  async restore(beforeId, afterId, signature) {
    const preview = await this.preview(beforeId, afterId);
    assert(preview.signature === signature, 'Workspace changed after the preview; refresh it before restoring.', 409);
    if (preview.conflicts.length) throw new SectionError('Intervening changes conflict with this restoration.', 409, preview.conflicts);
    const recovery = await this.capture(preview.workspace, { kind: 'restore-recovery', beforeId, afterId });
    const attempted = [];
    try {
      for (const change of preview.changes) if (!change.alreadyReverted) { attempted.push(change.path); await this.writeEntry(preview.workspace, change.path, change.before); }
    } catch (error) {
      const recoveryErrors = [];
      for (const path of attempted.reverse()) try { await this.writeEntry(preview.workspace, path, recovery.entries[path] ?? null); } catch (failure) { recoveryErrors.push(`${path}: ${failure.message}`); }
      throw new SectionError(`Restoration failed: ${error.message}. Recovery checkpoint: ${recovery.id}.`, 500, recoveryErrors);
    }
    return { restoredPaths: attempted, recoveryCheckpointId: recovery.id };
  }
}
