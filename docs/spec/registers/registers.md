# 登记表

## 兼容性风险登记表

| 日期 | 组件/依赖 | 风险 | 决策 | 状态 |
|---|---|---|---|---|
| M1 | node-pty 需匹配 Electron 22 ABI(109) | 编译失败风险 | child_process fallback（同 IShellSession 接口），Windows 发布前 electron-rebuild | open→mitigated |
| M1 | libsqlite3-sys MSRV 可能高于 1.77.2 | 无法编译 | Cargo.lock 锁版本；升级前在 1.77.2 下 cargo build 验证 | open |
| M1 | Electron 22 无全局 fetch（Node16） | 代码误用 | 主进程网络层一律 https 模块；review 检查 | closed |
| M2 | Linux 开发环境无 cmd.exe | terminal 行为差异 | shell 抽象：win=cmd.exe，dev=bash；命令纪律校验仅 Windows 强制 PS 规则 | closed |
| M2 | GBK 检测误判（短文件） | 编码识别错误 | BOM 优先 → UTF-8 严格校验失败回退 GB18030；可显式指定 encoding | open |

## 依赖准入单

| 依赖 | 版本 | 用途 | Win7 x64 | 体积 | 许可证 | 替代 | 状态 |
|---|---|---|---|---|---|---|---|
| electron | 22.3.27 | 桌面壳 | ✅ 末代支持 | ~250MB 解压 | MIT | 无（冻结） | 准入 |
| solid-js | ^1.8 | 渲染层 | ✅ 纯 JS | ~30KB gzip | MIT | React（否决：体积） | 准入 |
| vite + vite-plugin-solid | ^5 / ^2 | 构建 | 仅构建期 | - | MIT | esbuild 裸用 | 准入 |
| node-pty | 1.0.0 | 终端 | ✅ 预编译/重编 | 小 | MIT | child_process fallback | 准入 |
| zod | ^3.23 | schema 校验 | ✅ 纯 JS | 小 | MIT | 手写校验 | 准入 |
| esbuild | ^0.20 | 主进程打包 | 仅构建期 | - | MIT | tsc | 准入 |
| vitest | ^1.x | 测试 | 仅测试期 | - | MIT | - | 准入 |
| rusqlite(bundled) | 锁定 | sidecar 存储 | ✅ 静态链接 | 中 | MIT | 无（ADR-08） | 准入 |
| grep-searcher/ignore | 锁定 | sidecar 搜索 | ✅ 纯 Rust | 小 | MIT/Unlicense | rg.exe 随包（备选） | 准入 |
| serde/serde_json | 锁定 | sidecar 序列化 | ✅ 纯 Rust | 小 | MIT/Apache | - | 准入 |
| windows crate | 锁定 | DPAPI | ✅ 仅 win | 编译期 | MIT/Apache | - | 准入 |

禁入：任何需要 Node 17+ API 的包；任何无 Win7 x64 预编译且无 wasm/sidecar 替代的原生包；GPL/AGPL 链接依赖（待决策 #7 默认闭源）。

## 待决策 / 待验证登记表（本仓库相关）

| # | 事项 | 默认值 | 状态 |
|---|---|---|---|
| 1 | 商业化路径 | 自带 Key + 本地配置，ModelProvider 抽象层预留 | 按默认实现 |
| 3 | 前端框架 | Solid | 已确认（用户） |
| 4 | web.fetch 一期 | 不进；Researcher 库内调研 | 按默认实现 |
| 5 | 云端 embedding | 仅本地 | 不涉及（M5） |
| 12 | Goal 并发/预算 | 并发 2、单任务 200 轮 | 按默认实现 |
| 14 | per-user 安装/补丁向导 | 保留 per-user；补丁可跳过 | M6 |
| ? | Rust 1.77.2 下依赖编译 | 【待验证】首次 build 确认 | open |
| ? | Electron 22 Linux 冒烟（headless） | 【待验证】xvfb + --no-sandbox | open |
