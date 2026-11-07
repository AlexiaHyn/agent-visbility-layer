import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename, appendFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ProjectService } from './project-service.mjs';
import { handleProjectAPI } from './project-api.mjs';
import { PROJECT_TOOLS } from './section-extension.mjs';
import { SingleAgentSession } from './agent-session.mjs';
import { backfillReasoning, createReasoningCollector } from './reasoning.mjs';
import { analysisEligible, RelationshipAnalysisService } from './relationship-analysis.mjs';

const root = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(root, '.env'))) process.loadEnvFile?.(join(root, '.env'));
const workspace = root;
export const dataDir = process.env.NODE_ENV === 'test' && process.env.PI_TEST_DATA_DIR ? resolve(process.env.PI_TEST_DATA_DIR) : join(root, 'data');
await mkdir(join(dataDir, 'sessions'), { recursive: true });
const storePath = join(dataDir, 'chats.json');
const chats = existsSync(storePath) ? JSON.parse(await readFile(storePath, 'utf8')) : [];
const active = new Map();
const deleting = new Set();
export const projects = new ProjectService(dataDir);
await projects.initialize();
let writeQueue = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(chats, null, 2);
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    await writeFile(`${storePath}.tmp`, snapshot);
    await rename(`${storePath}.tmp`, storePath);
  });
  return writeQueue;
}
export const relationshipAnalysis = new RelationshipAnalysisService({ save,
  isPresent: (chat, message) => chats.includes(chat) && chat.messages.includes(message) && !deleting.has(chat.id),
});
const recoveredAnalysis = relationshipAnalysis.recover(chats);
if (await backfillReasoning(chats, join(dataDir, 'sessions')) || recoveredAnalysis) await save();

const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); return true; };
async function body(req, limit = 65536) {
  let input = '';
  for await (const chunk of req) { input += chunk; if (Buffer.byteLength(input) > limit) throw new Error('Message is too large.'); }
  return JSON.parse(input || '{}');
}
async function chatTurn(chat, text, req, res) {
  if (deleting.has(chat.id)) return json(res, 409, { error: 'This chat is being deleted.' });
  if (active.has(chat.id)) return json(res, 409, { error: 'This chat is already responding.' });
  const project = chat.projectId ? await projects.store.get(chat.projectId) : null;
  const runWorkspace = project?.workspace || workspace;
  const releaseWorkspace = await projects.acquireWorkspace(runWorkspace, chat.id);
  try { if (project && !project.request) await projects.event(project.id, 'request_set', { request: text }); }
  catch (error) { releaseWorkspace(); throw error; }
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const agent = new SingleAgentSession({
    workspace: runWorkspace, sessionDir: join(dataDir, 'sessions'), sessionFile: chat.sessionFile, resumeEntryId: chat.resumeEntryId, forkFrom: chat.forkFrom,
    projectContext: project ? { service: projects, projectId: project.id, chatId: chat.id,
      onProject: state => send('project', { projectId: state.id, revision: state.revision }),
      onActionOwner: (id, owner) => owners.set(id, owner),
    } : undefined,
  });
  const owners = new Map();
  const state = { agent, finished, projectId: project?.id };
  active.set(chat.id, state);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (type, value = {}) => { if (!res.destroyed) res.write(`data: ${JSON.stringify({ type, ...value })}\n\n`); };
  const cancel = () => { void agent.cancel().catch(console.error); };
  res.on('close', cancel);
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
  let assistant;
  try {
    await agent.initialize();
    if (agent.cancelled) return;
    chat.sessionFile = agent.sessionFile;
    if (chat.forkFrom) { chat.branchHistory ||= []; chat.branchHistory.push({ ...chat.forkFrom, createdAt: Date.now() }); }
    delete chat.resumeEntryId; delete chat.forkFrom;
    chat.messages.push({ id: randomUUID(), role: 'user', text });
    if (chat.title === 'New chat') chat.title = text.slice(0, 60);
    assistant = { id: randomUUID(), role: 'assistant', text: '', reasoning: [], reasoningGroups: [], tools: [], ...(project ? { projectId: project.id } : {}) };
    chat.messages.push(assistant);
    chat.updatedAt = Date.now();
    await save();
    send('started', { chat, messageId: assistant.id });
    const collectReasoning = createReasoningCollector((steps, groups) => {
      assistant.reasoning = steps;
      assistant.reasoningGroups = groups;
      send('reasoning', { steps, groups });
    });
    agent.subscribe(event => {
      collectReasoning(event);
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        const delta = event.assistantMessageEvent.delta;
        assistant.text += delta;
        send('delta', { delta });
      }
      if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
        const tool = { ...(owners.get(event.toolCallId) || {}), control: PROJECT_TOOLS.includes(event.toolName), id: event.toolCallId, name: event.toolName, status: event.type === 'tool_execution_start' ? 'running' : event.isError ? 'error' : 'done', input: event.args, result: event.result };
        const existing = assistant.tools.find(item => item.id === tool.id);
        if (existing) Object.assign(existing, { status: tool.status, result: tool.result });
        else assistant.tools.push(tool);
        send('tool', { tool });
        void appendFile(join(dataDir, 'tools.jsonl'), JSON.stringify({ chatId: chat.id, recordedAt: Date.now(), event }) + '\n').catch(console.error);
      }
    });
    await agent.prompt(text);
    assistant.stopped = agent.cancelled;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const last = chat.messages.at(-1);
    if (last?.role === 'assistant') last.error = message;
    send('error', { error: message });
  } finally {
    clearInterval(heartbeat);
    res.off('close', cancel);
    if (project) {
      try { await projects.finishTurn(project.id, agent.getSessionEntryId()); }
      catch (error) { if (assistant) assistant.error = assistant.error || error.message; }
    }
    agent.dispose();
    active.delete(chat.id);
    releaseWorkspace();
    chat.updatedAt = Date.now();
    const response = assistant;
    if (response) {
      response.finishedAt = Date.now();
      if (analysisEligible(response) && !deleting.has(chat.id)) {
        try { await relationshipAnalysis.request(chat, response); }
        catch (error) { response.relationshipAnalysis = { status: 'error', error: error.message }; }
      }
    }
    try {
      await save();
      send('done', { chat });
      res.end();
    } finally { finish(); }
  }
}
const files = { '/split-pane.js': ['split-pane.js', 'text/javascript'], '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/relationship-graph.js': ['relationship-graph.js', 'text/javascript'], '/project-ui.js': ['project-ui.js', 'text/javascript'], '/section-map.js': ['section-map.js', 'text/javascript'], '/section-draft.js': ['section-draft.js', 'text/javascript'] };
export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const host = req.headers.host;
    if (!host || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return json(res, 403, { error: 'Local access only.' });
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: 'Origin not allowed.' });
    if (url.pathname.startsWith('/api/projects')) {
      if (await handleProjectAPI(req, res, { url, json, body, service: projects, chats, saveChats: save, active, defaultWorkspace: workspace })) return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { provider: process.env.PI_PROVIDER || 'openai-codex', model: process.env.PI_MODEL || 'gpt-6.1-terra', workspaceFound: existsSync(workspace), cwd: workspace });
    if (url.pathname === '/api/chats' && req.method === 'GET') return json(res, 200, chats.map(({ sessionFile, ...chat }) => chat));
    if (url.pathname === '/api/chats' && req.method === 'POST') {
      const input = await body(req);
      if (input.projectId) await projects.store.get(input.projectId);
      const chat = { id: randomUUID(), title: 'New chat', updatedAt: Date.now(), messages: [], ...(input.projectId ? { projectId: input.projectId } : {}) };
      if (input.projectId) await projects.event(input.projectId, 'chat_attached', { chatId: chat.id });
      chats.unshift(chat); await save(); return json(res, 201, chat);
    }
    const analysisMatch = url.pathname.match(/^\/api\/chats\/([\w-]+)\/messages\/([\w-]+)\/relationships$/);
    if (analysisMatch && ['GET', 'POST'].includes(req.method)) {
      const chat = chats.find(item => item.id === analysisMatch[1]);
      const message = chat?.messages.find(item => item.id === analysisMatch[2] && item.role === 'assistant');
      if (!message) return json(res, 404, { error: 'Response not found.' });
      if (req.method === 'POST') {
        if (deleting.has(chat.id) || (active.has(chat.id) && chat.messages.at(-1) === message)) return json(res, 409, { error: 'This response is still running or being deleted.' });
        if (!analysisEligible(message)) return json(res, 422, { error: 'Analysis requires at least 8 tool calls and 3 provider-supplied reasoning steps.' });
        const input = await body(req);
        await relationshipAnalysis.request(chat, message, { retry: input.retry === true });
      }
      return json(res, 200, { eligible: analysisEligible(message), analysis: message.relationshipAnalysis || null });
    }
    const deletion = url.pathname.match(/^\/api\/chats\/([\w-]+)$/);
    if (deletion && req.method === 'DELETE') {
      const chat = chats.find(item => item.id === deletion[1]);
      if (!chat) return json(res, 404, { error: 'Chat not found.' });
      if (deleting.has(chat.id)) return json(res, 409, { error: 'This chat is being deleted.' });
      deleting.add(chat.id);
      relationshipAnalysis.cancelChat(chat);
      try {
        const state = active.get(chat.id);
        if (state) { await state.agent.cancel(); await state.finished; }
        // Remove only native session files inside this application's session directory.
        if (!chat.projectId && chat.sessionFile && dirname(resolve(chat.sessionFile)) === resolve(dataDir, 'sessions')) {
          await rm(chat.sessionFile, { force: true });
        }
        chats.splice(chats.indexOf(chat), 1);
        await save();
        return json(res, 200, { ok: true });
      } finally { deleting.delete(chat.id); }
    }
    const match = url.pathname.match(/^\/api\/chats\/([\w-]+)\/(message|stop)$/);
    if (match && req.method === 'POST') {
      const chat = chats.find(item => item.id === match[1]);
      if (!chat) return json(res, 404, { error: 'Chat not found.' });
      const input = await body(req);
      if (match[2] === 'message') {
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000) return json(res, 400, { error: 'Enter a message of 1–16,000 characters.' });
        return await chatTurn(chat, input.text.trim(), req, res);
      }
      const state = active.get(chat.id);
      if (match[2] === 'stop') { await state?.agent.cancel(); return json(res, 200, { ok: true }); }
    }
    if (req.method === 'GET' && files[url.pathname]) {
      const [file, type] = files[url.pathname];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
      return res.end(await readFile(join(root, 'public', file)));
    }
    json(res, 404, { error: 'Not found.' });
  } catch (error) { if (!res.headersSent) json(res, error.status || 500, { error: error.message, issues: error.issues }); else res.end(); }
});
let shutdownPromise;
export function shutdown() {
  return shutdownPromise ||= (async () => {
    console.log('Stopping Pi Chat...');
    const deadline = setTimeout(() => {
      console.error('Shutdown timed out; forcing exit.');
      server.closeAllConnections();
      process.exit(1);
    }, 5000);
    deadline.unref();
    try {
      const closed = new Promise((resolve, reject) => server.close(error => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      }));
      // Attach immediately so close errors cannot become unhandled rejections.
      const closing = Promise.all([closed, (async () => {
        const pending = [...active.values()];
        await Promise.allSettled(pending.map(state => state.agent.cancel()));
        await Promise.all(pending.map(state => state.finished));
        await relationshipAnalysis.close();
        await projects.close();
        await writeQueue;
        server.closeAllConnections();
      })()]);
      await closing;
      console.log('Pi Chat stopped.');
    } finally { clearTimeout(deadline); }
  })();
}
if (process.env.NODE_ENV !== 'test') {
  const stop = () => { void shutdown().then(() => process.exit(0), error => {
    console.error('Shutdown failed:', error);
    process.exit(1);
  }); };
  for (const signal of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) process.on(signal, stop);
  process.on('message', message => { if (message?.type === 'shutdown') stop(); });
  // Also clean up if the launcher itself disappears.
  if (process.connected) process.on('disconnect', stop);
  server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log(`Pi Chat: http://localhost:${process.env.PORT || 3000}`));
}

