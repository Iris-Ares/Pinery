/**
 * codegen:把 skills/*.md 内联为 src/embedded.ts 字符串常量。
 *
 * 为什么:Workers(workerd)没有可读的包文件系统,readSkill 的磁盘路径在
 * 云形态必然失败;embedded.ts 提交入库作为无盘运行时的回退。md 文件仍是
 * 唯一事实源 —— 本脚本在根 build 前运行,test/embedded.test.ts 断言两者同步。
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(pkgDir, "skills");
const outPath = join(pkgDir, "src", "embedded.ts");

const files = readdirSync(skillsDir).filter((f) => f.endsWith(".md")).sort();
const entries = files.map((file) => {
  const content = readFileSync(join(skillsDir, file), "utf8");
  return `  ${JSON.stringify(file)}: ${JSON.stringify(content)},`;
});

const out = `// 由 scripts/embed.mjs 生成,勿手工编辑;事实源是 ../skills/*.md
// (无盘运行时的回退载体,见 index.ts readSkill)

/** 内置 skills 全文,键为文件名 */
export const EMBEDDED_SKILL_FILES: Record<string, string> = {
${entries.join("\n")}
};
`;

writeFileSync(outPath, out);
console.log(`[skills] embedded ${files.length} files -> src/embedded.ts`);
