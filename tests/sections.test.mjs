import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePlan, impactOf, sectionStatus } from '../section-model.mjs';
import { SectionStore } from '../section-store.mjs';
const definition = (id, parentId, kind = 'step', dependsOn = []) => ({ id, parentId, kind, category: 'implement', title: `Build ${id}`, objective: `Deliver ${id}`, requirementIds: ['R1'], dependsOn, inputs: [], outputs: ['working feature'], acceptanceCriteria: ['Feature works'], validation: ['Run focused tests'] });
function plan(id) { return { specification: { description: 'Build a game', requirements: [{ id: 'R1', text: 'Playable game' }], acceptanceCriteria: ['Game works'] }, sections: [definition('S1', id), definition('W1', 'S1', 'work_unit'), definition('S2', id, 'step', ['S1']), definition('W2', 'S2', 'work_unit')] }; }
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-sections-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SectionStore(directory), project = await store.create({ title: 'Game', workspace: directory });
  return { directory, store, project, savePlan: () => store.dispatch(project.id, 'plan_revised', { plan: plan(project.id), autoApprove: true }) };
}
test('validates requirement coverage, hierarchy and dependency cycles', () => {
  assert.equal(validatePlan(plan('project'), 'project').sections.length, 4);
  const cyclic = plan('project'); cyclic.sections[0].dependsOn = ['S2'];
  assert.throws(() => validatePlan(cyclic, 'project'), error => error.issues.some(issue => issue.includes('cycle')));
  const missing = plan('project'); missing.specification.requirements.push({ id: 'R2', text: 'Extra' });
  assert.throws(() => validatePlan(missing, 'project'), error => error.issues.some(issue => issue.includes('not addressed')));
});
test('a work unit requires at least one call and evidence for all criteria to finish', async t => {
  const { store, project, savePlan } = await setup(t); await savePlan();
  await store.dispatch(project.id, 'attempt_started', { sectionId: 'W1', attemptId: 'A1' });
  await assert.rejects(store.dispatch(project.id, 'attempt_finished', { attemptId: 'A1', status: 'completed', validation: [] }), /at least one/);
  await store.dispatch(project.id, 'action_started', { attemptId: 'A1', action: { id: 'call-1', name: 'edit', input: {} } });
  await store.dispatch(project.id, 'action_finished', { attemptId: 'A1', toolCallId: 'call-1', result: {}, isError: false });
  await assert.rejects(store.dispatch(project.id, 'attempt_finished', { attemptId: 'A1', status: 'completed', validation: [{ criterion: 'Other', met: true, evidence: 'Passed' }] }), /each acceptance/);
  const state = await store.dispatch(project.id, 'attempt_finished', { attemptId: 'A1', status: 'completed', validation: [{ criterion: 'Feature works', met: true, evidence: 'Test passed' }] });
  assert.equal(sectionStatus(state, 'S1'), 'validating');
  const verified = await store.dispatch(project.id, 'step_confirmed', { sectionId: 'S1', validation: [{ criterion: 'Feature works', met: true, evidence: 'Integration check passed' }] });
  assert.equal(sectionStatus(verified, 'S1'), 'completed');
});
test('rejects out-of-order work and duplicate primary ownership, flags oversized work', async t => {
  const { store, project, savePlan } = await setup(t); await savePlan();
  await assert.rejects(store.dispatch(project.id, 'attempt_started', { sectionId: 'W2', attemptId: 'A2' }), /Prerequisite/);
  await store.dispatch(project.id, 'attempt_started', { sectionId: 'W1', attemptId: 'A1' });
  for (let i = 0; i < 6; i++) await store.dispatch(project.id, 'action_started', { attemptId: 'A1', action: { id: `call-${i}`, name: 'read' } });
  await assert.rejects(store.dispatch(project.id, 'action_started', { attemptId: 'A1', action: { id: 'call-0', name: 'read' } }), /primary owner/);
  assert.equal((await store.get(project.id)).attempts[0].oversized, true);
});
test('serializes changes and rejects stale revisions', async t => {
  const { store, project } = await setup(t);
  const outcomes = await Promise.allSettled(['a', 'b'].map(chatId => store.dispatch(project.id, 'chat_attached', { chatId }, { expectedRevision: project.revision })));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected')[0].reason.status, 409);
});
test('rebuilds from events and safely repairs an interrupted final append', async t => {
  const { directory, store, project, savePlan } = await setup(t); const planned = await savePlan();
  const path = join(directory, project.id, 'events.jsonl');
  await appendFile(path, '{"incomplete":');
  const recovered = new SectionStore(directory); assert.equal((await recovered.get(project.id)).revision, planned.revision);
  await recovered.dispatch(project.id, 'chat_attached', { chatId: 'new' });
  assert.equal((await new SectionStore(directory).get(project.id)).chatIds[0], 'new');
  await rm(join(directory, project.id, 'map.json'));
  assert.equal((await new SectionStore(directory).get(project.id)).planRevision, 1);
});
test('edits preserve revisions and identify downstream work', async t => {
  const { store, project, savePlan } = await setup(t); await savePlan();
  const updated = await store.dispatch(project.id, 'section_edited', { sectionId: 'S1', instructions: 'Use a new API' });
  assert.equal(updated.sections.find(section => section.id === 'S1').version, 2);
  assert.ok(impactOf(updated, 'S1').downstreamIds.includes('W2'));
  assert.equal(updated.sections.find(section => section.id === 'W2').stale, true);
  assert.equal(updated.sectionRevisions.filter(section => section.id === 'S1').length, 2);
});
