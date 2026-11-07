import { ProjectUI } from './project-ui.js';
import { relationshipEligible, renderRelationshipGraph, renderRelationshipDetails } from './relationship-graph.js';
const $ = selector => document.querySelector(selector);
let chats = [], currentId = null, busy = false, currentAssistant = null;
const reasoningVisibility = new Map();
const relationshipVisibility = new Map(), relationshipSelection = new Map(), analysisRequests = new Set(), analysisPolling = new Set();
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let theme = 'light';
try { theme = localStorage.getItem('pi-theme') || 'light'; } catch {}
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $('#theme span').textContent = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
}
applyTheme();
$('#theme').onclick = () => { theme = theme === 'light' ? 'dark' : 'light'; applyTheme(); try { localStorage.setItem('pi-theme', theme); } catch {} };
if (innerWidth <= 650) document.body.classList.add('sidebar-hidden');
function toggleMenu() { document.body.classList.toggle('sidebar-hidden'); $('#menu').setAttribute('aria-expanded', String(!document.body.classList.contains('sidebar-hidden'))); }
$('#menu').setAttribute('aria-expanded', String(innerWidth > 650));
$('#menu').onclick = toggleMenu;
const current = () => chats.find(chat => chat.id === currentId);
function notice(text = '') { $('#notice').hidden = !text; $('#notice').textContent = text; }
async function api(path, data, method) {
  const response = await fetch(path, data === undefined ? (method ? { method } : {}) : { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Request failed.'); }
  return response;
}
const projectUI = new ProjectUI({ api, getChat: current, isBusy: () => busy, onSelect: () => newChat(), notice,
  onBranch: chat => { const old = chats.find(item => item.id === chat.id); if (old) Object.assign(old, chat); else chats.unshift(chat); currentId = chat.id; render(); history(); },
  sendMessage: text => { if (!busy) { $('#prompt').value = text; resize(); $('#composer').requestSubmit(); } },
});
function history() {
  const query = $('#search').value.toLowerCase();
  const filtered = [...chats].sort((a, b) => b.updatedAt - a.updatedAt).filter(chat => chat.title.toLowerCase().includes(query));
  $('#history').replaceChildren();
  if (!filtered.length) { const item = document.createElement('div'); item.className = 'history-empty'; item.textContent = query ? 'No matching conversations.' : 'A little room for your next idea.\nStart a chat to see it here.'; $('#history').append(item); }
  for (const chat of filtered) {
    const button = document.createElement('button'); button.className = `history-item${chat.id === currentId ? ' selected' : ''}`; button.textContent = chat.title; button.title = chat.title;
    button.disabled = busy; button.onclick = () => { currentId = chat.id; notice(); render(); history(); if (innerWidth <= 650 && !document.body.classList.contains('sidebar-hidden')) toggleMenu(); };
    const row = document.createElement('div'); row.className = 'history-row';
    const remove = document.createElement('button'); remove.className = 'delete-chat';
    remove.title = 'Delete chat'; remove.setAttribute('aria-label', `Delete chat: ${chat.title}`);
    remove.innerHTML = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>';
    remove.disabled = busy; remove.onclick = () => deleteChat(chat.id);
    row.append(button, remove); $('#history').append(row);
  }
}
async function deleteChat(id) {
  if (busy) return;
  notice(); setBusy(true); $('#activity').textContent = 'Deleting chat…';
  try {
    await api(`/api/chats/${id}`, undefined, 'DELETE');
    chats = chats.filter(chat => chat.id !== id);
    if (currentId === id) {
      currentId = null; currentAssistant = null;
      $('#prompt').value = '';
    }
  } catch (error) { notice(error.message); }
  finally { setBusy(false); render(); resize(); }
}
// Escape all model output before applying a small, safe subset of Markdown.
function markdown(text) {
  return text.split(/(```[\s\S]*?```)/g).map(part => {
    if (part.startsWith('```')) { const code = part.slice(3, -3).replace(/^[\w+-]*\n/, ''); return `<pre><code>${escape(code)}</code></pre>`; }
    return escape(part).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  }).join('');
}
function openToolCards() {
  return new Set([...document.querySelectorAll('#messages details[open]')].map(item => item.dataset.id));
}
function toolCard(tool, previous) {
  return `<details class="tool-card nested-tool-card" data-id="${escape(tool.id)}"${previous.has(tool.id) ? ' open' : ''}><summary>${tool.status === 'running' ? '◌' : tool.status === 'error' ? '!' : '✓'} ${escape(tool.name)} · ${escape(tool.status)}</summary><pre>${escape(JSON.stringify({ input: tool.input, result: tool.result }, null, 2))}</pre></details>`;
}
// UI-only inference about the action's purpose. Never sent to the agent or saved.
function speculateToolPurpose(tool) {
  const path = tool.input?.path;
  const target = typeof path === 'string' && path ? ` ${path}` : ' the requested file';
  if (tool.name === 'read') return `Inspect${target} to gather information for the task.`;
  if (tool.name === 'write') return `Create or replace${target} with generated content.`;
  if (tool.name === 'edit') return `Modify selected content in${target}.`;
  if (tool.name === 'bash') return 'Run the requested shell command to perform or verify work.';
  return `Use the ${tool.name} tool to carry out the requested action.`;
}
function displayedReasoningGroups(message) {
  const tools = new Map((message.tools || []).filter(tool => !tool.control).map(tool => [tool.id, tool]));
  const placed = new Set();
  const source = Array.isArray(message.reasoningGroups) ? message.reasoningGroups :
    (message.reasoning || []).map(text => ({ text, toolCallIds: [] }));
  const groups = source.map(group => ({ text: group.text, tools: (group.toolCallIds || []).flatMap(id => {
    if (!tools.has(id) || placed.has(id)) return [];
    placed.add(id); return [tools.get(id)];
  }) }));
  // If a native message is unavailable, don't invent an association with real reasoning.
  for (const tool of tools.values()) if (!placed.has(tool.id)) groups.push({ text: null, tools: [tool] });
  return groups.filter(group => (typeof group.text === 'string' && group.text.trim()) || group.tools.length);
}
function reasoningBody(message, previous = openToolCards()) {
  return displayedReasoningGroups(message).map((group, index) => {
    const text = group.text ? markdown(group.text) : `<strong>[SPECULATED REASONING]</strong> ${escape(group.tools.map(speculateToolPurpose).join(' '))}`;
    return `<section class="reasoning-step"><div class="muted">Step ${index + 1}</div><div class="message-text reasoning-text">${text}</div>${group.tools.map(tool => toolCard(tool, previous)).join('')}</section>`;
  }).join('');
}
function reasoningCard(message, previous) {
  if (!displayedReasoningGroups(message).length) return '';
  const open = reasoningVisibility.get(message.id) ?? (busy && currentAssistant?.id === message.id);
  return `<details class="tool-card reasoning-card" data-message-id="${escape(message.id)}"${open ? ' open' : ''}><summary>Model reasoning</summary><div class="reasoning-body">${reasoningBody(message, previous)}</div></details>`;
}
function relationshipsCard(message) {
  if (!relationshipEligible(message)) return '';
  const analysis = message.relationshipAnalysis;
  const open = relationshipVisibility.get(message.id) ?? (analysis?.status === 'ready');
  const incomplete = analysis?.incomplete || message.stopped || message.error;
  let content = '<p class="muted">Analyzing tool relationships…</p>';
  if (analysis?.status === 'error') content = `<p class="error">${escape(analysis.error)}</p><button class="retry-analysis" data-message-id="${escape(message.id)}">Retry analysis</button>`;
  else if (analysis?.status === 'ready') content = renderRelationshipGraph(message, relationshipSelection.get(message.id)) + `<div class="relationship-details">${renderRelationshipDetails(message, relationshipSelection.get(message.id))}</div>`;
  return `<details class="tool-card relationship-card" data-message-id="${escape(message.id)}"${open ? ' open' : ''}><summary>Tool relationships${analysis?.status === 'pending' || analysis?.status === 'running' || !analysis ? ' · Analyzing…' : analysis.status === 'error' ? ' · Analysis failed' : ''}${incomplete ? ' · Incomplete response' : ''}</summary><div class="relationship-body">${content}</div></details>`;
}
function analysisPath(chat, message) { return `/api/chats/${chat.id}/messages/${message.id}/relationships`; }
function updateAnalysis(chat, message, analysis) {
  if (!chats.includes(chat) || !chat.messages.includes(message)) return;
  message.relationshipAnalysis = analysis;
  if (chat.id === currentId) render();
}
function pollAnalysis(chat, message) {
  const key = `${chat.id}:${message.id}`;
  if (analysisPolling.has(key)) return;
  analysisPolling.add(key);
  const poll = async () => {
    if (currentId !== chat.id || !chats.includes(chat)) { analysisPolling.delete(key); return; }
    try {
      const result = await (await api(analysisPath(chat, message))).json();
      updateAnalysis(chat, message, result.analysis);
      if (['pending', 'running'].includes(result.analysis?.status)) setTimeout(poll, 1000);
      else analysisPolling.delete(key);
    } catch (error) {
      analysisPolling.delete(key);
      updateAnalysis(chat, message, { status: 'error', error: error.message });
    }
  };
  setTimeout(poll, 1000);
}
async function requestAnalysis(chat, message, retry = false) {
  const key = `${chat.id}:${message.id}`;
  if (analysisRequests.has(key)) return;
  analysisRequests.add(key);
  message.relationshipAnalysis = { status: 'pending', incomplete: !!(message.stopped || message.error) };
  if (chat.id === currentId) render();
  try {
    const result = await (await api(analysisPath(chat, message), { retry })).json();
    updateAnalysis(chat, message, result.analysis);
    if (['pending', 'running'].includes(result.analysis?.status)) pollAnalysis(chat, message);
  } catch (error) { updateAnalysis(chat, message, { status: 'error', error: error.message }); }
  finally { analysisRequests.delete(key); }
}
function maintainAnalysis() {
  const chat = current();
  if (!chat) return;
  for (const message of chat.messages) {
    if (!relationshipEligible(message) || (busy && currentAssistant?.id === message.id) ||
      (busy && message === chat.messages.at(-1) && !message.finishedAt && !message.relationshipAnalysis)) continue;
    if (!message.relationshipAnalysis) void requestAnalysis(chat, message);
    else if (['pending', 'running'].includes(message.relationshipAnalysis.status)) pollAnalysis(chat, message);
  }
}
function bindRelationshipCards() {
  for (const card of document.querySelectorAll('.relationship-card')) {
    const message = current()?.messages.find(message => message.id === card.dataset.messageId);
    if (!message) continue;
    card.ontoggle = () => { if (card.isConnected) relationshipVisibility.set(message.id, card.open); };
    const select = selection => {
      relationshipSelection.set(message.id, selection);
      card.querySelector('.relationship-body').innerHTML = renderRelationshipGraph(message, selection) + `<div class="relationship-details">${renderRelationshipDetails(message, selection)}</div>`;
      bindRelationshipCards();
    };
    for (const node of card.querySelectorAll('[data-node-id]')) {
      node.onclick = () => select({ kind: 'node', id: node.dataset.nodeId });
      node.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); node.onclick(); } };
    }
    for (const edge of card.querySelectorAll('[data-edge-index]')) {
      edge.onclick = () => select({ kind: 'edge', index: Number(edge.dataset.edgeIndex) });
      edge.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); edge.onclick(); } };
    }
    const retry = card.querySelector('.retry-analysis');
    if (retry) retry.onclick = () => requestAnalysis(current(), message, true);
  }
}
function finishReasoning() {
  if (currentAssistant) reasoningVisibility.set(currentAssistant.id, false);
  currentAssistant = null;
}
function render() {
  projectUI.syncChat(current());
  projectUI.render();
  const messages = current()?.messages || [];
  $('#welcome').hidden = messages.length > 0;
  $('#messages').hidden = !messages.length;
  const previous = openToolCards();
  $('#messages').innerHTML = messages.map(message => `<article class="message ${message.role}" data-id="${escape(message.id)}">${message.role === 'assistant' ? '<div class="assistant-label"><span>π</span> Pi</div>' : ''}${message.role === 'assistant' ? reasoningCard(message, previous) : ''}${message.role === 'assistant' ? relationshipsCard(message) : ''}<div class="message-text response-text">${message.role === 'user' ? escape(message.text) : markdown(message.text)}</div>${message.error ? `<p class="error">${escape(message.error)}</p>` : ''}${message.stopped ? '<small class="muted">Response stopped</small>' : ''}${message.role === 'assistant' && message.text ? '<div class="message-actions"><button class="copy-button">Copy response</button></div>' : ''}</article>`).join('');
  for (const card of document.querySelectorAll('.reasoning-card')) card.ontoggle = () => {
    if (card.isConnected) reasoningVisibility.set(card.dataset.messageId, card.open);
  };
  bindRelationshipCards();
  maintainAnalysis();
  for (const button of document.querySelectorAll('.copy-button')) button.onclick = async () => {
    const message = messages.find(item => item.id === button.closest('article').dataset.id);
    try { await navigator.clipboard.writeText(message.text); button.textContent = 'Copied'; } catch { notice('Clipboard access was unavailable. You can select and copy the response.'); }
  };
}
function setBusy(value) {
  busy = value; $('#send').hidden = value; $('#stop').hidden = !value; $('#prompt').disabled = value; $('#new-chat').disabled = value;
  document.querySelectorAll('.suggestions button').forEach(button => { button.disabled = value; });
  $('#activity').textContent = value ? 'Pi is thinking…' : ''; history(); updateSend();
}
function updateSend() { $('#send').disabled = busy || !$('#prompt').value.trim(); }
function scrollDown() { const area = $('#scroll-area'); area.scrollTop = area.scrollHeight; }
async function newChat() { if (busy) return; currentId = null; notice(); render(); history(); $('#prompt').value = ''; resize(); $('#prompt').focus(); }
$('#new-chat').onclick = newChat;
$('#search').oninput = history;
function resize() { const input = $('#prompt'); input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; updateSend(); }
$('#prompt').oninput = resize;
$('#prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); } };
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); void newChat(); } });
for (const button of document.querySelectorAll('[data-prompt]')) button.onclick = () => { $('#prompt').value = button.dataset.prompt; resize(); $('#prompt').focus(); };
$('#stop').onclick = async () => { $('#stop').disabled = true; $('#activity').textContent = 'Stopping…'; try { await api(`/api/chats/${currentId}/stop`, {}); } catch (error) { notice(error.message); } finally { $('#stop').disabled = false; } };
function eventReceived(event) {
  const area = $('#scroll-area');
  // Follow response text only when the reader is already near the bottom.
  // Thinking, tool, and project updates must not pull the reader down.
  const followResponse = event.type === 'delta' &&
    area.scrollHeight - area.scrollTop - area.clientHeight <= 80;
  projectUI.onEvent(event);
  if (event.type === 'started') {
    Object.assign(current(), event.chat); currentAssistant = current().messages.find(message => message.id === event.messageId); render(); history();
  } else if (event.type === 'delta' && currentAssistant) {
    currentAssistant.text += event.delta;
    const node = [...document.querySelectorAll('.message')].find(item => item.dataset.id === currentAssistant.id)?.querySelector('.response-text');
    if (node) node.innerHTML = markdown(currentAssistant.text);
    $('#activity').textContent = 'Pi is responding…';
  } else if (event.type === 'reasoning' && currentAssistant) {
    currentAssistant.reasoning = event.steps;
    if (Array.isArray(event.groups)) currentAssistant.reasoningGroups = event.groups;
    const card = [...document.querySelectorAll('.reasoning-card')].find(item => item.dataset.messageId === currentAssistant.id);
    if (card && displayedReasoningGroups(currentAssistant).length) card.querySelector('.reasoning-body').innerHTML = reasoningBody(currentAssistant);
    else render();
    $('#activity').textContent = 'Pi is thinking…';
  } else if (event.type === 'tool' && currentAssistant) {
    const existing = currentAssistant.tools.find(item => item.id === event.tool.id);
    if (existing) Object.assign(existing, event.tool); else currentAssistant.tools.push(event.tool);
    render(); $('#activity').textContent = event.tool.status === 'running' ? `Using ${event.tool.name}…` : 'Pi is thinking…';
  }  else if (event.type === 'error') notice(event.error);
  else if (event.type === 'done') { Object.assign(current(), event.chat); finishReasoning(); render(); history(); }
  if (followResponse) scrollDown();
}
$('#composer').onsubmit = async event => {
  event.preventDefault(); const text = $('#prompt').value.trim(); if (!text || busy) return;
  notice(); setBusy(true); let started = false;
  try {
    if (!currentId) { const chat = await (await api('/api/chats', projectUI.selectedProjectId ? { projectId: projectUI.selectedProjectId } : {})).json(); chats.unshift(chat); currentId = chat.id; }
    current().messages.push({ id: 'pending', role: 'user', text }); render(); scrollDown();
    $('#prompt').value = ''; resize();
    const response = await api(`/api/chats/${currentId}/message`, { text });
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', completed = false;
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (!frame.startsWith('data: ')) continue;
        const item = JSON.parse(frame.slice(6)); if (item.type === 'started') started = true; if (item.type === 'done') completed = true; eventReceived(item);
      }
    }
    if (!completed) throw new Error('The connection ended before the response completed.');
  } catch (error) { notice(error.message); }
  finally {
    if (!started) { const chat = current(); if (chat) chat.messages = chat.messages.filter(message => message.id !== 'pending'); $('#prompt').value = text; }
    finishReasoning(); setBusy(false); render(); resize(); $('#prompt').focus();
  }
};
try {
  const [list, status] = await Promise.all([(await api('/api/chats')).json(), (await api('/api/status')).json()]);
  chats = list; await projectUI.initialize(status.cwd); $('#model-label').textContent = status.model; $('#model-label').title = `${status.provider} / ${status.model}`;
  if (!status.workspaceFound) notice('The project working directory was not found. Restart the server from the project checkout.');
  history(); render(); updateSend();
} catch (error) { notice(`Could not connect: ${error.message}`); }
