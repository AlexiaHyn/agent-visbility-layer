import { applySectionDraft } from './public/section-draft.js';
import { assert, validatePlan, descendants, sectionStatus, impactOf } from './section-model.mjs';
export function reduceProject(previous, event) {
  const p = structuredClone(previous);
  const data = event.payload;
  if (event.type === 'project_created') {
    assert(!p, 'Project already exists.', 409);
    return { schemaVersion: 1, id: event.projectId, revision: event.seq, title: data.title, workspace: data.workspace,
      chatIds: [], request: data.request || '', specification: null, planRevision: 0, planHistory: [], sections: [],
      sectionRevisions: [], dependencies: [], artifacts: {}, planningActions: [], assignmentOverrides: {}, attempts: [], checkpoints: [], interventions: [], status: 'draft', approvedPlanRevision: 0,
      activeBranchId: 'branch-1', branches: [{ id: 'branch-1', title: 'Initial implementation', headRevision: event.seq, createdAt: event.at }], createdAt: event.at, updatedAt: event.at };
  }
  assert(p, 'Project not found.', 404);
  const section = id => { const value = p.sections.find(section => section.id === id && !section.removed); assert(value, 'Section not found.', 404); return value; };
  if (event.type === 'chat_attached') { if (!p.chatIds.includes(data.chatId)) p.chatIds.push(data.chatId); }
  else if (event.type === 'draft_saved') {
    assert(data.basePlanRevision === p.planRevision, 'The plan changed; start a new draft from the latest revision.', 409);
    assert(!p.draft || p.draft.status === 'editing' || p.draft.status === 'awaiting_approval' || p.status === 'paused', 'Stop the current review before confirming another draft.', 409);
    if (p.draft && p.draft.status !== 'editing') { p.draftHistory ||= []; p.draftHistory.push(p.draft); }
    assert(Array.isArray(data.operations), 'Draft operations are required.');
    applySectionDraft(p, data.operations);
    p.draft = { baseMapRevision: p.draft?.baseMapRevision || event.seq - 1, basePlanRevision: data.basePlanRevision, operations: data.operations, notes: data.notes || '', status: 'editing', updatedAt: event.at };
  } else if (event.type === 'draft_discarded') {
    assert(!p.draft || p.draft.status === 'editing', 'A confirmed draft cannot be discarded without revising the proposal.', 409); p.draft = null;
  } else if (event.type === 'draft_confirmed') {
    assert(p.draft?.status === 'editing' && (p.draft.operations.length || p.draft.notes.trim()), 'Make a draft change or explain the requested change first.');
    assert(!p.attempts.some(attempt => attempt.status === 'active'), 'Wait for the active work unit to finish before confirming edits.', 409);
    p.draft.status = 'reviewing'; p.status = 'reviewing_changes'; p.pauseRequested = false;
  }
  else if (event.type === 'request_set') { assert(!p.attempts.some(attempt => attempt.status === 'active'), 'Pause execution before replacing the request.', 409); p.request = data.request; }
  else if (event.type === 'plan_revised') {
    assert(!p.attempts.some(attempt => attempt.status === 'active'), 'Finish or interrupt the active work unit before revising the plan.', 409);
    const plan = validatePlan(data.plan, p.id);
    if (p.draft?.status === 'reviewing') {
      const preview = applySectionDraft(p, p.draft.operations);
      for (const id of preview.removedIds) assert(!plan.sections.some(section => section.id === id), `The revised plan must honor removal or replacement of ${id}.`, 422);
      for (const id of Object.values(preview.assignmentOverrides)) assert(plan.sections.some(section => section.id === id), `Preserve manually assigned section ${id} in the proposal.`, 422);
      assert(data.changeReview && typeof data.changeReview.summary === 'string' && Array.isArray(data.changeReview.changes) && Array.isArray(data.changeReview.validation), 'A change-impact review is required for confirmed edits.', 422);
      p.changeProposal = { ...data.changeReview, basePlanRevision: p.planRevision, proposedPlanRevision: p.planRevision + 1, assignmentOverrides: preview.assignmentOverrides, operations: p.draft.operations };
      p.draft.status = 'awaiting_approval';
    }
    if (p.planRevision > 0 && !p.interventions.some(item => item.id === p.activeBranchId && item.kind === 'repair_rerun' && item.status === 'reviewing')) {
      const prior = p.branches.find(branch => branch.id === p.activeBranchId); if (prior) prior.headRevision = p.draft?.baseMapRevision || event.seq - 1;
      const branchId = `plan-${event.id}`;
      p.branches.push({ id: branchId, title: `Plan revision ${p.planRevision + 1}`, parentId: p.activeBranchId, headRevision: event.seq, createdAt: event.at });
      p.activeBranchId = branchId;
    }
    p.planRevision++;
    p.specification = plan.specification;
    for (const definition of plan.sections) {
      const old = p.sections.find(item => item.id === definition.id);
      const definitionKeys = ['id', 'parentId', 'kind', 'category', 'title', 'objective', 'instructions', 'requirementIds', 'dependsOn', 'inputs', 'outputs', 'acceptanceCriteria', 'validation'];
      const priorDefinition = old ? Object.fromEntries(definitionKeys.filter(key => old[key] !== undefined).map(key => [key, old[key]])) : undefined;
      const changed = !old || old.removed || JSON.stringify(priorDefinition) !== JSON.stringify(definition);
      const version = old ? old.version + (changed ? 1 : 0) : 1;
      const value = { ...definition, version, removed: false, stale: changed ? (!!old && p.attempts.some(attempt => attempt.sectionId === old.id)) : !!old?.stale };
      if (old) p.sections[p.sections.indexOf(old)] = value; else p.sections.push(value);
      if (changed) p.sectionRevisions.push({ ...value, planRevision: p.planRevision, at: event.at });
    }
    for (const item of p.sections) if (!plan.sections.some(definition => definition.id === item.id)) item.removed = true;
    p.planHistory.push({ revision: p.planRevision, specification: plan.specification, sections: plan.sections, reason: data.reason || 'Initial plan', at: event.at });
    for (const target of p.sections.filter(section => section.stale && section.kind !== 'work_unit')) {
      target.confirmation = null;
      for (const id of descendants(p, target.id)) { const child = p.sections.find(item => item.id === id); if (child.kind === 'work_unit' && !child.removed) child.stale = p.attempts.some(attempt => attempt.sectionId === child.id); }
      target.stale = false;
    }
    if (p.repairReview) for (const target of p.sections) if (!target.removed && p.repairReview.sectionIds.includes(target.id)) { if (target.kind === 'work_unit') target.stale = true; else { target.confirmation = null; target.stale = false; } }
    p.status = 'planned'; p.approvedPlanRevision = data.autoApprove ? p.planRevision : 0;
  } else if (event.type === 'sections_declared') {
    assert(p.approvedPlanRevision === p.planRevision && p.planRevision > 0, 'Approve the plan before declaring implementation details.', 409);
    assert(!p.attempts.some(attempt => attempt.status === 'active'), 'Finish the current work unit before declaring another.', 409);
    assert(Array.isArray(data.definitions) && data.definitions.length > 0, 'Declare at least one section.');
    for (const item of data.definitions) {
      assert(['subsection', 'work_unit'].includes(item.kind), 'Detailed expansion may add only subsections and work units.');
      assert(!p.sections.some(section => section.id === item.id), 'Section ID already exists.', 409);
    }
    const keys = ['id', 'parentId', 'kind', 'category', 'title', 'objective', 'instructions', 'requirementIds', 'dependsOn', 'inputs', 'outputs', 'acceptanceCriteria', 'validation'];
    const definitions = p.sections.filter(section => !section.removed).map(section => Object.fromEntries(keys.filter(key => section[key] !== undefined).map(key => [key, section[key]])));
    const validated = validatePlan({ specification: p.specification, sections: [...definitions, ...data.definitions] }, p.id);
    for (const supplied of data.definitions) { const item = validated.sections.find(item => item.id === supplied.id); const value = { ...item, version: 1, removed: false, stale: false }; p.sections.push(value); p.sectionRevisions.push({ ...value, planRevision: p.planRevision, at: event.at }); }
  } else if (event.type === 'planning_action_started') {
    assert(p.draft?.status === 'reviewing' || p.approvedPlanRevision !== p.planRevision || p.planRevision === 0, 'Planning inspection is only available before approval.', 409);
    p.planningActions.push({ ...data, status: 'running', startedAt: event.at });
  } else if (event.type === 'planning_action_finished') {
    const action = p.planningActions.find(action => action.id === data.toolCallId);
    assert(action, 'Planning action not found.', 404); Object.assign(action, { status: data.isError ? 'error' : 'done', result: data.result, endedAt: event.at });
  } else if (event.type === 'step_confirmed') {
    assert(p.approvedPlanRevision === p.planRevision && p.planRevision > 0 && p.status !== 'paused', 'Approve and resume the plan first.', 409);
    const target = section(data.sectionId);
    for (const id of target.dependsOn) assert(sectionStatus(p, id) === 'completed', `Prerequisite ${id} is not complete.`, 409);
    assert(target.kind !== 'work_unit', 'Finish work units through their execution attempt.');
    const children = p.sections.filter(section => !section.removed && section.parentId === target.id);
    if (!['understand', 'decide', 'deliver'].includes(target.category)) assert(children.length > 0, 'Implementation and integration steps need concrete work units.');
    assert(children.every(section => sectionStatus(p, section.id) === 'completed'), 'Complete and verify child sections first.', 409);
    assert(Array.isArray(data.validation) && target.acceptanceCriteria.every(criterion => data.validation.some(item => item.criterion === criterion && item.met === true && item.evidence)), 'Provide evidence for every criterion.', 422);
    target.stale = false;
    target.confirmation = { validation: data.validation, source: 'agent_reported', at: event.at };
  } else if (event.type === 'plan_approved') {
    assert(p.planRevision > 0 && p.draft?.status !== 'reviewing', 'Wait for a validated plan or change proposal before approval.', 409);
    assert(data.planRevision === p.planRevision, 'The plan changed; review its latest revision.', 409);
    p.approvedPlanRevision = p.planRevision; p.status = 'ready'; p.pauseRequested = false;
    if (p.changeProposal?.proposedPlanRevision === p.planRevision) {
      p.assignmentOverrides = p.changeProposal.assignmentOverrides;
      p.changeProposal.approvedAt = event.at;
      p.draft = null; p.rerunQueue = null;
      const review = p.interventions.find(item => item.id === p.activeBranchId && item.kind === 'repair_rerun'); if (review) review.status = 'implementing';
    }
  } else if (event.type === 'attempt_started') {
    assert(p.approvedPlanRevision === p.planRevision && p.planRevision > 0, 'A validated, approved plan is required.', 409);
    assert(!p.attempts.some(attempt => attempt.status === 'active'), 'Another work unit is active.', 409);
    const target = section(data.sectionId);
    assert(target.kind === 'work_unit', 'Tool execution must belong to a work unit.');
    const required = new Set(target.dependsOn);
    let parent = p.sections.find(item => item.id === target.parentId);
    while (parent) { parent.dependsOn.forEach(id => required.add(id)); parent = p.sections.find(item => item.id === parent.parentId); }
    for (const id of required) assert(sectionStatus(p, id) === 'completed', `Prerequisite ${id} is not complete.`, 409);
    assert(!p.attempts.some(attempt => attempt.id === data.attemptId), 'Attempt ID already exists.', 409);
    p.attempts.push({ id: data.attemptId, sectionId: target.id, sectionVersion: target.version, branchId: p.activeBranchId, planRevision: p.planRevision,
      sessionEntryId: data.sessionEntryId ?? null, chatId: data.chatId ?? null, sessionFile: data.sessionFile ?? null, beforeCheckpointId: data.beforeCheckpointId ?? null,
      status: 'active', validationStatus: 'unverified', actions: [], startedAt: event.at });
    target.stale = false; p.status = 'active';
  } else if (event.type === 'action_started') {
    const attempt = p.attempts.find(attempt => attempt.id === data.attemptId && attempt.status === 'active');
    assert(attempt, 'An active attempt is required.', 409);
    assert(!p.attempts.some(attempt => attempt.actions.some(action => action.id === data.action.id)), 'Tool call already has a primary owner.', 409);
    attempt.actions.push({ ...data.action, status: 'running', startedAt: event.at });
    const artifact = p.artifacts[data.action.path];
    if (artifact && artifact.sectionId !== attempt.sectionId && ['read', 'edit', 'write'].includes(data.action.name)) {
      const type = data.action.name === 'read' ? 'file_read_after_write' : 'file_overlap';
      if (!p.dependencies.some(edge => edge.from === artifact.sectionId && edge.to === attempt.sectionId && edge.path === data.action.path && edge.type === type)) p.dependencies.push({ from: artifact.sectionId, to: attempt.sectionId, kind: 'observed', type, path: data.action.path, explanation: `${data.action.path} was changed during ${artifact.sectionId} and then ${data.action.name} by ${attempt.sectionId}. This is file-level evidence, not proof of a function-level dependency.` });
    }
    if (attempt.actions.length > 5) attempt.oversized = true;
  } else if (event.type === 'action_finished') {
    const attempt = p.attempts.find(attempt => attempt.id === data.attemptId);
    const action = attempt?.actions.find(action => action.id === data.toolCallId);
    assert(action, 'Tool call is not assigned to this attempt.', 404);
    assert(action.status === 'running', 'Tool call has already finished.', 409);
    Object.assign(action, { status: data.isError ? 'error' : 'done', result: data.result, endedAt: event.at });
  } else if (event.type === 'attempt_finished') {
    const attempt = p.attempts.find(attempt => attempt.id === data.attemptId && attempt.status === 'active');
    assert(attempt, 'Active attempt not found.', 404);
    assert(['completed', 'failed', 'interrupted'].includes(data.status), 'Invalid attempt outcome.');
    if (data.status === 'completed') {
      assert(attempt.actions.length >= 1, 'A completed work unit requires at least one tool call.', 422);
      assert(attempt.actions.every(action => action.status !== 'running'), 'Wait for active tool calls to finish.', 409);
      assert(Array.isArray(data.validation) && data.validation.length > 0, 'Completion requires validation evidence.', 422);
      const target = section(attempt.sectionId);
      assert(target.acceptanceCriteria.every(criterion => data.validation.some(item => item.criterion === criterion && typeof item.met === 'boolean' && item.evidence)), 'Account for each acceptance criterion with evidence.', 422);
      assert(data.validation.every(item => item.met === true), 'Failed validation cannot be marked completed.', 422);
    }
    attempt.filesChanged = data.filesChanged || [];
    for (const change of attempt.filesChanged) p.artifacts[change.path] = { sectionId: attempt.sectionId, attemptId: attempt.id, checkpointId: data.afterCheckpointId, entry: change.after };
    Object.assign(attempt, { status: data.status, summary: data.summary || '', validation: data.validation || [],
      validationStatus: data.status === 'completed' ? 'passed' : 'unverified', afterCheckpointId: data.afterCheckpointId ?? null, endedAt: event.at });
    if (data.status === 'interrupted') for (const action of attempt.actions) if (action.status === 'running') action.status = 'interrupted';
    if (data.status === 'completed' && p.rerunQueue) p.rerunQueue = p.rerunQueue.filter(id => id !== attempt.sectionId);
    p.status = data.status === 'interrupted' || p.pauseRequested ? 'paused' : 'ready';
    if (p.status === 'paused') p.pauseRequested = false;
  } else if (event.type === 'section_edited') {
    const target = section(data.sectionId);
    assert(!p.attempts.some(attempt => attempt.status === 'active' && descendants(p, target.id).has(attempt.sectionId)), 'Pause the active section before editing it.', 409);
    for (const key of ['title', 'objective', 'instructions']) if (data[key] !== undefined) { assert(typeof data[key] === 'string' && data[key].trim(), `${key} cannot be empty.`); target[key] = data[key]; }
    target.version++; target.stale = p.attempts.some(attempt => descendants(p, target.id).has(attempt.sectionId));
    p.sectionRevisions.push({ ...target, at: event.at, planRevision: p.planRevision });
    for (const id of impactOf(p, target.id).downstreamIds) section(id).stale = true;
  } else if (event.type === 'section_removed') {
    const impact = impactOf(p, data.sectionId);
    assert(!p.attempts.some(attempt => attempt.status === 'active' && impact.sectionIds.includes(attempt.sectionId)), 'Pause the active section before removing it.', 409);
    for (const id of impact.sectionIds) section(id).removed = true;
    for (const id of impact.downstreamIds) section(id).stale = true;
  } else if (event.type === 'checkpoint_created') p.checkpoints.push({ ...data, at: event.at });
  else if (event.type === 'intervention_recorded') { p.interventions.push({ ...data, sourceRevision: event.seq - 1, at: event.at }); if (data.status === 'prepared') p.status = 'paused'; }
  else if (event.type === 'rerun_ready') {
    const intervention = p.interventions.find(item => item.id === data.interventionId); assert(intervention, 'Intervention not found.', 404);
    for (const old of p.interventions) if (old.id !== intervention.id && old.status === 'prepared') old.status = 'superseded';
    p.recoveryRequired = false;
    for (const [path, artifact] of Object.entries(data.artifactRestoration || {})) { if (artifact) p.artifacts[path] = artifact; else delete p.artifacts[path]; }
    intervention.status = 'ready'; intervention.recoveryCheckpointId = data.recoveryCheckpointId;
    const prior = p.branches.find(branch => branch.id === p.activeBranchId);
    if (prior) prior.headRevision = intervention.sourceRevision;
    p.branches.push({ id: intervention.id, title: `Rerun ${intervention.sectionId}`, parentId: p.activeBranchId, headRevision: event.seq, createdAt: event.at });
    p.activeBranchId = intervention.id;
    p.rerunQueue = data.workUnitIds;
    for (const target of p.sections) if (data.sectionIds.includes(target.id)) { if (target.kind === 'work_unit') target.stale = true; else { target.confirmation = null; target.stale = false; } }
    p.status = 'ready'; p.pauseRequested = false;
  }
  else if (event.type === 'repair_review_started') {
    assert(!p.draft && !p.attempts.some(attempt => attempt.status === 'active'), 'Finish current work or plan edits before requesting a rerun repair.', 409);
    const prior = p.branches.find(branch => branch.id === p.activeBranchId); if (prior) prior.headRevision = event.seq - 1;
    p.branches.push({ id: data.interventionId, title: `Repair rerun ${data.sectionId}`, parentId: p.activeBranchId, headRevision: event.seq, createdAt: event.at });
    p.activeBranchId = data.interventionId;
    p.interventions.push({ id: data.interventionId, kind: 'repair_rerun', status: 'reviewing', sectionId: data.sectionId, at: event.at, source: data.source });
    p.repairReview = { sectionIds: data.sectionIds, workUnitIds: data.workUnitIds, interleavedSectionIds: data.interleavedSectionIds };
    p.draft = { basePlanRevision: p.planRevision, operations: [], notes: `Rerun ${data.sectionId} and affected dependents ${data.sectionIds.join(', ')}. Preserve unrelated work in ${data.interleavedSectionIds.join(', ')}. Inspect current files and propose the smallest repairs, preferring reuse and reimports.`, status: 'reviewing', updatedAt: event.at };
    p.status = 'reviewing_changes'; p.pauseRequested = false;
  }
  else if (event.type === 'intervention_failed') { const intervention = p.interventions.find(item => item.id === data.interventionId); assert(intervention, 'Intervention not found.', 404); intervention.status = 'failed'; intervention.error = data.error; p.recoveryRequired = data.recoveryRequired; p.status = 'paused'; }
  else if (event.type === 'pause_requested') p.pauseRequested = true;
  else if (event.type === 'project_paused') { p.status = 'paused'; p.pauseRequested = false; p.pauseReason = data.reason || ''; }
  else if (event.type === 'project_resumed') { assert(!p.recoveryRequired && !p.interventions.some(item => item.status === 'prepared'), 'Review the interrupted restoration before continuing.', 409); assert(p.approvedPlanRevision === p.planRevision && p.planRevision > 0, 'Approve the current plan first.', 409); p.status = 'ready'; p.pauseRequested = false; }
  else if (event.type === 'project_completed') {
    assert(p.approvedPlanRevision === p.planRevision && p.planRevision > 0, 'Approve the current plan first.', 409);
    const steps = p.sections.filter(section => section.kind === 'step' && !section.removed);
    assert(steps.length > 0 && steps.every(section => sectionStatus(p, section.id) === 'completed'), 'Complete and verify all planned steps first.', 409);
    assert(Array.isArray(data.validation) && p.specification.acceptanceCriteria.every(criterion => data.validation.some(item => item.criterion === criterion && item.met === true && item.evidence)), 'Provide evidence for every project acceptance criterion.', 422);
    p.validation = data.validation;
    p.status = 'completed'; p.completedAt = event.at;
    for (const intervention of p.interventions) if (intervention.status === 'ready' || intervention.status === 'implementing') intervention.status = 'completed';
    p.repairReview = null;
  } else throw new Error(`Unknown project event: ${event.type}`);
  const head = p.branches?.find(branch => branch.id === p.activeBranchId); if (head) head.headRevision = event.seq;
  p.revision = event.seq; p.updatedAt = event.at;
  return p;
}
