const copy = value => structuredClone(value);
function need(value, message) { if (!value) throw new Error(message); }
function descendants(sections, id) {
  const ids = new Set([id]); let changed = true;
  while (changed) { changed = false; for (const item of sections) if (ids.has(item.parentId) && !ids.has(item.id)) { ids.add(item.id); changed = true; } }
  return ids;
}
const union = arrays => [...new Set(arrays.flat())];
export function applySectionDraft(project, operations = []) {
  let sections = copy(project.sections.filter(item => !item.removed));
  const overrides = { ...(project.assignmentOverrides || {}) }, removedIds = [];
  const actionsFor = id => project.attempts.flatMap(attempt => attempt.actions.filter(action => (overrides[action.id] || attempt.sectionId) === id));
  for (const operation of operations) {
    const selected = sections.find(item => item.id === operation.sectionId);
    need(selected, 'The selected section no longer exists. Refresh the draft.');
    if (operation.kind === 'edit') {
      for (const key of ['title', 'objective', 'instructions', 'outputs', 'acceptanceCriteria', 'validation']) if (operation.values?.[key] !== undefined) selected[key] = copy(operation.values[key]);
    } else if (operation.kind === 'move') {
      const invalid = descendants(sections, selected.id);
      if (selected.kind === 'step') need(operation.parentId === project.id, 'Top-level steps stay under the project.');
      else need(sections.some(item => item.id === operation.parentId && ['step', 'subsection'].includes(item.kind)), 'Choose a step or subsection as parent.');
      need(!invalid.has(operation.parentId), 'A section cannot move into its own subtree.');
      selected.parentId = operation.parentId;
    } else if (operation.kind === 'remove') {
      const ids = descendants(sections, selected.id); removedIds.push(...ids); sections = sections.filter(item => !ids.has(item.id));
    } else if (operation.kind === 'merge') {
      const sources = sections.filter(item => operation.sourceIds.includes(item.id));
      need(sources.length >= 2 && sources.length === new Set(operation.sourceIds).size, 'Choose at least two existing sections to merge.');
      need(sources.every(item => item.kind === selected.kind && item.parentId === selected.parentId), 'Merge sections of the same level under one parent.');
      need(!sections.some(item => item.id === operation.newId), 'Merged section ID is already used.');
      const merged = { ...copy(selected), id: operation.newId, title: operation.title, objective: operation.objective };
      for (const key of ['inputs', 'outputs', 'requirementIds', 'acceptanceCriteria', 'validation', 'dependsOn']) merged[key] = union(sources.map(item => item[key] || [])).filter(id => key !== 'dependsOn' || !operation.sourceIds.includes(id));
      for (const source of sources) for (const action of actionsFor(source.id)) overrides[action.id] = merged.id;
      sections = sections.filter(item => !operation.sourceIds.includes(item.id));
      for (const item of sections) {
        if (operation.sourceIds.includes(item.parentId)) item.parentId = merged.id;
        item.dependsOn = union(item.dependsOn.map(id => operation.sourceIds.includes(id) ? merged.id : id));
      }
      sections.push(merged); removedIds.push(...operation.sourceIds);
    } else if (operation.kind === 'split') {
      const parts = operation.parts;
      need(Array.isArray(parts) && parts.length >= 2 && new Set(parts.map(part => part.id)).size === parts.length, 'Define at least two distinct split sections.');
      need(parts.every(part => !sections.some(item => item.id === part.id)), 'Split section IDs must be new.');
      const members = selected.kind === 'work_unit' ? actionsFor(selected.id).map(action => action.id) : sections.filter(item => item.parentId === selected.id).map(item => item.id);
      if (selected.kind === 'work_unit' && members.length) need(parts.every(part => part.memberIds?.length > 0), 'Each split work unit needs at least one recorded call; individual calls cannot be split.');
      const assignments = parts.flatMap(part => part.memberIds || []);
      need(assignments.length === members.length && new Set(assignments).size === members.length && members.every(id => assignments.includes(id)), 'Assign every child section or recorded call to exactly one split section.');
      const replacements = parts.map(part => ({ ...copy(selected), id: part.id, title: part.title, objective: part.objective }));
      sections = sections.filter(item => item.id !== selected.id);
      for (const item of sections) {
        if (item.parentId === selected.id) item.parentId = parts.find(part => part.memberIds.includes(item.id)).id;
        item.dependsOn = union(item.dependsOn.flatMap(id => id === selected.id ? parts.map(part => part.id) : [id]));
      }
      if (selected.kind === 'work_unit') for (const part of parts) for (const id of part.memberIds) overrides[id] = part.id;
      sections.push(...replacements); removedIds.push(selected.id);
    } else throw new Error('Unknown draft operation.');
  }
  const live = new Set(sections.map(section => section.id));
  const warnings = sections.flatMap(section => section.dependsOn.filter(id => !live.has(id)).map(id => `${section.id} depends on removed section ${id}`));
  return { sections, warnings, assignmentOverrides: overrides, removedIds: [...new Set(removedIds)] };
}
