// Win7 SHA-2 补丁链检测（规格 1.3 / 待决策 #14 / 7.8）
// 设计约束：注册表/命令执行全部经参数注入（queryRegistry / exec），沙箱 Linux 表驱动单测；
// 检测默认执行、可跳过、非阻塞（#14：缺 KB 只引导，不拒绝安装）。

export interface OsVersion {
  major: number;
  minor: number;
  build: number;
}

export interface OsInfo extends OsVersion {
  /** Windows 6.1 内核 */
  isWin7: boolean;
  /** SP1 = build 7601+；RTM(7600) 拒绝安装 */
  isSp1: boolean;
  isRtm: boolean;
}

/** Win7 RTM 与 SP1 判定（6.1.x）；非 6.1 内核视为非 Win7 */
export function parseOsInfo(v: OsVersion): OsInfo {
  const isWin7 = v.major === 6 && v.minor === 1;
  return {
    ...v,
    isWin7,
    isSp1: isWin7 && v.build >= 7601,
    isRtm: isWin7 && v.build < 7601,
  };
}

/**
 * SHA-2 补丁链必需 KB（规格 1.3）：
 * - KB4490628：servicing stack update（SHA-2 前置）
 * - KB4474419：SHA-2 代码签名支持（Electron 22 / NSIS 3 安装包签名依赖）
 * 仅适用于 Win7 SP1（7601）；RTM 需先装 SP1（由调用方拒绝并引导）。
 */
export const REQUIRED_KBS = ['KB4490628', 'KB4474419'] as const;

export function requiredKbs(build: number): string[] {
  if (build < 7601) return [];
  return [...REQUIRED_KBS];
}

/**
 * WMF 5.1（PowerShell 5.1）需求：Win7 SP1 上 electron-updater 的部分脚本与
 * 系统探测依赖较新 PowerShell；RTM 不可直接安装 WMF5.1（需 SP1）。
 */
export function needsWmf(build: number): boolean {
  return build >= 7601;
}

/**
 * 解析已安装 KB 清单（wmic qfe get HotFixID 或 reg query 输出兼容）：
 * 提取所有 KB\d+ 形态标记，大写归一。
 */
export function parseKbList(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/KB(\d{6,})/gi)) {
    out.add(`KB${m[1]}`);
  }
  return [...out].sort();
}

/** 缺失 KB = required - installed（保持 required 顺序：先 SSU 后 SHA-2） */
export function missingKbs(required: string[], installed: string[]): string[] {
  const have = new Set(installed.map((k) => k.toUpperCase()));
  return required.filter((k) => !have.has(k.toUpperCase()));
}

export interface KbDetectResult {
  missing: string[];
  installed: string[];
  /** true = 检测本身失败（命令不可用/异常）；按 #14 非阻塞口径放行并提示跳过 */
  detectFailed: boolean;
}

/** 生产侧命令实现：wmic qfe（Win7 自带；PowerShell 5.1 缺失时 wmic 仍可用） */
export const wmicExec = async (cmd: string, args: string[]): Promise<string> => {
  const { execFile } = (await import('child_process')) as typeof import('child_process');
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
};

/**
 * 执行 KB 检测。exec 参数注入：生产用 wmicExec('wmic', ['qfe','get','HotFixID'])，
 * 测试注入桩返回固定输出。
 */
export async function detectKbs(
  build: number,
  exec: (cmd: string, args: string[]) => Promise<string> = wmicExec
): Promise<KbDetectResult> {
  const required = requiredKbs(build);
  let output: string;
  try {
    output = await exec('wmic', ['qfe', 'get', 'HotFixID']);
  } catch {
    return { missing: required, installed: [], detectFailed: true };
  }
  const installed = parseKbList(output);
  return { missing: missingKbs(required, installed), installed, detectFailed: false };
}
