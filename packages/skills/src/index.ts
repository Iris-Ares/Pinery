import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_SKILL_FILES } from "./embedded.js";

/**
 * Pinery prompt 资产(PRD §3.2:pi 哲学——skills 全为文件,Git 管理、可 review、可移植)。
 *
 * 运行时优先读取目标仓库 `.pinery/` 下的同名文件(团队可定制),
 * 缺失时回退到本包内置默认版本。
 */

export type SkillName =
  | "investigate"
  | "answer-format"
  | "task-spec"
  | "glossary-template"
  | "bootstrap-glossary";

export const SKILL_FILES: Record<SkillName, string> = {
  investigate: "investigate.md",
  "answer-format": "answer-format.md",
  "task-spec": "task-spec.md",
  "glossary-template": "glossary-template.md",
  "bootstrap-glossary": "bootstrap-glossary.md",
};

/** 内置 skills 目录(dist/ 与 src/ 的相对深度一致,均为 ../skills) */
export function skillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

export function skillPath(name: SkillName): string {
  return join(skillsDir(), SKILL_FILES[name]);
}

/** 读取 skill 内容:优先 repoDir/.pinery/<file>,回退内置默认 */
export function readSkill(name: SkillName, repoDir?: string): string {
  const file = SKILL_FILES[name];
  if (repoDir) {
    try {
      const local = join(repoDir, ".pinery", file);
      if (existsSync(local)) return readFileSync(local, "utf8");
    } catch {
      // 无盘运行时(workerd):仓库定制版不可达,落内置
    }
  }
  try {
    return readFileSync(skillPath(name), "utf8");
  } catch {
    // 无盘运行时:包文件不可读,用构建期内联副本(scripts/embed.mjs)
    const embedded = EMBEDDED_SKILL_FILES[file];
    if (embedded !== undefined) return embedded;
    throw new Error(`skill 不可读且无内联副本:${file}`);
  }
}

/** 读取仓库术语表(仅 .pinery/glossary.md,无内置回退——没有就是没有) */
export function readGlossary(repoDir: string): string | undefined {
  try {
    const p = join(repoDir, ".pinery", "glossary.md");
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  } catch {
    // 无盘运行时:等同于「没有」
    return undefined;
  }
}

/**
 * 把默认 skills 安装到仓库 .pinery/(已存在的文件不覆盖)。
 * 返回实际写入的文件名列表。
 */
export function installSkills(repoDir: string): string[] {
  const dest = join(repoDir, ".pinery");
  mkdirSync(dest, { recursive: true });
  const installed: string[] = [];
  const names: SkillName[] = ["investigate", "answer-format", "task-spec"];
  for (const name of names) {
    const file = SKILL_FILES[name];
    const target = join(dest, file);
    if (!existsSync(target)) {
      copyFileSync(skillPath(name), target);
      installed.push(file);
    }
  }
  return installed;
}
