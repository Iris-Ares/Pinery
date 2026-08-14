import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRepositoryGuidance } from "../src/repository-guidance.js";
import type { RemoteToolOperations } from "../src/toolset.js";

describe("loadRepositoryGuidance", () => {
  it("discovers root and nested AGENTS.md plus repository skills locally", async () => {
    const root = mkdtempSync(join(tmpdir(), "pinery-guidance-"));
    mkdirSync(join(root, "services", "api"), { recursive: true });
    mkdirSync(join(root, ".agents", "skills", "service-router"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "# Root rules\nRead this first.\n");
    writeFileSync(join(root, "services", "api", "AGENTS.md"), "# API rules\n");
    writeFileSync(
      join(root, ".agents", "skills", "service-router", "SKILL.md"),
      "---\nname: service-router\ndescription: Route requests to the owning service.\n---\n# Instructions\n",
    );

    const guidance = await loadRepositoryGuidance(root);
    expect(guidance.rootInstructions).toEqual({
      content: "# Root rules\nRead this first.\n",
      truncated: false,
    });
    expect(guidance.nestedInstructionPaths).toEqual(["services/api/AGENTS.md"]);
    expect(guidance.skills).toEqual([
      {
        name: "service-router",
        description: "Route requests to the owning service.",
        path: ".agents/skills/service-router/SKILL.md",
      },
    ]);
  });

  it("uses bounded remote reads for a Cloudflare Computer repository", async () => {
    const reads: Array<{ path: string; maxBytes: number }> = [];
    const files = new Map([
      ["/workspace/AGENTS.md", "# Remote rules\n"],
      [
        "/workspace/.agents/skills/remote-router/SKILL.md",
        "---\nname: remote-router\ndescription: Route remote tasks.\n---\n",
      ],
    ]);
    const operations = {
      repositoryContext: {
        readText: async (path: string, maxBytes: number) => {
          reads.push({ path, maxBytes });
          const text = files.get(path);
          if (text === undefined) throw new Error("not found");
          return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
        },
        find: async (pattern: string) =>
          pattern === "**/AGENTS.md"
            ? ["/workspace/AGENTS.md"]
            : ["/workspace/.agents/skills/remote-router/SKILL.md"],
      },
    } as RemoteToolOperations;

    const guidance = await loadRepositoryGuidance("/workspace", operations);
    expect(guidance.rootInstructions?.content).toBe("# Remote rules\n");
    expect(guidance.skills[0]?.path).toBe(".agents/skills/remote-router/SKILL.md");
    expect(reads).toEqual([
      { path: "/workspace/AGENTS.md", maxBytes: 96 * 1024 },
      { path: "/workspace/.agents/skills/remote-router/SKILL.md", maxBytes: 8 * 1024 },
    ]);
  });
});
