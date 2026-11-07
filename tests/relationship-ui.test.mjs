const ProjectUI = class { constructor() { this.selectedProjectId = null; } syncChat() {} render() {} initialize() {} onEvent() {} };
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { relationshipEligible, renderRelationshipGraph, renderRelationshipDetails } from '../public/relationship-graph.js';
const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
for (const firstStatus of ['running', 'error']) test(`historical response automatically analyzes and ${firstStatus === 'error' ? 'offers retry' : 'polls without blocking chat'}`, async () => {
  const elements = new Map(), timers = [], calls = [];
  const element = () => ({ value: '', style: {}, dataset: {}, innerHTML: '', textContent: '', children: [], attributes: {}, isConnected: true,
    scrollHeight: 40, classList: { add() {}, contains() { return false; } },
    setAttribute(name, value) { this.attributes[name] = value; }, replaceChildren() { this.children = []; },
    append(...children) { this.children.push(...children); }, focus() {} });
  const retry = element(), card = element(); card.dataset.messageId = 'answer';
  card.querySelectorAll = () => [];
  card.querySelector = selector => selector === '.retry-analysis' && elements.get('#messages')?.innerHTML.includes('retry-analysis') ? retry : null;
  const document = { documentElement: element(), body: element(), addEventListener() {}, createElement: element,
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); },
    querySelectorAll(selector) { return selector === '.relationship-card' && elements.get('#messages')?.innerHTML.includes('relationship-card') ? [card] : []; } };
  const message = { id: 'answer', role: 'assistant', text: 'Completed answer', reasoning: ['Inspect', 'Implement', 'Verify'],
    tools: Array.from({ length: 8 }, (_, i) => ({ id: `tool-${i}`, name: 'read', status: 'done' })) };
  const chat = { id: 'chat', title: 'Project', messages: [message] };
  const ready = { status: 'ready', relations: [{ from: 'tool-0', to: 'tool-1', type: 'dependency', explanation: 'Uses output', confidence: 0.8 }] };
  let attempts = 0;
  const fetch = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/chats') return Response.json([chat]);
    if (path === '/api/status') return Response.json({ model: 'fake', workspaceFound: true });
    assert.equal(path, '/api/chats/chat/messages/answer/relationships');
    if (options.method === 'POST') {
      attempts++;
      if (attempts > 1) { assert.equal(JSON.parse(options.body).retry, true); return Response.json({ eligible: true, analysis: ready }); }
      return Response.json({ eligible: true, analysis: { status: firstStatus, error: firstStatus === 'error' ? 'Model unavailable' : undefined } });
    }
    return Response.json({ eligible: true, analysis: ready });
  };
  await new AsyncFunction('document', 'fetch', 'localStorage', 'innerWidth', 'relationshipEligible', 'renderRelationshipGraph', 'renderRelationshipDetails', 'ProjectUI', 'setTimeout', source)(
    document, fetch, { getItem() { return null; } }, 1000, relationshipEligible, renderRelationshipGraph, renderRelationshipDetails, ProjectUI, callback => { timers.push(callback); });
  document.querySelector('#history').children[0].children[0].onclick();
  await new Promise(setImmediate);
  assert.equal(attempts, 1);
  assert.equal(document.querySelector('#prompt').disabled, undefined);
  assert.match(document.querySelector('#messages').innerHTML, /Completed answer/);
  if (firstStatus === 'error') {
    assert.match(document.querySelector('#messages').innerHTML, /Retry analysis/);
    await retry.onclick();
    assert.equal(attempts, 2);
  } else {
    assert.match(document.querySelector('#messages').innerHTML, /Analyzing/);
    await timers.shift()();
  }
  const html = document.querySelector('#messages').innerHTML;
  assert.match(html, /relationship-card[^>]* open/);
  assert.match(html, /data-node-id="tool-0"/);
  assert.match(html, /data-edge-index="0"/);
  assert.ok(html.indexOf('relationship-card') < html.indexOf('response-text'));
  assert.equal(calls.filter(call => call.options.method === 'POST').length, attempts);
});
