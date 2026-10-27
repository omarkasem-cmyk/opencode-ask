# ask

`/ask <claude|agy> <question>` — get another agent's opinion on the record,
without leaving your OpenCode session.

```text
/ask claude can this be concurrent?
/ask agy where would this design fail under load?
```

## How it works

1. The **command** parses `<target> <question>` and instructs your main agent —
   the one that lived the session — to curate a context briefing (the design
   under discussion, decisions, constraints) plus your question, verbatim.
2. The main agent calls the plugin's **`ask` tool** once.
3. The tool runs the target CLI **headless** (`claude -p` / `agy -p`) and waits
   for the answer. No terminal takeover, no new window — the session shows the
   tool running and comes back when the opinion arrives.
4. The opinion lands in the session context. Your main agent relays it,
   attributed, and continues the brainstorm with it in mind — agree, push back,
   or ask the other agent for a counterpoint.

## Behavior

- **Timeout**: 180s per ask, killed cleanly; the error says so.
- **Abort**: interrupting the session kills the underlying CLI too.
- **Briefing cap**: ~100k chars (argv limit); the tool rejects bigger briefings
  before spawning and tells the agent to trim.
- **Missing CLI / non-zero exit**: surfaced as a clear message, no retries.
- **Bad usage** (`/ask gpt ...`, `/ask claude` with no question): the agent
  tells you the usage line: `/ask <claude|agy> <question>`.

## Layout

- `index.ts` — plugin wiring: `/ask` command + `ask` tool
- `core.ts` — parsing, briefing, prompt building, headless CLI runner
- `core.test.ts` — tests (`node --test core.test.ts`), incl. fake-CLIs for
  timeout/abort/missing-binary/oversized cases

## Install

```sh
opencode plugin add github:omarkasem-cmyk/opencode-ask
```

Restart OpenCode (or run `opencode service restart`) and `/ask` is available in
every project. Requires the [Claude Code](https://claude.com/claude-code) CLI
and/or the [agy CLI](https://antigravity.google/docs/cli/install) on `PATH`,
signed in.

Optionally add more targets — one entry in `TARGETS` in `core.ts` (e.g.
`gemini`, or a `both` alias running two asks) — and the command and tool pick
it up automatically.
