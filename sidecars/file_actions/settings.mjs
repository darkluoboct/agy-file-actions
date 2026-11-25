// Persistent settings store for agy-file-actions.
// Stored at ~/.gemini/config/agy-file-actions/settings.json.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  overlayEnabled: true,
  editorPreference: 'auto', // 'auto' | 'vscode' | 'cursor' | 'system' | 'custom'
  customEditorPath: '',
  customEditorArgs: '{path}', // Supports {path}, {line}, {col}, {dir}
  terminalPreference: 'auto', // 'auto' | 'wt' | 'pwsh' | 'powershell' | 'cmd'
  pathSlashStyle: 'native', // 'native' | 'forward' | 'backslash'
  includeLineInCopy: true,
});

const VALID_EDITORS = new Set(['auto', 'vscode', 'cursor', 'system', 'custom']);
const VALID_TERMINALS = new Set(['auto', 'wt', 'pwsh', 'powershell', 'cmd']);
const VALID_SLASHES = new Set(['native', 'forward', 'backslash']);

export function getConfigRoot(env = process.env) {
  if (env.AGY_FILE_ACTIONS_DATA_DIR?.trim()) {
    return resolve(env.AGY_FILE_ACTIONS_DATA_DIR.trim());
  }
  const home = env.USERPROFILE || env.HOME || homedir();
  return join(home, '.gemini', 'config', 'agy-file-actions');
}

export function sanitizeSettings(input = {}, base = DEFAULT_SETTINGS) {
  const merged = { ...DEFAULT_SETTINGS, ...base };
  if (!input || typeof input !== 'object') return merged;

  if (typeof input.overlayEnabled === 'boolean') merged.overlayEnabled = input.overlayEnabled;
  if (typeof input.editorPreference === 'string' && VALID_EDITORS.has(input.editorPreference)) {
    merged.editorPreference = input.editorPreference;
  }
  if (typeof input.customEditorPath === 'string') {
    merged.customEditorPath = input.customEditorPath.trim().slice(0, 512);
  }
  if (typeof input.customEditorArgs === 'string') {
    const cleaned = input.customEditorArgs.trim().slice(0, 256);
    merged.customEditorArgs = cleaned || '{path}';
  }
  if (typeof input.terminalPreference === 'string' && VALID_TERMINALS.has(input.terminalPreference)) {
    merged.terminalPreference = input.terminalPreference;
  }
  if (typeof input.pathSlashStyle === 'string' && VALID_SLASHES.has(input.pathSlashStyle)) {
    merged.pathSlashStyle = input.pathSlashStyle;
  }
  if (typeof input.includeLineInCopy === 'boolean') {
    merged.includeLineInCopy = input.includeLineInCopy;
  }
  return merged;
}

export function createSettingsStore(options = {}) {
  const filePath = options.filePath || join(getConfigRoot(options.env), 'settings.json');

  function readFromDisk() {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      return sanitizeSettings(raw, DEFAULT_SETTINGS);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function writeToDisk(next) {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(tmp, filePath);
  }

  return {
    filePath,
    read() {
      return readFromDisk();
    },
    update(patch = {}) {
      const next = sanitizeSettings(patch, readFromDisk());
      try {
        writeToDisk(next);
      } catch (err) {
        console.error('[file-actions] failed to save settings:', err?.message || err);
      }
      return next;
    },
  };
}
