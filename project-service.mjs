import { realpath, stat, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, win32, resolve } from 'node:path';
import { SectionStore } from './section-store.mjs';
import { CheckpointStore } from './checkpoint-store.mjs';
import { assert, impactOf, descendants } from './section-model.mjs';
const fields = ['id', 'parentId', 'kind', 'category', 'title', 'objective', 'instructions', 'requirementIds', 'dependsOn', 'inputs', 'outputs', 'acceptanceCriteria', 'validation'];
export function sectionDefinition(section) { return Object.fromEntries(fields.filter(key => section[key] !== undefined).map(key => [key, structuredClone(section[key])])); }
export class ProjectService {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.store = new SectionStore(join(dataDirectory, 'projects'));
    this.checkpoints = new CheckpointStore(join(dataDirectory, 'checkpoints'));
    this.workspaceLocks = new Map(); this.listeners = new Set();
  }
  async initialize() {
    for (const project of await this.store.list()) {
      for (const attempt of project.attempts.filter(attempt => attempt.status === 'active')) await this.event(project.id, 'attempt_finished', { attemptId: attempt.id, status: 'interrupted', summary: 'Server stopped before this work unit finished.' });
      if (project.interventions.some(item => item.status === 'prepared')) await this.event(project.id, 'project_paused', { reason: 'A restoration was interrupted. Review and retry the rerun before continuing implementation.' });
    }
  }
  async create({ title, workspace }) {
    const directory = await realpath(workspace);
    assert((await stat(directory)).isDirectory(), 'Workspace must be an existing directory.');
    return this.store.create({ title, workspace: directory });
  }
  async event(id, type, payload, options) {
    const project = await this.store.dispatch(id, type, payload, options);
    for (const listener of this.listeners) listener(project);
    return project;
  }
  async acquireWorkspace(workspace, owner) {
    const path = await realpath(workspace);
    assert(!this.workspaceLocks.has(path), 'This workspace is busy in another conversation. Wait for it to finish.', 409);
    this.workspaceLocks.set(path, owner);
    return () => { if (this.workspaceLocks.get(path) === owner) this.workspaceLocks.delete(path); };
  }
  async submitPlan(id, plan, reason = 'Initial plan', changeReview) {
    return this.event(id, 'plan_revised', { plan, reason, changeReview, autoApprove: false });
  }
  async declareSections(id, definitions) {
    return this.event(id, 'sections_declared', { definitions });
  }
  async startUnit(id, sectionId, sessionEntryId, context = {}) {
    const project = await this.store.get(id);
    assert(project.status !== 'paused' && !project.pauseRequested, 'Execution is paused. Wait for the user to continue.', 409);
    if (project.rerunQueue?.length) assert(project.rerunQueue.includes(sectionId), 'Rerun the selected and affected work units before unrelated work.', 409);
    const attemptId = randomUUID();
    const checkpoint = await this.checkpoints.capture(project.workspace, { projectId: id, sectionId, attemptId, phase: 'before', sessionEntryId, artifacts: project.artifacts });
    await this.event(id, 'checkpoint_created', { id: checkpoint.id, sectionId, attemptId, phase: 'before', sessionEntryId, artifacts: project.artifacts });
    return this.event(id, 'attempt_started', { sectionId, attemptId, sessionEntryId, chatId: context.chatId, sessionFile: context.sessionFile, beforeCheckpointId: checkpoint.id });
  }
  async recordAction(id, attemptId, event) {
    const project = await this.store.get(id);
    let path;
    if (typeof event.input?.path === 'string') {
      path = resolve(project.workspace, event.input.path);
      path = await realpath(path).catch(() => path);
    }
    return this.event(id, 'action_started', { attemptId, action: { id: event.toolCallId, name: event.toolName, input: event.input, path } });
  }
  async finishUnit(id, outcome, sessionEntryId) {
    const project = await this.store.get(id), attempt = project.attempts.find(attempt => attempt.status === 'active');
    assert(attempt, 'No work unit is active.', 409);
    const checkpoint = await this.checkpoints.capture(project.workspace, { projectId: id, sectionId: attempt.sectionId, attemptId: attempt.id, phase: 'after', sessionEntryId });
    const before = await this.checkpoints.get(attempt.beforeCheckpointId);
    const filesChanged = [...new Set([...Object.keys(before.entries), ...Object.keys(checkpoint.entries)])].filter(path => JSON.stringify(before.entries[path]) !== JSON.stringify(checkpoint.entries[path])).map(path => ({ path: resolve(project.workspace, path), relativePath: path, before: before.entries[path] || null, after: checkpoint.entries[path] || null }));
    await this.event(id, 'checkpoint_created', { id: checkpoint.id, sectionId: attempt.sectionId, attemptId: attempt.id, phase: 'after', sessionEntryId });
    return this.event(id, 'attempt_finished', { ...outcome, filesChanged, attemptId: attempt.id, afterCheckpointId: checkpoint.id });
  }
  async finishTurn(id, sessionEntryId) {
    const project = await this.store.get(id);
    const active = project.attempts.find(attempt => attempt.status === 'active');
    if (active) {
      try { await this.finishUnit(id, { status: 'interrupted', summary: 'The response ended before the active work unit was completed.' }, sessionEntryId); }
      catch (error) { await this.event(id, 'attempt_finished', { attemptId: active.id, status: 'interrupted', summary: `Interrupted; after-checkpoint unavailable: ${error.message}` }); }
    }
    return this.store.get(id);
  }
  async impact(id, sectionId) {
    const project = await this.store.get(id), impact = impactOf(project, sectionId);
    const attempts = project.attempts.filter(attempt => impact.sectionIds.includes(attempt.sectionId) && attempt.beforeCheckpointId && attempt.afterCheckpointId);
    const latest = attempts.at(-1);
    const checkpointPreview = latest ? await this.checkpoints.preview(latest.beforeCheckpointId, latest.afterCheckpointId) : null;
    return { ...impact, attemptId: latest?.id || null, checkpointPreview,
      historicalOnly: !latest, revision: project.revision, definition: project.sections.find(section => section.id === sectionId) };
  }
  async rerunPreview(id, sectionId) {
    const project = await this.store.get(id);
    assert(project.approvedPlanRevision === project.planRevision && project.planRevision > 0 && !project.draft, 'Approve or finish the current plan edits before rerunning.', 409);
    assert(!project.attempts.some(attempt => attempt.status === 'active'), 'Stop the current implementation before preparing a rerun.', 409);
    const impact = impactOf(project, sectionId), affected = new Set([...impact.sectionIds, ...impact.downstreamIds]);
    const attempts = project.attempts.filter(attempt => sectionId === project.id || affected.has(attempt.sectionId) || attempt.actions.some(action => affected.has(project.assignmentOverrides?.[action.id])));
    assert(attempts.length && attempts.every(attempt => attempt.beforeCheckpointId && attempt.afterCheckpointId), 'This section lacks complete recorded checkpoints. Use a reviewed repair plan instead.', 409);
    const firstIndex = Math.min(...attempts.map(attempt => project.attempts.indexOf(attempt))), lastIndex = Math.max(...attempts.map(attempt => project.attempts.indexOf(attempt)));
    const first = project.attempts[firstIndex], last = project.attempts[lastIndex];
    const interleaved = project.attempts.slice(firstIndex, lastIndex + 1).filter(attempt => !attempts.includes(attempt));
    const checkpointPreview = await this.checkpoints.preview(first.beforeCheckpointId, last.afterCheckpointId);
    assert(first.sessionFile && first.sessionEntryId, 'No pre-section conversation checkpoint was recorded. A branch cannot be restored safely.', 409);
    const sourceFile = join(this.dataDirectory, 'sessions', win32.basename(first.sessionFile));
    const entries = (await readFile(sourceFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert(entries.some(entry => entry.id === first.sessionEntryId), 'The recorded pre-section context is missing.', 409);
    return { projectId: id, sectionId, revision: project.revision, sectionIds: impact.sectionIds, downstreamIds: impact.downstreamIds, validationAncestorIds: impact.validationAncestorIds,
      workUnitIds: project.sections.filter(section => section.kind === 'work_unit' && !section.removed && affected.has(section.id)).map(section => section.id),
      checkpointPreview, interleavedSectionIds: [...new Set(interleaved.map(attempt => attempt.sectionId))],
      strategy: interleaved.length ? 'review_repair' : 'restore', source: { sessionFile: sourceFile, entryId: first.sessionEntryId, chatId: first.chatId },
      instruction: 'Rerun all selected work units and all affected dependents, then revalidate their parent sections and project acceptance criteria.' };
  }
  async prepareRerun(id, sectionId, { revision, signature, strategy }) {
    const project = await this.store.get(id), release = await this.acquireWorkspace(project.workspace, `rerun:${randomUUID()}`);
    try {
      const preview = await this.rerunPreview(id, sectionId);
      assert(preview.revision === revision && preview.checkpointPreview.signature === signature, 'Project or workspace changed since the preview. Review a fresh preview.', 409);
      assert(preview.strategy === strategy, 'The rerun strategy changed. Review a fresh preview.', 409);
      if (strategy === 'review_repair') {
        const interventionId = randomUUID();
        const state = await this.event(id, 'repair_review_started', { interventionId, sectionId, source: preview.source, sectionIds: [...new Set([...preview.sectionIds, ...preview.downstreamIds, ...preview.validationAncestorIds])], workUnitIds: preview.workUnitIds, interleavedSectionIds: preview.interleavedSectionIds });
        return { project: state, source: preview.source, interventionId, workUnitIds: preview.workUnitIds, strategy, restoredPaths: [] };
      }
      assert(strategy === 'restore', 'Unsupported rerun strategy.');
      assert(preview.checkpointPreview.conflicts.length === 0, 'Intervening file edits conflict with rerun. Resolve them before restoring.', 409);
      const interventionId = randomUUID();
      await this.event(id, 'intervention_recorded', { id: interventionId, kind: 'rerun', status: 'prepared', sectionId, sectionIds: preview.sectionIds, downstreamIds: preview.downstreamIds, source: preview.source, beforeId: preview.checkpointPreview.beforeId, afterId: preview.checkpointPreview.afterId });
      let result;
      try { result = await this.checkpoints.restore(preview.checkpointPreview.beforeId, preview.checkpointPreview.afterId, signature); }
      catch (error) { await this.event(id, 'intervention_failed', { interventionId, error: error.message, recoveryRequired: error.status === 500 && error.issues?.length > 0 }); throw error; }
      const baseline = await this.checkpoints.get(preview.checkpointPreview.beforeId);
      const artifactRestoration = Object.fromEntries(preview.checkpointPreview.changes.map(change => [resolve(project.workspace, change.path), baseline.metadata.artifacts?.[resolve(project.workspace, change.path)] ?? null]));
      const state = await this.event(id, 'rerun_ready', { interventionId, sectionIds: [...new Set([...preview.sectionIds, ...preview.downstreamIds, ...preview.validationAncestorIds])], workUnitIds: preview.workUnitIds, recoveryCheckpointId: result.recoveryCheckpointId, artifactRestoration });
      return { project: state, source: preview.source, interventionId, workUnitIds: preview.workUnitIds, strategy: 'restore', restoredPaths: result.restoredPaths };
    } finally { release(); }
  }
  async close() { await this.store.close(); }
}
