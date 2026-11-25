// Official stdio MCP server for agy-file-actions.
// Exposes explicit tools so the user or agent can reveal files in Explorer,
// open containing folders, open files in VS Code/Cursor/default app, or open a terminal.

import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { getConfigRoot } from '../sidecars/file_actions/settings.mjs';
import { createFileActionsEngine } from '../sidecars/file_actions/server.mjs';

const SERVER_INFO = { name: 'agy-file-actions', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

let fallbackEngine = null;
function getFallback() {
  if (!fallbackEngine) fallbackEngine = createFileActionsEngine();
  return fallbackEngine;
}

function readIpc() {
  try {
    const raw = JSON.parse(readFileSync(join(getConfigRoot(), 'ipc.json'), 'utf8'));
    if (Number.isInteger(raw?.port) && typeof raw?.token === 'string' && raw.token) return raw;
  } catch {}
  return null;
}

async function callSidecar(path, body = {}) {
  const ipc = readIpc();
  if (!ipc) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${ipc.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-File-Actions-Token': ipc.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function dispatchAction(action, args = {}) {
  const payload = {
    action,
    rawInput: String(args.path || ''),
    conversationId: args.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || '',
    editorId: args.editor || '',
    terminalId: args.terminal || '',
  };
  const fromSidecar = await callSidecar('/internal/action', payload);
  if (fromSidecar) return fromSidecar;
  return getFallback().executeAction(payload);
}

const TOOLS = [
  {
    name: 'reveal_in_explorer',
    title: 'Reveal File in Explorer',
    description: 'Open OS file explorer and select the specified file or folder.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path, file:// URI, or workspace-relative path.' },
      },
    },
  },
  {
    name: 'open_containing_folder',
    title: 'Open Containing Folder',
    description: 'Open the parent folder containing the given file path in OS file explorer.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path, file:// URI, or workspace-relative path.' },
      },
    },
  },
  {
    name: 'open_in_editor',
    title: 'Open File in External Editor',
    description: 'Open the given file (optionally with :line or #Lline) in VS Code, Cursor, custom editor, or system default app.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'File path (supports :line:col or #Lline).' },
        editor: { type: 'string', enum: ['auto', 'vscode', 'cursor', 'system', 'custom'] },
      },
    },
  },
  {
    name: 'open_terminal_here',
    title: 'Open Terminal at Path',
    description: 'Open Windows Terminal / PowerShell in the target directory or containing folder.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Directory or file path.' },
        terminal: { type: 'string', enum: ['auto', 'wt', 'pwsh', 'powershell', 'cmd'] },
      },
    },
  },
];

function sendJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleRequest(msg) {
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    return sendJson({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      },
    });
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') return sendJson({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return sendJson({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const map = {
      reveal_in_explorer: 'reveal',
      open_containing_folder: 'open-folder',
      open_in_editor: 'open-editor',
      open_terminal_here: 'open-terminal',
    };
    const action = map[params.name];
    if (!action) {
      return sendJson({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${params.name}` } });
    }
    try {
      const res = await dispatchAction(action, params.arguments || {});
      return sendJson({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(res) }],
          structuredContent: res,
        },
      });
    } catch (err) {
      return sendJson({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `File Actions error: ${err?.message || err}` }],
        },
      });
    }
  }
  if (id != null) {
    sendJson({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try { void handleRequest(JSON.parse(trimmed)); } catch {}
  });
}
