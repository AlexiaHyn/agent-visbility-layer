import { createSectionExtension, PLANNING_TOOLS, IMPLEMENTATION_TOOLS } from './section-extension.mjs';
import { existsSync } from 'node:fs';
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';

let runtimePromise;
export function getModelRuntime() {
  return runtimePromise ||= ModelRuntime.create().catch(error => {
    runtimePromise = undefined;
    throw error;
  });
}

export function createSessionManager({ workspace, sessionDir, sessionFile, forkFrom }) {
  if (forkFrom) {
    const manager = SessionManager.open(forkFrom.sessionFile, sessionDir, workspace);
    manager.createBranchedSession(forkFrom.entryId);
    return manager;
  }
  return sessionFile && existsSync(sessionFile) ? SessionManager.open(sessionFile, sessionDir, workspace) : SessionManager.create(workspace, sessionDir);
}

// One agent turn, with its own session, subscription, and cancellation state.
// The HTTP server owns chat records and decides how to deliver these events.
export class SingleAgentSession {
  constructor({ workspace, sessionDir, sessionFile, projectContext, resumeEntryId, forkFrom }) {
    this.workspace = workspace;
    this.projectContext = projectContext;
    this.resumeEntryId = resumeEntryId; this.forkFrom = forkFrom;
    this.sessionDir = sessionDir;
    this.sessionFile = sessionFile;
    this.session = null;
    this.cancelled = false;
    this.unsubscribe = null;
  }

  async initialize() {
    const { workspace } = this;
    if (!existsSync(workspace)) throw new Error(`Cannot find the agent working directory: ${workspace}`);
    const modelRuntime = await getModelRuntime();
    const provider = process.env.PI_PROVIDER || 'openai-codex';
    const modelId = process.env.PI_MODEL || 'gpt-6.1-terra';
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Model ${provider}/${modelId} was not found in pi's catalog.`);
    const loader = new DefaultResourceLoader({
      cwd: workspace, agentDir: getAgentDir(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: this.projectContext ? [createSectionExtension(this.projectContext)] : [],
    });
    await loader.reload();
    if (this.cancelled) return;
    const manager = createSessionManager({ workspace, sessionDir: this.sessionDir, sessionFile: this.sessionFile, forkFrom: this.forkFrom });
    const project = this.projectContext ? await this.projectContext.service.store.get(this.projectContext.projectId) : null;
    const tools = project ? (project.draft?.status !== 'reviewing' && project.planRevision > 0 && project.approvedPlanRevision === project.planRevision ? IMPLEMENTATION_TOOLS : PLANNING_TOOLS) : ['read', 'write', 'edit', 'bash'];
    const { session } = await createAgentSession({ modelRuntime, model, thinkingLevel: 'low', cwd: workspace, tools, resourceLoader: loader, sessionManager: manager });
    this.session = session;
    this.sessionFile = manager.getSessionFile();
    await session.bindExtensions({});
    if (this.resumeEntryId) await session.navigateTree(this.resumeEntryId, { summarize: false });
    if (this.cancelled) await session.abort();
  }

  subscribe(listener) {
    this.unsubscribe?.();
    this.unsubscribe = this.session.subscribe(listener);
  }

  async prompt(text) {
    if (this.cancelled) return;
    await this.session.prompt(text);
    const last = this.session.messages.filter(message => message.role === 'assistant').at(-1);
    if (last?.errorMessage && last.stopReason === 'error') throw new Error(last.errorMessage);
  }

  async cancel() {
    this.cancelled = true;
    await this.session?.abort();
  }

  getSessionEntryId() { return this.session?.sessionManager.getLeafId() ?? null; }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session?.dispose();
    this.session = null;
  }
}
