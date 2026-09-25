# Codara 构建指南（编译环境表）

> 适用：zip 包 `codara-source-m1-m7.zip`（M1–M7 全部源码，可直接构建编译）。
> 构建宿主：Linux x64 / Windows x64 / macOS 均可（**运行目标平台为 Windows 7 SP1+**，Linux 上可跑全部测试）。

## 1. 环境要求（精确版本）

| 组件 | 版本 | 用途 | 获取方式 |
|---|---|---|---|
| **Node.js** | **22.13.x**（≥16.17 可用，22.x 已验证） | JS 工具链 / electron 依赖 | https://nodejs.org（或 nvm install 22） |
| **pnpm** | **9.x**（≥8 可用） | 包管理（workspace 协议） | `corepack enable && corepack prepare pnpm@9 --activate` 或 `npm i -g pnpm@9` |
| Rust | **1.77.2（MSRV 硬约束）** | sidecar 编译 | `rustup toolchain install 1.77.2`；`sidecar/rust-toolchain.toml` 会自动选中；**禁止 1.78+ 作为发布目标**（Win7 兼容面未验证） |
| **cargo** | 随 rustup 1.77.2 | Rust 构建/测试 | 同上 |
| SQLite | 系统库（rusqlite bundled，无需安装） | sidecar 索引存储 | — |
| **NSIS 3.x**（可选） | ≥3.08 已验证（3.09） | 仅打安装包；跑测试不需要 | Windows 官方包 / Linux `apt install nsis` |

> Windows 构建额外要求：MSVC Build Tools（Rust msvc target）+ Windows SDK；sidecar target = `x86_64-pc-windows-msvc`。

## 2. 构建步骤（4 条命令）

```bash
# 1) 安装 JS 依赖（含 electron 22.3.27 二进制，首次约 1-2 分钟）
pnpm install

# 2) 全量构建：shared(契约) → sidecar(Rust release) → electron(esbuild) → renderer(vite)
pnpm build
#    分步等价：pnpm build:shared && pnpm build:sidecar && pnpm build:main && pnpm build:renderer

# 3) 全量测试（可选但推荐）
pnpm -r typecheck          # 0 错误
pnpm test:main             # main+contract 56
pnpm test:integration      # 57（自动 spawn 真实 sidecar 二进制，需先完成第 2 步）
pnpm test:sidecar          # cargo test 28

# 4) 启动（构建产物直接运行）
pnpm dev                   # = node scripts/dev.mjs（构建后拉起 electron）
```

## 3. 安装包打包（可选，需 NSIS）

```bash
# 四变体：online/offline × per-user/admin；体积硬校验（≤10MB / ≤180MB）
cd installer && node scripts/build-installer.mjs

# 附带生成物
node scripts/gen-notices.mjs . dist/NOTICES.txt      # 许可证清单
node scripts/gen-update-yml.mjs 0.1.0 dist           # electron-updater 锁版配置
```

> 离线安装包需要 `installer/nsis/payload/`（构建流水把 electron 产物/sidecar 二进制/MinGit/字体放入）；仓库内含占位结构，仅编译冒烟。
> Windows 构建宿主编 online 变体时定义 `-DCODARA_HAS_INETC` 启用真实 INetC 下载（Linux 冒烟走桩分支）。

## 4. 目录结构速览

| 目录 | 内容 |
|---|---|
| `shared/` | IPC 契约与类型（@codara/contract） |
| `electron/` | 主进程：loop/tools/gateway/crew/memory/IPC handlers |
| `renderer/` | SolidJS UI（Meta 风格） |
| `sidecar/` | Rust 侧车：fs/git/term/search/governance/index(索引+BM25F) |
| `tests/` | main（单测）+ integration（真实进程 e2e）+ mock-llm |
| `installer/` | winDetect/backupPlan（TS 逻辑）+ NSIS 脚本 + 生成脚本 |
| `docs/spec/` | 规格文档 / 自测报告（m1–m6 + final）/ 立项文档 / Win7 回归清单 |

## 5. 常见问题

| 症状 | 处理 |
|---|---|
| rustup 报 `error downloading ... channel-rust-1.77.2.toml` | 受限网络无法访问 static.rust-lang.org。若 1.77.2 已装：`export RUSTUP_TOOLCHAIN=1.77.2` 跳过 channel 在线解析后重跑；代码实测在 1.93.0 上同样编译通过（开发机可用 `RUSTUP_TOOLCHAIN=<本机版本>` 临时开发，发布请切回 1.77.2） |
| `cargo build` 选错版本 | 确认 `rustup toolchain install 1.77.2`；rust-toolchain.toml 会强制 |
| integration 测试找不到 sidecar 二进制 | 先跑 `pnpm build:sidecar`（二进制拷贝到 electron/resources/bin/，测试按 target/{release,debug} 查找） |
| electron 下载慢 | `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后重新 `pnpm install` |
| Win7 运行时缺 KB | 安装包 KB 引导页有指引；手动装 KB4490628→KB4474419（顺序） |
