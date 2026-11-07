import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createSessionManager } from '../agent-session.mjs';
import { ProjectService } from '../project-service.mjs';
const definition = (id, parentId, kind, dependsOn = []) => ({ id, parentId, kind, category: 'implement', title: id, objective: 'Create a function', requirementIds: ['R1'], dependsOn, inputs: [], outputs: ['code.js'], acceptanceCriteria: ['Works'], validation: ['Check the function'] });
const evidence = [{ criterion: 'Works', met: true, evidence: 'Focused check passed' }];
async function setup(t, interleaved = false) {
  const root = await mkdtemp(join(tmpdir(), 'pi-rerun-')); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), data = join(root, 'data'); await mkdir(workspace); await mkdir(join(data, 'sessions'), { recursive: true });
  await writeFile(join(workspace, 'code.js'), 'before');
  const service = new ProjectService(data), project = await service.create({ title: 'Game', workspace });
  const sections = [definition('S1', project.id, 'step'), definition('W1', 'S1', 'work_unit'), definition('S2', project.id, 'step', ['S1']), definition('W2', 'S2', 'work_unit')];
  if (interleaved) sections.push(definition('SX', project.id, 'step'), definition('WX', 'SX', 'work_unit'));
  await service.submitPlan(project.id, { specification: { description: 'Game', requirements: [{ id: 'R1', text: 'Works' }], acceptanceCriteria: ['Works'] }, sections });
  await service.event(project.id, 'plan_approved', { planRevision: 1 });
  const manager = SessionManager.create(workspace, join(data, 'sessions'));
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Implement' }], timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Plan accepted' }], stopReason: 'stop', timestamp: Date.now() });
  const sourceEntry = manager.getLeafId(), sessionFile = manager.getSessionFile();
  const unit = async (id, file, text, name = 'write') => {
    const state = await service.startUnit(project.id, id, sourceEntry, { chatId: 'source-chat', sessionFile });
    const attempt = state.attempts.find(attempt => attempt.status === 'active');
    await service.recordAction(project.id, attempt.id, { toolCallId: `call-${id}`, toolName: name, input: { path: file } });
    if (name === 'write') await writeFile(join(workspace, file), text);
    await service.event(project.id, 'action_finished', { attemptId: attempt.id, toolCallId: `call-${id}`, result: { text: 'done' }, isError: false });
    await service.finishUnit(project.id, { status: 'completed', summary: id, validation: evidence }, sourceEntry);
  };
  await unit('W1', 'code.js', 'after'); await service.event(project.id, 'step_confirmed', { sectionId: 'S1', validation: evidence });
  if (interleaved) { await unit('WX', 'unrelated.js', 'keep unrelated'); await service.event(project.id, 'step_confirmed', { sectionId: 'SX', validation: evidence }); }
  await unit('W2', 'code.js', '', 'read'); await service.event(project.id, 'step_confirmed', { sectionId: 'S2', validation: evidence });
  return { service, project, workspace, data, sessionFile, sourceEntry };
}
test('rerun restores selected effects, invalidates affected dependents and retains historical map branches', async t => {
  const { service, project, workspace, sessionFile } = await setup(t);
  const old = await service.store.get(project.id), original = await readFile(sessionFile, 'utf8');
  const preview = await service.rerunPreview(project.id, 'W1');
  assert.equal(preview.strategy, 'restore'); assert.ok(preview.downstreamIds.includes('W2')); assert.ok(preview.validationAncestorIds.includes('S1'));
  const result = await service.prepareRerun(project.id, 'W1', { revision: preview.revision, signature: preview.checkpointPreview.signature, strategy: preview.strategy });
  assert.equal(await readFile(join(workspace, 'code.js'), 'utf8'), 'before');
  assert.equal(await readFile(sessionFile, 'utf8'), original);
  assert.deepEqual(result.project.rerunQueue, ['W1', 'W2']); assert.notEqual(result.project.activeBranchId, old.activeBranchId);
  const historicalBranch = result.project.branches.find(branch => branch.id === old.activeBranchId);
  const historical = await service.store.atRevision(project.id, historicalBranch.headRevision);
  assert.equal(historical.sections.find(section => section.id === 'W1').stale, false);
  assert.equal(result.project.sections.find(section => section.id === 'W1').stale, true);
});
test('interleaved unrelated work requests a minimal repair proposal without restoring files', async t => {
  const { service, project, workspace } = await setup(t, true);
  const preview = await service.rerunPreview(project.id, 'W1'); assert.equal(preview.strategy, 'review_repair');
  assert.ok(preview.interleavedSectionIds.includes('WX'));
  const result = await service.prepareRerun(project.id, 'W1', { revision: preview.revision, signature: preview.checkpointPreview.signature, strategy: preview.strategy });
  assert.equal(await readFile(join(workspace, 'code.js'), 'utf8'), 'after');
  assert.equal(await readFile(join(workspace, 'unrelated.js'), 'utf8'), 'keep unrelated');
  assert.equal(result.project.draft.status, 'reviewing'); assert.equal(result.project.status, 'reviewing_changes');
});
test('forking pre-section native context creates a new session file and preserves the source', async t => {
  const { data, workspace, sessionFile, sourceEntry } = await setup(t);
  const original = await readFile(sessionFile, 'utf8');
  const fork = createSessionManager({ workspace, sessionDir: join(data, 'sessions'), forkFrom: { sessionFile, entryId: sourceEntry } });
  assert.notEqual(fork.getSessionFile(), sessionFile);
  assert.equal(fork.getLeafId(), sourceEntry);
  fork.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Rerun' }], timestamp: Date.now() });
  assert.equal(await readFile(sessionFile, 'utf8'), original);
});
