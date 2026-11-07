const ProjectUI = class { constructor() { this.selectedProjectId = null; } syncChat() {} render() {} initialize() {} onEvent() {} };
import { relationshipEligible, renderRelationshipGraph, renderRelationshipDetails } from '../public/relationship-graph.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

for (const [includeReasoning, includeTools] of [[true, true], [false, true], [false, false]]) test(`streams, reloads, and deletes a chat (reasoning=${includeReasoning}, tools=${includeTools})`, async () => {
  const elements = new Map();
  const element = () => ({
    value: '', style: {}, dataset: {}, innerHTML: '', textContent: '', children: [], attributes: {},
    scrollHeight: 40, classList: { add() {}, contains() { return false; } },
    setAttribute(name, value) { this.attributes[name] = value; },
    replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); }, focus() {},
  });
  const openCards = includeTools ? [{ dataset: { id: 'tool-1' } }] : [];
  const document = {
    documentElement: element(), body: element(), addEventListener() {},
    createElement: element,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    querySelectorAll(selector) { return selector === '#messages details[open]' ? openCards : []; },
  };
  const calls = [];
  let failDelete = true;
  let storedChats = [];
  const fetch = async (path, options) => {
    calls.push({ path, options });
    if (path === '/api/chats/chat-1' && options.method === 'DELETE') {
      if (failDelete) { failDelete = false; return Response.json({ error: 'Could not delete chat.' }, { status: 500 }); }
      return Response.json({ ok: true });
    }
    if (path === '/api/status') return Response.json({ model: 'test-model', provider: 'test', workspaceFound: true });
    if (path === '/api/chats' && !options.method) return Response.json(storedChats);
    const chat = { id: 'chat-1', title: 'Hello', updatedAt: 1, messages: [] };
    if (path === '/api/chats') return Response.json(chat);
    assert.equal(path, '/api/chats/chat-1/message');
    assert.deepEqual(JSON.parse(options.body), { text: 'Hello <pi>' });
    const user = { id: 'user-1', role: 'user', text: 'Hello <pi>' };
    const assistant = { id: 'assistant-1', role: 'assistant', text: '', tools: [] };
    const reasoning = includeReasoning ? ['**Inspect** <script>unsafe</script>', 'Verify the result'] : [];
    const tools = includeTools ? [{ id: 'tool-1', name: 'read', status: 'done' }, { id: 'tool-2', name: 'write', status: 'done' }, { id: 'tool-3', name: 'bash', status: 'error' }] : [];
    const groups = includeReasoning ? [{ text: reasoning[0], toolCallIds: ['tool-1', 'tool-2'] }, { text: reasoning[1], toolCallIds: ['tool-3'] }] : (includeTools ? [{ text: null, toolCallIds: ['tool-1', 'tool-2', 'tool-3'] }] : []);
    const finalChat = { ...chat, messages: [user, { ...assistant, reasoning, reasoningGroups: groups, text: 'Hello back!', tools }] };
    storedChats = [finalChat];
    const frames = [
      { type: 'started', chat: { ...chat, messages: [user, assistant] }, messageId: assistant.id },
      { type: 'reasoning', steps: reasoning.slice(0, 1), groups: groups.slice(0, 1) },
      { type: 'reasoning', steps: reasoning, groups },
      { type: 'delta', delta: 'Hello back!' },
      ...tools.map(tool => ({ type: 'tool', tool })),
      { type: 'done', chat: finalChat },
    ];
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.close();
    } }));
  };
  const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('document', 'fetch', 'localStorage', 'innerWidth', 'relationshipEligible', 'renderRelationshipGraph', 'renderRelationshipDetails', 'ProjectUI', source)(document, fetch, { getItem() { return null; } }, 1000, relationshipEligible, renderRelationshipGraph, renderRelationshipDetails, ProjectUI);
  assert.equal(document.querySelector('#notice').textContent, '');
  assert.equal(document.querySelector('#welcome').hidden, false);
  const renders = [];
  let html = '';
  Object.defineProperty(document.querySelector('#messages'), 'innerHTML', {
    get: () => html, set: value => { html = value; renders.push(value); },
  });
  document.querySelector('#prompt').value = 'Hello <pi>';
  await document.querySelector('#composer').onsubmit({ preventDefault() {} });
  assert.equal(calls.filter(call => call.path.endsWith('/message')).length, 1);
  const rendered = document.querySelector('#messages').innerHTML;
  assert.match(rendered, /Hello &lt;pi&gt;/);
  assert.match(rendered, /Hello back!/);
  if (includeTools) {
    assert.match(rendered, /data-id="tool-1" open/);
    assert.match(rendered, /data-id="tool-2"><summary>/, 'new tool cards default to collapsed');
    assert.ok(rendered.indexOf('data-id="tool-3"') < rendered.lastIndexOf('response-text'), 'all tool cards appear inside reasoning above the answer');
  }
  assert.equal(document.querySelector('#notice').textContent, '');
  assert.equal(document.querySelector('#prompt').disabled, false);
  assert.equal(document.querySelector('#stop').hidden, true);
  if (includeReasoning) {
    assert.ok(renders.some(value => /reasoning-card[^>]* open/.test(value)), 'reasoning opens during streaming');
    assert.doesNotMatch(rendered, /reasoning-card[^>]* open/, 'reasoning collapses on completion');
    assert.match(rendered, /Model reasoning/);
    assert.match(rendered, /Step 1/);
    assert.match(rendered, /Step 2/);
    assert.match(rendered, /<strong>Inspect<\/strong> &lt;script&gt;unsafe&lt;\/script&gt;/);
    assert.ok(rendered.indexOf('reasoning-card') < rendered.indexOf('Hello back!'));
    assert.ok(rendered.indexOf('data-id="tool-1"') < rendered.indexOf('Step 2'));
    assert.ok(rendered.indexOf('data-id="tool-2"') < rendered.indexOf('Step 2'));
    assert.ok(rendered.indexOf('data-id="tool-3"') > rendered.indexOf('Step 2'));
    assert.doesNotMatch(rendered, /SPECULATED REASONING/);
  } else if (includeTools) {
    assert.match(rendered, /\[SPECULATED REASONING\]/);
    assert.match(rendered, /Inspect the requested file/);
    assert.equal(JSON.stringify(storedChats).includes('SPECULATED REASONING'), false);
  } else assert.doesNotMatch(rendered, /Model reasoning/);
  await new AsyncFunction('document', 'fetch', 'localStorage', 'innerWidth', 'relationshipEligible', 'renderRelationshipGraph', 'renderRelationshipDetails', 'ProjectUI', source)(document, fetch, { getItem() { return null; } }, 1000, relationshipEligible, renderRelationshipGraph, renderRelationshipDetails, ProjectUI);
  document.querySelector('#history').children[0].children[0].onclick();
  if (includeReasoning) assert.match(document.querySelector('#messages').innerHTML, /Verify the result/);
  else if (includeTools) assert.match(document.querySelector('#messages').innerHTML, /SPECULATED REASONING/);
  else assert.doesNotMatch(document.querySelector('#messages').innerHTML, /Model reasoning/);
  assert.doesNotMatch(document.querySelector('#messages').innerHTML, /reasoning-card[^>]* open/);
  let remove = document.querySelector('#history').children[0].children[1];
  assert.equal(remove.attributes['aria-label'], 'Delete chat: Hello');
  await remove.onclick();
  assert.equal(document.querySelector('#notice').textContent, 'Could not delete chat.');
  assert.match(document.querySelector('#messages').innerHTML, /Hello back!/);
  remove = document.querySelector('#history').children[0].children[1];
  await remove.onclick();
  assert.equal(document.querySelector('#notice').textContent, '');
  assert.equal(document.querySelector('#welcome').hidden, false);
  assert.equal(document.querySelector('#messages').innerHTML, '');
  assert.equal(document.querySelector('#history').children[0].className, 'history-empty');
  assert.equal(calls.filter(call => call.options.method === 'DELETE').length, 2);

});
