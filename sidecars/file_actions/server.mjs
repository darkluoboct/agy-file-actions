// Main Sidecar backend for agy-file-actions.
// Provides:
// - Workspace root auto-resolution via `agentapi get-conversation-metadata` + sidebar pushes
// - Path inspection & OS launcher actions (Reveal in Explorer, Open Folder, Open in Editor, Open Terminal)
// - Authenticated loopback IPC for MCP tools
// - Mode 2 Native Right-Click Context Menu Overlay with automatic Mode 1 fallback

import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSettingsStore, getConfigRoot } from './settings.mjs';
import { resolveTargetPath } from './path_resolver.mjs';
import { createLauncher, pickEditor, pickTerminal } from './launcher.mjs';
import { installAsyncHostRoutes, installEpipeGuard, runAgentApi, startLsWatchdog, startSelfReloadWatcher } from './host_bridge.mjs';
import { createSidebarHtml } from './sidebar_ui.mjs';
import { startContextMenuOverlay } from './context_menu_overlay.mjs';

export const PLUGIN_VERSION = '1.0.0';

export function createFileActionsEngine(options = {}) {
  const env = options.env || process.env;
  const settingsStore = options.settingsStore || createSettingsStore({ env });
  const launcher = options.launcher || createLauncher({ env });
  const fetchConvMeta = options.fetchConvMeta || (convId => runAgentApi(['get-conversation-metadata', convId], { env }));

  const workspaceCache = new Map(); // conversationId -> { roots: string[], at: number }
  let lastKnownWorkspaces = [];
  const recentPaths = []; // most-recent-first resolved targets (max 15)
  let overlayHandle = null;

  function recordRecent(target) {
    if (!target?.absolutePath) return;
    const key = `${target.absolutePath.toLowerCase()}::${target.line || ''}`;
    const idx = recentPaths.findIndex(r => `${r.absolutePath.toLowerCase()}::${r.line || ''}` === key);
    if (idx !== -1) recentPaths.splice(idx, 1);
    recentPaths.unshift({ ...target, touchedAt: Date.now() });
    if (recentPaths.length > 15) recentPaths.pop();
  }

  function rememberWorkspaces(conversationId, uris = []) {
    const clean = (Array.isArray(uris) ? uris : []).filter(u => typeof u === 'string' && u.trim());
    if (clean.length === 0) return;
    lastKnownWorkspaces = clean;
    if (conversationId) {
      workspaceCache.set(conversationId, { roots: clean, at: Date.now() });
      if (workspaceCache.size > 48) {
        const oldest = workspaceCache.keys().next().value;
        workspaceCache.delete(oldest);
      }
    }
  }

  async function resolveWorkspaceRoots(conversationId, hintUris = []) {
    if (Array.isArray(hintUris) && hintUris.length > 0) {
      rememberWorkspaces(conversationId, hintUris);
      return hintUris;
    }
    if (conversationId) {
      const cached = workspaceCache.get(conversationId);
      if (cached && Date.now() - cached.at < 60_000) return cached.roots;
      try {
        const res = await fetchConvMeta(conversationId);
        const meta = res?.response?.conversationMetadata?.metadata || res?.payload?.conversationMetadata?.metadata;
        const fromArr = Array.isArray(meta?.workspaceUris) ? meta.workspaceUris : [];
        const fromObjs = Array.isArray(meta?.workspaces)
          ? meta.workspaces.map(w => w?.workspaceFolderAbsoluteUri).filter(Boolean)
          : [];
        const roots = [...new Set([...fromObjs, ...fromArr])];
        if (roots.length > 0) {
          rememberWorkspaces(conversationId, roots);
          return roots;
        }
      } catch {}
    }
    return lastKnownWorkspaces;
  }

  async function inspectPath({ rawInput, conversationId = '', workspaceUris = [] } = {}) {
    const settings = settingsStore.read();
    const roots = await resolveWorkspaceRoots(conversationId, workspaceUris);
    const target = resolveTargetPath(rawInput, {
      workspaceRoots: roots,
      slashStyle: settings.pathSlashStyle,
      env,
    });
    const capabilities = launcher.getCapabilities();
    const activeEditor = pickEditor(capabilities.editors, settings);
    const activeTerminal = pickTerminal(capabilities.terminals, settings);
    return {
      target,
      settings,
      capabilities,
      activeEditor,
      activeTerminal,
    };
  }

  async function executeAction({ action, rawInput, conversationId = '', workspaceUris = [], editorId = '', terminalId = '' } = {}) {
    const inspected = await inspectPath({ rawInput, conversationId, workspaceUris });
    if (!inspected.target) {
      throw new Error('Unable to resolve target path');
    }
    recordRecent(inspected.target);

    if (action === 'reveal') {
      return await launcher.revealInExplorer(inspected.target);
    }
    if (action === 'open-folder') {
      return await launcher.openContainingFolder(inspected.target);
    }
    if (action === 'open-editor') {
      return await launcher.openInEditor(inspected.target, inspected.settings, editorId);
    }
    if (action === 'open-terminal') {
      return await launcher.openTerminalHere(inspected.target, inspected.settings, terminalId);
    }
    if (action === 'record-copy') {
      return { ok: true, action: 'record-copy', target: inspected.target };
    }
    throw new Error(`Unsupported action: ${action}`);
  }

  async function getState({ conversationId = '', workspaceUris = [] } = {}) {
    if (workspaceUris?.length) rememberWorkspaces(conversationId, workspaceUris);
    const settings = settingsStore.read();
    const capabilities = launcher.getCapabilities();
    const activeEditor = pickEditor(capabilities.editors, settings);
    const activeTerminal = pickTerminal(capabilities.terminals, settings);
    return {
      version: PLUGIN_VERSION,
      settings,
      capabilities,
      activeEditor,
      activeTerminal,
      recentPaths: recentPaths.slice(0, 15),
      overlay: overlayHandle ? overlayHandle.getStatus() : { status: settings.overlayEnabled ? 'starting' : 'disabled' },
    };
  }

  function setOverlayHandle(handle) {
    overlayHandle = handle;
  }

  return {
    settingsStore,
    launcher,
    inspectPath,
    executeAction,
    getState,
    rememberWorkspaces,
    setOverlayHandle,
  };
}

function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 512 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolvePromise({});
      try { resolvePromise(JSON.parse(body)); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

export async function startIpcServer(engine, options = {}) {
  const env = options.env || process.env;
  const token = randomBytes(24).toString('hex');
  const stateRoot = getConfigRoot(env);
  mkdirSync(stateRoot, { recursive: true });

  const server = createServer(async (req, res) => {
    if (String(req.headers['x-file-actions-token'] || '') !== token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      const data = req.method === 'POST' ? await readJsonBody(req) : {};
      let result;
      if (req.method === 'POST' && url.pathname === '/internal/state') {
        result = await engine.getState(data);
      } else if (req.method === 'POST' && url.pathname === '/internal/inspect') {
        result = await engine.inspectPath(data);
      } else if (req.method === 'POST' && url.pathname === '/internal/action') {
        result = await engine.executeAction(data);
      } else if (req.method === 'POST' && url.pathname === '/internal/settings') {
        result = { settings: engine.settingsStore.update(data) };
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
  });

  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  const ipcPath = join(stateRoot, 'ipc.json');
  const tmp = `${ipcPath}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ port, token, pid: process.pid, lsAddress: env.ANTIGRAVITY_LS_ADDRESS || '' }, null, 2) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  );
  renameSync(tmp, ipcPath);
  console.log(`[file-actions] IPC server listening on 127.0.0.1:${port}`);

  return {
    port,
    token,
    ipcPath,
    close: () => new Promise(resolveClose => server.close(() => resolveClose())),
  };
}

export async function startSidecarPanel(engine, loadSdk = () => import('sidecar_sdk'), env = process.env) {
  if (!env.ANTIGRAVITY_SIDECAR_UI_TOKEN?.trim()) {
    console.error('[file-actions] sidebar disabled: host did not supply a UI token');
    return null;
  }
  const { SidecarApp } = await loadSdk();
  const app = new SidecarApp();
  const uiHtml = createSidebarHtml({ version: PLUGIN_VERSION });

  app.page('/', () => uiHtml);
  app.page('/ui.html', () => uiHtml);

  app.api('/api/state', (data = {}) =>
    engine.getState({
      conversationId: data.conversationId || app.config?.conversationId || '',
      workspaceUris: data.workspaceUris || [],
    }), 'POST');

  app.api('/api/inspect', (data = {}) =>
    engine.inspectPath({
      rawInput: data.rawInput || '',
      conversationId: data.conversationId || app.config?.conversationId || '',
      workspaceUris: data.workspaceUris || [],
    }), 'POST');

  app.api('/api/action', (data = {}) =>
    engine.executeAction({
      action: data.action || '',
      rawInput: data.rawInput || '',
      conversationId: data.conversationId || app.config?.conversationId || '',
      workspaceUris: data.workspaceUris || [],
      editorId: data.editorId || '',
      terminalId: data.terminalId || '',
    }), 'POST');

  app.api('/api/settings', (data = {}) => ({ settings: engine.settingsStore.update(data) }), 'POST');

  const ready = app.run();
  installAsyncHostRoutes(app);
  await ready;
  return app;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  installEpipeGuard();
  const engine = createFileActionsEngine();
  const ipc = await startIpcServer(engine);

  const productRoot = dirname(dirname(dirname(
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    join(getConfigRoot(), '..', '..', 'antigravity', 'sidecar_data', 'agy-file-actions', 'file_actions', 'data'),
  )));
  const overlay = startContextMenuOverlay(engine, {
    env: process.env,
    productRoots: [productRoot],
  });
  engine.setOverlayHandle(overlay);

  let panelApp = null;
  if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
    panelApp = await startSidecarPanel(engine);
  }

  let stopping = false;
  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    console.log('[file-actions] shutting down:', reason);
    stopWatchdog();
    stopReload();
    try { await overlay.stop(); } catch {}
    try { await ipc.close(); } catch {}
    try { await panelApp?.close?.(); } catch {}
    process.exit(0);
  };

  const stopReload = startSelfReloadWatcher(dirname(fileURLToPath(import.meta.url)), shutdown);
  const stopWatchdog = startLsWatchdog(process.env.ANTIGRAVITY_LS_ADDRESS, shutdown);
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => void shutdown(sig));
  }
}
