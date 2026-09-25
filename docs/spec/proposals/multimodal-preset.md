# 立项：多模态预设（截图 + 视觉输入）

> 对应规格：3.1 Agent 预设表「多模态（二期）：标准 + screenshot/视觉输入，底座需具备视觉」；
> 表 6-1 `ui.screenshot`「Win7 用 GDI/DWM 兜底，auto（多模态预设）」。

## 范围

- 新预设 `multimodal`：工具面 = 标准五工具 + `ui.screenshot` + `image.read`（视觉文件读取）。
- `ui.screenshot`（sidecar）：对指定窗口/全屏截图 → PNG → 缓存引用返回。
  - Win10/8：DXGI/DWM 缩放路径；**Win7 兜底：GDI BitBlt**（DWM 关闭亦可），分层窗口注明限制。
  - DPI 感知：按系统缩放修正坐标，输出实际像素尺寸。
- `image.read`：本地图片 → base64 → 视觉消息（走 OpenAI 兼容 `image_url` 或厂商适配层）；仅当底座声明视觉能力时注册，UI 明示。
- Tester 角色工具矩阵追加 screenshot（规格 4.2 表：Tester 含 screenshot），验收报告支持附截图。
- 预设选择：设置页 Agent 预设区新增「多模态（底座需视觉）」，不声明视觉的底座禁用并提示。

## 非目标

- 不做 OCR 本地化识别（识别交给底座视觉模型）。
- 不做录屏/连续帧；不做区域交互式标注编辑器（MVP：整窗/全屏 + 系统选窗）。

## WBS

1. sidecar `capture/` 模块：GDI 路径（Win7 主路径，先做）+ DXGI 路径（8/10/11 优化）+ 窗口枚举。
2. `ui.screenshot`/`image.read` RPC + 缓存 + 信封；契约类型扩展（视觉消息）。
3. electron model 适配层：视觉消息装配（按底座能力开关）。
4. 预设/角色矩阵/设置页接线；权限网关 `ui.screenshot` → auto（仅多模态预设）。
5. 测试：Linux 桩（像素合成图）+ Win7 真机项归档（GDI 截全屏/截窗/DPI 125%/150%）。

## 验收标准

- Win7 SP1（DWM 开/关）截全屏与指定窗口成功，PNG 可读，DPI 150% 下坐标不偏移。
- 视觉底座开启预设后，模型可基于截图回答内容问题（人工验收 3 例）。
- 非视觉底座时预设不可选；`image.read` 不注册。
- Win7 真机项归档回归清单（F 节）。

## 风险与体积成本

- 风险：GDI 对硬件加速层内容（视频）可能截黑——验收口径为「UI 截图比对可用」；DXGI 路径在 8/10 的多屏混合 DPI 需实测。
- 体积：sidecar 增量 ~150–250KB（GDI/DXGI 原生调用，无第三方大依赖）。
- 工期：2 周（真机调 DPI/多屏为主）。
