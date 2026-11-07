import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CheckpointStore } from '../checkpoint-store.mjs';
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-checkpoints-')); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project'); await mkdir(workspace);
  return { workspace, store: new CheckpointStore(join(workspace, 'data/checkpoints')) };
}
test('restores created, modified and deleted files while retaining unrelated later work', async t => {
  const { workspace, store } = await setup(t);
  await writeFile(join(workspace, 'old.txt'), 'before'); await writeFile(join(workspace, 'deleted.txt'), 'keep');
  const before = await store.capture(workspace);
  await writeFile(join(workspace, 'old.txt'), 'after'); await rm(join(workspace, 'deleted.txt')); await writeFile(join(workspace, 'new.txt'), 'new');
  const after = await store.capture(workspace);
  await writeFile(join(workspace, 'unrelated.txt'), 'user edit');
  const preview = await store.preview(before.id, after.id); assert.deepEqual(preview.conflicts, []);
  const modified = preview.changes.find(change => change.path === 'old.txt');
  assert.equal(modified.beforeContent.text, 'before'); assert.equal(modified.afterContent.text, 'after');
  await store.restore(before.id, after.id, preview.signature);
  assert.equal(await readFile(join(workspace, 'old.txt'), 'utf8'), 'before');
  assert.equal(await readFile(join(workspace, 'deleted.txt'), 'utf8'), 'keep');
  await assert.rejects(readFile(join(workspace, 'new.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(workspace, 'unrelated.txt'), 'utf8'), 'user edit');
});
test('blocks conflicts and stale previews before modifying any files', async t => {
  const { workspace, store } = await setup(t); const path = join(workspace, 'code.txt');
  await writeFile(path, 'before'); const before = await store.capture(workspace);
  await writeFile(path, 'after'); const after = await store.capture(workspace);
  const preview = await store.preview(before.id, after.id);
  await writeFile(path, 'manual edit');
  await assert.rejects(store.restore(before.id, after.id, preview.signature), /changed after the preview/);
  const conflicted = await store.preview(before.id, after.id); assert.deepEqual(conflicted.conflicts, ['code.txt']);
  await assert.rejects(store.restore(before.id, after.id, conflicted.signature), /Intervening changes/);
  assert.equal(await readFile(path, 'utf8'), 'manual edit');
});
test('excludes application data, credentials, git internals and dependencies without dropping source data folders', async t => {
  const { workspace, store } = await setup(t);
  for (const dir of ['data', '.git', 'node_modules', 'src/data']) await mkdir(join(workspace, dir), { recursive: true });
  for (const name of ['.env', '.env.example', 'data/chats.json', '.git/config', 'node_modules/lib.js', 'src/data/example.txt']) await writeFile(join(workspace, name), 'content');
  const snapshot = await store.capture(workspace);
  assert.deepEqual(Object.keys(snapshot.entries).sort(), ['.env.example', 'src/data/example.txt']);
});
test('refuses to restore through a new symlink directory', async t => {
  const { workspace, store } = await setup(t);
  await mkdir(join(workspace, 'src')); await writeFile(join(workspace, 'src/code.txt'), 'before'); const before = await store.capture(workspace);
  await writeFile(join(workspace, 'src/code.txt'), 'after'); const after = await store.capture(workspace);
  await rm(join(workspace, 'src'), { recursive: true }); const outside = join(workspace, 'outside'); await mkdir(outside);
  await symlink(outside, join(workspace, 'src'));
  await assert.rejects(store.preview(before.id, after.id), /symbolic-link directory/);
});
