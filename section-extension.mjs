import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { applySectionDraft } from './public/section-draft.js';
import { assert } from './section-model.mjs';
const List = Type.Array(Type.String());
const Definition = Type.Object({ id: Type.String(), parentId: Type.String(), kind: Type.Union([Type.Literal('step'), Type.Literal('subsection'), Type.Literal('work_unit')]),
  category: Type.Union(['understand', 'decide', 'implement', 'integrate', 'validate', 'deliver'].map(value => Type.Literal(value))),
  title: Type.String(), objective: Type.String(), instructions: Type.Optional(Type.String()), requirementIds: List, dependsOn: List,
  inputs: List, outputs: List, acceptanceCriteria: List, validation: List });
const Evidence = Type.Array(Type.Object({ criterion: Type.String(), met: Type.Boolean(), evidence: Type.String() }));
export const PROJECT_TOOLS = ['submit_plan', 'declare_sections', 'start_work_unit', 'finish_work_unit', 'confirm_step', 'complete_project'];
export const PLANNING_TOOLS = ['read', 'ls', 'find', 'grep', ...PROJECT_TOOLS];
export const IMPLEMENTATION_TOOLS = ['read', 'ls', 'find', 'grep', 'write', 'edit', 'bash', ...PROJECT_TOOLS];
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], details: data });
const PROTOCOL = `You are implementing a project through a versioned, user-reviewable plan.

Before implementation, inspect using read-only tools and call submit_plan with the complete
specification and outcome-based top-level implementation steps. Use categories understand, decide,
implement, integrate, validate, deliver as appropriate; avoid gratuitous components. Every
requirement must be covered and every step must define outputs, acceptance criteria, dependencies,
and validation. The project ID is the parent of each top-level step.

Each planning step should do only one thing. If a step contains two separate tasks, split it into two
steps. For example, use "Add the Node.js server" and "Add leaderboard storage" as separate steps.
Likewise, keep "Add automated tests" and "Write running instructions" separate.
Choose the steps based on the user's request. Show how steps depend on each other when needed.
Follow this rule when creating or revising a plan, and show the same separate steps in the chat
summary.

After submit_plan, the user MUST approve the plan. Stop your response; do not implement or work
around the gate. Changes to top-level requirements or steps require resubmitting the plan and
renewed user approval.

Once approved, expand each ready step with declare_sections, creating meaningful work units before
changing files. Optional subsections group related capabilities. A work unit is a concrete outcome,
such as connecting a Quit button to stopGame(), not a tool operation. Work units require at least
ONE normal tool call; target at most FIVE, with larger coherent units allowed but flagged. State
coherent acceptance criteria. Every normal execution call must occur between start_work_unit and
finish_work_unit. Never batch unrelated capabilities into one huge script to avoid attribution.

Only one work unit is active. Dependencies must be completed first. Confirm every step/subsection
with confirm_step and evidence after its children finish. Purely informational
understand/decide/deliver steps can be confirmed without children. Implementation steps require work
units. Finish units with evidence for every acceptance criterion. Failed validation must be reported
as failed, not completed. Preserve earlier attempts; repairs occur as new attempts under the same
approved objective. If changes to the plan are needed, submit a revision for user approval.

Honor pause requests. Do not execute more tools after a paused boundary. Call complete_project only
after all planned steps and project acceptance criteria are satisfied. Tool results supply
authoritative current definitions; user edits take precedence over prior instructions. Provider
reasoning is not a substitute for a plan or validation evidence.`;
export function createSectionExtension({ service, projectId, chatId, onProject = () => {}, onActionOwner = () => {} }) {
  const owners = new Map();
  return pi => {
    const update = project => { onProject(project); return project; };
    pi.on('before_agent_start', async event => {
      const project = await service.store.get(projectId);
      const context = { ...project, planHistory: project.planHistory.map(plan => ({ revision: plan.revision, reason: plan.reason })), sectionRevisions: undefined, planningActions: undefined, checkpoints: undefined,
        attempts: project.attempts.map(attempt => ({ id: attempt.id, sectionId: attempt.sectionId, status: attempt.status, summary: attempt.summary, validation: attempt.validation, calls: attempt.actions.length })) };
      if (project.draft?.status === 'reviewing') {
        context.draftPreview = applySectionDraft(project, project.draft.operations);
        context.changeInstructions = 'The user confirmed draft changes, not implementation. Inspect the current code read-only. Propose the smallest necessary repair plan, prefer reuse and reimporting over new code, explain removed/changed/added sections and dependency rewiring, preserve manually created IDs, provide changeReview, then stop for approval. Add explicit checks that removed behavior and stale references are gone. Never edit implementation before this renewed approval.';
      }
      event.systemPromptOptions.sections.project_protocol = `${PROTOCOL}\nCURRENT PROJECT:\n${JSON.stringify(context)}`;
      pi.setActiveTools(project.draft?.status !== 'reviewing' && project.planRevision > 0 && project.approvedPlanRevision === project.planRevision ? IMPLEMENTATION_TOOLS : PLANNING_TOOLS);
    });
    pi.registerTool({ name: 'submit_plan', label: 'Submit implementation plan', description: 'Record or revise the complete project specification and implementation plan. Each top-level step must deliver exactly one distinct outcome; split independently implementable capabilities and separate testing from documentation. Requires user approval before coding.',
      parameters: Type.Object({ reason: Type.String(), specification: Type.Object({ description: Type.String(), requirements: Type.Array(Type.Object({ id: Type.String(), text: Type.String() })), acceptanceCriteria: List, assumptions: Type.Optional(List), exclusions: Type.Optional(List) }), sections: Type.Array(Definition), changeReview: Type.Optional(Type.Object({ summary: Type.String(), changes: Type.Array(Type.Object({ sectionId: Type.String(), operation: Type.String(), reason: Type.String(), reuseStrategy: Type.String() })), validation: List })) }), executionMode: 'sequential',
      async execute(id, params) {
        const project = update(await service.submitPlan(projectId, { specification: params.specification, sections: params.sections }, params.reason, params.changeReview));
        pi.setActiveTools(PLANNING_TOOLS);
        return result({ planRevision: project.planRevision, awaitingUserApproval: true, instruction: 'Explain the plan briefly and end this response. The user will approve or edit it in the UI.' });
      } });
    pi.registerTool({ name: 'declare_sections', label: 'Declare work sections', description: 'Expand an approved step into optional subsections and concrete work units. Adds detail without changing the approved top-level plan.',
      parameters: Type.Object({ sections: Type.Array(Definition) }), executionMode: 'sequential',
      async execute(id, params) { const project = update(await service.declareSections(projectId, params.sections)); return result({ planRevision: project.planRevision, sections: project.sections.filter(section => params.sections.some(item => item.id === section.id)) }); } });
    pi.registerTool({ name: 'start_work_unit', label: 'Start work unit', description: 'Start one ready work unit, recording its checkpoint and tool ownership. Returns its authoritative definition.',
      parameters: Type.Object({ sectionId: Type.String() }), executionMode: 'sequential',
      async execute(id, params, signal, onUpdate, ctx) {
        const triggering = ctx.sessionManager.getBranch?.().findLast(entry => entry.type === 'message' && entry.message?.role === 'assistant' && Array.isArray(entry.message.content) && entry.message.content.some(block => block.type === 'toolCall' && block.id === id));
        const entryId = triggering ? triggering.parentId : ctx.sessionManager.getLeafId();
        const project = update(await service.startUnit(projectId, params.sectionId, entryId, { chatId, sessionFile: ctx.sessionManager.getSessionFile?.() }));
        return result({ section: project.sections.find(section => section.id === params.sectionId), attempt: project.attempts.find(attempt => attempt.status === 'active') });
      } });
    pi.registerTool({ name: 'finish_work_unit', label: 'Finish work unit', description: 'Finish the active work unit with honest outcome and acceptance evidence. Zero-call work units cannot complete.',
      parameters: Type.Object({ status: Type.Union([Type.Literal('completed'), Type.Literal('failed')]), summary: Type.String(), validation: Evidence }), executionMode: 'sequential',
      async execute(id, params, signal, onUpdate, ctx) {
        const project = update(await service.finishUnit(projectId, params, ctx.sessionManager.getLeafId()));
        return result({ projectStatus: project.status, instruction: project.status === 'paused' ? 'The user requested a pause. Stop this response.' : 'Continue with the next ready work unit or step.' });
      } });
    pi.registerTool({ name: 'confirm_step', label: 'Validate section', description: 'Validate a step or subsection with evidence after all child work is complete. Informational steps can finish without code changes.',
      parameters: Type.Object({ sectionId: Type.String(), validation: Evidence }), executionMode: 'sequential',
      async execute(id, params) { const project = update(await service.event(projectId, 'step_confirmed', params)); return result({ section: project.sections.find(section => section.id === params.sectionId), projectStatus: project.status }); } });
    pi.registerTool({ name: 'complete_project', label: 'Complete project', description: 'Complete the project only after all steps and project acceptance criteria have passed.',
      parameters: Type.Object({ validation: Evidence }), executionMode: 'sequential',
      async execute(id, params) { const project = update(await service.event(projectId, 'project_completed', params)); return result({ status: project.status, validation: project.validation }); } });
    pi.on('tool_call', async event => {
      try {
        const project = await service.store.get(projectId);
        if (PROJECT_TOOLS.includes(event.toolName)) {
          if (event.toolName !== 'submit_plan') assert(project.draft?.status !== 'reviewing' && project.approvedPlanRevision === project.planRevision && project.planRevision > 0 && project.status !== 'paused', 'Wait for user approval or resume before implementing the plan.', 409);
          return;
        }
        assert(project.status !== 'paused', 'Project is paused. Wait for the user to continue.', 409);
        const approved = project.draft?.status !== 'reviewing' && project.planRevision > 0 && project.approvedPlanRevision === project.planRevision;
        if (!approved) {
          assert(['read', 'ls', 'find', 'grep'].includes(event.toolName), 'Implementation is blocked until the user approves the plan.', 409);
          await service.event(projectId, 'planning_action_started', { id: event.toolCallId, name: event.toolName, input: event.input });
          owners.set(event.toolCallId, { planning: true }); onActionOwner(event.toolCallId, { projectId, scope: 'planning' }); return;
        }
        const attempt = project.attempts.find(attempt => attempt.status === 'active');
        assert(attempt, 'Call start_work_unit before using implementation tools.', 409);
        await service.recordAction(projectId, attempt.id, event);
        const owner = { projectId, attemptId: attempt.id, sectionId: attempt.sectionId };
        owners.set(event.toolCallId, owner); onActionOwner(event.toolCallId, owner);
      } catch (error) { return { block: true, reason: error.message }; }
    });
    pi.on('tool_result', async event => {
      const owner = owners.get(event.toolCallId); if (!owner) return;
      const details = { toolCallId: event.toolCallId, isError: event.isError, result: { content: event.content, details: event.details } };
      if (owner.planning) update(await service.event(projectId, 'planning_action_finished', details));
      else update(await service.event(projectId, 'action_finished', { ...details, attemptId: owner.attemptId }));
      owners.delete(event.toolCallId);
    });
  };
}
