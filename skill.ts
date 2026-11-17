import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

interface Skill {
  name: string;
  description: string;
  file: string;
}

export default function (pi: ExtensionAPI) {
  const roots = [
    path.join(os.homedir(), ".agents/skills"),
    path.join(os.homedir(), ".pi/agent/skills"),
    path.join(process.cwd(), ".agents/skills"),
  ];

  async function discover(dir: string): Promise<Skill[]> {
    const result: Skill[] = [];

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return result;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        result.push(...await discover(fullPath));
      } else if (entry.name === "SKILL.md") {
        const content = await readFile(fullPath, "utf8");
        const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);

        if (!frontmatter) continue;

        const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1].trim();
        const description = frontmatter[1]
          .match(/^description:\s*(.+)$/m)?.[1].trim();

        if (name && description) {
          result.push({ name, description, file: fullPath });
        }
      }
    }

    return result;
  }

  pi.registerTool({
    name: "skill",
    label: "Load Skill",
    description:
      "Discover and load an Agent Skill by name. " +
      "Use this when specialized workflow instructions are needed.",
    promptSnippet: "Load specialized instructions from an Agent Skill.",
    promptGuidelines: [
      "Use skill to load the full instructions before executing a specialized workflow.",
      "Do not guess skill names; use the list action to discover available skills.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("load"),
      ]),
      name: Type.Optional(Type.String({
        description: "Exact name of the skill to load",
      })),
    }),

    async execute(_id, params) {
      const skills: Skill[] = [];

      for (const root of roots) {
        skills.push(...await discover(root));
      }

      const unique = [...new Map(
        skills.map(s => [s.name, s])
      ).values()];

      if (params.action === "list") {
        return {
          content: [{
            type: "text",
            text: unique.length
              ? unique.map(s =>
                  `- ${s.name}: ${s.description}`
                ).join("\n")
              : "No skills found.",
          }],
        };
      }

      if (!params.name) {
        return {
          content: [{ type: "text", text: "Skill name is required." }],
          isError: true,
        };
      }

      const skill = unique.find(s => s.name === params.name);

      if (!skill) {
        return {
          content: [{
            type: "text",
            text: `Skill not found: ${params.name}`,
          }],
          isError: true,
        };
      }

      const content = await readFile(skill.file, "utf8");

      return {
        content: [{
          type: "text",
          text: `Loaded skill: ${skill.name}\n\n${content}`,
        }],
      };
    },
  });
}