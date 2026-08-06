import { existsSync, readFileSync } from "node:fs";

/**
 * 极简 .env 加载(不覆盖已有环境变量;无第三方依赖)。
 * 支持 KEY=VALUE、注释行、单双引号包裹值。
 */
export function loadDotEnv(paths: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const loaded: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1]!;
      if (key in env) continue;
      let value = m[2]!;
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}
