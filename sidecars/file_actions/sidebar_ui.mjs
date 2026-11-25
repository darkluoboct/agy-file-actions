// Mode 1 Official Aux-Pane Sidebar UI for agy-file-actions.
// Zero emoji, follows host CSS variables, provides:
// - Quick manual path action bar (works even without CDP)
// - Recent right-clicked / inspected paths history
// - Editor, terminal, path slash style, and Mode 2 right-click menu settings

export function createSidebarHtml({ version = '1.0.0' } = {}) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>File Actions</title>
  <script src="/preload.js"></script>
  <style>
    :root {
      color-scheme: light dark;
      --fa-bg: var(--background, #0f1117);
      --fa-fg: var(--foreground, #e6e8ef);
      --fa-muted: var(--muted-foreground, #8e96a8);
      --fa-card: var(--card, rgba(128, 136, 160, 0.08));
      --fa-card-hover: var(--secondary, rgba(128, 136, 160, 0.14));
      --fa-border: var(--border, rgba(128, 136, 160, 0.22));
      --fa-accent: var(--primary, #2563eb);
      --fa-accent-fg: var(--primary-foreground, #ffffff);
      --fa-ok: #22c55e;
      --fa-warn: #f59e0b;
      --fa-radius: 10px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px 12px 24px;
      background: var(--fa-bg);
      color: var(--fa-fg);
      font-family: "Source Han Sans CN", "Microsoft YaHei UI", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      line-height: 1.48;
      -webkit-font-smoothing: antialiased;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .brand-dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--fa-accent);
    }
    .brand-title { font-weight: 600; font-size: 14px; }
    .brand-ver { font-size: 11px; color: var(--fa-muted); }
    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid var(--fa-border);
      background: var(--fa-card);
      font-size: 11.5px;
      color: var(--fa-muted);
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--fa-muted);
    }
    .dot.ok { background: var(--fa-ok); }
    .dot.warn { background: var(--fa-warn); }
    .notice {
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 11.5px;
      margin-bottom: 10px;
      border: 1px solid rgba(245, 158, 11, 0.35);
      background: rgba(245, 158, 11, 0.08);
    }
    .card {
      border: 1px solid var(--fa-border);
      background: var(--fa-card);
      border-radius: var(--fa-radius);
      padding: 10px 11px;
      margin-bottom: 10px;
    }
    .section-title {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--fa-muted);
      letter-spacing: 0.03em;
      margin-bottom: 8px;
    }
    input[type="text"], select {
      width: 100%;
      border-radius: 7px;
      border: 1px solid var(--fa-border);
      background: var(--fa-bg);
      color: var(--fa-fg);
      font-family: inherit;
      font-size: 12.5px;
      padding: 6px 8px;
      outline: none;
    }
    input[type="text"]:focus, select:focus { border-color: var(--fa-accent); }
    .mono {
      font-family: ui-monospace, Consolas, "Cascadia Code", monospace;
      font-size: 11.5px;
      word-break: break-all;
    }
    .btns {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    button.btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 5px 9px;
      border-radius: 7px;
      border: 1px solid var(--fa-border);
      background: var(--fa-bg);
      color: var(--fa-fg);
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    button.btn:hover:not(:disabled) { background: var(--fa-card-hover); }
    button.btn.primary {
      background: var(--fa-accent);
      color: var(--fa-accent-fg);
      border-color: transparent;
    }
    button.btn.small {
      padding: 3px 8px;
      font-size: 11.5px;
    }
    .setting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--fa-border);
    }
    .setting-row:last-child { border-bottom: none; }
    .setting-label { font-size: 12.5px; font-weight: 500; }
    .setting-desc { font-size: 11px; color: var(--fa-muted); margin-top: 2px; }
    .recent-item {
      padding: 8px 0;
      border-bottom: 1px solid var(--fa-border);
    }
    .recent-item:last-child { border-bottom: none; padding-bottom: 0; }
    .recent-name { font-weight: 600; font-size: 12.5px; }
    .recent-path { color: var(--fa-muted); margin-top: 2px; }
    .toast {
      position: fixed;
      left: 12px;
      right: 12px;
      bottom: 10px;
      padding: 8px 10px;
      border-radius: 8px;
      background: #18181b;
      color: #fafafa;
      font-size: 12px;
      border: 1px solid rgba(255,255,255,0.14);
      opacity: 0;
      pointer-events: none;
      transform: translateY(6px);
      transition: opacity 0.16s, transform 0.16s;
      z-index: 20;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    .kbd {
      display: inline-block;
      padding: 1px 5px;
      border-radius: 4px;
      border: 1px solid var(--fa-border);
      font-size: 10.5px;
      font-family: ui-monospace, Consolas, monospace;
      color: var(--fa-muted);
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">
      <span class="brand-dot"></span>
      <span class="brand-title">File Actions</span>
      <span class="brand-ver">v${version}</span>
    </div>
  </div>

  <div class="pill-row">
    <span class="badge">
      <span class="dot" id="overlayDot"></span>
      <span id="overlayText">检测右键菜单状态…</span>
    </span>
    <span class="badge" id="editorBadge">编辑器检测中…</span>
    <span class="badge" id="terminalBadge">终端检测中…</span>
  </div>

  <div id="fallbackNotice" class="notice" style="display:none;"></div>

  <div class="card">
    <div class="section-title">路径快捷直达</div>
    <input type="text" id="quickPath" class="mono" placeholder="粘贴文件路径、file:// 链接或相对路径（如 src/index.ts:42）" />
    <div class="btns">
      <button class="btn primary small" data-quick="reveal">定位文件</button>
      <button class="btn small" data-quick="open-folder">打开文件夹</button>
      <button class="btn small" data-quick="open-editor">外部编辑器</button>
      <button class="btn small" data-quick="open-terminal">打开终端</button>
      <button class="btn small" data-quick="copy-abs">复制绝对路径</button>
    </div>
  </div>

  <div class="card">
    <div class="section-title">最近右键 / 操作过的路径</div>
    <div id="recentList" style="font-size:12px;color:var(--fa-muted);">在对话里的文件链接或代码路径上点击右键即可触发快捷菜单（按住 <span class="kbd">Shift</span> + 右键保留原生菜单）。</div>
  </div>

  <div class="card">
    <div class="section-title">设置</div>
    <div class="setting-row">
      <div>
        <div class="setting-label">对话内右键菜单增强</div>
        <div class="setting-desc">仅在命中文件链接或路径时接管，普通区域保留原生右键</div>
      </div>
      <input type="checkbox" id="optOverlay" />
    </div>
    <div class="setting-row">
      <div style="flex:1;">
        <div class="setting-label">外部编辑器</div>
        <div class="setting-desc" id="detectedEditorsHint">自动探测本机已安装编辑器</div>
        <select id="optEditor" style="margin-top:6px;">
          <option value="auto">自动优先（VS Code > Cursor > 系统默认）</option>
          <option value="vscode">VS Code</option>
          <option value="cursor">Cursor</option>
          <option value="system">系统默认程序</option>
          <option value="custom">自定义可执行文件</option>
        </select>
      </div>
    </div>
    <div id="customEditorBox" style="display:none; padding: 6px 0 10px; border-bottom: 1px solid var(--fa-border);">
      <div class="setting-desc" style="margin-bottom:4px;">可执行文件完整路径（例如 D:\\Tools\\Editor.exe）</div>
      <input type="text" id="optCustomPath" class="mono" placeholder="D:\\path\\to\\editor.exe" />
      <div class="setting-desc" style="margin:6px 0 4px;">参数模板（支持 {path} {line} {col} {dir}）</div>
      <input type="text" id="optCustomArgs" class="mono" placeholder="--goto {path}:{line}" />
      <div class="btns"><button class="btn small primary" id="btnSaveCustomEditor">保存自定义编辑器</button></div>
    </div>
    <div class="setting-row">
      <div style="flex:1;">
        <div class="setting-label">默认终端</div>
        <select id="optTerminal" style="margin-top:6px;">
          <option value="auto">自动优先（Windows Terminal > PowerShell 7）</option>
          <option value="wt">Windows Terminal</option>
          <option value="pwsh">PowerShell 7</option>
          <option value="powershell">Windows PowerShell</option>
          <option value="cmd">命令提示符 (cmd)</option>
        </select>
      </div>
    </div>
    <div class="setting-row">
      <div style="flex:1;">
        <div class="setting-label">复制路径斜杠格式</div>
        <select id="optSlash" style="margin-top:6px;">
          <option value="native">跟随当前系统</option>
          <option value="forward">统一正斜杠 (/)</option>
          <option value="backslash">统一反斜杠 (\\)</option>
        </select>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const api = {
      post(path, body = {}) {
        const fn = window.sidecar?.fetch || fetch;
        return fn(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(async res => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
          return data;
        });
      },
    };

    const $ = id => document.getElementById(id);
    let convId = window.sidecar?.conversationId || '';
    let workspaceUris = [];
    let toastTimer = null;
    let boundSettings = false;

    function showToast(msg) {
      const el = $('toast');
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
    }

    function esc(s) {
      return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function render(data) {
      if (!data) return;
      const ov = data.overlay || {};
      const dot = $('overlayDot');
      dot.className = 'dot';
      if (ov.status === 'connected') {
        dot.classList.add('ok');
        $('overlayText').textContent = '对话内右键菜单已激活';
        $('fallbackNotice').style.display = 'none';
      } else if (ov.status === 'disabled') {
        $('overlayText').textContent = '右键菜单已关闭';
        $('fallbackNotice').style.display = 'none';
      } else if (ov.status === 'missing-cdp' || ov.status === 'unreachable') {
        dot.classList.add('warn');
        $('overlayText').textContent = '侧边栏降级模式';
        $('fallbackNotice').style.display = 'block';
        $('fallbackNotice').textContent = '未检测到本地调试端口（DevToolsActivePort），对话内右键菜单暂未挂载。可使用上方路径直达栏，或从带 --remote-debugging-port=0 的桌面快捷方式重启 Antigravity。';
      } else {
        dot.classList.add('warn');
        $('overlayText').textContent = '等待对话窗口…';
        $('fallbackNotice').style.display = 'none';
      }

      const editors = data.capabilities?.editors || [];
      const terminals = data.capabilities?.terminals || [];
      $('editorBadge').textContent = '编辑器：' + (data.activeEditor?.name || '系统默认');
      $('terminalBadge').textContent = '终端：' + (data.activeTerminal?.name || '自动');
      $('detectedEditorsHint').textContent = '本机已检测到：' + editors.map(e => e.name).join(' / ');

      if (!boundSettings || (document.activeElement?.tagName !== 'SELECT' && document.activeElement?.tagName !== 'INPUT')) {
        $('optOverlay').checked = Boolean(data.settings?.overlayEnabled);
        $('optEditor').value = data.settings?.editorPreference || 'auto';
        $('optTerminal').value = data.settings?.terminalPreference || 'auto';
        $('optSlash').value = data.settings?.pathSlashStyle || 'native';
        $('optCustomPath').value = data.settings?.customEditorPath || '';
        $('optCustomArgs').value = data.settings?.customEditorArgs || '{path}';
        $('customEditorBox').style.display = $('optEditor').value === 'custom' ? 'block' : 'none';
        boundSettings = true;
      }

      const recents = data.recentPaths || [];
      const list = $('recentList');
      if (recents.length === 0) {
        list.innerHTML = '在对话里的文件链接或代码路径上点击右键即可触发快捷菜单（按住 <span class="kbd">Shift</span> + 右键保留原生菜单）。';
      } else {
        list.innerHTML = recents.map((item, idx) => (
          '<div class="recent-item" data-ridx="' + idx + '">' +
            '<div class="recent-name">' + esc(item.fileName || item.absolutePath) + (item.line ? ' :' + item.line : '') + (item.exists ? '' : '（已不存在）') + '</div>' +
            '<div class="recent-path mono">' + esc(item.relativePath || item.formattedAbsolutePath) + '</div>' +
            '<div class="btns">' +
              '<button class="btn small" data-ract="reveal" data-ridx="' + idx + '">定位文件</button>' +
              '<button class="btn small" data-ract="open-folder" data-ridx="' + idx + '">打开文件夹</button>' +
              '<button class="btn small" data-ract="open-editor" data-ridx="' + idx + '">编辑器打开</button>' +
              '<button class="btn small" data-ract="open-terminal" data-ridx="' + idx + '">打开终端</button>' +
              '<button class="btn small" data-ract="copy-abs" data-ridx="' + idx + '">复制路径</button>' +
            '</div>' +
          '</div>'
        )).join('');
      }
      window.__faRecents = recents;
    }

    async function runAction(action, rawPath) {
      const target = String(rawPath || '').trim();
      if (!target) { showToast('请输入或选择一个路径'); return; }
      try {
        if (action === 'copy-abs') {
          const info = await api.post('/api/inspect', { conversationId: convId, rawInput: target, workspaceUris });
          if (!info.target) { showToast('无法解析该路径'); return; }
          await navigator.clipboard.writeText(info.target.formattedAbsolutePath);
          showToast('已复制绝对路径');
          return;
        }
        const res = await api.post('/api/action', { action, conversationId: convId, rawInput: target, workspaceUris });
        if (action === 'reveal') showToast(res.fallbackToAncestor ? '原文件不存在，已打开最近的上级目录' : '已在资源管理器中定位');
        else if (action === 'open-folder') showToast('已打开所在文件夹');
        else if (action === 'open-editor') showToast('已在 ' + (res.editor || '编辑器') + ' 中打开');
        else if (action === 'open-terminal') showToast('已在 ' + (res.terminal || '终端') + ' 中打开');
        refresh();
      } catch (err) {
        showToast('操作失败：' + (err.message || err));
      }
    }

    async function refresh() {
      try {
        const data = await api.post('/api/state', { conversationId: convId, workspaceUris });
        render(data);
      } catch {}
    }

    document.querySelectorAll('button[data-quick]').forEach(btn => {
      btn.addEventListener('click', () => runAction(btn.dataset.quick, $('quickPath').value));
    });

    $('recentList').addEventListener('click', e => {
      const btn = e.target.closest('button[data-ract]');
      if (!btn) return;
      const item = window.__faRecents?.[Number(btn.dataset.ridx)];
      if (!item) return;
      const raw = item.line ? (item.absolutePath + ':' + item.line) : item.absolutePath;
      runAction(btn.dataset.ract, raw);
    });

    $('optOverlay').addEventListener('change', e => api.post('/api/settings', { overlayEnabled: e.target.checked }).then(refresh));
    $('optEditor').addEventListener('change', e => {
      $('customEditorBox').style.display = e.target.value === 'custom' ? 'block' : 'none';
      api.post('/api/settings', { editorPreference: e.target.value }).then(refresh);
    });
    $('btnSaveCustomEditor').addEventListener('click', async () => {
      await api.post('/api/settings', {
        editorPreference: 'custom',
        customEditorPath: $('optCustomPath').value,
        customEditorArgs: $('optCustomArgs').value,
      });
      showToast('已保存自定义编辑器配置');
      refresh();
    });
    $('optTerminal').addEventListener('change', e => api.post('/api/settings', { terminalPreference: e.target.value }).then(refresh));
    $('optSlash').addEventListener('change', e => api.post('/api/settings', { pathSlashStyle: e.target.value }).then(refresh));

    if (window.sidecar?.onWorkspaceChange) {
      window.sidecar.onWorkspaceChange(uris => {
        workspaceUris = Array.isArray(uris) ? uris : [];
        refresh();
      });
    }

    refresh();
    const timer = setInterval(refresh, 2000);
    window.addEventListener('beforeunload', () => clearInterval(timer));
  </script>
</body>
</html>`;
}
