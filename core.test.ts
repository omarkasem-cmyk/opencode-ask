import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { parseAskArgs, buildPrompt, commandText, runAsk, type TargetRegistry } from "./core.ts"

// Fake CLIs exercised through a test-only registry so tests spawn real
// subprocesses without touching claude/agy.
const testDir = mkdtempSync(join(tmpdir(), "opencode", "ask-tests-"))
const binDir = join(testDir, "bin")
mkdirSync(binDir, { recursive: true })
const markerPath = join(testDir, "spawned.marker")

function makeFakeBin(name: string, body: string): string {
  const path = join(binDir, name)
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 })
  return path
}

test.after(() => rmSync(testDir, { recursive: true, force: true }))

const fakeRegistry: TargetRegistry = {
  fake: {
    label: "Fake Agent",
    bin: makeFakeBin("fake-agent", 'echo "OPINION: $1" | head -c 200'),
    buildArgs: (prompt) => ["-p", prompt],
  },
}

test("parseAskArgs splits target and question", () => {
  const parsed = parseAskArgs("claude can this be concurrent?")
  assert.deepEqual(parsed, { target: "claude", question: "can this be concurrent?" })
})

test("parseAskArgs normalizes target case and extra whitespace", () => {
  const parsed = parseAskArgs("  Claude   can this be concurrent?  ")
  assert.deepEqual(parsed, { target: "claude", question: "can this be concurrent?" })
})

test("parseAskArgs rejects unknown targets with usage listing", () => {
  assert.throws(
    () => parseAskArgs("gpt what do you think?"),
    (err: Error) => err.message.includes("gpt") && err.message.includes("claude") && err.message.includes("agy"),
  )
})

test("parseAskArgs rejects empty input", () => {
  assert.throws(() => parseAskArgs(""), (err: Error) => /question/i.test(err.message))
})

test("parseAskArgs rejects target without a question", () => {
  assert.throws(() => parseAskArgs("claude"), (err: Error) => /question/i.test(err.message))
  assert.throws(() => parseAskArgs("claude   "), (err: Error) => /question/i.test(err.message))
})

test("commandText instructs the agent to curate context, call ask, and relay the opinion", () => {
  const text = commandText({ target: "claude", question: "can this be concurrent?" })
  assert.match(text, /can this be concurrent\?/)
  assert.match(text, /claude/i)
  assert.match(text, /ask/)
  assert.match(text, /context/i)
  assert.match(text, /relay|attribut/i)
})

test("buildPrompt includes the question and the curated context", () => {
  const prompt = buildPrompt({
    target: "claude",
    question: "can this be concurrent?",
    context: "We are designing a job queue backed by SQLite in WAL mode.",
  })
  assert.match(prompt, /can this be concurrent\?/)
  assert.match(prompt, /SQLite in WAL mode/)
})

test("runAsk returns the CLI's printed opinion", async () => {
  const result = await runAsk({
    target: "fake",
    question: "can this be concurrent?",
    context: "queue design",
    registry: fakeRegistry,
    timeoutMs: 10_000,
  })
  assert.match(result, /OPINION: -p/)
})

test("runAsk surfaces stderr when the CLI exits non-zero", async () => {
  const registry: TargetRegistry = {
    grumpy: {
      label: "Grumpy",
      bin: makeFakeBin("grumpy-agent", 'echo "model overloaded" >&2; exit 1'),
      buildArgs: (prompt) => ["-p", prompt],
    },
  }
  await assert.rejects(
    runAsk({ target: "grumpy", question: "q", registry, timeoutMs: 10_000 }),
    (err: Error) => err.message.includes("model overloaded") && /exit/i.test(err.message),
  )
})

test("runAsk times out, kills the CLI, and reports clearly", async () => {
  const registry: TargetRegistry = {
    slow: {
      label: "Slow",
      bin: makeFakeBin("slow-agent", "exec sleep 30"),
      buildArgs: (prompt) => ["-p", prompt],
    },
  }
  await assert.rejects(
    runAsk({ target: "slow", question: "q", registry, timeoutMs: 300 }),
    (err: Error) => /timed out/i.test(err.message),
  )
})

test("runAsk aborts with the caller's signal", async () => {
  const registry: TargetRegistry = {
    slow: {
      label: "Slow",
      bin: makeFakeBin("slow-agent-2", "exec sleep 30"),
      buildArgs: (prompt) => ["-p", prompt],
    },
  }
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 150)
  await assert.rejects(
    runAsk({ target: "slow", question: "q", registry, timeoutMs: 30_000, signal: controller.signal }),
    (err: Error) => /abort/i.test(err.message),
  )
})

test("runAsk reports a missing binary without hanging", async () => {
  const registry: TargetRegistry = {
    ghost: {
      label: "Ghost",
      bin: "definitely-not-a-real-binary-xyz",
      buildArgs: (prompt) => ["-p", prompt],
    },
  }
  await assert.rejects(
    runAsk({ target: "ghost", question: "q", registry, timeoutMs: 10_000 }),
    (err: Error) => /not found/i.test(err.message),
  )
})

test("runAsk rejects oversized briefings before spawning", async () => {
  const registry: TargetRegistry = {
    marker: {
      label: "Marker",
      bin: makeFakeBin("marker-agent", `touch ${markerPath}; echo done`),
      buildArgs: (prompt) => ["-p", prompt],
    },
  }
  await assert.rejects(
    runAsk({
      target: "marker",
      question: "q",
      context: "x".repeat(150_000),
      registry,
      timeoutMs: 10_000,
    }),
    (err: Error) => /too large|too big/i.test(err.message),
  )
  assert.equal(existsSync(markerPath), false, "CLI must not spawn for an oversized briefing")
})
