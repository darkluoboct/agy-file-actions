// Mode 2 Native Right-Click Context Menu Overlay for agy-file-actions.
// - Connects ONLY to loopback 127.0.0.1 via user-enabled DevToolsActivePort.
// - Intercepts `contextmenu` ONLY when a valid file link or file/folder path is
//   right-clicked (and never when Shift is held), preserving native menus everywhere else.
// - Renders an isolated Shadow DOM menu following Antigravity's theme CSS variables.
// - Zero emoji, zero React fiber probing, instant fallback to Mode 1 Sidebar when CDP is absent.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BINDING_NAME = '__agyFileActionsBridge';
const INSTANCE_TS = Date.now();
const POLL_MS = 1200;

function defaultPortFile() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Antigravity', 'DevToolsActivePort');
}

// Self-contained runtime executed in the Antigravity renderer document.
function installContextMenuRuntime(owner, hash, bindingName) {
  const prev = globalThis.__agyFileActionsOverlay;
  if (prev?.owner > owner) return 'superseded';
  prev?.dispose();

  let disposed = false;
  let activeReqId = 0;
  let activeContext = null; // { reqId, rawInput, conversationId, x, y, inspected }
  let hostEl = null;
  let shadowRoot = null;
  let toastTimer = null;

  function cleanEdge(s) {
    return String(s || '')
      .trim()
      .replace(/^[`"'<(\[]+/, '')
      .replace(/[`"'>)\],;]+$/, '')
      .trim();
  }

  function looksLikeAbsolutePath(raw) {
    const s = cleanEdge(raw);
    if (!s || s.length > 512 || /[\r\n\0]/.test(s)) return false;
    if (/^(https?|mailto|sidecar|customization|javascript|data|conversation):/i.test(s)) return false;
    if (/^file:\/\/\/?/i.test(s)) return true;
    if (/^[A-Za-z]:[\\/][^<>|?*\r\n]+$/.test(s)) return true;
    if (/^\\\\[^\\\s]+\\[^<>|?*\r\n]+$/.test(s)) return true;
    if (/^~[\\/][^<>|?*\r\n]+$/.test(s)) return true;
    if (/^%[A-Za-z0-9_]+%[\\/][^<>|?*\r\n]+$/.test(s)) return true;
    return false;
  }

  function looksLikeRelativePath(raw) {
    const s = cleanEdge(raw);
    if (!s || s.length < 3 || s.length > 260 || /[\r\n\0]/.test(s)) return false;
    if (/^(https?|mailto|sidecar|customization|javascript|data|conversation):/i.test(s)) return false;
    if (/[;{}()=<>|*?"]/.test(s)) return false;
    if (!/[\\/]/.test(s)) return false;
    // Strip optional :line:col or #Lline before validating path body
    const base = s.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '');
    if (!base || /\s{2,}/.test(base)) return false;
    // Allow spaces only if it ends with a plausible file extension
    if (/\s/.test(base) && !/\.[A-Za-z0-9]{1,8}$/.test(base)) return false;
    // Reject obvious ratios/dates like 2026/11/26 or 1/2
    if (/^\d+[\\/]\d+(?:[\\/]\d+)?$/.test(base)) return false;
    // Must contain at least one letter/CJK char and a meaningful filename or trailing slash
    return /[A-Za-z\u4e00-\u9fff]/.test(base) && /(?:\/|\\)$|\.[A-Za-z0-9_-]{1,10}$|[\\/][A-Za-z0-9._-]{2,}$/.test(base);
  }

  function looksLikeAnyPath(raw) {
    return looksLikeAbsolutePath(raw) || looksLikeRelativePath(raw);
  }

  function extractCandidate(target) {
    if (!target || !(target instanceof Element)) return null;

    // 1. User-selected single-line path text takes priority when right-clicked
    const sel = String(window.getSelection?.()?.toString() || '').trim();
    if (sel && !/[\r\n]/.test(sel) && looksLikeAnyPath(sel)) {
      return { rawInput: cleanEdge(sel), source: 'selection' };
    }

    // 2. Direct file:// anchor links (e.g. markdown clickable file links in responses)
    const link = target.closest('a[href]');
    if (link) {
      const href = link.getAttribute('href') || '';
      if (/^file:\/\//i.test(href)) {
        return { rawInput: href, source: 'file-link' };
      }
    }

    // 3. Elements carrying explicit file URI / path attributes or path tooltips
    const withAttr = target.closest('[data-file-uri], [data-uri], [data-path], [data-file-path], [title]');
    if (withAttr) {
      for (const attr of ['data-file-uri', 'data-uri', 'data-file-path', 'data-path', 'title']) {
        const val = withAttr.getAttribute(attr);
        if (val && looksLikeAbsolutePath(val)) {
          return { rawInput: cleanEdge(val), source: attr };
        }
      }
    }

    // 4. Inline <code> or short clickable filename chip inside conversation messages
    const code = target.closest('code');
    if (code) {
      const txt = String(code.innerText || code.textContent || '').trim();
      if (txt && !/[\r\n]/.test(txt) && looksLikeAnyPath(txt)) {
        return { rawInput: cleanEdge(txt), source: 'code' };
      }
    }

    // 5. Short leaf element whose visible text is an unambiguous absolute path
    const leafText = String(target.innerText || target.textContent || '').trim();
    if (leafText && leafText.length <= 320 && !/[\r\n]/.test(leafText) && looksLikeAbsolutePath(leafText)) {
      return { rawInput: cleanEdge(leafText), source: 'text' };
    }

    return null;
  }

  function detectConversationId(target) {
    const view = target?.closest?.('[data-testid="conversation-view"]') || document.querySelector('[data-testid="conversation-view"]');
    const attrId = view?.getAttribute?.('data-cascade-id') || '';
    if (/^[0-9a-f-]{36}$/i.test(attrId)) return attrId;
    const m = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    return m ? m[1] : '';
  }

  function emit(payload) {
    const fn = globalThis[bindingName];
    if (typeof fn !== 'function') return;
    try { fn(JSON.stringify(payload)); } catch {}
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ensureHost() {
    if (hostEl && hostEl.isConnected) return hostEl;
    const stale = document.getElementById('agy-file-actions-menu-host');
    if (stale) stale.remove();

    hostEl = document.createElement('div');
    hostEl.id = 'agy-file-actions-menu-host';
    hostEl.setAttribute('translate', 'no');
    hostEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483640;';
    shadowRoot = hostEl.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = `
      <style>
        :host {
          font-family: "Source Han Sans CN", "Microsoft YaHei UI", system-ui, -apple-system, sans-serif;
          font-size: 12.5px;
          color: var(--foreground, #e5e7eb);
        }
        .fa-menu {
          position: fixed;
          min-width: 236px;
          max-width: 340px;
          padding: 5px;
          border-radius: 10px;
          border: 1px solid color-mix(in srgb, var(--foreground, #fff) 14%, transparent);
          background: var(--card, #181a20);
          color: var(--foreground, #e5e7eb);
          box-shadow: 0 14px 36px -8px rgba(0, 0, 0, 0.48), 0 2px 8px rgba(0, 0, 0, 0.28);
          pointer-events: auto;
          user-select: none;
          display: none;
        }
        .fa-menu.open { display: block; }
        .fa-head {
          padding: 5px 8px 6px;
          border-bottom: 1px solid color-mix(in srgb, var(--foreground, #fff) 10%, transparent);
          margin-bottom: 4px;
        }
        .fa-name {
          font-weight: 600;
          font-size: 12px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .fa-sub {
          margin-top: 2px;
          font-family: ui-monospace, Consolas, monospace;
          font-size: 10.5px;
          color: var(--muted-foreground, #9ca3af);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .fa-warn {
          margin-top: 3px;
          font-size: 10.5px;
          color: #f59e0b;
        }
        button.fa-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          width: 100%;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: inherit;
          font-family: inherit;
          font-size: 12.5px;
          text-align: left;
          padding: 6px 8px;
          cursor: pointer;
        }
        button.fa-item:hover:not(:disabled) {
          background: color-mix(in srgb, var(--foreground, #fff) 10%, transparent);
        }
        button.fa-item:disabled {
          opacity: 0.42;
          cursor: not-allowed;
        }
        .fa-hint {
          font-size: 11px;
          color: var(--muted-foreground, #9ca3af);
          flex-shrink: 0;
        }
        .fa-sep {
          height: 1px;
          margin: 4px 6px;
          background: color-mix(in srgb, var(--foreground, #fff) 10%, transparent);
        }
        .fa-foot {
          margin-top: 4px;
          padding: 4px 8px 2px;
          border-top: 1px solid color-mix(in srgb, var(--foreground, #fff) 8%, transparent);
          font-size: 10.5px;
          color: var(--muted-foreground, #9ca3af);
        }
        .fa-toast {
          position: fixed;
          right: 18px;
          bottom: 18px;
          padding: 8px 12px;
          border-radius: 8px;
          background: #18181b;
          color: #fafafa;
          border: 1px solid rgba(255, 255, 255, 0.16);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
          font-size: 12px;
          opacity: 0;
          transform: translateY(6px);
          transition: opacity 0.15s, transform 0.15s;
          pointer-events: none;
        }
        .fa-toast.show {
          opacity: 1;
          transform: translateY(0);
        }
      </style>
      <div class="fa-menu" id="faMenu" role="menu"></div>
      <div class="fa-toast" id="faToast"></div>
    `;

    shadowRoot.getElementById('faMenu').addEventListener('click', e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn || btn.disabled || !activeContext) return;
      const act = btn.dataset.act;
      const editorId = btn.dataset.editor || '';
      handleMenuClick(act, editorId);
    });

    document.documentElement.appendChild(hostEl);
    return hostEl;
  }

  function showToast(msg) {
    ensureHost();
    const el = shadowRoot.getElementById('faToast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1900);
  }

  function closeMenu() {
    activeContext = null;
    const menu = shadowRoot?.getElementById('faMenu');
    if (menu) {
      menu.classList.remove('open');
      menu.innerHTML = '';
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  async function handleMenuClick(act, editorId) {
    const ctx = activeContext;
    if (!ctx) return;
    const t = ctx.inspected?.target;
    closeMenu();

    if (act === 'copy-abs') {
      const val = t?.formattedAbsolutePath || ctx.rawInput;
      await copyText(val);
      showToast('已复制绝对路径');
      emit({ type: 'action', action: 'record-copy', rawInput: ctx.rawInput, conversationId: ctx.conversationId });
      return;
    }
    if (act === 'copy-rel') {
      const val = t?.relativePath || t?.formattedAbsolutePath || ctx.rawInput;
      await copyText(val);
      showToast('已复制相对路径');
      emit({ type: 'action', action: 'record-copy', rawInput: ctx.rawInput, conversationId: ctx.conversationId });
      return;
    }
    if (act === 'copy-line') {
      const val = t?.copyWithLine || t?.formattedAbsolutePath || ctx.rawInput;
      await copyText(val);
      showToast('已复制带行号引用');
      emit({ type: 'action', action: 'record-copy', rawInput: ctx.rawInput, conversationId: ctx.conversationId });
      return;
    }
    if (act === 'copy-name') {
      const val = t?.fileName || ctx.rawInput;
      await copyText(val);
      showToast('已复制文件名');
      emit({ type: 'action', action: 'record-copy', rawInput: ctx.rawInput, conversationId: ctx.conversationId });
      return;
    }

    emit({
      type: 'action',
      action: act,
      rawInput: ctx.rawInput,
      conversationId: ctx.conversationId,
      editorId,
    });
  }

  function positionMenu(menu, x, y) {
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.add('open');
    const r = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function renderMenu() {
    if (!activeContext) return;
    ensureHost();
    const menu = shadowRoot.getElementById('faMenu');
    const info = activeContext.inspected;
    const t = info?.target;

    const title = t?.fileName || activeContext.rawInput.split(/[\\/]/).filter(Boolean).at(-1) || activeContext.rawInput;
    const sub = t ? (t.relativePath || t.formattedAbsolutePath) : activeContext.rawInput;
    const lineTag = t?.line ? ` :${t.line}` : '';
    const exists = info ? Boolean(t?.exists) : true;
    const isDir = Boolean(t?.isDirectory);
    const canOpenAncestor = Boolean(t?.nearestExistingDir);

    const activeEd = info?.activeEditor || { id: 'auto', name: '外部编辑器' };
    const activeTerm = info?.activeTerminal || { id: 'auto', name: '终端' };
    const editors = info?.capabilities?.editors || [];
    const altEditors = editors.filter(e => e.id !== activeEd.id && e.id !== 'system').slice(0, 1);

    const items = [];
    items.push(
      '<div class="fa-head">' +
        '<div class="fa-name">' + esc(title + lineTag) + '</div>' +
        '<div class="fa-sub" title="' + esc(t?.formattedAbsolutePath || activeContext.rawInput) + '">' + esc(sub) + '</div>' +
        (info && !exists
          ? '<div class="fa-warn">' + (canOpenAncestor ? '目标不存在，可打开最近的上级目录' : '目标路径不存在') + '</div>'
          : '') +
      '</div>',
    );

    // 1. Explorer actions
    const revealLabel = !exists
      ? '打开最近的上级目录'
      : isDir
        ? '在资源管理器中打开'
        : '在资源管理器中定位';
    items.push(
      '<button class="fa-item" data-act="reveal"' + (info && !exists && !canOpenAncestor ? ' disabled' : '') + '>' +
        '<span>' + esc(revealLabel) + '</span>' +
        '<span class="fa-hint">Explorer</span>' +
      '</button>',
    );
    if (!isDir) {
      items.push(
        '<button class="fa-item" data-act="open-folder"' + (info && !exists && !canOpenAncestor ? ' disabled' : '') + '>' +
          '<span>打开所在文件夹</span>' +
        '</button>',
      );
    }

    items.push('<div class="fa-sep"></div>');

    // 2. Editor & Terminal actions
    const edLabel = activeEd.id === 'system'
      ? '用系统默认程序打开'
      : '在 ' + activeEd.name + ' 中打开' + (t?.line ? '（第 ' + t.line + ' 行）' : '');
    items.push(
      '<button class="fa-item" data-act="open-editor"' + (info && !exists ? ' disabled' : '') + '>' +
        '<span>' + esc(edLabel) + '</span>' +
      '</button>',
    );
    for (const alt of altEditors) {
      items.push(
        '<button class="fa-item" data-act="open-editor" data-editor="' + esc(alt.id) + '"' + (info && !exists ? ' disabled' : '') + '>' +
          '<span>在 ' + esc(alt.name) + ' 中打开</span>' +
        '</button>',
      );
    }
    if (activeEd.id !== 'system') {
      items.push(
        '<button class="fa-item" data-act="open-editor" data-editor="system"' + (info && !exists ? ' disabled' : '') + '>' +
          '<span>用系统默认程序打开</span>' +
        '</button>',
      );
    }
    items.push(
      '<button class="fa-item" data-act="open-terminal"' + (info && !exists && !canOpenAncestor ? ' disabled' : '') + '>' +
        '<span>在此处打开终端</span>' +
        '<span class="fa-hint">' + esc(activeTerm.name) + '</span>' +
      '</button>',
    );

    items.push('<div class="fa-sep"></div>');

    // 3. Copy actions
    items.push('<button class="fa-item" data-act="copy-abs"><span>复制绝对路径</span></button>');
    if (t?.relativePath) {
      items.push('<button class="fa-item" data-act="copy-rel"><span>复制相对路径</span></button>');
    }
    if (t?.line) {
      items.push('<button class="fa-item" data-act="copy-line"><span>复制带行号引用</span><span class="fa-hint">:' + esc(t.line) + '</span></button>');
    }
    items.push('<button class="fa-item" data-act="copy-name"><span>复制文件名</span></button>');

    items.push('<div class="fa-foot">按住 Shift + 右键 使用系统原生菜单</div>');

    menu.innerHTML = items.join('');
    positionMenu(menu, activeContext.x, activeContext.y);
  }

  function onContextMenu(e) {
    if (disposed) return;
    if (e.shiftKey) {
      closeMenu();
      return;
    }
    if (hostEl && e.composedPath().includes(hostEl)) {
      e.preventDefault();
      return;
    }
    const candidate = extractCandidate(e.target);
    if (!candidate) {
      closeMenu();
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const reqId = ++activeReqId;
    const conversationId = detectConversationId(e.target);
    activeContext = {
      reqId,
      rawInput: candidate.rawInput,
      conversationId,
      x: e.clientX,
      y: e.clientY,
      inspected: null,
    };
    renderMenu();
    emit({
      type: 'inspect',
      reqId,
      rawInput: candidate.rawInput,
      conversationId,
    });
  }

  function onGlobalPointerDown(e) {
    if (!activeContext) return;
    if (hostEl && e.composedPath().includes(hostEl)) return;
    closeMenu();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && activeContext) {
      closeMenu();
    }
  }

  function onDismiss() {
    if (activeContext) closeMenu();
  }

  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('pointerdown', onGlobalPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onDismiss);
  window.addEventListener('resize', onDismiss);
  window.addEventListener('scroll', onDismiss, true);

  const api = {
    owner,
    hash,
    ping(caller) {
      if (caller < owner) return 'superseded';
      return { owner, hash, alive: !disposed };
    },
    receiveInspect(caller, reqId, inspected) {
      if (caller < owner) return 'superseded';
      if (disposed || !activeContext || activeContext.reqId !== reqId) return false;
      activeContext.inspected = inspected;
      renderMenu();
      return true;
    },
    notifyToast(caller, text) {
      if (caller < owner) return 'superseded';
      if (!disposed && text) showToast(text);
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      closeMenu();
      clearTimeout(toastTimer);
      document.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('pointerdown', onGlobalPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onDismiss);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('scroll', onDismiss, true);
      hostEl?.remove();
      hostEl = null;
      shadowRoot = null;
      if (globalThis.__agyFileActionsOverlay === api) {
        delete globalThis.__agyFileActionsOverlay;
      }
    },
  };

  globalThis.__agyFileActionsOverlay = api;
  return true;
}

export function buildContextMenuBundle(owner = INSTANCE_TS) {
  const src = installContextMenuRuntime.toString();
  const hash = createHash('sha256').update(src).digest('hex').slice(0, 16);
  const code = `(()=>{if(globalThis.__agyFileActionsOverlay?.owner>${Number(owner)})return 'superseded';${src}\nreturn installContextMenuRuntime(${Number(owner)},${JSON.stringify(hash)},${JSON.stringify(BINDING_NAME)});})()`;
  return { code, hash };
}

function createComposerOriginResolver(productRoots = [], env = process.env) {
  let cachedOrigin = null;
  let cachedAddr = '';
  return function resolveOrigin() {
    const addr = env.ANTIGRAVITY_LS_ADDRESS || '';
    if (cachedOrigin && cachedAddr === addr) return cachedOrigin;
    const m = /^(127\.0\.0\.1|localhost):([1-9]\d{0,4})$/.exec(addr);
    if (!m) return null;
    const httpPort = Number(m[2]);
    for (const root of productRoots) {
      try {
        const hub = JSON.parse(readFileSync(join(root, 'daemon', `hub_${httpPort}.json`), 'utf8'));
        if (hub?.httpPort === httpPort && Number.isInteger(hub.httpsPort)) {
          cachedOrigin = `https://127.0.0.1:${hub.httpsPort}`;
          cachedAddr = addr;
          return cachedOrigin;
        }
      } catch {}
    }
    return null;
  };
}

export function startContextMenuOverlay(engine, options = {}) {
  const owner = options.instanceTs ?? INSTANCE_TS;
  const portFile = options.portFile || defaultPortFile();
  const resolveOrigin = createComposerOriginResolver(options.productRoots || [], options.env || process.env);
  const bundle = buildContextMenuBundle(owner);

  const sockets = new Map();
  let status = engine.settingsStore.read().overlayEnabled ? 'starting' : 'disabled';
  let lastError = '';
  let stopped = false;
  let busy = false;
  let cachedTargets = [];
  let lastListAt = 0;

  function retire(id, entry) {
    if (!entry || entry.closed) return;
    entry.closed = true;
    for (const cb of entry.pending.values()) cb(undefined);
    entry.pending.clear();
    try { entry.ws.close(); } catch {}
    if (sockets.get(id) === entry) sockets.delete(id);
  }

  function sendCommand(entry, method, params = {}) {
    return new Promise(resolvePromise => {
      if (!entry || entry.ws.readyState !== 1) return resolvePromise(undefined);
      const id = entry.nextId++;
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        resolvePromise(undefined);
      }, 3000);
      entry.pending.set(id, msg => {
        clearTimeout(timer);
        resolvePromise(msg?.result);
      });
      try {
        entry.ws.send(JSON.stringify({ id, method, params }));
      } catch {
        clearTimeout(timer);
        entry.pending.delete(id);
        resolvePromise(undefined);
      }
    });
  }

  async function evaluate(entry, expression) {
    if (!entry?.context) return undefined;
    const res = await sendCommand(entry, 'Runtime.evaluate', {
      uniqueContextId: entry.context,
      expression,
      returnByValue: true,
    });
    return res?.result?.value;
  }

  async function handleBinding(entry, payloadStr) {
    let msg;
    try { msg = JSON.parse(payloadStr); } catch { return; }

    if (msg.type === 'inspect') {
      try {
        const inspected = await engine.inspectPath({
          rawInput: msg.rawInput,
          conversationId: msg.conversationId || '',
        });
        await evaluate(
          entry,
          `globalThis.__agyFileActionsOverlay?.receiveInspect(${owner},${Number(msg.reqId)},${JSON.stringify(inspected)})`,
        );
      } catch {}
      return;
    }

    if (msg.type === 'action') {
      try {
        const res = await engine.executeAction({
          action: msg.action,
          rawInput: msg.rawInput,
          conversationId: msg.conversationId || '',
          editorId: msg.editorId || '',
          terminalId: msg.terminalId || '',
        });
        if (msg.action === 'record-copy') return;
        let toast = '';
        if (msg.action === 'reveal') {
          toast = res.fallbackToAncestor ? '目标不存在，已打开最近的上级目录' : '已在资源管理器中定位';
        } else if (msg.action === 'open-folder') {
          toast = '已打开所在文件夹';
        } else if (msg.action === 'open-editor') {
          toast = `已在 ${res.editor || '编辑器'} 中打开`;
        } else if (msg.action === 'open-terminal') {
          toast = `已在 ${res.terminal || '终端'} 中打开`;
        }
        if (toast) {
          await evaluate(entry, `globalThis.__agyFileActionsOverlay?.notifyToast(${owner},${JSON.stringify(toast)})`);
        }
      } catch (err) {
        const errMsg = `操作失败：${String(err?.message || err).slice(0, 80)}`;
        await evaluate(entry, `globalThis.__agyFileActionsOverlay?.notifyToast(${owner},${JSON.stringify(errMsg)})`);
      }
    }
  }

  async function connectTarget(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const entry = {
      ws,
      pending: new Map(),
      nextId: 1,
      origin: new URL(target.url).origin,
      frameId: null,
      context: null,
      closed: false,
    };

    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => { retire(target.id, entry); rejectOpen(new Error('ws timeout')); }, 3000);
      ws.onopen = () => { clearTimeout(timer); resolveOpen(); };
      ws.onerror = () => { clearTimeout(timer); retire(target.id, entry); rejectOpen(new Error('ws error')); };
    });

    if (stopped) {
      retire(target.id, entry);
      throw new Error('stopped');
    }

    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.method === 'Runtime.executionContextCreated') {
          const ctx = msg.params?.context;
          if (ctx?.auxData?.isDefault && ctx.auxData.frameId === entry.frameId) {
            entry.context = ctx.origin === entry.origin ? ctx.uniqueId : null;
          }
        } else if (
          msg.method === 'Runtime.executionContextsCleared' ||
          (msg.method === 'Runtime.executionContextDestroyed' && msg.params?.executionContextUniqueId === entry.context)
        ) {
          entry.context = null;
        } else if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === BINDING_NAME) {
          void handleBinding(entry, msg.params.payload);
        }
        const cb = entry.pending.get(msg.id);
        if (cb) {
          entry.pending.delete(msg.id);
          cb(msg);
        }
      } catch {}
    };
    ws.onerror = ws.onclose = () => retire(target.id, entry);
    sockets.set(target.id, entry);

    const tree = await sendCommand(entry, 'Page.getFrameTree', {});
    entry.frameId = tree?.frameTree?.frame?.id || null;
    if (!entry.frameId || !(await sendCommand(entry, 'Runtime.enable', {}))) {
      retire(target.id, entry);
      throw new Error('failed to enable Runtime');
    }
    await sendCommand(entry, 'Runtime.addBinding', { name: BINDING_NAME });
    return entry;
  }

  async function listTargets() {
    const nowMs = Date.now();
    if (lastListAt && nowMs - lastListAt < 4000) return cachedTargets;

    let port;
    try {
      port = readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim();
    } catch {
      status = 'missing-cdp';
      lastError = 'DevToolsActivePort not found';
      return [];
    }

    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      status = 'unreachable';
      lastError = 'Invalid CDP port';
      return [];
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2500),
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const targets = await res.json();
      const origin = resolveOrigin();
      const wsOrigin = `ws://127.0.0.1:${Number(port)}`;
      cachedTargets = (Array.isArray(targets) ? targets : []).filter(t => {
        if (t?.type !== 'page' || !t.id || !t.url || !t.webSocketDebuggerUrl) return false;
        if (!URL.canParse(t.url) || !URL.canParse(t.webSocketDebuggerUrl)) return false;
        if (origin && new URL(t.url).origin !== origin) return false;
        const wsUrl = new URL(t.webSocketDebuggerUrl);
        return wsUrl.origin === wsOrigin && wsUrl.pathname === `/devtools/page/${t.id}`;
      });
      lastListAt = nowMs;

      const aliveIds = new Set(cachedTargets.map(t => t.id));
      for (const [id, entry] of sockets) {
        if (!aliveIds.has(id)) retire(id, entry);
      }
      return cachedTargets;
    } catch (err) {
      status = 'unreachable';
      lastError = String(err?.message || err);
      return [];
    }
  }

  async function teardownAll() {
    await Promise.all([...sockets].map(async ([id, entry]) => {
      try {
        await evaluate(entry, `globalThis.__agyFileActionsOverlay?.owner===${owner}&&globalThis.__agyFileActionsOverlay.dispose()`);
      } catch {}
      finally {
        retire(id, entry);
      }
    }));
  }

  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      const settings = engine.settingsStore.read();
      if (!settings.overlayEnabled) {
        if (sockets.size > 0) await teardownAll();
        status = 'disabled';
        lastError = '';
        return;
      }

      const targets = await listTargets();
      if (targets.length === 0) return;

      let connectedAny = false;
      for (const target of targets) {
        if (stopped) break;
        try {
          const entry = sockets.get(target.id) || await connectTarget(target);
          if (!entry.context) continue;
          let ping = await evaluate(entry, `globalThis.__agyFileActionsOverlay?.ping(${owner})??null`);
          if (ping === 'superseded') {
            await stop();
            return;
          }
          if (!ping || ping.owner !== owner || ping.hash !== bundle.hash) {
            const ok = await evaluate(entry, bundle.code);
            if (ok === 'superseded') {
              await stop();
              return;
            }
            ping = await evaluate(entry, `globalThis.__agyFileActionsOverlay?.ping(${owner})??null`);
          }
          if (ping?.alive) connectedAny = true;
        } catch (err) {
          retire(target.id, sockets.get(target.id));
          lastError = String(err?.message || err);
        }
      }
      status = connectedAny ? 'connected' : 'waiting';
      if (connectedAny) lastError = '';
    } finally {
      busy = false;
    }
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await teardownAll();
  }

  const timer = setInterval(() => void tick(), POLL_MS);
  timer.unref?.();
  void tick();

  return {
    getStatus: () => ({ status, lastError }),
    stop,
  };
}
