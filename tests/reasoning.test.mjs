import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reasoningGroups, reasoningSteps, createReasoningCollector, restoreReasoning, backfillReasoning } from '../reasoning.mjs';

const assistant = (...blocks) => ({ role: 'assistant', content: blocks });
const think = text => ({ type: 'thinking', thinking: text, thinkingSignature: 'secret-signature' });
const user = text => ({ role: 'user', content: [{ type: 'text', text }] });

test('only readable reasoning is extracted, excluding signatures and redacted content', () => {
  assert.deepEqual(reasoningSteps(assistant(think('Inspect files'), think(' '),
    { ...think('hidden'), redacted: true }, { type: 'text', text: 'Answer' })), ['Inspect files']);
});

test('streamed blocks become numbered steps across model calls without duplicating final snapshots', () => {
  let steps = [];
  const collect = createReasoningCollector(value => { steps = value; });
  collect({ type: 'message_start', message: assistant() });
  collect({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0,
    delta: 'Inspect', partial: assistant(think('Inspect')) } });
  assert.deepEqual(steps, ['Inspect']);
  collect({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0,
    content: 'Inspect files', partial: assistant(think('Inspect files')) } });
  collect({ type: 'message_end', message: assistant(think('Inspect files')) });
  collect({ type: 'message_start', message: assistant() });
  collect({ type: 'message_end', message: assistant(think('Implement'), think('Test')) });
  assert.deepEqual(steps, ['Inspect files', 'Implement', 'Test']);
  assert.equal(JSON.stringify(steps).includes('secret-signature'), false);
});

test('partial readable reasoning survives an interrupted message with no final content', () => {
  let steps = [];
  const collect = createReasoningCollector(value => { steps = value; });
  collect({ type: 'message_start', message: assistant() });
  collect({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0,
    delta: 'Partial', partial: assistant(think('Partial')) } });
  collect({ type: 'message_end', message: { ...assistant(), stopReason: 'aborted' } });
  assert.deepEqual(steps, ['Partial']);
});

test('a final redacted block replaces any previously streamed readable content', () => {
  let steps = [];
  const collect = createReasoningCollector(value => { steps = value; });
  collect({ type: 'message_start', message: assistant() });
  collect({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0,
    partial: assistant(think('Transient')) } });
  collect({ type: 'message_end', message: assistant({ ...think('hidden'), redacted: true }) });
  assert.deepEqual(steps, []);
});

test('historical import follows the active branch and matches repeated user turns in order', () => {
  const entries = [
    { type: 'message', id: 'u1', parentId: null, message: user('Same prompt') },
    { type: 'message', id: 'a1', parentId: 'u1', message: assistant(think('First step')) },
    { type: 'message', id: 'a2', parentId: 'a1', message: assistant(think('Second step')) },
    { type: 'message', id: 'u2', parentId: 'a2', message: user('Same prompt') },
    { type: 'message', id: 'old', parentId: 'u2', message: assistant(think('Abandoned branch')) },
    { type: 'message', id: 'new', parentId: 'u2', message: assistant(think('Current branch')) },
  ];
  const chat = { messages: [
    { role: 'user', text: 'Same prompt' }, { role: 'assistant' },
    { role: 'user', text: 'Same prompt' }, { role: 'assistant' },
    { role: 'user', text: 'Not recorded' }, { role: 'assistant' },
  ] };
  assert.equal(restoreReasoning(chat, entries), true);
  assert.deepEqual(chat.messages[1].reasoning, ['First step', 'Second step']);
  assert.deepEqual(chat.messages[3].reasoning, ['Current branch']);
  assert.equal(chat.messages[5].reasoning, undefined);
  assert.equal(restoreReasoning(chat, entries), false);
});

test('backfill reads Windows session paths, tolerates partial final lines, and never changes native files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-reasoning-'));
  try {
    const content = [
      { type: 'message', id: 'u', parentId: null, message: user('Hello') },
      { type: 'message', id: 'a', parentId: 'u', message: assistant(think('Check the project')) },
    ].map(value => JSON.stringify(value)).join('\n') + '\n{"incomplete"';
    await writeFile(join(dir, 'native.jsonl'), content);
    const chats = [{ sessionFile: 'C:\\old\\data\\sessions\\native.jsonl', messages: [{ role: 'user', text: 'Hello' }, { role: 'assistant' }] },
      { sessionFile: 'missing.jsonl', messages: [{ role: 'assistant' }] }];
    assert.equal(await backfillReasoning(chats, dir), true);
    assert.deepEqual(chats[0].messages[1].reasoning, ['Check the project']);
    assert.equal(await readFile(join(dir, 'native.jsonl'), 'utf8'), content);
    assert.equal(await backfillReasoning(chats, dir), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const call = id => ({ type: 'toolCall', id, name: 'read', arguments: { path: 'README.md' } });
test('several tool calls share their nearest preceding reasoning in the same message', () => {
  assert.deepEqual(reasoningGroups(assistant(call('before'), think('Inspect'), call('one'), call('two'),
    think('Verify'), call('three'))), [
    { text: null, toolCallIds: ['before'] },
    { text: 'Inspect', toolCallIds: ['one', 'two'] },
    { text: 'Verify', toolCallIds: ['three'] },
  ]);
});

test('live tool associations never borrow reasoning from an earlier model call', () => {
  let groups;
  const collect = createReasoningCollector((steps, value) => { groups = value; });
  collect({ type: 'message_start', message: assistant() });
  collect({ type: 'message_end', message: assistant(think('Read files'), call('one')) });
  collect({ type: 'message_start', message: assistant() });
  collect({ type: 'message_end', message: assistant(call('two'), call('three')) });
  assert.deepEqual(groups, [
    { text: 'Read files', toolCallIds: ['one'] },
    { text: null, toolCallIds: ['two', 'three'] },
  ]);
  assert.equal(JSON.stringify(groups).includes('SPECULATED'), false);
});

test('saved chats with existing reasoning are upgraded with native tool associations', () => {
  const chat = { messages: [{ role: 'user', text: 'Hello' }, { role: 'assistant', reasoning: ['Inspect'], tools: [{ id: 'one' }] }] };
  const entries = [
    { type: 'message', id: 'u', parentId: null, message: user('Hello') },
    { type: 'message', id: 'a', parentId: 'u', message: assistant(think('Inspect'), call('one'), call('two')) },
    { type: 'message', id: 'b', parentId: 'a', message: assistant(call('three')) },
  ];
  assert.equal(restoreReasoning(chat, entries), true);
  assert.deepEqual(chat.messages[1].reasoningGroups, [
    { text: 'Inspect', toolCallIds: ['one', 'two'] },
    { text: null, toolCallIds: ['three'] },
  ]);
  assert.equal(restoreReasoning(chat, entries), false);
  assert.equal(JSON.stringify(chat).includes('SPECULATED'), false);
});
