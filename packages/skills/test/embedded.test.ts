import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMBEDDED_SKILL_FILES } from "../src/embedded.js";
import { skillsDir } from "../src/index.js";

/**
 * embedded.ts 是 skills/*.md 的构建期内联副本(无盘运行时的回退载体)。
 * 本测试锁两者同步:改了 md 忘了跑 codegen(bun run build 自动跑)会在这里红。
 */
describe("embedded skills stay in sync with skills/*.md", () => {
  const dir = skillsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();

  it("covers exactly the md files shipped in skills/", () => {
    expect(Object.keys(EMBEDDED_SKILL_FILES).sort()).toEqual(files);
  });

  for (const file of files) {
    it(`content matches: ${file}`, () => {
      expect(EMBEDDED_SKILL_FILES[file]).toBe(readFileSync(join(dir, file), "utf8"));
    });
  }
});
