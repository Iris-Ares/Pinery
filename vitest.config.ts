import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    // 测试直接跑 src,避免跨包测试前必须先 build
    alias: {
      "@pinery/core": p("packages/core/src/index.ts"),
      "@pinery/skills": p("packages/skills/src/index.ts"),
      "@pinery/runner-pi": p("packages/runner-pi/src/index.ts"),
      "@pinery/workspace-cf-computer": p("packages/workspace-cf-computer/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "deploy/**/*.test.ts"],
    // deploy/cloudflare/test 跑在 workerd 里(@cloudflare/vitest-pool-workers,
    // 该目录自带 vitest 配置),与本配置的 node 环境互不混跑
    exclude: ["**/node_modules/**", "deploy/cloudflare/**"],
    environment: "node",
  },
});
