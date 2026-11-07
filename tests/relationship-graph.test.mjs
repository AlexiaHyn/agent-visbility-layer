import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, renderRelationshipGraph, renderRelationshipDetails } from '../public/relationship-graph.js';
const tools = ['a', 'b', 'c', 'd'].map(id => ({ id, name: 'read', status: 'done', input: { path: '<script>.txt' } }));
const edge = (from, to) => ({ from, to, type: 'dependency', explanation: 'Uses <script>output</script>', confidence: 0.9 });
test('layout follows inferred dependencies instead of execution order', () => {
  const { positions } = layoutGraph(tools, [edge('c', 'a'), edge('a', 'b')]);
  assert.ok(positions.get('c').x < positions.get('a').x);
  assert.ok(positions.get('a').x < positions.get('b').x);
  assert.equal(positions.size, 4);
});
test('cycles and disconnected nodes have finite distinct positions', () => {
  const { positions, width, height } = layoutGraph(tools, [edge('a', 'b'), edge('b', 'a')]);
  assert.equal(new Set([...positions.values()].map(value => `${value.x},${value.y}`)).size, 4);
  assert.ok(Number.isFinite(width) && Number.isFinite(height));
});
test('graph and selected details are keyboard-accessible and escape trace/model text', () => {
  const message = { id: 'message', tools, relationshipAnalysis: { relations: [edge('a', 'b')] } };
  const graph = renderRelationshipGraph(message);
  assert.match(graph, /tabindex="0"/); assert.match(graph, /data-node-id="a"/); assert.match(graph, /data-edge-index="0"/);
  assert.doesNotMatch(graph, /<script>/);
  assert.match(renderRelationshipDetails(message, { kind: 'node', id: 'a' }), /&lt;script&gt;/);
  assert.match(renderRelationshipDetails(message, { kind: 'edge', index: 0 }), /90%/);
  assert.match(renderRelationshipDetails(message, { kind: 'edge', index: 0 }), /&lt;script&gt;/);
});
test('an empty relation result still shows every tool node', () => {
  const html = renderRelationshipGraph({ id: 'message', tools, relationshipAnalysis: { relations: [] } });
  assert.match(html, /No supported relationships/);
  assert.equal((html.match(/data-node-id=/g) || []).length, tools.length);
});
