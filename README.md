# Pi Chat

A local ChatGPT-style chat website built around the existing pi labs. Light theme with a dark-mode toggle, saved conversations with a delete icon for each chat, streamed replies, a mobile sidebar, stop generation, copy response, and expandable tool cards.

## Run

Run in **WSL**, where your working pi model catalog and login are configured:

```bash
cd /mnt/c/Users/sunfl/Documents/My/Stanford/cs329Z/CS329z-project-alexia
npm start
```

Dependencies are already installed. On a fresh checkout, run `npm install` first. WSL needs Node 22.19 or later (your current WSL runtime is 22.23.4).

For Windows:

```powershell
npm install --cache .npm-cache
npm start
```

Open **http://localhost:3000**. A project-local Node 24 runtime is installed with the dependencies; `npm start` uses it automatically, even if your system Node is older.

The agent works in this project’s root directory (the directory containing `server.mjs`), including when resuming an existing chat. Relative paths used by its tools resolve there. Set `PORT`, `PI_PROVIDER`, and `PI_MODEL` in `.env`. The old `PI_LABS_DIR` setting is no longer used.

## Existing backend integration

`agent-session.mjs` owns the model runtime, session creation/restoration, prompt execution, cancellation, and cleanup. `server.mjs` handles HTTP routes, streamed browser events, and chat persistence.

The agent module adapts the session setup from `01-basic.ts` and `02-customization.ts` to HTTP streaming. It uses this project’s root as the working directory, selects `openai-codex/gpt-6.1-terra` with low thinking. The original lab files are unchanged.

The read, write, edit, and bash tools are enabled. Tool events are recorded in `data/tools.jsonl`.

Conversations and native pi sessions are saved in `data/` using the same `SessionManager.create` / `SessionManager.open` APIs as labs 03 and 04. Keep this directory to retain conversations after restarting. There are no accounts or cloud sync; this server binds to this computer only.

Pi uses its existing provider credentials from the current OS user's pi configuration. **A pi login in WSL does not automatically provide a Windows login.** If authentication fails, log into the configured provider using pi in the same environment where you run this website. Credentials are never sent to the browser. The model provider receives submitted messages and tool results when you send a chat message.

The first version supports text and a small safe Markdown subset (bold, inline code, fenced code). It does not yet include attachments, model selection, or the project's module oversight dashboard.

## Verify

```powershell
npm run check
npm test
```

Tests cover HTTP serving, browser-origin isolation, missing conversations, chat deletion, session cancellation, and shutdown. They do not call a paid model. To check a real session, send the “Explore the project” suggestion, then stop a response to check cancellation.

## Model reasoning

Provider-supplied readable reasoning appears as numbered steps in a **Model reasoning** section above each response. It uses the same Markdown support as assistant responses, opens during streaming, and collapses when the response completes, fails, or stops. You can expand it again manually. Responses without readable reasoning have no section.

Reasoning is saved with chat history. On startup, available reasoning from existing native session files is matched to chat turns and added to saved chats. Native sessions are read without modification. Encrypted signatures and redacted blocks are excluded; the provider may expose only a summary rather than its full internal reasoning.

Tool cards appear inside Model reasoning, below their nearest preceding readable reasoning block in the same native assistant message. Several calls may share one step. Tool-only messages get a clearly marked `[SPECULATED REASONING]` explanation inferred from the tool name and arguments in the browser. These generated explanations are never saved in chats or native sessions and are never included in model context. Existing chats gain tool-to-reasoning associations from native sessions on startup.

## Tool relationship analysis

Responses with at least **8 distinct tool calls and 3 provider-supplied reasoning steps** are analyzed automatically after completion, including stopped/failed responses. Speculative reasoning does not count. Opening an older eligible response starts analysis if no saved result exists. Jobs run in the background, one at a time, so you can continue chatting.

A separate model request receives that response’s tool names, arguments, results (bounded excerpts for long values), statuses, and readable reasoning. Set `PI_ANALYSIS_PROVIDER` and `PI_ANALYSIS_MODEL` to choose the analyzer; omitted values inherit the coding model settings. Analysis runs without executable tools and never changes the native agent session. Results and job status are stored in `data/chats.json`.

The **Tool relationships** section appears between Model reasoning and response text. Its dependency-based graph opens when ready; nodes and arrows show details when selected. Links are inferred, with explanations and confidence, and may use dependency, information-flow, verification, or custom types. Cycles and disconnected calls remain visible. Errors preserve the coding response and offer Retry analysis. Restart-interrupted jobs require retry. Deleting a chat cancels its queued/running analysis.

## Planned implementation projects

Select an implementation project above the conversation, or choose **New project** and an existing workspace directory. Ordinary chats still work without a project. Chats, native sessions, and project data remain in this app's `data/` directory even when the implementation workspace is elsewhere.

The agent initially has only read-only inspection tools and planning tools. It submits a specification and outcome-based implementation steps. The plan appears in chat and coding remains blocked until you select **Approve plan and implement**. During implementation, the agent declares work units, records each unit's normal tool calls, and provides validation evidence. A completed unit must contain at least one normal call; more than five calls is allowed and flagged. Each step needs its own acceptance evidence after its children finish. Validation claims are agent-reported, with the recorded evidence available for inspection.

**Plan execution details** opens the closable split map. Expand sections, navigate breadcrumbs, select dependencies, or inspect attempts and tool results. **Edit plan** stops an active response immediately before opening a local draft. Rename, move, merge, split, and remove operations affect only that draft. Closing edit mode, closing the map, or refreshing discards unconfirmed changes.

**Confirm edits** saves the draft and asks the agent to inspect the current code read-only. It must propose a minimal repair plan, explain affected sections, prefer reuse/reimporting over unnecessary code, and wait for renewed approval. Only after approval can it reconcile implementation with the revised plan. Previous definitions, plans, and attempts remain recorded.

Select a completed section and choose **Rerun** to review its captured before/after file contents, affected dependents, and snapshot coverage. Approval selectively restores the eligible interval and reruns the selected work plus affected dependents. Later conflicting edits block restoration. If unrelated sections ran within that interval, the model instead reviews the current workspace read-only and proposes a minimal repair plan for separate approval; unrelated work is preserved.

Reruns fork the recorded pre-section conversation into a new native session file, preserving the original. The map defaults to the latest branch; its branch dropdown opens previous map states read-only. Existing conversations are never converted into historical project maps.

Project records are append-only events under `data/projects/<id>/events.jsonl` plus a rebuildable `map.json`. Snapshot blobs and manifests are under `data/checkpoints/`. Snapshot coverage excludes app data, .env credentials, Git internals, node_modules, and configured runtime caches; source data in a separate project workspace is included. Deleting an attached chat retains its native session for project history.

The test suite uses mocked model calls and disposable workspaces/data directories. Run `npm test` and `npm run check`. Live model behavior still depends on the configured provider and model following the structured protocol; host guards enforce approval and work-unit ownership even when it does not.
