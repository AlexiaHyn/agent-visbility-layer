import { initializeSplitPane } from './split-pane.js';
import { applySectionDraft } from './section-draft.js';
import { renderProjectPlan, renderSectionMap, renderInspector, visibleDependencies, escape } from './section-map.js';
const filePreview = change => `<details class="impact-file"><summary><strong>${escape(change.path)}</strong> · ${change.before ? change.after ? 'Modified' : 'Deleted' : 'Created'}</summary>${['before', 'after'].map(side => { const content = change[side + 'Content']; return `<h5>${side === 'before' ? 'Before section' : 'After section'}</h5><pre>${escape(content?.binary ? '[Binary file]' : content?.text ?? '[Content unavailable]')}</pre>${content?.truncated ? '<small>Excerpt limited to 12 KB</small>' : ''}`; }).join('')}</details>`;
export class ProjectUI {
  constructor({ api, getChat, isBusy, onSelect, onBranch, sendMessage, notice }) {
    Object.assign(this, { api, getChat, isBusy, onSelect, onBranch, sendMessage, notice });
    this.enabled = typeof document.querySelector('#project-select')?.addEventListener === 'function';
    this.historicalProject = null;
    this.selectedProjectId = null; this.project = null; this.focusId = null; this.selectedId = null;
    this.editMode = false; this.draftOperations = []; this.draftNotes = ""; this.persistDraft = false; this.draftQueue = Promise.resolve();
    this.expanded = new Set(); this.lastChatId = null; this.loading = null; this.pollTimer = null;
    if (!this.enabled) return;
    initializeSplitPane({ document, window });
    document.querySelector('#project-select').onchange = async event => {
      if (this.isBusy()) return;
      this.selectedProjectId = event.target.value || null; this.project = null; this.lastChatId = null;
      await this.onSelect(); await this.refresh();
    };
    document.querySelector('#create-project').onclick = () => this.newProjectDialog();
    document.querySelector('#map-branch-select').onchange = event => this.selectMapBranch(event.target.value);
    document.querySelector('#toggle-plan-edit').onclick = () => this.enterEditMode();
    document.querySelector('#confirm-plan-edits').onclick = () => this.confirmDraft();
    document.querySelector('#discard-plan-edits').onclick = () => this.discardDraft();
    document.querySelector('#close-project-map').onclick = () => { this.editMode = false; this.draftOperations = []; this.draftNotes = ''; this.historicalProject = null; document.querySelector('#project-map-panel').hidden = true; };
    document.querySelector('#close-project-dialog').onclick = () => document.querySelector('#project-dialog').close();
  }
  async initialize(defaultWorkspace) {
    if (!this.enabled) return;
    this.defaultWorkspace = defaultWorkspace;
    await this.reloadProjects(); this.render();
  }
  async reloadProjects() {
    const projects = await (await this.api('/api/projects')).json();
    document.querySelector('#project-select').innerHTML = '<option value="">Chat only — no implementation project</option>' + projects.map(project => `<option value="${escape(project.id)}">${escape(project.title)}</option>`).join('');
    document.querySelector('#project-select').value = this.selectedProjectId || '';
  }
  syncChat(chat) {
    if (!this.enabled) return;
    if (!chat) { this.lastChatId = null; this.render(); return; }
    if (chat.id !== this.lastChatId) {
      this.lastChatId = chat.id; this.selectedProjectId = chat.projectId || null;
      document.querySelector('#project-select').value = this.selectedProjectId || '';
      this.project = null; void this.refresh();
    }
  }
  async refresh() {
    if (!this.enabled) return;
    if (!this.selectedProjectId) { this.project = null; this.render(); return; }
    if (this.loading) { this.refreshAgain = true; return this.loading; }
    const id = this.selectedProjectId;
    this.loading = (async () => {
      try {
        const project = await (await this.api(`/api/projects/${id}`)).json();
        if (id !== this.selectedProjectId) return;
        const changedProject = this.project?.id !== project.id;
        this.project = project;
        if (changedProject || !this.editMode) { this.draftOperations = project.draft?.status === 'editing' ? project.draft.operations : []; this.draftNotes = project.draft?.notes || ''; this.editMode = project.draft?.status === 'editing'; }
        if (changedProject) { this.historicalProject = null; this.focusId = project.id; this.selectedId = project.id; this.expanded.clear(); }
        this.render();
      } catch (error) { this.notice(error.message); }
      finally {
        this.loading = null;
        if (this.refreshAgain) { this.refreshAgain = false; void this.refresh(); }
      }
    })();
    return this.loading;
  }
  onEvent(event) { if (this.enabled && (event.type === 'project' || event.type === 'done')) void this.refresh(); }
  render() {
    if (!this.enabled) return;
    const panel = document.querySelector('#project-plan'); panel.hidden = !this.selectedProjectId;
    document.querySelector('#project-select').disabled = this.isBusy(); document.querySelector('#create-project').disabled = this.isBusy();
    if (!this.selectedProjectId) { document.querySelector('#project-map-panel').hidden = true; return; }
    if (!this.project) { panel.innerHTML = '<p>Loading project…</p>'; return; }
    const project = this.project;
    panel.innerHTML = renderProjectPlan(project, this.isBusy());
    panel.querySelector('#open-project-map').onclick = () => this.openMap();
    for (const button of panel.querySelectorAll('[data-plan-select]')) button.onclick = () => this.openMap(button.dataset.planSelect);
    const approve = panel.querySelector('#approve-plan');
    if (approve) approve.onclick = () => this.perform(async () => {
      this.project = await (await this.api(`/api/projects/${project.id}/approve`, { planRevision: project.planRevision })).json(); this.render();
      this.sendMessage(`Implement approved plan revision ${project.planRevision}. Follow its steps and declare concrete work units before using implementation tools.`);
    });
    const resume = panel.querySelector('#continue-project');
    if (resume) resume.onclick = () => this.perform(async () => {
      this.project = await (await this.api(`/api/projects/${project.id}/resume`, {})).json(); this.render();
      this.sendMessage('Continue the approved implementation plan from the next ready work unit. Preserve completed work and validate each outcome.');
    });
    const pause = panel.querySelector('#pause-project');
    if (pause) pause.onclick = () => this.action('pause', {});
    if (!document.querySelector('#project-map-panel').hidden) this.renderMap();
    clearTimeout(this.pollTimer);
    if (this.isBusy() || project.status === 'active') this.pollTimer = setTimeout(() => this.refresh(), 1200);
  }
  openMap(id) {
    if (id) this.selectedId = id;
    document.querySelector('#project-map-panel').hidden = false; this.renderMap();
  }
  renderMap() {
    const source = this.historicalProject || this.project; if (!source) return;
    const history = !!source.readOnlyHistorical;
    const selector = document.querySelector('#map-branch-select');
    selector.innerHTML = (this.project.branches || []).map(branch => `<option value="${escape(branch.id)}">${escape(branch.title)}${branch.id === this.project.activeBranchId ? ' (latest)' : ''}</option>`).join('');
    selector.value = source.viewedBranchId || this.project.activeBranchId;
    document.querySelector('#historical-map-notice').hidden = !history;
    const project = this.editMode ? { ...source, ...applySectionDraft(source, this.draftOperations) } : source;
    if (this.editMode) {
      const changed = new Set(this.draftOperations.flatMap(operation => [operation.sectionId, ...(operation.sourceIds || []), ...(operation.parts || []).map(part => part.id), operation.newId]));
      project.sections = project.sections.map(section => changed.has(section.id) ? { ...section, displayStatus: 'draft' } : section);
    }
    if (this.editMode) document.querySelector('#draft-notice').textContent = 'Unsaved draft — code is unchanged. Closing edit mode or the map discards edits. Confirm requests model review.' + (project.warnings?.length ? ' Links needing repair: ' + project.warnings.join('; ') : '');
    this.displayProject = project;
    document.querySelector('#toggle-plan-edit').hidden = history || this.editMode || !source.planRevision;
    document.querySelector('#confirm-plan-edits').hidden = !this.editMode;
    document.querySelector('#discard-plan-edits').hidden = !this.editMode;
    document.querySelector('#confirm-plan-edits').disabled = this.isBusy();
    document.querySelector('#draft-notice').hidden = !this.editMode;
    const map = document.querySelector('#project-map');
    map.innerHTML = renderSectionMap(project, { focusId: this.focusId, selectedId: this.selectedId, expanded: this.expanded });
    const canvas = map.querySelector('.section-canvas');
    if (canvas) { canvas.style.width = `${canvas.dataset.canvasWidth}px`; canvas.style.height = `${canvas.dataset.canvasHeight}px`; }
    for (const card of map.querySelectorAll('.positioned-section')) { card.style.left = `${card.dataset.nodeX}px`; card.style.top = `${card.dataset.nodeY}px`; }
    for (const button of map.querySelectorAll('[data-select-section]')) button.onclick = () => { this.selectedId = button.dataset.selectSection; this.renderMap(); };
    for (const button of map.querySelectorAll('[data-expand-section]')) button.onclick = () => {
      const id = button.dataset.expandSection; if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id); this.renderMap();
    };
    for (const button of map.querySelectorAll('[data-focus-section]')) button.onclick = () => { this.focusId = button.dataset.focusSection; this.selectedId = this.focusId; this.renderMap(); };
    for (const edge of map.querySelectorAll('[data-select-dependency]')) {
      edge.onclick = () => {
        const dependency = visibleDependencies(project, this.focusId)[Number(edge.dataset.selectDependency)];
        document.querySelector('#section-inspector').innerHTML = `<h3>${escape(dependency.kind)} dependency</h3><p>${escape(dependency.from)} → ${escape(dependency.to)}</p><p>${escape(dependency.explanation)}</p>`;
      };
      edge.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); edge.onclick(); } };
    }
    const inspector = document.querySelector('#section-inspector'); inspector.innerHTML = renderInspector(project, this.selectedId);
    for (const button of inspector.querySelectorAll('[data-select-section]')) button.onclick = () => { this.selectedId = button.dataset.selectSection; this.renderMap(); };
    const focus = inspector.querySelector('#focus-selected-section');
    if (focus) focus.onclick = () => { this.focusId = this.selectedId; this.renderMap(); };
    const rerun = inspector.querySelector('#rerun-selected-section');
    if (rerun) { rerun.disabled = !!source.sections.find(section => section.id === this.selectedId)?.removed || history || this.editMode || this.isBusy() || source.approvedPlanRevision !== source.planRevision; rerun.onclick = () => this.rerunDialog(); }
    const edit = inspector.querySelector('#edit-selected-section'); if (edit) { edit.hidden = history || !this.editMode || !!project.sections.find(section => section.id === this.selectedId)?.removed; edit.onclick = () => this.editDialog(); }
    const preview = inspector.querySelector('#preview-selected-section'); if (preview) { preview.hidden = history; preview.onclick = () => this.impactDialog(); }
    const organize = inspector.querySelector('#reorganize-selected-section'); if (organize) { organize.hidden = history || !this.editMode || !!project.sections.find(section => section.id === this.selectedId)?.removed; organize.onclick = () => this.organizeDialog(); }
    if (!history && this.editMode && this.selectedId !== project.id && !project.sections.find(section => section.id === this.selectedId)?.removed) {
      const actions = inspector.querySelector('.inspector-actions');
      const remove = document.createElement('button'); remove.textContent = 'Remove section';
      remove.onclick = () => this.addDraftOperation({ kind: 'remove', sectionId: this.selectedId });
      actions.append(remove);
    }
  }
  dialog(title, content, submitLabel, submit) {
    const dialog = document.querySelector('#project-dialog');
    document.querySelector('#project-dialog-title').textContent = title;
    const form = document.querySelector('#project-dialog-form');
    form.innerHTML = content + (submitLabel ? `<div class="dialog-actions"><button class="primary-button" type="submit">${escape(submitLabel)}</button></div>` : '');
    form.onsubmit = async event => {
      event.preventDefault(); const button = form.querySelector('button[type=submit]'); if (button) button.disabled = true;
      try { await submit(new FormData(form)); dialog.close(); } catch (error) {
        this.notice(error.message);
        let issue = form.querySelector('.dialog-error');
        if (!issue) { issue = document.createElement('p'); issue.className = 'error dialog-error'; issue.setAttribute('role', 'alert'); form.prepend(issue); }
        issue.textContent = error.message;
      } finally { if (button) button.disabled = false; }
    };
    if (!dialog.open) dialog.showModal();
  }
  newProjectDialog() {
    this.dialog('Create implementation project', `<label>Project name<input name="title" required maxlength="200"></label><label>Workspace directory<input name="workspace" required value="${escape(this.defaultWorkspace || '')}"></label><p class="muted">Choose an existing directory. Implementation tools work there; chats, sessions, and project records stay in this app’s data directory.</p>`, 'Create project', async data => {
      const project = await (await this.api('/api/projects', { title: data.get('title'), workspace: data.get('workspace') })).json();
      this.selectedProjectId = project.id; this.project = project; this.focusId = project.id; this.selectedId = project.id;
      await this.reloadProjects(); await this.onSelect(); this.render();
    });
  }
  editDialog() {
    const section = (this.displayProject || this.project).sections.find(section => section.id === this.selectedId);
    const fields = [['title', 'Title'], ['objective', 'Objective'], ['instructions', 'Instructions'], ['outputs', 'Outputs (one per line)'], ['acceptanceCriteria', 'Acceptance criteria (one per line)'], ['validation', 'Validation methods (one per line)']];
    this.dialog('Edit section definition', fields.map(([key, label]) => `<label>${label}<textarea name="${key}"${key === 'instructions' ? '' : ' required'}>${escape(Array.isArray(section[key]) ? section[key].join('\n') : section[key] || '')}</textarea></label>`).join('') + '<p class="muted">This changes only your draft. Confirm the draft to request a minimal repair proposal; implementation still requires your approval.</p>', 'Save draft change', async data => {
      const input = Object.fromEntries(fields.map(([key]) => [key, ['outputs', 'acceptanceCriteria', 'validation'].includes(key) ? String(data.get(key)).split('\n').map(text => text.trim()).filter(Boolean) : data.get(key)]));
      await this.addDraftOperation({ kind: 'edit', sectionId: section.id, values: input });
    });
  }
  async impactDialog() {
    await this.perform(async () => {
      const impact = await (await this.api(`/api/projects/${this.project.id}/impact/${this.selectedId}`)).json();
      this.dialog('Section changes and impact', `<p>${impact.toolCallIds.length} tool calls · ${impact.downstreamIds.length} downstream sections</p><p>${impact.historicalOnly ? 'No usable checkpoint exists for this section.' : 'Workspace differences captured at section boundaries:'}</p>${(impact.checkpointPreview?.changes || []).map(filePreview).join('')}${impact.checkpointPreview?.conflicts.length ? `<p class="error">Intervening edits conflict: ${escape(impact.checkpointPreview.conflicts.join(', '))}</p>` : ''}<p class="muted">Snapshot coverage excludes application data, .env credentials, Git internals, and dependencies. External side effects cannot be reversed by file snapshots.</p>`, null);
    });
  }
  organizeDialog() {
    const project = this.displayProject || this.project;
    const section = project.sections.find(section => section.id === this.selectedId);
    const parents = project.sections.filter(item => !item.removed && ['step', 'subsection'].includes(item.kind) && item.id !== section.id);
    const peers = project.sections.filter(item => item.kind === section.kind && item.parentId === section.parentId && item.id !== section.id);
    const actions = project.attempts.flatMap(attempt => attempt.actions.filter(action => (project.assignmentOverrides?.[action.id] || attempt.sectionId) === section.id));
    const members = section.kind === 'work_unit' ? actions.map(action => ({ id: action.id, title: `${action.name} · ${action.id}` })) : project.sections.filter(item => item.parentId === section.id);
    this.dialog('Reorganize section', `<label>Operation<select name="operation"><option value="move">Move</option><option value="merge">Merge with sibling</option><option value="split">Split into two sections</option></select></label><fieldset data-operation="move"><legend>Move</legend><label>New parent<select name="parentId">${section.kind === 'step' ? `<option value="${escape(project.id)}">Project root</option>` : parents.map(item => `<option value="${escape(item.id)}"${item.id === section.parentId ? ' selected' : ''}>${escape(item.title)}</option>`).join('')}</select></label></fieldset><fieldset data-operation="merge"><legend>Merge</legend><label>Sibling section<select name="mergeId"><option value="">Choose a sibling</option>${peers.map(item => `<option value="${escape(item.id)}">${escape(item.title)}</option>`).join('')}</select></label><label>Merged title<input name="mergedTitle"></label><label>Merged objective<textarea name="mergedObjective"></textarea></label></fieldset><fieldset data-operation="split"><legend>Split</legend><label>First section title<input name="firstTitle"></label><label>First section objective<textarea name="firstObjective"></textarea></label><label>Second section title<input name="secondTitle"></label><label>Second section objective<textarea name="secondObjective"></textarea></label>${members.map(member => `<label>${escape(member.title || member.id)}<select name="member:${escape(member.id)}"><option value="first">First section</option><option value="second">Second section</option></select></label>`).join('')}</fieldset><p class="muted">Changes are draft proposals. Recorded attempts remain unchanged; Confirm requests model review before implementation.</p>`, 'Save draft operation', async data => {
      const operation = data.get('operation');
      if (operation === 'move') await this.addDraftOperation({ kind: 'move', sectionId: section.id, parentId: data.get('parentId') });
      else if (operation === 'merge') {
        if (!data.get('mergeId') || !data.get('mergedTitle')?.trim() || !data.get('mergedObjective')?.trim()) throw new Error('Choose a sibling and provide the merged title and objective.');
        await this.addDraftOperation({ kind: 'merge', sectionId: section.id, sourceIds: [section.id, data.get('mergeId')], newId: `merged-${crypto.randomUUID()}`, title: data.get('mergedTitle'), objective: data.get('mergedObjective') });
      } else {
        for (const key of ['firstTitle', 'firstObjective', 'secondTitle', 'secondObjective']) if (!data.get(key)?.trim()) throw new Error('Provide titles and objectives for both split sections.');
        await this.addDraftOperation({ kind: 'split', sectionId: section.id, parts: [
          { id: `split-${crypto.randomUUID()}`, title: data.get('firstTitle'), objective: data.get('firstObjective'), memberIds: members.filter(member => data.get(`member:${member.id}`) === 'first').map(member => member.id) },
          { id: `split-${crypto.randomUUID()}`, title: data.get('secondTitle'), objective: data.get('secondObjective'), memberIds: members.filter(member => data.get(`member:${member.id}`) === 'second').map(member => member.id) },
        ] });
      }
    });
    const form = document.querySelector('#project-dialog-form'), select = form.querySelector('[name=operation]');
    select.onchange = () => { for (const fieldset of form.querySelectorAll('[data-operation]')) fieldset.hidden = fieldset.dataset.operation !== select.value; };
    select.onchange();
  }
  async selectMapBranch(id) {
    await this.perform(async () => {
      this.editMode = false; this.draftOperations = []; this.draftNotes = '';
      this.historicalProject = id === this.project.activeBranchId ? null : await (await this.api(`/api/projects/${this.project.id}?branch=${encodeURIComponent(id)}`)).json();
      this.focusId = this.project.id; this.selectedId = this.project.id; this.expanded.clear(); this.renderMap();
    });
  }
  async rerunDialog() {
    await this.perform(async () => {
      const preview = await (await this.api(`/api/projects/${this.project.id}/rerun/preview`, { sectionId: this.selectedId })).json();
      const repair = preview.strategy === 'review_repair';
      this.dialog(repair ? 'Review a selective rerun repair' : 'Approve rerun and affected dependents', `<p>${repair ? 'Unrelated sections were executed between these checkpoints. The workspace will not be restored. The model will inspect current code and propose a minimal repair plan for your approval.' : 'The captured code changes below will be reversed to the pre-section baseline. The agent will then rerun the selected work and every affected dependent on a preserved conversation branch.'}</p><h4>Selected sections</h4><p>${escape(preview.sectionIds.join(', '))}</p><h4>Affected dependent sections</h4><p>${escape(preview.downstreamIds.join(', ') || 'None')}</p>${repair ? `<p>Unrelated sections to preserve: ${escape(preview.interleavedSectionIds.join(', '))}</p>` : ''}<h4>Captured workspace changes</h4>${preview.checkpointPreview.changes.map(filePreview).join('')}${!repair && preview.checkpointPreview.conflicts.length ? `<p class="error">Restore blocked by intervening edits: ${escape(preview.checkpointPreview.conflicts.join(', '))}</p>` : ''}<p class="muted">App data, .env credentials, Git internals and dependencies are excluded. File snapshots cannot reverse external side effects. Captured boundary changes may include manual edits made while the unit ran; inspect this scope before approving.</p>`, repair ? 'Request repair proposal' : 'Approve and rerun', async () => {
        const response = await (await this.api(`/api/projects/${this.project.id}/rerun/approve`, { sectionId: this.selectedId, revision: preview.revision, signature: preview.checkpointPreview.signature, strategy: preview.strategy, branchMode: this.getChat() ? 'current_chat' : 'new_chat', chatId: this.getChat()?.id })).json();
        this.historicalProject = null; this.project = response.project; this.focusId = this.project.id;
        this.onBranch(response.chat); this.render(); this.sendMessage(response.instruction);
      });
    });
  }
  async enterEditMode() {
    await this.perform(async () => {
      await this.api(`/api/projects/${this.project.id}/pause`, { immediate: true });
      this.editMode = true; this.draftOperations = this.project.draft?.operations || []; this.draftNotes = this.project.draft?.notes || '';
      if (this.persistDraft) await this.saveDraft();
      this.renderMap();
    });
  }
  async addDraftOperation(operation) {
    applySectionDraft(this.project, [...this.draftOperations, operation]);
    this.draftOperations.push(operation);
    if (this.persistDraft) await this.saveDraft();
    this.selectedId = this.project.id; this.renderMap();
  }
  saveDraft() {
    const id = this.project.id, input = { basePlanRevision: this.project.planRevision, operations: structuredClone(this.draftOperations), notes: this.draftNotes };
    this.draftQueue = this.draftQueue.catch(() => {}).then(async () => { const state = await (await this.api(`/api/projects/${id}/draft`, input)).json(); if (this.project.id === id) this.project = state; });
    return this.draftQueue;
  }
  async confirmDraft() {
    await this.perform(async () => {
      await this.saveDraft();
      await this.api(`/api/projects/${this.project.id}/draft/confirm`, {});
      this.editMode = false; await this.refresh();
      this.sendMessage('Review my confirmed plan edits. Inspect the actual implementation and dependencies, propose the smallest necessary changes, prefer reuse or reimporting over new code, and explain every affected section. Submit the revised plan with changeReview and stop for my approval. Do not change code yet.');
    });
  }
  async discardDraft() {
    await this.perform(async () => { await this.draftQueue; if (this.project.draft?.status === 'editing') await this.api(`/api/projects/${this.project.id}/draft/discard`, {}); this.editMode = false; this.draftOperations = []; this.draftNotes = ''; await this.refresh(); });
  }
  async action(path, input) { return this.perform(async () => { await this.api(`/api/projects/${this.project.id}/${path}`, input); await this.refresh(); }); }
  async perform(task) { try { return await task(); } catch (error) { this.notice(error.message); } }
}
