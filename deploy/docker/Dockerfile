# Pinery 主部署路径(PRD §3.7):Bun 运行时,单容器,repo volume,长连接免公网回调。
# 构建上下文 = 仓库根目录:docker build -f deploy/docker/Dockerfile .

FROM oven/bun:1-slim AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile
# --bun:强制用 bun 执行 tsc(镜像内无 node)
RUN bun run --bun build
# 只保留生产依赖
RUN rm -rf node_modules && bun install --frozen-lockfile --production

FROM oven/bun:1-slim
# git:clone/pull 与 worktree;ripgrep:agent 检索
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages

# 数据目录:pinery.yaml、SQLite、repos、sessions 都收敛在 /data
ENV PINERY_CONFIG=/data/pinery.yaml
VOLUME /data

ENTRYPOINT ["bun", "packages/adapter/dist/cli/main.js"]
CMD ["start"]
