# syntax=docker/dockerfile:1
#
# UGS Metadata Server —— 容器镜像
#
# 构建：
#   docker build -t ugs-metadata:local .
#
# 运行：
#   docker run -d --name ugs-metadata -p 8080:8080 -v ugs-data:/data ugs-metadata:local
#
# 或者直接用 compose（推荐，见 docker-compose.yml）：
#   docker compose up -d

ARG DENO_VERSION=2.9.7

# ---------------------------------------------------------------------------
# 第一阶段：预热依赖
#
# 这一层只依赖两个清单文件，因此改业务代码不会让它失效，
# 后续每次构建都能直接复用已下载的依赖，省去反复联网拉取。
# ---------------------------------------------------------------------------
FROM denoland/deno:alpine-${DENO_VERSION} AS deps

WORKDIR /app
COPY deno.json deno.lock ./

# 用一份临时入口把 import map 里的依赖全部拉下来；
# 同一个 RUN 内删除，不会在镜像里留下多余文件。
RUN printf 'import "hono";\n' > prewarm.ts \
  && deno cache prewarm.ts \
  && rm prewarm.ts

# ---------------------------------------------------------------------------
# 第二阶段：运行镜像
# ---------------------------------------------------------------------------
FROM denoland/deno:alpine-${DENO_VERSION}

# 复用第一阶段已经下载好的依赖缓存
COPY --from=deps /deno-dir /deno-dir

# 准备目录：
#   /deno-dir —— Deno 的依赖与编译缓存
#   /app      —— 应用代码
#   /data     —— SQLite 数据卷挂载点
# 基础镜像里已经存在 uid/gid 1000 的 deno 用户，这里把目录交给他，
# 使容器可以以非 root 身份运行（同时让具名卷在首次创建时继承该属主）。
RUN mkdir -p /app /data \
  && chown -R deno:deno /deno-dir /app /data

WORKDIR /app

COPY --chown=deno:deno deno.json deno.lock ./
COPY --chown=deno:deno src ./src
COPY --chown=deno:deno tools ./tools

USER deno

# 显式预热一次真实入口，确保镜像内依赖完整（构建期有网络，运行期可以完全离线）
RUN deno cache src/server.ts tools/healthcheck.ts

# ---------------------------------------------------------------------------
# 运行时配置
# ---------------------------------------------------------------------------
ENV SQLITE_PATH=/data/ugs.db \
    PORT=8080 \
    HOST=0.0.0.0 \
    # 容器里不需要 Deno 的版本更新检查，避免无意义的外网请求
    DENO_NO_UPDATE_CHECK=1

EXPOSE 8080
VOLUME ["/data"]

# 健康检查依赖 /health（会真正查一次数据库）。
# 用 exec 数组形式，不经过 shell，因此基础镜像里没有 curl/wget 也没问题。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["deno", "run", "--no-config", "--allow-net", "--allow-env", "tools/healthcheck.ts"]

# 基础镜像的 entrypoint（/tini + docker-entrypoint.sh）会把 "task start"
# 转发成 "deno task start"，因此这里写 deno 子命令即可。
CMD ["task", "start"]
