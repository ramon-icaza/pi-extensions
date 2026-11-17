import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type JsonEvent = {
  type?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    stopReason?: string;
    errorMessage?: string;
  };
};

function getPiInvocation(args: string[]) {
  // When Pi is launched as a script, reuse that script and runtime.
  const currentScript = process.argv[1];

  if (
    currentScript &&
    !currentScript.startsWith("/$bunfs/root/") &&
    !/^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(currentScript) &&
    fs.existsSync(currentScript)
  ) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  // When embedded in a generic Node/Bun runtime, resolve the pi CLI from PATH.
  const runtime = path.basename(process.execPath).toLowerCase();
  if (/^(node|bun)(\.exe)?$/.test(runtime)) {
    return { command: "pi", args };
  }

  return { command: process.execPath, args };
}

function extractText(event: JsonEvent): string {
  if (event.type !== "message_end" || event.message?.role !== "assistant") {
    return "";
  }

  return (event.message.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a task to a fresh Pi process with an isolated context. " +
      "Provide the subagent instructions in prompt and the concrete task in description.",
    parameters: Type.Object({
      prompt: Type.String({
        description: "Instructions for the subagent (used as additional system instructions).",
      }),
      description: Type.String({
        description: "Short description of the task to perform.",
      }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Subagent execution cancelled before start." }],
          isError: true,
        };
      }

      const tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-subagent-"),
      );
      const promptFile = path.join(tempDir, "prompt.md");

      try {
        await fs.promises.writeFile(promptFile, params.prompt, {
          encoding: "utf8",
          mode: 0o600,
        });

        const args = [
          "--mode", "json",
          "-p",
          "--no-session",
          "--append-system-prompt", promptFile,
        ];

        // Keep the child on the same model and reasoning level as its parent.
        if (ctx.model) {
          args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
        }
        if (ctx.thinkingLevel) {
          args.push("--thinking", ctx.thinkingLevel);
        }

        // Pass the task as the child's user message. No shell interpolation.
        args.push(params.description);

        const invocation = getPiInvocation(args);

        const result = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
          output: string;
          stderr: string;
          spawnError?: Error;
          aborted: boolean;
        }>((resolve) => {
          let settled = false;
          let stdoutBuffer = "";
          let output = "";
          let stderr = "";
          let aborted = false;
          let killTimer: ReturnType<typeof setTimeout> | undefined;

          const child = spawn(invocation.command, invocation.args, {
            cwd: ctx.cwd,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
          });

          const finish = (value: {
            code: number | null;
            signal: NodeJS.Signals | null;
            output: string;
            stderr: string;
            spawnError?: Error;
            aborted: boolean;
          }) => {
            if (settled) return;
            settled = true;
            if (killTimer) clearTimeout(killTimer);
            signal?.removeEventListener("abort", abortChild);
            resolve(value);
          };

          const abortChild = () => {
            if (settled || child.exitCode !== null || child.signalCode !== null) {
              return;
            }

            aborted = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
              if (!settled) child.kill("SIGKILL");
            }, 3000);
          };

          child.stdout.on("data", (chunk: Buffer) => {
            stdoutBuffer += chunk.toString("utf8");
            const lines = stdoutBuffer.split("\n");
            stdoutBuffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.trim()) continue;

              try {
                const event = JSON.parse(line) as JsonEvent;
                const text = extractText(event);
                if (text) output = text;
              } catch {
                // Ignore non-JSON stdout lines; JSON mode normally emits JSONL.
              }
            }
          });

          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });

          child.on("error", (error) => {
            finish({
              code: null,
              signal: null,
              output,
              stderr,
              spawnError: error,
              aborted,
            });
          });

          child.on("close", (code, terminationSignal) => {
            if (stdoutBuffer.trim()) {
              try {
                const event = JSON.parse(stdoutBuffer) as JsonEvent;
                const text = extractText(event);
                if (text) output = text;
              } catch {
                // Ignore an incomplete/non-JSON trailing line.
              }
            }

            finish({
              code,
              signal: terminationSignal,
              output,
              stderr,
              aborted,
            });
          });

          if (signal) {
            if (signal.aborted) abortChild();
            else signal.addEventListener("abort", abortChild, { once: true });
          }
        });

        if (result.aborted) {
          return {
            content: [{ type: "text", text: "Subagent execution cancelled." }],
            isError: true,
          };
        }

        if (result.spawnError) {
          return {
            content: [{
              type: "text",
              text: `Could not start Pi subagent: ${result.spawnError.message}`,
            }],
            isError: true,
          };
        }

        if (result.code !== 0) {
          const diagnostics = [
            `Pi subagent exited with code ${result.code ?? "unknown"}.`,
            result.signal ? `Signal: ${result.signal}` : "",
            result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
            result.output ? `Last assistant output:\n${result.output}` : "",
          ].filter(Boolean).join("\n\n");

          return {
            content: [{ type: "text", text: diagnostics }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text",
            text: result.output || "(Subagent finished without a text response.)",
          }],
        };
      } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    },
  });
}
