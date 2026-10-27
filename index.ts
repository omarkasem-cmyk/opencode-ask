import { Plugin } from "@opencode/plugin"

import { commandText, parseAskArgs, runAsk, TARGETS } from "./core.ts"

/**
 * /ask <claude|agy> <question> — get another agent's opinion without leaving
 * the session. The command tells the main agent to curate context and call
 * the `ask` tool; the tool runs the target CLI headless (print mode), waits,
 * and returns the opinion into the session. No terminal takeover, ever.
 */
export default Plugin.define({
  id: "ask",
  async setup(ctx) {
    const workdir = ctx.location.directory

    await ctx.command.transform((editor) => {
      editor.add({
        name: "ask",
        description: "Ask claude or agy for its opinion on a question — second opinion without leaving the session",
        execute: async ({ sessionID, prompt, delivery }) => {
          let text: string
          try {
            const { target, question } = parseAskArgs(prompt.text ?? "")
            text = commandText({ target, question })
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            text = `The /ask command was used incorrectly: ${message}. Tell the user this briefly and stop — do not attempt anything else.`
          }
          await ctx.session.prompt({ ...prompt, sessionID, text, delivery })
        },
      })
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "ask",
        description:
          "Ask another agent (claude or agy) for its opinion. Pass the user's question verbatim and a context briefing " +
          "you curated from the session (design under discussion, decisions, constraints). Runs headless and waits for " +
          "the answer; the opinion comes back as this tool's result.",
        input: {
          type: "object",
          properties: {
            target: {
              type: "string",
              enum: Object.keys(TARGETS),
              description: `Which agent to ask (${Object.entries(TARGETS)
                .map(([id, def]) => `${id} = ${def.label}`)
                .join(", ")})`,
            },
            question: {
              type: "string",
              description: "The user's question, verbatim",
            },
            context: {
              type: "string",
              description:
                "Curated briefing: the design/architecture under discussion, key decisions, constraints — " +
                "everything the other agent needs to give a useful, specific opinion. Focused, not a transcript dump.",
            },
          },
          required: ["target", "question", "context"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const { target, question, context: briefing } = input as {
            target: string
            question: string
            context: string
          }
          const label = TARGETS[target]?.label ?? target
          try {
            await context.progress({ status: `asking ${label} for its opinion…` })
            const opinion = await runAsk({
              target,
              question,
              context: briefing,
              cwd: workdir,
              signal: context.signal,
            })
            return {
              content: `----- ${label}'s opinion -----\n\n${opinion}\n\n----- end of ${label}'s opinion -----`,
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return {
              content: `asking ${label} failed: ${message}. Tell the user what failed; do not retry on your own.`,
            }
          }
        },
      })
    })
  },
})
