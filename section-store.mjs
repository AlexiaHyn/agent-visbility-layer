import { mkdir, readFile, open, rename, readdir, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert, validId } from './section-model.mjs';
import { reduceProject } from './section-reducer.mjs';
export class SectionStore {
  constructor(directory) { this.directory = directory; this.cache = new Map(); this.queues = new Map(); }
  path(id) { assert(validId(id), 'Invalid project ID.'); return join(this.directory, id); }
  async load(id, { repairTail = false } = {}) {
    const path = this.path(id); let text;
    try { text = await readFile(join(path, 'events.jsonl'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let state = null, goodBytes = 0;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]; if (!line.trim()) { goodBytes += Buffer.byteLength(line) + (i < lines.length - 1 ? 1 : 0); continue; }
      let event;
      try { event = JSON.parse(line); } catch (error) {
        if (i === lines.length - 1) { if (repairTail) await truncate(join(path, 'events.jsonl'), goodBytes); break; }
        throw new Error(`Corrupt project event ${i + 1}: ${error.message}`);
      }
      assert(event.projectId === id && event.seq === (state?.revision || 0) + 1, 'Project event sequence is invalid.', 500);
      state = reduceProject(state, event);
      goodBytes += Buffer.byteLength(line) + (i < lines.length - 1 ? 1 : 0);
    }
    if (repairTail && state && goodBytes === Buffer.byteLength(text) && text && !text.endsWith('\n')) {
      const file = await open(join(path, 'events.jsonl'), 'a');
      try { await file.writeFile('\n'); await file.sync(); } finally { await file.close(); }
    }
    if (state) this.cache.set(id, state);
    return state;
  }
  async get(id) { const state = this.cache.get(id) || await this.load(id); assert(state, 'Project not found.', 404); return structuredClone(state); }
  async atRevision(id, revision) {
    assert(Number.isInteger(revision) && revision >= 1, 'Invalid project revision.');
    const text = await readFile(join(this.path(id), 'events.jsonl'), 'utf8'); let state = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const event = JSON.parse(line); if (event.seq > revision) break;
      assert(event.seq === (state?.revision || 0) + 1 && event.projectId === id, 'Project event sequence is invalid.', 500);
      state = reduceProject(state, event);
    }
    assert(state?.revision === revision, 'Requested project history is unavailable.', 404);
    return structuredClone(state);
  }
  async list() {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    return Promise.all(entries.filter(entry => entry.isDirectory() && validId(entry.name)).map(entry => this.get(entry.name)));
  }
  async dispatch(id, type, payload, { expectedRevision } = {}) {
    const old = this.queues.get(id) || Promise.resolve();
    const next = old.catch(() => {}).then(async () => {
      const before = await this.load(id, { repairTail: true });
      if (expectedRevision !== undefined) assert((before?.revision || 0) === expectedRevision, 'The project changed; refresh before applying this edit.', 409);
      const event = { id: randomUUID(), projectId: id, seq: (before?.revision || 0) + 1, type, payload, at: Date.now() };
      const after = reduceProject(before, event);
      const path = this.path(id); await mkdir(path, { recursive: true });
      const file = await open(join(path, 'events.jsonl'), 'a');
      try { await file.writeFile(JSON.stringify(event) + '\n'); await file.sync(); } finally { await file.close(); }
      this.cache.set(id, after);
      const temp = join(path, `map-${randomUUID()}.tmp`);
      const view = await open(temp, 'w');
      try { await view.writeFile(JSON.stringify(after, null, 2)); await view.sync(); } finally { await view.close(); }
      await rename(temp, join(path, 'map.json'));
      return structuredClone(after);
    });
    this.queues.set(id, next);
    try { return await next; } finally { if (this.queues.get(id) === next) this.queues.delete(id); }
  }
  async create({ title, workspace, request = '' }) {
    assert(typeof title === 'string' && title.trim(), 'Project title is required.');
    assert(typeof workspace === 'string' && workspace.trim(), 'Project workspace is required.');
    return this.dispatch(randomUUID(), 'project_created', { title: title.trim(), workspace, request });
  }
  async close() { await Promise.allSettled([...this.queues.values()]); }
}
