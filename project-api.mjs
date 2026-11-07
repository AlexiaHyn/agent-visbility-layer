import { applySectionDraft } from './public/section-draft.js';
import { randomUUID } from 'node:crypto';
import { sectionStatus, assert } from './section-model.mjs';
import { sectionDefinition } from './project-service.mjs';
export function projectView(project) {
  const assignments = project.attempts.flatMap(attempt => attempt.actions.map(action => ({ toolCallId: action.id, sectionId: project.assignmentOverrides?.[action.id] || attempt.sectionId, originalSectionId: attempt.sectionId, attemptId: attempt.id })));
  return { ...project, assignments, ...(project.draft?.status === 'editing' ? { draftPreview: applySectionDraft(project, project.draft.operations) } : {}), sections: project.sections.map(section => ({ ...section, displayStatus: sectionStatus(project, section.id) })) };
}
export async function handleProjectAPI(req, res, { url, json, body, service, chats, saveChats, active, defaultWorkspace }) {
  if (url.pathname === '/api/projects') {
    if (req.method === 'GET') return json(res, 200, (await service.store.list()).map(project => ({ id: project.id, title: project.title, workspace: project.workspace, status: project.status, revision: project.revision })));
    if (req.method === 'POST') { const input = await body(req); return json(res, 201, projectView(await service.create({ title: input.title, workspace: input.workspace || defaultWorkspace }))); }
  }
  const match = url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/(.*))?$/);
  if (!match) return false;
  const id = match[1], path = match[2] || '', project = await service.store.get(id);
  if (req.method === 'GET' && !path) {
    const branchId = url.searchParams.get('branch');
    if (!branchId || branchId === project.activeBranchId) return json(res, 200, projectView(project));
    const branch = project.branches.find(branch => branch.id === branchId); assert(branch, 'Map branch not found.', 404);
    const historical = await service.store.atRevision(id, branch.headRevision);
    return json(res, 200, { ...projectView(historical), branches: project.branches, viewedBranchId: branchId, latestBranchId: project.activeBranchId, readOnlyHistorical: true });
  }
  if (req.method === 'GET' && path.startsWith('impact/')) return json(res, 200, await service.impact(id, path.slice(7)));
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const input = await body(req, 2097152);
  if (path === 'rerun/preview') return json(res, 200, await service.rerunPreview(id, input.sectionId));
  if (path === 'rerun/approve') {
    assert(['new_chat', 'current_chat'].includes(input.branchMode), 'Choose how to display the rerun branch.');
    const target = chats.find(chat => chat.id === input.chatId && chat.projectId === id);
    assert(input.branchMode === 'new_chat' || target, 'Select a conversation attached to this project.', 400);
    const prepared = await service.prepareRerun(id, input.sectionId, input);
    const section = prepared.project.sections.find(section => section.id === input.sectionId);
    const title = section?.title || project.title;
    let branch = target;
    if (input.branchMode === 'new_chat') {
      branch = { id: randomUUID(), title: `Rerun: ${title}`.slice(0, 80), projectId: id, updatedAt: Date.now(), messages: [] };
      chats.unshift(branch); await service.event(id, 'chat_attached', { chatId: branch.id });
    }
    branch.forkFrom = { ...prepared.source, interventionId: prepared.interventionId, previousSessionFile: branch.sessionFile || null };
    branch.messages.push({ id: randomUUID(), role: 'notice', text: `Rerun branch before “${title}”. Earlier attempts and the original native session are retained.` });
    await saveChats();
    return json(res, 200, { chat: branch, project: projectView(await service.store.get(id)), instruction: prepared.strategy === 'review_repair' ? `Review the rerun request against the current workspace without changing files. Preserve unrelated interleaved work, inspect dependencies, prefer reuse/reimporting, and submit the smallest repair plan with changeReview. Stop for approval before implementation. The selected and affected units are ${prepared.workUnitIds.join(', ')}.` : `Rerun the approved work units ${prepared.workUnitIds.join(', ')} and every affected dependent. Use the current approved definitions, preserve unrelated work, validate each parent section, and complete project acceptance checks. You are on a branch of the recorded pre-section context.` });
  }
  if (path === 'draft') return json(res, 200, projectView(await service.event(id, 'draft_saved', { basePlanRevision: input.basePlanRevision, operations: input.operations, notes: input.notes })));
  if (path === 'draft/discard') return json(res, 200, projectView(await service.event(id, 'draft_discarded', {})));
  if (path === 'draft/confirm') return json(res, 200, projectView(await service.event(id, 'draft_confirmed', {})));
  if (path === 'approve') return json(res, 200, projectView(await service.event(id, 'plan_approved', { planRevision: input.planRevision })));
  if (path === 'pause') {
    const state = await service.event(id, input.immediate ? 'project_paused' : 'pause_requested', {});
    if (input.immediate) for (const value of active.values()) if (value.projectId === id) { await value.agent.cancel(); await value.finished; }
    return json(res, 200, projectView(state));
  }
  if (path === 'resume') return json(res, 200, projectView(await service.event(id, 'project_resumed', {})));
  return json(res, 404, { error: 'Project action not found.' });
}
