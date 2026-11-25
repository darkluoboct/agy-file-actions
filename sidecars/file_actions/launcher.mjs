// Secure OS launcher for Explorer, external editors (VS Code / Cursor / Custom / System),
// and terminals (Windows Terminal / PowerShell 7 / Windows PowerShell / cmd).
// Security invariant: NEVER invokes `shell: true` with user-controlled paths;
// validates against control chars / quotes before launching detached OS processes.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function assertSafePath(p) {
  const s = String(p || '').trim();
  if (!s || /[\r\n\0"]/.test(s)) {
    throw new Error('Invalid path characters');
  }
  return s;
}

function searchPathEntries(names, env = process.env, platform = process.platform) {
  const rawPath = env.PATH || env.Path || '';
  const dirs = rawPath.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

function resolveGuiExeFromBin(binPath, exeName, maxDepth = 4) {
  if (!binPath) return '';
  let cur = dirname(binPath);
  for (let i = 0; i < maxDepth; i++) {
    const direct = join(cur, exeName);
    if (existsSync(direct)) return direct;
    const parent = dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return '';
}

export function detectEditors(env = process.env, platform = process.platform) {
  const detected = [];
  if (platform === 'win32') {
    const localApp = env.LOCALAPPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Local');
    const progFiles = env.ProgramFiles || 'C:\\Program Files';

    // 1. VS Code (resolve real Code.exe to run directly with shell: false)
    const codeCmd = searchPathEntries(['code.cmd', 'code.exe', 'Code.exe'], env, platform);
    const vscodeCandidates = [
      resolveGuiExeFromBin(codeCmd, 'Code.exe'),
      join(localApp, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      join(progFiles, 'Microsoft VS Code', 'Code.exe'),
    ].filter(Boolean);
    const vscodeExe = vscodeCandidates.find(p => existsSync(p));
    if (vscodeExe) {
      detected.push({ id: 'vscode', name: 'VS Code', executable: vscodeExe, supportsGoto: true });
    }

    // 2. Cursor (handles custom install drives like D:\cursor\Cursor.exe via PATH resolution!)
    const cursorCmd = searchPathEntries(['cursor.cmd', 'cursor.exe', 'Cursor.exe'], env, platform);
    const cursorCandidates = [
      resolveGuiExeFromBin(cursorCmd, 'Cursor.exe'),
      join(localApp, 'Programs', 'cursor', 'Cursor.exe'),
      join(progFiles, 'cursor', 'Cursor.exe'),
    ].filter(Boolean);
    const cursorExe = cursorCandidates.find(p => existsSync(p));
    if (cursorExe) {
      detected.push({ id: 'cursor', name: 'Cursor', executable: cursorExe, supportsGoto: true });
    }
  } else {
    const codeBin = searchPathEntries(['code'], env, platform);
    if (codeBin) detected.push({ id: 'vscode', name: 'VS Code', executable: codeBin, supportsGoto: true });
    const cursorBin = searchPathEntries(['cursor'], env, platform);
    if (cursorBin) detected.push({ id: 'cursor', name: 'Cursor', executable: cursorBin, supportsGoto: true });
  }

  detected.push({ id: 'system', name: '系统默认程序', executable: '', supportsGoto: false });
  return detected;
}

export function detectTerminals(env = process.env, platform = process.platform) {
  const detected = [];
  if (platform === 'win32') {
    const localApp = env.LOCALAPPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Local');
    const wt = searchPathEntries(['wt.exe'], env, platform) ||
      (existsSync(join(localApp, 'Microsoft', 'WindowsApps', 'wt.exe')) ? join(localApp, 'Microsoft', 'WindowsApps', 'wt.exe') : '');
    if (wt) detected.push({ id: 'wt', name: 'Windows Terminal', executable: wt });

    const pwsh = searchPathEntries(['pwsh.exe'], env, platform);
    if (pwsh) detected.push({ id: 'pwsh', name: 'PowerShell 7', executable: pwsh });

    const ps = searchPathEntries(['powershell.exe'], env, platform);
    if (ps) detected.push({ id: 'powershell', name: 'Windows PowerShell', executable: ps });

    const cmd = env.ComSpec || searchPathEntries(['cmd.exe'], env, platform);
    if (cmd && existsSync(cmd)) detected.push({ id: 'cmd', name: '命令提示符 (cmd)', executable: cmd });
  } else if (platform === 'darwin') {
    detected.push({ id: 'terminal', name: 'Terminal.app', executable: '/usr/bin/open' });
  } else {
    for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'alacritty', 'kitty']) {
      const found = searchPathEntries([term], env, platform);
      if (found) detected.push({ id: term, name: term, executable: found });
    }
  }
  return detected;
}

export function pickEditor(detectedEditors, settings) {
  const pref = settings?.editorPreference || 'auto';
  if (pref === 'custom') {
    const customPath = String(settings?.customEditorPath || '').trim();
    if (customPath && existsSync(customPath)) {
      return {
        id: 'custom',
        name: '自定义编辑器',
        executable: customPath,
        argsTemplate: settings.customEditorArgs || '{path}',
        supportsGoto: false,
      };
    }
  }
  if (pref !== 'auto') {
    const exact = detectedEditors.find(e => e.id === pref);
    if (exact) return exact;
  }
  return detectedEditors[0] || { id: 'system', name: '系统默认程序', executable: '', supportsGoto: false };
}

export function pickTerminal(detectedTerminals, settings) {
  const pref = settings?.terminalPreference || 'auto';
  if (pref !== 'auto') {
    const exact = detectedTerminals.find(t => t.id === pref);
    if (exact) return exact;
  }
  return detectedTerminals[0] || null;
}

export function buildCustomEditorArgs(template, target) {
  const rawTokens = String(template || '{path}').match(/"[^"]*"|'[^']*'|\S+/g) || ['{path}'];
  return rawTokens.map(tok => {
    const unquoted = tok.replace(/^["']|["']$/g, '');
    return unquoted
      .replace(/\{path\}/g, target.absolutePath)
      .replace(/\{dir\}/g, target.parentDir || '')
      .replace(/\{line\}/g, String(target.line || 1))
      .replace(/\{col\}/g, String(target.col || 1));
  });
}

function spawnDetached(file, args, options = {}, spawnImpl = spawn) {
  return new Promise((resolvePromise, rejectPromise) => {
    try {
      const child = spawnImpl(file, args, {
        detached: true,
        stdio: 'ignore',
        shell: false,
        ...options,
      });
      child.once('error', err => rejectPromise(err));
      child.unref?.();
      // Give spawn a short tick to emit immediate ENOENT/EINVAL before resolving.
      setTimeout(() => resolvePromise({ ok: true, pid: child.pid }), 40);
    } catch (err) {
      rejectPromise(err);
    }
  });
}

export function createLauncher(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const spawnImpl = options.spawnImpl || spawn;

  function getCapabilities() {
    return {
      editors: detectEditors(env, platform),
      terminals: detectTerminals(env, platform),
    };
  }

  async function revealInExplorer(target) {
    if (!target) throw new Error('Target path not resolved');
    const usePath = target.exists ? target.absolutePath : target.nearestExistingDir;
    if (!usePath) throw new Error('Target path and parent directories do not exist');
    const safe = assertSafePath(usePath);

    if (platform === 'win32') {
      if (target.exists && target.isFile) {
        // Windows explorer.exe requires exact `/select,"<path>"` verbatim syntax when paths contain spaces.
        await spawnDetached(
          'explorer.exe',
          [`/select,"${safe}"`],
          { windowsVerbatimArguments: true, windowsHide: false },
          spawnImpl,
        );
      } else {
        await spawnDetached('explorer.exe', [safe], { windowsHide: false }, spawnImpl);
      }
      return { ok: true, action: 'reveal', openedPath: safe, fallbackToAncestor: !target.exists };
    }

    if (platform === 'darwin') {
      const args = target.exists && target.isFile ? ['-R', safe] : [safe];
      await spawnDetached('/usr/bin/open', args, {}, spawnImpl);
      return { ok: true, action: 'reveal', openedPath: safe, fallbackToAncestor: !target.exists };
    }

    const dir = target.exists && target.isDirectory ? safe : dirname(safe);
    await spawnDetached('xdg-open', [dir], {}, spawnImpl);
    return { ok: true, action: 'reveal', openedPath: dir, fallbackToAncestor: !target.exists };
  }

  async function openContainingFolder(target) {
    if (!target) throw new Error('Target path not resolved');
    const dir = target.exists ? target.parentDir : target.nearestExistingDir;
    if (!dir) throw new Error('Containing folder does not exist');
    const safe = assertSafePath(dir);

    if (platform === 'win32') {
      await spawnDetached('explorer.exe', [safe], { windowsHide: false }, spawnImpl);
    } else if (platform === 'darwin') {
      await spawnDetached('/usr/bin/open', [safe], {}, spawnImpl);
    } else {
      await spawnDetached('xdg-open', [safe], {}, spawnImpl);
    }
    return { ok: true, action: 'open-folder', openedPath: safe };
  }

  async function openInEditor(target, settings, overrideEditorId = '') {
    if (!target) throw new Error('Target path not resolved');
    if (!target.exists) throw new Error(`File does not exist: ${target.absolutePath}`);
    const safe = assertSafePath(target.absolutePath);

    const editors = detectEditors(env, platform);
    const effectiveSettings = overrideEditorId ? { ...settings, editorPreference: overrideEditorId } : settings;
    const editor = pickEditor(editors, effectiveSettings);

    if (editor.id === 'system' || !editor.executable) {
      if (platform === 'win32') {
        await spawnDetached('explorer.exe', [safe], { windowsHide: false }, spawnImpl);
      } else if (platform === 'darwin') {
        await spawnDetached('/usr/bin/open', [safe], {}, spawnImpl);
      } else {
        await spawnDetached('xdg-open', [safe], {}, spawnImpl);
      }
      return { ok: true, action: 'open-editor', editor: editor.name, openedPath: safe };
    }

    if (editor.id === 'custom') {
      const args = buildCustomEditorArgs(editor.argsTemplate, target);
      await spawnDetached(editor.executable, args, { windowsHide: false }, spawnImpl);
      return { ok: true, action: 'open-editor', editor: editor.name, openedPath: safe };
    }

    // VS Code / Cursor: use `--goto path:line:col` for files with line numbers.
    const args = [];
    if (editor.supportsGoto && target.isFile && target.line) {
      const loc = target.col ? `${safe}:${target.line}:${target.col}` : `${safe}:${target.line}`;
      args.push('--goto', loc);
    } else {
      args.push(safe);
    }
    await spawnDetached(editor.executable, args, { windowsHide: false }, spawnImpl);
    return { ok: true, action: 'open-editor', editor: editor.name, openedPath: safe };
  }

  async function openTerminalHere(target, settings, overrideTerminalId = '') {
    if (!target) throw new Error('Target path not resolved');
    const dir = target.exists ? target.parentDir : target.nearestExistingDir;
    if (!dir) throw new Error('Directory does not exist');
    const safeDir = assertSafePath(resolve(dir));

    const terminals = detectTerminals(env, platform);
    const effectiveSettings = overrideTerminalId ? { ...settings, terminalPreference: overrideTerminalId } : settings;
    const terminal = pickTerminal(terminals, effectiveSettings);
    if (!terminal) throw new Error('No supported terminal found on this machine');

    if (platform === 'win32') {
      if (terminal.id === 'wt') {
        await spawnDetached(terminal.executable, ['-d', safeDir], { windowsHide: false }, spawnImpl);
      } else if (terminal.id === 'pwsh' || terminal.id === 'powershell') {
        // Use conhost.exe so a visible interactive terminal window opens cleanly in safeDir via cwd.
        await spawnDetached(
          'conhost.exe',
          [terminal.executable, '-NoExit'],
          { cwd: safeDir, windowsHide: false },
          spawnImpl,
        );
      } else {
        await spawnDetached('conhost.exe', [terminal.executable], { cwd: safeDir, windowsHide: false }, spawnImpl);
      }
      return { ok: true, action: 'open-terminal', terminal: terminal.name, openedPath: safeDir };
    }

    if (platform === 'darwin') {
      await spawnDetached('/usr/bin/open', ['-a', 'Terminal', safeDir], {}, spawnImpl);
      return { ok: true, action: 'open-terminal', terminal: terminal.name, openedPath: safeDir };
    }

    await spawnDetached(terminal.executable, [], { cwd: safeDir }, spawnImpl);
    return { ok: true, action: 'open-terminal', terminal: terminal.name, openedPath: safeDir };
  }

  return {
    getCapabilities,
    revealInExplorer,
    openContainingFolder,
    openInEditor,
    openTerminalHere,
  };
}
