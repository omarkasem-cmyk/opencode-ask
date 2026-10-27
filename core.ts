import { spawn } from "node:child_process"

/** A second-opinion target: a headless CLI we can ask a question. */
export interface TargetDef {
  label: string
  bin: string
  buildArgs: (prompt: string) => string[]
  maxPromptChars?: number
}

export type TargetRegistry = Record<string, TargetDef>

/**
 * The targets `/ask` knows about. Adding one (gemini, codex, ...) is a single
 * entry here; the command and tool pick it up automatically.
 */
export const TARGETS: TargetRegistry = {
  claude: {
    label: "Claude Code",
    bin: "claude",
    buildArgs: (prompt) => ["-p", prompt, "--output-format", "text"],
  },
  agy: {
    label: "agy (Antigravity)",
    bin: "agy",
    buildArgs: (prompt) => ["-p", prompt, "--output-format", "text"],
  },
}

export const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_MAX_PROMPT_CHARS = 100_000

export interface ParsedAsk {
  target: string
  question: string
}

/** Parse `/ask <target> <question>` input into its parts. */
export function parseAskArgs(text: string, registry: TargetRegistry = TARGETS): ParsedAsk {
  const trimmed = text.trim()
  if (!trimmed) throw new Error(usageMessage(registry, "provide a question"))
  const [first, ...rest] = trimmed.split(/\s+/)
  const target = first.toLowerCase()
  if (!(target in registry)) {
    throw new Error(usageMessage(registry, `unknown model '${first}'`))
  }
  const question = rest.join(" ").trim()
  if (!question) throw new Error(usageMessage(registry, "provide a question"))
  return { target, question }
}

function usageMessage(registry: TargetRegistry, problem: string): string {
  return `/ask: ${problem}. Usage: /ask <${Object.keys(registry).join("|")}> <question>`
}

export interface AskPromptInput {
  target: string
  question: string
  context?: string
  registry?: TargetRegistry
}

/** Build the briefing sent to the target CLI. */
export function buildPrompt(input: AskPromptInput): string {
  const def = (input.registry ?? TARGETS)[input.target]
  const label = def?.label ?? input.target
  const context = input.context?.trim()
  return [
    `You are ${label}, asked for an independent second opinion on a question that came up in another agent's session.`,
    "",
    "## Context",
    context && context.length > 0 ? context : "(no additional context provided)",
    "",
    "## Question",
    input.question,
    "",
    `Give your honest, concrete opinion as ${label} would. Point at where the approach could fail, its risks and blind spots, and answer the question directly. Be specific, not diplomatic.`,
  ].join("\n")
}

export interface CommandTextInput {
  target: string
  question: string
}

/**
 * The instruction submitted to the main agent when the user runs /ask:
 * curate context, call the ask tool, then relay the opinion and keep going.
 */
export function commandText(input: CommandTextInput): string {
  const def = TARGETS[input.target]
  const label = def?.label ?? input.target
  return [
    `The user ran: /ask ${input.target} ${input.question}`,
    "",
    `They want ${label}'s independent opinion on this question. Do two things:`,
    "",
    `1. Call the \`ask\` tool once with target="${input.target}", the user's question VERBATIM as the question, and a context briefing you write yourself: the design or architecture under discussion in this session, the key decisions, constraints, and any code the other agent needs to see to answer well. Keep it focused — curate, don't dump the transcript.`,
    "",
    `2. When the opinion comes back, relay it to the user attributed to ${label} — quote it or summarize tightly, don't dilute it. Then continue the discussion with the opinion in mind: agree, push back, or adjust the design as warranted.`,
  ].join("\n")
}

export interface RunAskInput extends AskPromptInput {
  timeoutMs?: number
  signal?: AbortSignal
  cwd?: string
}

/**
 * Ask a target CLI for its opinion, headless: spawn it in print mode,
 * wait for the answer, and return it. Never opens or takes over a terminal.
 */
export async function runAsk(input: RunAskInput): Promise<string> {
  const registry = input.registry ?? TARGETS
  const def = registry[input.target]
  if (!def) throw new Error(`Unknown target '${input.target}'. Available: ${Object.keys(registry).join(", ")}`)
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const prompt = buildPrompt({ ...input, registry })
  const maxChars = def.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS
  if (prompt.length > maxChars) {
    throw new Error(
      `briefing too large for ${input.target}: ${prompt.length} chars (cap ${maxChars}). Trim the context and try again.`,
    )
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const child = spawn(def.bin, def.buildArgs(prompt), {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let aborted = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
      settle(new Error(`${def.label} timed out after ${Math.round(timeoutMs / 1000)}s — no answer came back.`))
    }, timeoutMs)

    const onAbort = () => {
      aborted = true
      child.kill("SIGKILL")
      settle(new Error(`ask ${input.target} was aborted.`))
    }
    input.signal?.addEventListener("abort", onAbort, { once: true })

    function settle(err?: Error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", onAbort)
      if (err) reject(err)
      else resolve(stdout.trim())
    }

    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()))

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        settle(
          new Error(
            `'${def.bin}' not found on PATH — is ${def.label} installed? (opinion target '${input.target}')`,
          ),
        )
      } else {
        settle(new Error(`${def.label} failed to start: ${err.message}`))
      }
    })

    child.on("close", (code) => {
      if (timedOut || aborted) return // already settled by the killer
      if (code !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : ""
        settle(new Error(`${def.label} exited with code ${code}${detail}`))
      } else {
        settle()
      }
    })
  })
}
