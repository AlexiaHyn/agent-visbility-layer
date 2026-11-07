const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function relationshipEligible(message) {
  return message?.role === 'assistant' && new Set((message.tools || []).filter(tool => !tool.control).map(tool => tool.id)).size >= 8 &&
    (message.reasoning || []).filter(text => typeof text === 'string' && text.trim()).length >= 3;
}

// Condense strongly connected components, then rank the resulting dependency DAG.
// Cycles remain visible within a rank instead of breaking layout or inventing links.
export function layoutGraph(tools, relations) {
  const ids = [...new Set(tools.map(tool => tool.id))], known = new Set(ids);
  const next = new Map(ids.map(id => [id, []]));
  for (const edge of relations) if (known.has(edge.from) && known.has(edge.to)) next.get(edge.from).push(edge.to);
  let index = 0;
  const indices = new Map(), low = new Map(), stack = [], onStack = new Set(), components = [];
  function visit(id) {
    indices.set(id, index); low.set(id, index++); stack.push(id); onStack.add(id);
    for (const target of next.get(id)) {
      if (!indices.has(target)) { visit(target); low.set(id, Math.min(low.get(id), low.get(target))); }
      else if (onStack.has(target)) low.set(id, Math.min(low.get(id), indices.get(target)));
    }
    if (low.get(id) === indices.get(id)) {
      const component = []; let member;
      do { member = stack.pop(); onStack.delete(member); component.push(member); } while (member !== id);
      components.push(component);
    }
  }
  ids.forEach(id => { if (!indices.has(id)) visit(id); });
  const owner = new Map(); components.forEach((members, i) => members.forEach(id => owner.set(id, i)));
  const outgoing = components.map(() => new Set()), degree = components.map(() => 0), rank = components.map(() => 0);
  for (const edge of relations) {
    const from = owner.get(edge.from), to = owner.get(edge.to);
    if (from === undefined || to === undefined || from === to || outgoing[from].has(to)) continue;
    outgoing[from].add(to); degree[to]++;
  }
  const queue = degree.flatMap((value, i) => value === 0 ? [i] : []);
  for (let i = 0; i < queue.length; i++) for (const target of outgoing[queue[i]]) {
    rank[target] = Math.max(rank[target], rank[queue[i]] + 1);
    if (--degree[target] === 0) queue.push(target);
  }
  const rows = new Map(), positions = new Map();
  for (const id of ids) {
    const column = rank[owner.get(id)], row = rows.get(column) || 0;
    positions.set(id, { x: 35 + column * 265, y: 40 + row * 120 }); rows.set(column, row + 1);
  }
  return { positions, width: Math.max(360, 265 * (Math.max(0, ...rank) + 1) + 50),
    height: Math.max(180, 120 * Math.max(1, ...rows.values()) + 60) };
}

export function renderRelationshipGraph(message, selected) {
  const tools = (message.tools || []).filter(tool => !tool.control), relations = message.relationshipAnalysis?.relations || [];
  const { positions, width, height } = layoutGraph(tools, relations);
  const marker = `arrow-${String(message.id).replace(/[^a-z0-9-]/gi, '-')}`;
  const edges = relations.map((edge, index) => {
    const from = positions.get(edge.from), to = positions.get(edge.to);
    if (!from || !to) return '';
    const x1 = from.x + 170, y1 = from.y + 31, x2 = to.x, y2 = to.y + 31;
    const bend = Math.max(45, Math.abs(x2 - x1) / 2);
    const path = `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
    return `<g class="relationship-edge${selected?.kind === 'edge' && selected.index === index ? ' selected' : ''}" role="button" tabindex="0" data-edge-index="${index}" aria-label="${escape(edge.type)}: ${escape(edge.explanation)}"><path class="edge-hit" d="${path}"/><path class="edge-line" d="${path}" marker-end="url(#${marker})"/><text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 8}" text-anchor="middle">${escape(edge.type.slice(0, 28))}</text></g>`;
  }).join('');
  const nodes = tools.map((tool, index) => {
    const { x, y } = positions.get(tool.id);
    const hint = tool.input?.path || tool.input?.command || tool.id;
    return `<g class="relationship-node${selected?.kind === 'node' && selected.id === tool.id ? ' selected' : ''}" role="button" tabindex="0" data-node-id="${escape(tool.id)}" aria-label="Tool ${index + 1}: ${escape(tool.name)}, ${escape(tool.status)}" transform="translate(${x},${y})"><rect width="170" height="65" rx="8"/><text x="10" y="21">${index + 1}. ${escape(tool.name)} · ${escape(tool.status)}</text><text class="node-hint" x="10" y="45">${escape(String(hint).slice(0, 24))}</text></g>`;
  }).join('');
  return `${relations.length ? '' : '<p class="muted">No supported relationships were found. Tool calls are shown without inferred links.</p>'}<p class="muted">Links are model-inferred. Select a tool or arrow for details.</p><div class="relationship-viewport"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Inferred tool-call relationships"><defs><marker id="${marker}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z"/></marker></defs>${edges}${nodes}</svg></div>`;
}

export function renderRelationshipDetails(message, selected) {
  if (selected?.kind === 'node') {
    const tool = message.tools.find(tool => tool.id === selected.id);
    if (tool) return `<strong>${escape(tool.name)} · ${escape(tool.status)}</strong><pre>${escape(JSON.stringify({ id: tool.id, input: tool.input, result: tool.result }, null, 2))}</pre>`;
  } else if (selected?.kind === 'edge') {
    const edge = message.relationshipAnalysis?.relations?.[selected.index];
    if (edge) return `<strong>${escape(edge.type)} · confidence ${Math.round(edge.confidence * 100)}%</strong><p>${escape(edge.explanation)}</p><small>${escape(edge.from)} → ${escape(edge.to)}</small>`;
  }
  return '';
}
