// Codara 主进程入口：窗口生命周期、sidecar 托管、IPC 注册、恢复入口（M4）
import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import * as path from 'path';

import { registerIpcHandlers } from './ipc/handlers';
import { SidecarManager } from './sidecar/manager';
import { SettingsStore } from './config/settingsStore';
import { ModelClient } from './model/client';
import { BudgetLedger } from './budget/ledger';
import { AgentLoop } from './loop/agentLoop';
import { ApprovalGateway } from './tools/gateway';
import { ToolRuntime } from './tools/runtime';
import { CrewScheduler } from './crew/scheduler';
import { IPC } from '@codara/contract';
import { logger } from './util/logger';

/** 中文应用菜单（保留 Electron 内置角色与快捷键） */
function setupChineseMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [{ role: 'quit', label: '退出' }],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '最大化' },
        { role: 'close', label: '关闭' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 Codara',
          click: () => {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win) return;
            void dialog.showMessageBox(win, {
              type: 'info',
              title: '关于 Codara',
              message: 'Codara 对话式编程 Agent',
              detail: 'Win7 SP1+ / Electron 22 · 支持 DeepSeek、Agnes、GLM、通义千问、Kimi 与任意 OpenAI 兼容端点',
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let mainWindow: BrowserWindow | null = null;

// Win7 兼容：老显卡驱动 + Chromium 108 的 GPU 进程崩溃会导致白屏（窗口只有底色）
// 统一禁用硬件加速走软件合成，稳定优先
app.disableHardwareAcceleration();

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  setupChineseMenu();

  app
    .whenReady()
    .then(onReady)
    .catch((err) => {
      // onReady 未捕获异常兜底：至少留下日志，避免无窗口假死
      logger.error('onReady fatal error', err);
    });
}

async function onReady(): Promise<void> {
  // 数据目录：per-user（规格 5.3）
  const userData = path.join(app.getPath('appData'), 'Codara');
  app.setPath('userData', userData);

  const settings = new SettingsStore(userData);
  const sidecar = new SidecarManager(userData);

  // 引擎启动容错：sidecar 缺失/崩溃时仍创建窗口（UI 降级显示），
  // 避免 await 链抛错后 createWindow 永不执行 → 用户看到"点击无反应"
  let sidecarReady = false;
  try {
    await sidecar.start();
    await sidecar.initialize(settings.get('workspacePath') || undefined);
    // DB 迁移（sessions/messages/usage/audit/crew 表）
    await sidecar.call('db.migrate', {});
    sidecarReady = true;
  } catch (err) {
    logger.error('sidecar startup failed, launching UI in degraded mode', err);
  }

  const budget = new BudgetLedger(sidecar, settings);
  const model = new ModelClient(settings, budget);
  const gateway = new ApprovalGateway(sidecar);

  // M3：专家团调度器（并发 2 可配；事件经 webContents 广播给渲染层角色树）
  const scheduler = new CrewScheduler(sidecar, model, budget, settings, (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  });
  const tools = new ToolRuntime(sidecar, budget, gateway, settings, scheduler);
  scheduler.attachTools(tools);
  const loop = new AgentLoop(model, sidecar, settings, budget, tools);

  // 主对话会话（kind=main，roleId=main 持久化）
  if (sidecarReady) {
    try {
      const mainSess = await sidecar.call('session.create', { kind: 'main', title: '主对话' });
      const sessData = mainSess.data as { sessionId?: string } | undefined;
      if (mainSess.ok && sessData?.sessionId) {
        loop.attachMainSession(String(sessData.sessionId));
      }
    } catch (err) {
      logger.warn('main session create failed', err);
    }
  }

  registerIpcHandlers({
    mainWindowRef: () => mainWindow,
    settings,
    sidecar,
    model,
    loop,
    budget,
    tools,
    scheduler,
    gateway,
  });

  // M4：启动时检查过期锁 → 崩溃恢复入口（规格 4.6）
  let stale: Array<{ name: string; owner: string; heartbeat: number }> = [];
  if (sidecarReady) {
    try {
      const locks = await sidecar.call('lock.inspect', {});
      logger.info('startup lock inspect', locks);
      stale = ((locks.data as { stale?: Array<{ name: string; owner: string; heartbeat: number }> })?.stale ??
        []) as Array<{ name: string; owner: string; heartbeat: number }>;
    } catch (err) {
      logger.warn('lock inspect failed', err);
    }
  }

  createWindow(settings);

  if (stale.length > 0 && mainWindow) {
    mainWindow.webContents.send(IPC.recoveryNeeded, { locks: stale });
  }
}

function createWindow(settings: SettingsStore): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    show: false,
    backgroundColor: '#f5f6f7',
    title: 'Codara',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需要 require contract
      spellcheck: false,
    },
  });

  const ui = settings.get('ui');
  if (ui.minimalMode) {
    // 极简模式：无动画
    mainWindow.once('ready-to-show', () => mainWindow?.show());
  } else {
    mainWindow.once('ready-to-show', () => mainWindow?.show());
  }
  // 兜底：渲染层 8s 内未触发 ready-to-show（GPU/渲染异常）也强制显示窗口，
  // 让用户看到界面状态而非"点击无反应"
  const showTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      logger.warn('ready-to-show timeout, force showing window');
      mainWindow.show();
    }
  }, 8000);
  mainWindow.once('closed', () => clearTimeout(showTimer));

  if (process.env.CODARA_DEV_URL) {
    void mainWindow.loadURL(process.env.CODARA_DEV_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../../renderer/dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 清理 sidecar 由 SidecarManager.dispose 处理
});

export { mainWindow as MainWindowRef };
