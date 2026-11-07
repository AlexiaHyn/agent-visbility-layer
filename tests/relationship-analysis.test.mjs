import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysisEligible, analysisConfig, validateRelations, buildAnalysisInput, RelationshipAnalysisService } from '../relationship-analysis.mjs';
const response = () => ({ id: 'response', role: 'assistant', reasoning: ['Inspect', 'Implement', 'Verify'],
  tools: Array.from({ length: 8 }, (_, i) => ({ id: `call-${i}`, name: 'read', status: 'done', input: { path: `${i}.txt` }, result: { text: 'content' } })) });
const edge = () => ({ from: 'call-0', to: 'call-1', type: 'information_flow', explanation: 'The second call uses the first result.', confidence: 0.8 });
function setup(analyze, timeoutMs) {
  const message = response(), chat = { id: 'chat', messages: [message] };
  let present = true, saves = 0;
  const service = new RelationshipAnalysisService({ analyze, timeoutMs, save: async () => { saves++; }, isPresent: () => present });
  return { message, chat, service, remove: () => { present = false; }, saves: () => saves };
}
test('eligibility requires eight distinct calls and three real reasoning steps', () => {
  const message = response();
  assert.equal(analysisEligible(message), true);
  assert.equal(analysisEligible({ ...message, tools: message.tools.slice(0, 7) }), false);
  assert.equal(analysisEligible({ ...message, reasoning: ['one', 'two'] }), false);
  assert.equal(analysisEligible({ ...message, tools: Array(8).fill(message.tools[0]) }), false);
});
test('analysis model config inherits defaults and accepts overrides', () => {
  assert.deepEqual(analysisConfig({ PI_PROVIDER: 'coding', PI_MODEL: 'base' }), { provider: 'coding', model: 'base' });
  assert.deepEqual(analysisConfig({ PI_PROVIDER: 'coding', PI_MODEL: 'base', PI_ANALYSIS_PROVIDER: 'other', PI_ANALYSIS_MODEL: 'analyzer' }), { provider: 'other', model: 'analyzer' });
});
test('validation accepts explained custom relationships and rejects invented IDs, duplicates and invalid confidence', () => {
  const tools = response().tools;
  assert.equal(validateRelations({ relations: [{ ...edge(), type: 'refines' }] }, tools)[0].type, 'refines');
  for (const invalid of [{ ...edge(), to: 'missing' }, { ...edge(), to: 'call-0' }, { ...edge(), confidence: 2 }, { ...edge(), type: '<script>' }, { ...edge(), explanation: '' }]) {
    assert.throws(() => validateRelations({ relations: [invalid] }, tools));
  }
  assert.throws(() => validateRelations({ relations: [edge(), edge()] }, tools));
  assert.deepEqual(validateRelations({ relations: [] }, tools), []);
});
test('trace input contains only this response and bounded result excerpts', () => {
  const message = response(); message.tools[0].result = 'x'.repeat(200000); message.stopped = true;
  const input = buildAnalysisInput(message);
  assert.equal(input.incomplete, true); assert.equal(input.tools.length, 8);
  assert.equal(input.tools[0].result.truncated, true);
  assert.ok(JSON.stringify(input).length < 120000);
});
test('jobs deduplicate, return before analysis resolves, and persist validated results', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, chat, message, saves } = setup(async () => { calls++; await gate; return { relations: [edge()] }; });
  await service.request(chat, message);
  await service.request(chat, message);
  assert.equal(calls, 1); assert.equal(message.relationshipAnalysis.status, 'running');
  release(); await service.worker;
  assert.equal(message.relationshipAnalysis.status, 'ready'); assert.ok(saves() >= 3);
  await service.request(chat, message); assert.equal(calls, 1);
});
test('failure preserves the coding answer and needs explicit retry', async () => {
  let calls = 0;
  const { service, chat, message } = setup(async () => { if (++calls === 1) throw new Error('Provider unavailable'); return { relations: [] }; });
  message.text = 'Existing answer';
  await service.request(chat, message); await service.worker;
  assert.equal(message.relationshipAnalysis.status, 'error'); assert.equal(message.text, 'Existing answer');
  await service.request(chat, message); assert.equal(calls, 1);
  await service.request(chat, message, { retry: true }); await service.worker;
  assert.equal(calls, 2); assert.equal(message.relationshipAnalysis.status, 'ready');
});
test('analysis times out even when a provider ignores cancellation', async () => {
  const { service, chat, message } = setup(() => new Promise(() => {}), 15);
  await service.request(chat, message); await service.worker;
  assert.equal(message.relationshipAnalysis.status, 'error'); assert.match(message.relationshipAnalysis.error, /timed out/);
});
test('deletion cancels background work without writing back to a deleted chat', async () => {
  const { service, chat, message, remove, saves } = setup(() => new Promise(() => {}));
  await service.request(chat, message); const before = saves();
  remove(); service.cancelChat(chat); await service.worker;
  assert.equal(service.jobs.size, 0); assert.equal(saves(), before);
});
test('shutdown cancels queued jobs and restart recovery exposes Retry', async () => {
  const { service, chat, message } = setup(() => new Promise(() => {}));
  await service.request(chat, message); await service.close();
  assert.equal(message.relationshipAnalysis.status, 'error');
  message.relationshipAnalysis.status = 'running';
  assert.equal(service.recover([chat]), true); assert.equal(message.relationshipAnalysis.status, 'error');
});
