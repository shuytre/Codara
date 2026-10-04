# 便携包「丢失 ffmpeg.dll」修复报告

- **日期**：2026-10-01
- **报障**：用户解压 `Codara-portable-win7-x64.zip` 后启动 `Codara.exe`，弹窗
  `无法启动此程序，因为计算机中丢失 ffmpeg.dll。尝试重新安装该程序以解决此问题。`
- **定级**：**分发环节致命缺陷** —— CI 显示 success，但用户拿到手的产物不可用。

---

## 一、先复现，不猜测

下载线上产物实测（`gh api .../artifacts/<id>/zip`，102,525,861 字节）：

```
$ python3 -c "import zipfile; print(zipfile.ZipFile('portable.zip').namelist())"
总条目数: 1
['Codara-portable-win7-x64.zip']          ← 只有 1 个条目，且是另一个 zip
```

**产物是套娃的**：外层 zip 里装的不是应用，而是内层同名 zip。
剥开内层才发现真正的内容：

```
内层条目数: 84
['Codara.exe', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll',
 'locales', 'resources', 'resources.pak', 'snapshot_blob.bin', ...]
```

内层 **84 个条目、结构完全正确**（`ffmpeg.dll` 2,767,872 字节在位，
`resources/renderer/dist`、`resources/bin/x86_64-pc-windows-msvc/codara-sidecar.exe`
层级也都对）。

> 对照用户截图：标题栏 `...zip\Codara-portable-win7-x64.zip\` 正是这两层同名目录；
> `选定 1 / 19 个项目` 是解压工具在**二次展开内层 zip 时只解出 19 项**就停了 ——
> `ffmpeg.dll` 虽出现在列表里，但没有真正落盘。

---

## 二、根因（两个独立缺陷叠加）

### 缺陷 1：`upload-artifact@v4` 对文件再打一层 zip

旧实现（`.github/workflows/build.yml`）：

```powershell
- name: 打包便携完整包
  run: Compress-Archive -Path "$stage\*" -DestinationPath "$env:RUNNER_TEMP\Codara-portable-win7-x64.zip" -Force

- name: 上传产物 - 便携完整包
  uses: actions/upload-artifact@v4
  with:
    path: ${{ runner.temp }}/Codara-portable-win7-x64.zip     # ← 指向一个 zip 文件
```

`upload-artifact@v4` 的语义是「把 `path` 命中的内容**打包成** artifact zip」。
当 `path` 命中一个 zip 文件时，结果是 `<artifact>.zip` 里含该 zip —— **套娃**。

### 缺陷 2：`Compress-Archive` 生成的 zip 索引不可靠

`Compress-Archive` 基于 .NET `ZipArchive`，对大内容 + 多条目场景（这里是
**157MB 的 `Codara.exe` + 84 个条目**）存在已知的索引/写入不可靠问题
（且该 cmdlet 有 2GB 上限）。用户实测二次解压仅得 **19 / 84** 个文件，
缺失的正是 `ffmpeg.dll` 等运行时依赖 → Electron 加载失败 → 报「丢失 ffmpeg.dll」。

> 注意：缺陷 2 也意味着**即使不套娃**，`Compress-Archive` 的产物依然可能是坏的。

---

## 三、修复

### 3.1 不再自建 zip，让 `upload-artifact` 直接抓目录

```yaml
- name: 上传产物 - 便携完整包
  uses: actions/upload-artifact@v4
  with:
    name: codara-portable-win7-x64
    path: ${{ runner.temp }}/portable/Codara/     # ← 目录：下载得到的 zip 内层即运行目录本身
    if-no-files-found: error
    retention-days: 30
```

下载后解压**一次**即得 `Codara.exe`、`ffmpeg.dll`、`locales/`、`resources/` —— **零套娃**。

### 3.2 上传前结构自检（防「产物坏但 CI 绿」）

新增步骤 `校验便携包结构（上传前自检）`，断言 stage 中必备文件存在：

| 类别 | 断言文件 |
|---|---|
| Electron 22.3.27 运行时 | `Codara.exe`、`ffmpeg.dll`、`icudtl.dat`、`libEGL.dll`、`libGLESv2.dll`、`vk_swiftshader.dll`、`vulkan-1.dll` |
| 资源包 | `resources.pak`、`chrome_100_percent.pak`、`snapshot_blob.bin`、`v8_context_snapshot.bin` |
| 本地化 | `locales\zh-CN.pak`、`locales\en-US.pak` |
| 应用 | `resources\app\dist\main.js`、`resources\app\package.json` |
| 渲染层 | `resources\renderer\dist\index.html` |
| sidecar | `resources\bin\x86_64-pc-windows-msvc\codara-sidecar.exe` |

外加「文件总数 ≥ 60」兜底断言（正常 84 项）。任一缺失即以
`::error title=portable-stage-incomplete::` 失败。

### 3.3 上传后解压自检（闭环验证）

新增步骤 `校验已上传产物可完整解压`：

1. 用 `tar -a -c -f` 复现 upload-artifact 的抓取语义；
2. `Expand-Archive` 解压到独立目录；
3. 断言 `Codara\Codara.exe` 存在；
4. **断言 `Codara\ffmpeg.dll` 存在，且大小与源文件逐字节一致** —— 历史 bug 就死在这；
5. 打印实际解出文件数。

> 这样「套娃」和「解压丢文件」两类回归都会在 CI 里当场暴露，
> 不会再以 success 的状态流到用户手里。

---

## 四、验证

| 检查 | 结果 |
|---|---|
| YAML 语法（`yaml.safe_load`） | ✅ 2 jobs / 12 + 19 steps 解析正常 |
| 步骤顺序 | ✅ stage 组装 → 结构自检 → 上传 → 解压自检 |
| `Compress-Archive` 残留 | ✅ 仅存于注释（历史说明），代码路径已无 |
| 新产物结构 | 见下方 CI 结果 |

**CI**：run [#36813211876](https://github.com/shuytre/Codara/actions/runs/36813211876)

---

## 五、风险与回滚

| 风险 | 评估 | 缓解 |
|---|---|---|
| 改为目录上传后 artifact 名仍为 `codara-portable-win7-x64.zip` | 无 | 名字由 `name:` 决定，与 `path` 是否为目录无关 |
| `Expand-Archive` 自检步骤耗时增加 | 低 | 便携包约 100MB，解压 + 校验在秒级 |
| 结构自检误报（Electron 升级后文件名变化） | 低 | 版本锁死 22.3.27；若将来升级需同步更新断言列表 |

**回滚**：`git revert` 本 commit 即可；如需临时绕过，只删「上传前/后自检」两步不影响打包本身。

---

## 六、复盘

> 这是典型的 **「CI 绿 ≠ 交付可用」**：pipeline 每一步都返回 0，
> 但产物是套娃 + 索引损坏的 zip。
> 教训：**打包产物必须有「解压后断言关键文件存在」的闭环校验**，
> 否则错误只会在用户机器上以「丢失 xxx.dll」的形式出现。
