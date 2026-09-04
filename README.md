# Strata

**An append-only decision ledger that humans and AI agents share.**

Every specification, decision, prototype and release becomes an immutable layer on one live ledger. Both people and their agents read and write the same truth — nothing is overwritten, every action is attributed, and the full history stays queryable and exportable.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![WebMCP](https://img.shields.io/badge/WebMCP-10%20tools-blue)](#how-webmcp-is-used)

---

## The Problem

Software teams rarely lose the final deliverable. They lose the decisions and reasoning underneath it.

- Specs get overwritten.
- Prototypes fork into `final_v3_REAL`.
- The “why” disappears the moment its author leaves the room.
- AI agents arrive in the browser but are forced to guess the UI, click blindly, and often act without shared context.

This is expensive. Knowledge workers already spend a large fraction of their week searching for information that already exists, and managers report that a significant portion of decision time is used ineffectively. Agents make the problem worse when they operate without a durable, structured source of truth.

WebMCP solves the transport problem. The product still has to expose its real capabilities cleanly. That is what Strata does.

## Existing Tools and the Gap

| Tool                        | What it versions              | What it misses                                              |
|-----------------------------|-------------------------------|-------------------------------------------------------------|
| Notion / Confluence         | Documents (overwritable)      | No sign-off semantics, no agent interface                   |
| Jira / Linear               | Tickets and status            | Reasoning is scattered across comments                      |
| GitHub                      | Code + PR approvals           | Pre-code decisions live elsewhere                           |
| Slack / chat                | Nothing                       | Decisions are unstructured and unsearchable                 |
| Generic agent + any web app | —                             | Agent guesses the DOM; actions are invisible and unauditable|

Strata occupies the missing layer: an **append-only record of decisions** with named human sign-offs that is also a structured API an agent can operate.

## What Strata Is

Five concepts only:

- **Layer** — one immutable record (spec, decision, prototype or release) with id, kind, title, summary, status (`open` | `approved` | `rejected`), named reviewer, and timestamp. Never edited, never deleted.
- **Ledger** — the append-only sequence of layers, shown as cards, as a diagram, and as a live 3D stack.
- **Sign-off** — an approval or rejection bound to the exact layer and always attributed to a named human.
- **Stratum** — a point-in-time bundle of approved layers (basis for release notes and diagrams).
- **Workspace** — a short-code ledger (e.g. `DEMO01`), optionally password-locked, shareable by URL, and live-synced to every open window.

## What Humans and Agents Can Do Together

A concrete end-to-end session:

1. Human opens a workspace and says:  
   *“List the layers, add a decision layer called ‘Adopt saved cards’, then draft release notes.”*
2. The agent calls `list_layers`, reads the history, calls `add_layer`, and drafts notes from approved layers only.
3. Every agent action appears in the shared activity feed in real time — attributed and timestamped — while a new slab drops into the 3D stack.
4. The agent can run structured diffs (`compare_layers`) that no human has time to do manually.
5. The human signs off, cuts the release, and exports the full ledger (JSON / CSV / Markdown / SVG / PNG).

No DOM scraping. No ambiguous button labels. No “which version is this?”.

## How WebMCP Is Used

Tools are registered on the browser’s model context using the exact surface required by the challenge:

```js
document.modelContext.registerTool({
  name: "add_layer",
  description: "Add a new versioned layer to the workspace on behalf of the human. Use when the user describes a decision, a spec version, a prototype or a release.",
  inputSchema: {
    type: "object",
    properties: {
      title:   { type: "string", description: "Short title, e.g. \"Checkout spec v3\"" },
      kind:    { type: "string", enum: ["spec", "decision", "prototype", "release"] },
      summary: { type: "string", description: "One sentence on what this layer captures" }
    },
    required: ["title", "kind"]
  },
  execute: async (input) => {
    // validated, written to the shared ledger, broadcast via SSE
    return { added: "L-8", layer: { /* … */ } };
  }
});
```

**Full toolset (10 tools):**

| Tool                  | Type     | Purpose                                              |
|-----------------------|----------|------------------------------------------------------|
| `list_layers`         | read     | Full ledger state                                    |
| `get_activity`        | read     | Human + agent actions, newest first                  |
| `compare_layers`      | read     | Field-by-field diff of any two layers                |
| `add_layer`           | write    | Record a spec / decision / prototype / release       |
| `sign_off`            | write    | Record a verdict (requires named human reviewer)     |
| `draft_release_notes` | artifact | Markdown release notes from approved layers only     |
| `generate_diagram`    | artifact | SVG strata diagram of the ledger                     |
| `export_workspace`    | artifact | JSON / CSV / Markdown download                       |
| `navigate`            | ui       | Scroll to a section                                  |
| `set_theme`           | ui       | Switch design system                                 |

Design choices that matter for agents:

- Structured JSON ground truth instead of DOM scraping
- Typed schemas + server-side validation with actionable errors
- Clear trust boundaries (sign-offs require a named human; locked workspaces return errors)
- Every action is attributed (human vs agent) in an append-only feed

## Architecture

```
Browser (vanilla JS + Three.js)
  UI · 3D ledger · WebMCP tools · diagram / export
        │ REST                          ▲ SSE
Backend (Node + Express)
  workspaces · layers · sign-offs · activity · auth · exports
        │
SQLite (WAL) — persists to disk (JSON fallback available)
```

- Real-time: Server-Sent Events broadcast every mutation
- Persistence: SQLite with WAL; data survives restarts
- Auth: optional per-workspace password (scrypt + HMAC tokens)
- The agent inherits the human’s unlocked session

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/strata-webmcp.git
cd strata-webmcp
npm install
npm start
```

Open http://localhost:3000

First boot seeds an open demo workspace `DEMO01` (no password).

### Testing with an agent

- ChatGPT in-app browser (WebMCP supported out of the box), or
- Chrome with `chrome://flags/#enable-webmcp-testing` enabled

Then try:

> List the layers, add a decision layer called “Adopt saved cards”, then draft release notes.

The status pill in the Live Demo header shows registration state:  
**WEBMCP · 10 TOOLS LIVE · SERVER**

## Project Structure

```
├── server.js            # Express API, SSE, auth, SQLite
├── public/
│   └── index.html       # Full frontend + 3D + WebMCP registration
├── package.json
├── LICENSE              # MIT
└── README.md
```

## Honest Limitations

- Auth is workspace-level (demo-grade): no user accounts, no rate limiting
- Concurrent edits resolve last-write-wins
- No delete / undo — by design (append-only ledger)
- Session tokens travel as query parameters for EventSource and downloads
- Reasoning quality on top of the tools belongs to the agent model


Built for the [WebMCP Challenge](https://webmcp.devpost.com/).
