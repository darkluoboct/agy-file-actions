// Unit & integration tests for agy-file-actions.
// Run with: node --test tests/file_actions.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { createSettingsStore, DEFAULT_SETTINGS } from '../sidecars/file_actions/settings.mjs';
import {
  parseRawPathInput,
  resolveTargetPath,
  formatPathForCopy,
  toFileUri,
} from '../sidecars/file_actions/path_resolver.mjs';
import {
  createLauncher,
  detectEditors,
  detectTerminals,
  buildCustomEditorArgs,
} from '../sidecars/file_actions/launcher.mjs';
import { createFileActionsEngine, startIpcServer } from '../sidecars/file_actions/server.mjs';
import { buildContextMenuBundle } from '../sidecars/file_actions/context_menu_overlay.mjs';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'agy-fa-test-'));
}

test('path_resolver: parses file:// URIs, Chinese chars, line/col ranges, relative paths, and deleted ancestors', () => {
  const tmp = makeTempDir();
  try {
    const subDir = join(tmp, 'src', '中文 目录');
    mkdirSync(subDir, { recursive: true });
    const filePath = join(subDir, 'app.ts');
    writeFileSync(filePath, 'export const ok = true;\n', 'utf8');

    // 1. file:// URI with URL-encoded Chinese, spaces, and #L10-L20
    const uri = toFileUri(filePath, 10, 20);
    const parsedUri = parseRawPathInput(uri);
    assert.equal(parsedUri.line, 10);
    assert.equal(parsedUri.endLine, 20);
    const resUri = resolveTargetPath(uri, { workspaceRoots: [tmp], slashStyle: 'forward' });
    assert.equal(resUri.exists, true);
    assert.equal(resUri.isFile, true);
    assert.equal(resUri.line, 10);
    assert.equal(resUri.fileName, 'app.ts');
    assert.equal(resUri.relativePath, 'src/中文 目录/app.ts');
    assert.equal(resUri.copyWithLine, 'src/中文 目录/app.ts:10');
    assert.ok(resUri.formattedAbsolutePath.includes('/src/'));

    // 2. Relative path with :line:col resolved against workspace URI
    const wsUri = toFileUri(tmp);
    const resRel = resolveTargetPath('`src/中文 目录/app.ts:42:5`', { workspaceRoots: [wsUri] });
    assert.equal(resRel.exists, true);
    assert.equal(resRel.line, 42);
    assert.equal(resRel.col, 5);
    assert.equal(resRel.copyWithLine, 'src/中文 目录/app.ts:42:5');

    // 3. Deleted file falls back to nearest existing ancestor directory
    const ghost = join(subDir, 'deleted', 'missing.ts');
    const resGhost = resolveTargetPath(ghost, { workspaceRoots: [tmp] });
    assert.equal(resGhost.exists, false);
    assert.equal(resGhost.nearestExistingDir, subDir);

    // 4. Web URLs are rejected
    assert.equal(parseRawPathInput('https://example.com/foo/bar.ts'), null);
    assert.equal(parseRawPathInput('sidecar://agy-file-actions/file_actions/'), null);

    // 5. Slash formatting styles
    assert.equal(formatPathForCopy('C:\\a\\b\\c.txt', 'forward'), 'C:/a/b/c.txt');
    assert.equal(formatPathForCopy('C:/a/b/c.txt', 'backslash'), 'C:\\a\\b\\c.txt');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('settings: persists atomic updates and rejects invalid option values', () => {
  const tmp = makeTempDir();
  try {
    const store = createSettingsStore({ env: { AGY_FILE_ACTIONS_DATA_DIR: tmp } });
    assert.deepEqual(store.read(), DEFAULT_SETTINGS);
    const next = store.update({
      editorPreference: 'cursor',
      terminalPreference: 'wt',
      pathSlashStyle: 'forward',
      customEditorArgs: '--goto {path}:{line}',
      overlayEnabled: false,
    });
    assert.equal(next.editorPreference, 'cursor');
    assert.equal(next.terminalPreference, 'wt');
    assert.equal(next.pathSlashStyle, 'forward');
    assert.equal(next.overlayEnabled, false);
    assert.equal(store.read().editorPreference, 'cursor');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('launcher: auto-detects local editors/terminals and launches securely with shell:false', async () => {
  const tmp = makeTempDir();
  try {
    const fakeBin = join(tmp, 'fake-bin');
    mkdirSync(fakeBin, { recursive: true });
    const fakeCodeExe = join(fakeBin, 'Code.exe');
    const fakeWtExe = join(fakeBin, 'wt.exe');
    writeFileSync(fakeCodeExe, '', 'utf8');
    writeFileSync(fakeWtExe, '', 'utf8');
    const testEnv = { ...process.env, PATH: fakeBin, LOCALAPPDATA: tmp, ProgramFiles: tmp };

    const filePath = join(tmp, 'hello world.ts');
    writeFileSync(filePath, 'console.log(1);\n', 'utf8');

    const editors = detectEditors(testEnv, 'win32');
    const terminals = detectTerminals(testEnv, 'win32');
    assert.ok(editors.some(e => e.id === 'system'));
    assert.ok(editors.some(e => e.id === 'vscode' && e.executable === fakeCodeExe));
    assert.ok(terminals.some(t => t.id === 'wt' && t.executable === fakeWtExe));

    const spawned = [];
    const fakeSpawn = (file, args, opts) => {
      spawned.push({ file, args, opts });
      return { pid: 9999, once() {}, unref() {} };
    };

    const launcher = createLauncher({ env: testEnv, platform: 'win32', spawnImpl: fakeSpawn });
    const target = resolveTargetPath(`${filePath}:18:3`, { workspaceRoots: [tmp] });

    // Reveal uses explorer.exe /select,"<path>" with shell:false and verbatim args
    const rev = await launcher.revealInExplorer(target);
    assert.equal(rev.ok, true);
    assert.equal(spawned[0].file, 'explorer.exe');
    assert.equal(spawned[0].args[0], `/select,"${target.absolutePath}"`);
    assert.equal(spawned[0].opts.shell, false);
    assert.equal(spawned[0].opts.windowsVerbatimArguments, true);

    // Open containing folder
    await launcher.openContainingFolder(target);
    assert.equal(spawned[1].file, 'explorer.exe');
    assert.equal(spawned[1].args[0], tmp);
    assert.equal(spawned[1].opts.shell, false);

    // Open in editor passes --goto path:line:col when VS Code/Cursor detected
    await launcher.openInEditor(target, { ...DEFAULT_SETTINGS, editorPreference: 'auto' });
    assert.equal(spawned[2].opts.shell, false);
    assert.equal(spawned[2].file, fakeCodeExe);
    assert.equal(spawned[2].args[0], '--goto');
    assert.equal(spawned[2].args[1], `${target.absolutePath}:18:3`);

    // Open terminal passes target dir safely
    await launcher.openTerminalHere(target, { ...DEFAULT_SETTINGS, terminalPreference: 'auto' });
    assert.equal(spawned[3].file, fakeWtExe);
    assert.deepEqual(spawned[3].args, ['-d', tmp]);
    assert.equal(spawned[3].opts.shell, false);

    // Custom editor arg templating
    const customArgs = buildCustomEditorArgs('"-g" "{path}:{line}" "{dir}"', target);
    assert.deepEqual(customArgs, ['-g', `${target.absolutePath}:18`, tmp]);

    // Injection / quote characters in path must be rejected
    await assert.rejects(
      () => launcher.revealInExplorer({ exists: true, isFile: true, absolutePath: 'C:\\a" & calc.exe' }),
      /Invalid path characters/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('engine, loopback IPC, overlay bundle & MCP stdio contract', async () => {
  const tmp = makeTempDir();
  const env = { AGY_FILE_ACTIONS_DATA_DIR: tmp };
  const sampleFile = join(tmp, 'demo.js');
  writeFileSync(sampleFile, '1;\n', 'utf8');

  const actionsCalled = [];
  const fakeLauncher = {
    getCapabilities: () => ({
      editors: [{ id: 'vscode', name: 'VS Code', executable: 'Code.exe', supportsGoto: true }, { id: 'system', name: '系统默认程序', executable: '', supportsGoto: false }],
      terminals: [{ id: 'wt', name: 'Windows Terminal', executable: 'wt.exe' }],
    }),
    revealInExplorer: async t => { actionsCalled.push(['reveal', t.absolutePath]); return { ok: true, action: 'reveal', openedPath: t.absolutePath }; },
    openContainingFolder: async t => { actionsCalled.push(['open-folder', t.parentDir]); return { ok: true, action: 'open-folder', openedPath: t.parentDir }; },
    openInEditor: async t => { actionsCalled.push(['open-editor', t.absolutePath, t.line]); return { ok: true, action: 'open-editor', editor: 'VS Code' }; },
    openTerminalHere: async t => { actionsCalled.push(['open-terminal', t.parentDir]); return { ok: true, action: 'open-terminal', terminal: 'Windows Terminal' }; },
  };

  const engine = createFileActionsEngine({
    env,
    launcher: fakeLauncher,
    fetchConvMeta: async () => ({
      response: { conversationMetadata: { metadata: { workspaceUris: [toFileUri(tmp)] } } },
    }),
  });

  const ipc = await startIpcServer(engine, { env });
  try {
    // Unauthorized IPC rejected
    const bad = await fetch(`http://127.0.0.1:${ipc.port}/internal/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-File-Actions-Token': 'bad' },
      body: '{}',
    });
    assert.equal(bad.status, 401);

    // Authorized relative path inspect resolves against mocked conversation workspace
    const inspRes = await fetch(`http://127.0.0.1:${ipc.port}/internal/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-File-Actions-Token': ipc.token },
      body: JSON.stringify({ rawInput: 'demo.js:7', conversationId: 'conv-1' }),
    });
    assert.equal(inspRes.status, 200);
    const insp = await inspRes.json();
    assert.equal(insp.target.exists, true);
    assert.equal(insp.target.absolutePath, sampleFile);
    assert.equal(insp.target.line, 7);

    // Execute reveal & verify recent history populated
    await engine.executeAction({ action: 'reveal', rawInput: 'demo.js:7', conversationId: 'conv-1' });
    assert.equal(actionsCalled[0][0], 'reveal');
    const st = await engine.getState({ conversationId: 'conv-1' });
    assert.equal(st.recentPaths.length, 1);
    assert.equal(st.recentPaths[0].fileName, 'demo.js');

    // Overlay bundle syntax check
    const bundle = buildContextMenuBundle(12345);
    assert.equal(bundle.hash.length, 16);
    assert.doesNotThrow(() => new Function(bundle.code));

    // Real MCP server stdio check
    const mcpPath = join(import.meta.dirname, '..', 'mcp', 'server.mjs');
    const child = spawn(process.execPath, [mcpPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const responses = [];
    const done = new Promise((resolveDone, rejectDone) => {
      let buf = '';
      child.stdout.on('data', chunk => {
        buf += String(chunk);
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const line of parts) {
          if (!line.trim()) continue;
          responses.push(JSON.parse(line));
          if (responses.length === 2) resolveDone();
        }
      });
      child.on('error', rejectDone);
      setTimeout(() => rejectDone(new Error('MCP timeout')), 5000);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    await done;
    child.kill();

    assert.equal(responses[0].result.serverInfo.name, 'agy-file-actions');
    assert.deepEqual(
      responses[1].result.tools.map(t => t.name),
      ['reveal_in_explorer', 'open_containing_folder', 'open_in_editor', 'open_terminal_here'],
    );
  } finally {
    await ipc.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
