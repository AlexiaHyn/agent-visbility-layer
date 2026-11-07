export const STEP_KINDS = ['understand', 'decide', 'implement', 'integrate', 'validate', 'deliver'];
export class SectionError extends Error {
  constructor(message, status = 400, issues = []) { super(message); this.name = 'SectionError'; this.status = status; this.issues = issues; }
}
export function assert(condition, message, status = 400) { if (!condition) throw new SectionError(message, status); }
export function validId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id); }
export function nonempty(value) { return typeof value === 'string' && !!value.trim(); }
function strings(value) { return Array.isArray(value) && value.every(nonempty); }
export function validatePlan(plan, projectId) {
  const issues = [];
  const need = (condition, message) => { if (!condition) issues.push(message); };
  need(nonempty(plan?.specification?.description), 'Specification needs a project description.');
  const requirements = plan?.specification?.requirements;
  need(Array.isArray(requirements) && requirements.length > 0, 'Specify at least one requirement.');
  const reqIds = new Set();
  for (const item of Array.isArray(requirements) ? requirements : []) {
    need(validId(item?.id) && nonempty(item?.text), 'Requirements need valid IDs and text.');
    need(!reqIds.has(item?.id), `Duplicate requirement: ${item?.id}`); reqIds.add(item?.id);
  }
  need(strings(plan?.specification?.acceptanceCriteria) && plan.specification.acceptanceCriteria.length > 0, 'Specify project acceptance criteria.');
  const sections = Array.isArray(plan?.sections) ? plan.sections.filter(section => section && typeof section === 'object' && !Array.isArray(section)) : [];
  need(sections.length === plan?.sections?.length, 'Sections must be objects.');
  need(sections.some(section => section.kind === 'step'), 'The plan needs at least one implementation step.');
  const ids = new Set();
  for (const section of sections) {
    need(validId(section.id) && section.id !== projectId, `Invalid section ID: ${section.id}`);
    need(!ids.has(section.id), `Duplicate section: ${section.id}`); ids.add(section.id);
    need(['step', 'subsection', 'work_unit'].includes(section.kind), `Invalid section kind: ${section.id}`);
    need(nonempty(section.title) && nonempty(section.objective), `${section.id}: title and objective are required.`);
    need(STEP_KINDS.includes(section.category), `${section.id}: use a supported step category.`);
    for (const field of ['inputs', 'outputs', 'acceptanceCriteria', 'validation', 'dependsOn', 'requirementIds']) {
      need(Array.isArray(section[field]) && section[field].every(value => nonempty(value)), `${section.id}: ${field} must be an array of strings.`);
    }
    need(section.outputs?.length > 0 && section.acceptanceCriteria?.length > 0 && section.validation?.length > 0,
      `${section.id}: outputs, acceptance criteria, and a validation method are required.`);
  }
  const byId = new Map(sections.map(section => [section.id, section]));
  const covered = new Set();
  for (const section of sections) {
    if (section.kind === 'step') need(section.parentId === projectId, `${section.id}: steps belong directly to the project.`);
    else {
      const parent = byId.get(section.parentId);
      need(parent && ['step', 'subsection'].includes(parent.kind), `${section.id}: parent must be a step or subsection.`);
    }
    for (const id of Array.isArray(section.requirementIds) ? section.requirementIds : []) { need(reqIds.has(id), `${section.id}: unknown requirement ${id}.`); covered.add(id); }
    for (const id of Array.isArray(section.dependsOn) ? section.dependsOn : []) need(ids.has(id) && id !== section.id, `${section.id}: invalid dependency ${id}.`);
  }
  for (const id of reqIds) need(covered.has(id), `Requirement ${id} is not addressed by the plan.`);
  function detectCycles(neighbors, description) {
    const visited = new Set(), active = new Set();
    function walk(id) {
      if (active.has(id)) { issues.push(`${description} cycle involving ${id}.`); return; }
      if (visited.has(id)) return;
      active.add(id);
      for (const next of neighbors(byId.get(id)) || []) if (byId.has(next)) walk(next);
      active.delete(id); visited.add(id);
    }
    sections.forEach(section => walk(section.id));
  }
  detectCycles(section => [section?.parentId], 'Hierarchy');
  detectCycles(section => section?.dependsOn, 'Dependency');
  detectCycles(section => {
    if (!section) return [];
    const required = [...(Array.isArray(section.dependsOn) ? section.dependsOn : [])];
    const seen = new Set(); let parent = byId.get(section.parentId);
    while (parent && !seen.has(parent.id)) { seen.add(parent.id); if (Array.isArray(parent.dependsOn)) required.push(...parent.dependsOn); parent = byId.get(parent.parentId); }
    if (section.kind !== 'work_unit') required.push(...sections.filter(item => item.parentId === section.id).map(item => item.id));
    return [...new Set(required)];
  }, 'Execution');
  if (issues.length) throw new SectionError('The implementation plan is invalid.', 422, [...new Set(issues)]);
  const fields = ['id', 'parentId', 'kind', 'category', 'title', 'objective', 'instructions', 'requirementIds', 'dependsOn', 'inputs', 'outputs', 'acceptanceCriteria', 'validation'];
  return { specification: structuredClone({ description: plan.specification.description, requirements: plan.specification.requirements.map(item => ({ id: item.id, text: item.text })), acceptanceCriteria: plan.specification.acceptanceCriteria, assumptions: plan.specification.assumptions || [], exclusions: plan.specification.exclusions || [] }),
    sections: sections.map(section => Object.fromEntries(fields.filter(key => section[key] !== undefined).map(key => [key, structuredClone(section[key])]))) }; 
}
export function descendants(project, id) {
  const result = new Set([id]);
  let changed = true;
  while (changed) { changed = false; for (const section of project.sections) if (!section.removed && result.has(section.parentId) && !result.has(section.id)) { result.add(section.id); changed = true; } }
  return result;
}
export function latestAttempt(project, sectionId) { return project.attempts.filter(attempt => attempt.sectionId === sectionId).at(-1); }
export function sectionStatus(project, id) {
  const section = project.sections.find(section => section.id === id);
  if (!section || section.removed) return 'removed';
  if (section.kind === 'work_unit') {
    if (section.stale) return 'stale';
    return latestAttempt(project, id)?.status || 'planned';
  }
  const children = project.sections.filter(child => child.parentId === id && !child.removed);
  const statuses = children.map(child => sectionStatus(project, child.id));
  if (statuses.includes('active')) return 'active';
  if (statuses.includes('stale') || section.stale) return 'stale';
  if (statuses.includes('failed') || statuses.includes('interrupted') || statuses.includes('needs_attention')) return 'needs_attention';
  if (children.length && statuses.every(status => status === 'completed')) return section.confirmation ? 'completed' : 'validating';
  if (!children.length && section.confirmation) return 'completed';
  return 'planned';
}
export function impactOf(project, id) {
  assert(project.sections.some(section => section.id === id && !section.removed) || id === project.id, 'Section not found.', 404);
  const affected = descendants(project, id), downstream = new Set(), validationAncestors = new Set();
  const changed = new Set(affected);
  const addParents = ids => {
    for (const member of ids) {
      let section = project.sections.find(item => item.id === member); const seen = new Set();
      while (section && section.parentId !== project.id && !seen.has(section.parentId)) {
        seen.add(section.parentId); validationAncestors.add(section.parentId); changed.add(section.parentId);
        section = project.sections.find(item => item.id === section.parentId && !item.removed);
      }
      if (section?.parentId === project.id) { changed.add(section.id); if (!affected.has(section.id) && !downstream.has(section.id)) validationAncestors.add(section.id); }
    }
  };
  addParents(affected);
  let more = true;
  while (more) {
    more = false;
    for (const section of project.sections) if (!section.removed && !affected.has(section.id) && !downstream.has(section.id) &&
      (section.dependsOn.some(dep => changed.has(dep)) || (project.dependencies || []).some(edge => edge.to === section.id && changed.has(edge.from)))) {
      const added = descendants(project, section.id); added.forEach(child => { if (!affected.has(child)) downstream.add(child); changed.add(child); });
      addParents(added); more = true;
    }
  }
  return { sectionIds: [...affected], downstreamIds: [...downstream], validationAncestorIds: [...validationAncestors],
    toolCallIds: project.attempts.filter(attempt => affected.has(attempt.sectionId)).flatMap(attempt => attempt.actions.map(action => action.id)) };
}
