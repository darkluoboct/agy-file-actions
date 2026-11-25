// Robust path parser, workspace resolver, and formatter for agy-file-actions.
// Handles:
// - `file:///C:/...#L10-L20` and URL-encoded paths (UTF-8, spaces, `%3A`)
// - Windows absolute paths (`D:\foo\bar.ts:42:5`, `C:/foo/bar.mjs#L12`)
// - Home-relative paths (`~/.gemini/config/plugins/...`)
// - Workspace-relative paths (`src/auth.ts:12`, `packages/shared/index.ts`)
// - Deleted-file graceful fallback to nearest existing ancestor directory

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function safeDecodeURIComponent(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

export function workspaceUriToPath(uri) {
  const raw = String(uri || '').trim();
  if (!raw) return '';
  if (/^file:\/\//i.test(raw)) {
    try {
      return normalize(fileURLToPath(raw));
    } catch {
      const stripped = safeDecodeURIComponent(raw.replace(/^file:\/\/\/?/i, ''));
      if (/^[A-Za-z]:/.test(stripped)) return normalize(stripped);
      return normalize('/' + stripped);
    }
  }
  return normalize(raw);
}

export function stripWrappingPunctuation(input) {
  let s = String(input || '').trim();
  // Remove enclosing quotes, backticks, angle brackets, markdown parens.
  s = s.replace(/^[`"'<(\[]+/, '').replace(/[`"'>)\],;]+$/, '').trim();
  return s;
}

export function parseRawPathInput(rawInput, env = process.env) {
  let raw = stripWrappingPunctuation(rawInput);
  if (!raw || /[\r\n\0]/.test(raw)) return null;

  // Reject web URLs / custom app schemes other than file://
  if (/^(https?|mailto|sidecar|customization|javascript|data|conversation):/i.test(raw)) {
    return null;
  }

  let line = null;
  let endLine = null;
  let col = null;

  // 1. Handle file:// URI
  if (/^file:\/\//i.test(raw)) {
    const hashIdx = raw.indexOf('#');
    let hash = '';
    let baseUri = raw;
    if (hashIdx !== -1) {
      hash = raw.slice(hashIdx + 1);
      baseUri = raw.slice(0, hashIdx);
    }
    const lineHash = /^L?(\d+)(?:-L?(\d+))?(?::(\d+))?$/i.exec(hash);
    if (lineHash) {
      line = Number(lineHash[1]);
      if (lineHash[2]) endLine = Number(lineHash[2]);
      if (lineHash[3]) col = Number(lineHash[3]);
    }
    const fsPath = workspaceUriToPath(baseUri);
    if (!fsPath) return null;
    return { rawPath: fsPath, line, endLine, col, isUri: true };
  }

  // 2. Strip trailing `#L10-L20` or `#L10`
  const hashMatch = /#L(\d+)(?:-L?(\d+))?$/i.exec(raw);
  if (hashMatch) {
    line = Number(hashMatch[1]);
    if (hashMatch[2]) endLine = Number(hashMatch[2]);
    raw = raw.slice(0, hashMatch.index);
  } else {
    // 3. Strip trailing `:line:col` or `:line` (careful not to eat Windows `C:` drive colon!)
    const lineColMatch = /:(\d+)(?::(\d+))?$/.exec(raw);
    if (lineColMatch && lineColMatch.index > 1) {
      line = Number(lineColMatch[1]);
      if (lineColMatch[2]) col = Number(lineColMatch[2]);
      raw = raw.slice(0, lineColMatch.index);
    }
  }

  // 4. Expand leading `~/` or `~\`
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    const home = env.USERPROFILE || env.HOME || homedir();
    raw = join(home, raw.slice(1));
  }

  // 5. Handle Windows `%ENV%` shortcuts occasionally shown in docs (e.g. %USERPROFILE%\...)
  raw = raw.replace(/%([A-Za-z0-9_]+)%/g, (m, name) => env[name] || m);

  if (!raw || raw.length > 1024) return null;
  return { rawPath: raw, line, endLine, col, isUri: false };
}

export function findNearestExistingDir(targetPath) {
  let cur = normalize(targetPath);
  for (let i = 0; i < 32; i++) {
    try {
      if (existsSync(cur)) {
        const st = statSync(cur);
        return st.isDirectory() ? cur : dirname(cur);
      }
    } catch {}
    const parent = dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return '';
}

export function formatPathForCopy(fsPath, slashStyle = 'native') {
  if (!fsPath) return '';
  if (slashStyle === 'forward') return fsPath.replace(/\\/g, '/');
  if (slashStyle === 'backslash') return fsPath.replace(/\//g, '\\');
  return normalize(fsPath);
}

export function toFileUri(fsPath, line = null, endLine = null) {
  const forward = String(fsPath || '').replace(/\\/g, '/');
  const prefixed = /^[A-Za-z]:\//.test(forward) ? `file:///${forward}` : `file://${forward.startsWith('/') ? '' : '/'}${forward}`;
  // Encode spaces and `#`/`?` while keeping drive colons & slashes readable.
  const encoded = prefixed
    .replace(/%/g, '%25')
    .replace(/ /g, '%20')
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
  if (line && endLine && endLine !== line) return `${encoded}#L${line}-L${endLine}`;
  if (line) return `${encoded}#L${line}`;
  return encoded;
}

export function resolveTargetPath(rawInput, { workspaceRoots = [], slashStyle = 'native', env = process.env } = {}) {
  const parsed = parseRawPathInput(rawInput, env);
  if (!parsed) return null;

  const cleanRoots = workspaceRoots
    .map(workspaceUriToPath)
    .filter(Boolean);

  let resolvedPath = '';
  let matchedWorkspace = '';

  const looksWinAbs = /^[A-Za-z]:[\\/]/.test(parsed.rawPath) || /^\\\\[^\\]/.test(parsed.rawPath);
  if (looksWinAbs || isAbsolute(parsed.rawPath)) {
    resolvedPath = normalize(parsed.rawPath);
  } else {
    // Try resolving relative path against each known workspace root; prefer one that exists.
    for (const root of cleanRoots) {
      const candidate = resolve(root, parsed.rawPath);
      if (existsSync(candidate)) {
        resolvedPath = candidate;
        matchedWorkspace = root;
        break;
      }
    }
    if (!resolvedPath && cleanRoots.length > 0) {
      resolvedPath = resolve(cleanRoots[0], parsed.rawPath);
      matchedWorkspace = cleanRoots[0];
    } else if (!resolvedPath) {
      return null;
    }
  }

  // Match workspace root for relativePath computation even for absolute inputs.
  if (!matchedWorkspace) {
    const lowerTarget = resolvedPath.toLowerCase();
    for (const root of cleanRoots) {
      const lowerRoot = root.toLowerCase().replace(/[\\/]+$/, '');
      if (lowerTarget === lowerRoot || lowerTarget.startsWith(lowerRoot + '\\') || lowerTarget.startsWith(lowerRoot + '/')) {
        matchedWorkspace = root;
        break;
      }
    }
  }

  let exists = false;
  let isDirectory = false;
  let isFile = false;
  try {
    if (existsSync(resolvedPath)) {
      const st = statSync(resolvedPath);
      exists = true;
      isDirectory = st.isDirectory();
      isFile = st.isFile();
    }
  } catch {}

  const parentDir = isDirectory ? resolvedPath : dirname(resolvedPath);
  const nearestExistingDir = exists ? parentDir : findNearestExistingDir(resolvedPath);
  const fileName = basename(resolvedPath);

  let relPath = '';
  if (matchedWorkspace) {
    relPath = relative(matchedWorkspace, resolvedPath);
    if (relPath.startsWith('..')) relPath = '';
  }

  const formattedAbs = formatPathForCopy(resolvedPath, slashStyle);
  const formattedRel = relPath ? formatPathForCopy(relPath, slashStyle === 'backslash' ? 'backslash' : 'forward') : '';
  const lineSuffix = parsed.line ? (parsed.col ? `:${parsed.line}:${parsed.col}` : `:${parsed.line}`) : '';
  const copyWithLine = (formattedRel || formattedAbs) + lineSuffix;

  return {
    rawInput: String(rawInput || ''),
    absolutePath: resolvedPath,
    formattedAbsolutePath: formattedAbs,
    relativePath: formattedRel,
    copyWithLine,
    fileUri: toFileUri(resolvedPath, parsed.line, parsed.endLine),
    fileName,
    parentDir,
    nearestExistingDir,
    workspaceRoot: matchedWorkspace,
    exists,
    isDirectory,
    isFile,
    line: parsed.line,
    endLine: parsed.endLine,
    col: parsed.col,
  };
}
