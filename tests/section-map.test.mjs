import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProjectPlan, renderSectionMap, renderInspector, visibleDependencies } from '../public/section-map.js';
import { applySectionDraft } from '../public/section-draft.js';
const section = (id, parentId, kind, dependsOn = []) => ({ id, parentId, kind, category: 'implement', title: id, objective: 'Create a feature', dependsOn, outputs: ['working code'], inputs: [], requirementIds: ['R1'], acceptanceCriteria: ['Works'], validation: ['Test'], displayStatus: 'planned' });
function project() { return { id: 'P', title: 'Snake <game>', workspace: '/project', status: 'planned', planRevision: 1, approvedPlanRevision: 0, specification: { description: 'A game', acceptanceCriteria: ['Playable'] }, planHistory: [], sectionRevisions: [], attempts: [], sections: [section('S1', 'P', 'step'), section('W1', 'S1', 'work_unit'), section('W2', 'S1', 'work_unit'), section('S2', 'P', 'step', ['S1']), section('W3', 'S2', 'work_unit')] }; }
test('plan stays readable at step level and requires initial approval', () => {
  const html = renderProjectPlan(project()); assert.match(html, /Approve plan and implement/); assert.match(html, /Snake &lt;game&gt;/); assert.doesNotMatch(html, /data-plan-select="W1"/);
});
test('hierarchical map expands children and aggregates visible dependencies', () => {
  const p = project(); assert.equal(visibleDependencies(p, 'P').length, 1);
  assert.doesNotMatch(renderSectionMap(p), /data-section-id="W1"/);
  assert.match(renderSectionMap(p, { expanded: new Set(['S1']) }), /data-section-id="W1"/);
  assert.match(renderInspector(p, 'W1'), /No execution attempts/);
});
test('draft operations do not mutate the approved plan or duplicate call ownership', () => {
  const p = project(); p.attempts.push({ id: 'A', sectionId: 'W1', actions: [{ id: 'call-1' }, { id: 'call-2' }] });
  const draft = applySectionDraft(p, [{ kind: 'split', sectionId: 'W1', parts: [{ id: 'A1', title: 'First', objective: 'First half', memberIds: ['call-1'] }, { id: 'A2', title: 'Second', objective: 'Second half', memberIds: ['call-2'] }] }]);
  assert.deepEqual(draft.assignmentOverrides, { 'call-1': 'A1', 'call-2': 'A2' });
  assert.ok(p.sections.some(section => section.id === 'W1'));
  assert.equal(p.assignmentOverrides, undefined);
  assert.throws(() => applySectionDraft(p, [{ kind: 'move', sectionId: 'S1', parentId: 'W1' }]), /Top-level|subtree/);
});
test('draft removal and merge retain change history in the original project', () => {
  const p = project();
  const removed = applySectionDraft(p, [{ kind: 'remove', sectionId: 'S1' }]); assert.deepEqual(removed.removedIds.sort(), ['S1', 'W1', 'W2']);
  assert.equal(p.sections.length, 5);
  const merged = applySectionDraft(p, [{ kind: 'merge', sectionId: 'W1', sourceIds: ['W1', 'W2'], newId: 'W12', title: 'Controls', objective: 'Working controls' }]);
  assert.equal(merged.sections.find(section => section.id === 'W12').parentId, 'S1');
});
