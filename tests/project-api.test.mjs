import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SingleAgentSession } from '../agent-session.mjs';
import { createSectionExtension } from '../section-extension.mjs';
process.env.NODE_ENV = 'test';
process.env.PI_TEST_DATA_DIR = await mkdtemp(join(tmpdir(), 'pi-project-api-data-'));
const { server, shutdown, dataDir } = await import('../server.mjs');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await shutdown(); await rm(dataDir, { recursive: true, force: true }); });
const definition = (id, parentId, kind) => ({ id, parentId, kind, category: 'implement', title: 'Create a function', objective: 'Provide hello()', requirementIds: ['R1'], dependsOn: [], inputs: [], outputs: ['hello.js'], acceptanceCriteria: ['Function works'], validation: ['Check the function'] });
test('project plan approval gates implementation, and actual work is attributed and checkpointed', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'pi-project-api-')); t.after(() => rm(workspace, { recursive: true, force: true }));
  const post = (path, data) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const project = await (await post('/api/projects', { title: 'Test project', workspace })).json();
  assert.equal(project.workspace, workspace);
  t.after(() => rm(join(dataDir, 'projects', project.id), { recursive: true, force: true }));
  const forbidden = await fetch(`${base}/api/projects`, { method: 'POST', headers: { Origin: 'https://example.com' }, body: '{}' }); assert.equal(forbidden.status, 403);
  const chat = await (await post('/api/chats', { projectId: project.id })).json();
  t.after(() => fetch(`${base}/api/chats/${chat.id}`, { method: 'DELETE' }));
  t.mock.method(SingleAgentSession.prototype, 'initialize', async function () {
    this.tools = new Map(); this.handlers = new Map();
    createSectionExtension(this.projectContext)({ registerTool: tool => this.tools.set(tool.name, tool), on: (name, handler) => this.handlers.set(name, handler), setActiveTools() {} });
  });
  t.mock.method(SingleAgentSession.prototype, 'subscribe', function (listener) { this.listener = listener; });
  let turn = 0;
  t.mock.method(SingleAgentSession.prototype, 'prompt', async function () {
    const ctx = { sessionManager: { getLeafId: () => 'before-unit' } };
    const execute = (name, args) => this.tools.get(name).execute(name, args, undefined, undefined, ctx);
    if (++turn === 1) {
      const blocked = await this.handlers.get('tool_call')({ toolName: 'write', toolCallId: 'unapproved', input: { path: 'hello.js' } });
      assert.equal(blocked.block, true);
      await execute('submit_plan', { reason: 'Initial plan', specification: { description: 'Build a function', requirements: [{ id: 'R1', text: 'Working function' }], acceptanceCriteria: ['Function works'] }, sections: [definition('S1', project.id, 'step')] });
    } else {
      await execute('declare_sections', { sections: [definition('W1', 'S1', 'work_unit')] });
      await execute('start_work_unit', { sectionId: 'W1' });
      assert.equal(await this.handlers.get('tool_call')({ toolName: 'write', toolCallId: 'owned-write', input: { path: 'hello.js' } }), undefined);
      await writeFile(join(workspace, 'hello.js'), 'export const hello = () => 1;');
      await this.handlers.get('tool_result')({ toolCallId: 'owned-write', content: [], isError: false });
      const validation = [{ criterion: 'Function works', met: true, evidence: 'Function inspected and checked' }];
      await execute('finish_work_unit', { status: 'completed', summary: 'Created hello()', validation });
      await execute('confirm_step', { sectionId: 'S1', validation });
      await execute('complete_project', { validation });
    }
  });
  const send = async text => { const response = await post(`/api/chats/${chat.id}/message`, { text }); assert.equal(response.status, 200); return response.text(); };
  const initial = await send('Create hello.js'); assert.match(initial, /"type":"project"/);
  await assert.rejects(readFile(join(workspace, 'hello.js')), { code: 'ENOENT' });
  const planned = await (await fetch(`${base}/api/projects/${project.id}`)).json(); assert.equal(planned.approvedPlanRevision, 0);
  assert.equal((await post(`/api/projects/${project.id}/approve`, { planRevision: 99 })).status, 409);
  assert.equal((await post(`/api/projects/${project.id}/approve`, { planRevision: 1 })).status, 200);
  await send('Implement the approved plan');
  const complete = await (await fetch(`${base}/api/projects/${project.id}`)).json();
  assert.equal(complete.status, 'completed'); assert.equal(complete.attempts[0].actions[0].id, 'owned-write');
  assert.equal(complete.sections.find(section => section.id === 'S1').displayStatus, 'completed');
  assert.equal(await readFile(join(workspace, 'hello.js'), 'utf8'), 'export const hello = () => 1;');
  const impact = await (await fetch(`${base}/api/projects/${project.id}/impact/W1`)).json();
  assert.equal(impact.checkpointPreview.changes[0].path, 'hello.js');
});
