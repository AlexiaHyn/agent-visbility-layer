import { readFile } from 'node:fs/promises';
import { win32, join } from 'node:path';

// Only readable provider text belongs in the UI, never signatures or redacted payloads.
export function reasoningSteps(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content.filter(block => block.type === 'thinking' && !block.redacted &&
    typeof block.thinking === 'string' && block.thinking.trim()).map(block => block.thinking);
}

// Walk actual content order. A tool can only inherit reasoning from this same
// assistant message; several tool calls can share the nearest preceding block.
export function reasoningGroups(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return [];
  const groups = [];
  let current = null;
  for (const block of message.content) {
    if (block?.type === 'thinking') {
      current = null;
      if (!block.redacted && typeof block.thinking === 'string' && block.thinking.trim()) {
        current = { text: block.thinking, toolCallIds: [] }; groups.push(current);
      }
    } else if (block?.type === 'toolCall' && typeof block.id === 'string') {
      if (!current) { current = { text: null, toolCallIds: [] }; groups.push(current); }
      current.toolCallIds.push(block.id);
    }
  }
  return groups;
}

export function createReasoningCollector(onChange) {
  let complete = [], content = [], active = false, previous = '[]';
  const groups = () => reasoningGroups({ role: 'assistant', content });
  function publish() {
    const result = [...complete, ...groups()];
    const serialized = JSON.stringify(result);
    if (serialized !== previous) {
      previous = serialized;
      onChange(result.filter(group => group.text).map(group => group.text), result);
    }
  }
  return event => {
    if (event.type === 'message_start' && event.message?.role === 'assistant') {
      content = []; active = true;
    } else if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      if (!update || !(update.type.startsWith('thinking_') || update.type.startsWith('toolcall_'))) return;
      active = true;
      const partial = update.partial ?? event.message;
      if (Array.isArray(partial?.content)) content = [...partial.content];
      else if (update.type.startsWith('thinking_')) {
        const old = content[update.contentIndex]?.thinking ?? '';
        content[update.contentIndex] = { type: 'thinking', thinking: update.type === 'thinking_end' ? update.content : old + (update.delta ?? '') };
      } else if (update.type === 'toolcall_end') content[update.contentIndex] = update.toolCall;
      publish();
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      if (!active) content = [];
      // Preserve captured partial text when an interrupted final message has no content.
      if (event.message.content?.length) content = [...event.message.content];
      publish();
      complete.push(...groups());
      content = []; active = false;
    }
  };
}

function activeBranch(entries) {
  const records = entries.filter(entry => entry.type !== 'session');
  if (!records.some(entry => 'parentId' in entry)) return records;
  const byId = new Map(records.map(entry => [entry.id, entry]));
  const branch = [], seen = new Set();
  let entry = records.at(-1);
  while (entry && !seen.has(entry.id)) {
    branch.push(entry); seen.add(entry.id); entry = byId.get(entry.parentId);
  }
  return branch.reverse();
}

// Match user turns in order; all assistant model calls before the next user belong
// to the single response displayed by the chat UI. Never guess on unmatched prompts.
export function restoreReasoning(chat, entries) {
  const turns = [];
  for (const entry of activeBranch(entries)) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message?.role === 'user') {
      const text = typeof message.content === 'string' ? message.content :
        (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
      turns.push({ text, steps: [], groups: [] });
    } else if (message?.role === 'assistant' && turns.length) {
      turns.at(-1).steps.push(...reasoningSteps(message));
      turns.at(-1).groups.push(...reasoningGroups(message));
    }
  }
  let cursor = 0, matched = null, changed = false;
  for (const message of chat.messages ?? []) {
    if (message.role === 'user') {
      const index = turns.findIndex((turn, i) => i >= cursor && turn.text === message.text);
      matched = index < 0 ? null : turns[index];
      if (index >= 0) cursor = index + 1;
    } else if (message.role === 'assistant') {
      if (matched) {
        if (!Array.isArray(message.reasoning)) { message.reasoning = [...matched.steps]; changed = true; }
        if (!Array.isArray(message.reasoningGroups)) { message.reasoningGroups = matched.groups; changed = true; }
      }
      matched = null;
    }
  }
  return changed;
}

export async function backfillReasoning(chats, sessionDir) {
  let changed = false;
  for (const chat of chats) {
    if (!chat.sessionFile || !chat.messages?.some(message => message.role === 'assistant' && (!Array.isArray(message.reasoning) || !Array.isArray(message.reasoningGroups)))) continue;
    // Session paths may have been written under Windows. Read only our local session directory.
    const path = join(sessionDir, win32.basename(chat.sessionFile));
    try {
      const lines = (await readFile(path, 'utf8')).split('\n').filter(line => line.trim());
      const entries = [];
      for (let i = 0; i < lines.length; i++) {
        try { entries.push(JSON.parse(lines[i])); }
        catch (error) { if (i !== lines.length - 1) throw error; } // tolerate an interrupted final append
      }
      changed = restoreReasoning(chat, entries) || changed;
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Could not restore reasoning for chat', chat.id, error.message);
    }
  }
  return changed;
}
