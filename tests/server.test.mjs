import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SingleAgentSession } from '../agent-session.mjs';
process.env.NODE_ENV = 'test';
process.env.PI_TEST_DATA_DIR = await mkdtemp(join(tmpdir(), 'pi-server-data-'));
const { server, shutdown, relationshipAnalysis, dataDir } = await import('../server.mjs');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await shutdown(); await rm(dataDir, { recursive: true, force: true }); });
test('serves the UI and reports the project working directory', async () => {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /What are we exploring today/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.model, process.env.PI_MODEL || 'gpt-6.1-terra');
  assert.equal(status.workspaceFound, true);
  assert.equal(status.cwd, fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, ''));
});
test('blocks writes originating from another site', async () => {
  const response = await fetch(`${base}/api/chats`, { method: 'POST', headers: { Origin: 'https://example.com' } });
  assert.equal(response.status, 403);
});
test('rejects unknown conversations', async () => {
  const response = await fetch(`${base}/api/chats/missing/stop`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 404);
});
test('deletes a chat from the API and saved history, preserving other chats', async () => {
  const before = await (await fetch(`${base}/api/chats`)).json();
  const chat = await (await fetch(`${base}/api/chats`, { method: 'POST' })).json();
  const path = `${base}/api/chats/${chat.id}`;
  const forbidden = await fetch(path, { method: 'DELETE', headers: { Origin: 'https://example.com' } });
  assert.equal(forbidden.status, 403);
  const deleted = await fetch(path, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
  const remaining = await (await fetch(`${base}/api/chats`)).json();
  assert.deepEqual(remaining, before);
  const saved = JSON.parse(await readFile(join(dataDir, 'chats.json'), 'utf8'));
  assert.equal(saved.some(item => item.id === chat.id), false);
  assert.equal((await fetch(path, { method: 'DELETE' })).status, 404);
});

test('streams and saves readable reasoning for completed, stopped, and failed turns', async t => {
  for (const outcome of ['completed', 'stopped', 'failed']) {
    await t.test(outcome, async t => {
      t.mock.method(SingleAgentSession.prototype, 'initialize', async function () {});
      t.mock.method(SingleAgentSession.prototype, 'subscribe', function (listener) { this.listener = listener; });
      t.mock.method(SingleAgentSession.prototype, 'prompt', async function () {
        this.listener({ type: 'message_start', message: { role: 'assistant', content: [] } });
        this.listener({ type: 'message_update', assistantMessageEvent: {
          type: 'thinking_delta', contentIndex: 0, delta: 'Inspect files',
          partial: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Inspect files', thinkingSignature: 'PRIVATE_PAYLOAD' }] },
        } });
        if (outcome === 'failed') throw new Error('Simulated provider error');
        if (outcome === 'stopped') this.cancelled = true;
        if (outcome === 'completed') {
          this.listener({ type: 'message_end', message: { role: 'assistant', content: [
            { type: 'thinking', thinking: 'Inspect files' },
            { type: 'toolCall', id: 'read-one', name: 'read', arguments: { path: 'README.md' } },
            { type: 'toolCall', id: 'read-two', name: 'read', arguments: { path: 'package.json' } },
          ] } });
          for (const id of ['read-one', 'read-two']) {
            this.listener({ type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: { path: 'README.md' } });
            this.listener({ type: 'tool_execution_end', toolCallId: id, toolName: 'read', result: { content: [{ type: 'text', text: 'File content' }] }, isError: false });
          }
        }

      });
      const chat = await (await fetch(`${base}/api/chats`, { method: 'POST' })).json();
      try {
        const response = await fetch(`${base}/api/chats/${chat.id}/message`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Reason about the project' }),
        });
        const stream = await response.text();
        assert.equal(stream.includes('PRIVATE_PAYLOAD'), false);
        const events = stream.split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)));
        assert.deepEqual(events.find(event => event.type === 'reasoning').steps, ['Inspect files']);
        const message = events.find(event => event.type === 'done').chat.messages.at(-1);
        assert.deepEqual(message.reasoning, ['Inspect files']);
        if (outcome === 'completed') {
          assert.deepEqual(message.reasoningGroups, [{ text: 'Inspect files', toolCallIds: ['read-one', 'read-two'] }]);
          assert.equal(message.tools.length, 2);
        }
        assert.equal(JSON.stringify(message).includes('SPECULATED REASONING'), false);
        if (outcome === 'failed') assert.equal(message.error, 'Simulated provider error');
        if (outcome === 'stopped') assert.equal(message.stopped, true);
        const saved = JSON.parse(await readFile(join(dataDir, 'chats.json'), 'utf8'));
        assert.deepEqual(saved.find(item => item.id === chat.id).messages.at(-1).reasoning, ['Inspect files']);
      } finally {
        await fetch(`${base}/api/chats/${chat.id}`, { method: 'DELETE' });
      }
    });
  }
});

test('eligible analysis runs in the background, persists, and can retry without blocking the next turn', async t => {
  let release, attempts = 0, turn = 0;
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(relationshipAnalysis, 'analyze', async () => {
    if (++attempts === 1) { await gate; throw new Error('Simulated analysis outage'); }
    return { relations: [{ from: 'graph-0', to: 'graph-1', type: 'verification', explanation: 'Checks the first result.', confidence: 0.8 }] };
  });
  t.mock.method(SingleAgentSession.prototype, 'initialize', async function () {});
  t.mock.method(SingleAgentSession.prototype, 'subscribe', function (listener) { this.listener = listener; });
  t.mock.method(SingleAgentSession.prototype, 'prompt', async function () {
    if (++turn > 1) return;
    const content = ['Inspect', 'Implement', 'Verify'].map(thinking => ({ type: 'thinking', thinking }));
    content.push(...Array.from({ length: 8 }, (_, i) => ({ type: 'toolCall', id: `graph-${i}`, name: 'read', arguments: { path: 'README.md' } })));
    this.listener({ type: 'message_end', message: { role: 'assistant', content } });
    for (let i = 0; i < 8; i++) {
      this.listener({ type: 'tool_execution_start', toolCallId: `graph-${i}`, toolName: 'read', args: { path: 'README.md' } });
      this.listener({ type: 'tool_execution_end', toolCallId: `graph-${i}`, toolName: 'read', result: { content: [] }, isError: false });
    }
  });
  const chat = await (await fetch(`${base}/api/chats`, { method: 'POST' })).json();
  const send = async text => {
    const response = await fetch(`${base}/api/chats/${chat.id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(3000) });
    const frames = (await response.text()).split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)));
    return frames.find(event => event.type === 'done').chat;
  };
  try {
    const first = await send('Complex implementation');
    const message = first.messages.at(-1);
    assert.ok(['pending', 'running'].includes(message.relationshipAnalysis.status));
    const second = await send('Next question while analysis runs');
    assert.equal(second.messages.length, 4);
    const endpoint = `${base}/api/chats/${chat.id}/messages/${message.id}/relationships`;
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://example.com' } })).status, 403);
    release(); await relationshipAnalysis.worker;
    assert.equal((await (await fetch(endpoint)).json()).analysis.status, 'error');
    assert.equal((await fetch(endpoint, { method: 'POST', body: JSON.stringify({ retry: true }) })).status, 200);
    await relationshipAnalysis.worker;
    const result = await (await fetch(endpoint)).json();
    assert.equal(result.analysis.status, 'ready'); assert.equal(result.analysis.relations.length, 1);
    assert.equal(attempts, 2);
    const saved = JSON.parse(await readFile(join(dataDir, 'chats.json'), 'utf8'));
    assert.equal(saved.find(item => item.id === chat.id).messages.find(item => item.id === message.id).relationshipAnalysis.status, 'ready');
    const ineligible = `${base}/api/chats/${chat.id}/messages/${second.messages.at(-1).id}/relationships`;
    assert.equal((await fetch(ineligible, { method: 'POST', body: '{}' })).status, 422);
  } finally {
    release(); await fetch(`${base}/api/chats/${chat.id}`, { method: 'DELETE' }); await relationshipAnalysis.worker;
  }
});

test('shutdown closes the listener and is safe to request repeatedly', async () => {
  const first = shutdown();
  assert.equal(shutdown(), first);
  await first;
  assert.equal(server.listening, false);
  await assert.rejects(fetch(`${base}/api/status`));
});
