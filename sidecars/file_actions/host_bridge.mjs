// Async host bridge, EPIPE guard, LS watchdog, and self-reload watcher for agy-file-actions.

import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function runAgentApi(args, { projectId, env = process.env, execFileImpl = execFile } = {}) {
  const childEnv = { ...env };
  if (projectId) childEnv.ANTIGRAVITY_PROJECT_ID = projectId;
  const exe = env.ANTIGRAVITY_AGENTAPI_EXE;
  const file = exe || 'agentapi';
  const execArgs = exe ? ['agentapi', ...args] : args;
  return new Promise((resolve, reject) => {
    execFileImpl(
      file,
      execArgs,
      { encoding: 'utf8', env: childEnv, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const out = String(stdout ?? '').trim();
          resolve(out ? JSON.parse(out) : {});
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

export function installAsyncHostRoutes(app, options = {}) {
  const run = (args, extra) => runAgentApi(args, { ...options, ...extra });
  app.api('/_sidecar/send-message', (data = {}) => {
    const args = ['send-message'];
    if (data.title) args.push('--title', data.title);
    args.push(data.conversationId, data.message);
    return run(args, { projectId: data.projectId });
  }, 'POST');
  app.api('/_sidecar/new-conversation', (data = {}) =>
    run(['new-conversation', '--model', data.model || 'flash', data.message], { projectId: data.projectId }), 'POST');
  app.api('/_sidecar/get-conversation-metadata', (data = {}) =>
    run(['get-conversation-metadata', data.conversationId]), 'POST');
}

export function installEpipeGuard(proc = process) {
  const isEpipe = err => err?.code === 'EPIPE';
  for (const stream of [proc.stdout, proc.stderr]) {
    stream?.on?.('error', err => { if (!isEpipe(err)) throw err; });
  }
  const fatal = err => {
    if (isEpipe(err)) return;
    try { console.error('[file-actions] fatal:', err); } catch {}
    proc.exit(1);
  };
  proc.on('uncaughtException', fatal);
  proc.on('unhandledRejection', fatal);
}

export function startLsWatchdog(lsAddress, onLost, intervalMs = 15_000) {
  if (!lsAddress) return () => {};
  let failures = 0;
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const res = await fetch(`http://${lsAddress}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) { failures = 0; return; }
    } catch {}
    failures++;
    if (failures >= 3 && !stopped) {
      stopped = true;
      clearInterval(timer);
      onLost?.('language server unreachable');
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function startSelfReloadWatcher(dir, onChange, intervalMs = 2000) {
  const snapshot = () => {
    try {
      return readdirSync(dir)
        .filter(f => f.endsWith('.mjs') || f.endsWith('.json'))
        .sort()
        .map(f => {
          const st = statSync(join(dir, f), { throwIfNoEntry: false });
          return `${f}:${st?.size || 0}:${Math.floor(st?.mtimeMs || 0)}`;
        })
        .join('|');
    } catch {
      return '';
    }
  };
  let baseline = snapshot();
  let pendingAt = 0;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const current = snapshot();
    if (current && current !== baseline) {
      baseline = current;
      pendingAt = Date.now();
    } else if (pendingAt && Date.now() - pendingAt >= 1500) {
      stopped = true;
      clearInterval(timer);
      onChange?.('plugin files changed');
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
