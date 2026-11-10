import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, writeFile, rename, mkdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';

export const GROUPS = ['archived', 'deleted', 'unassociated', 'unknown'];
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const inside = (root, path) => path === root || path.startsWith(root + sep);

export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.new';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

export async function optionalJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function collectDescendants(snapshots, seedIds) {
  const byParent = new Map();
  for (const snapshot of snapshots) {
    const parentId = snapshot.header.parentSession;
    if (!parentId) continue;
    let list = byParent.get(parentId);
    if (!list) { list = []; byParent.set(parentId, list); }
    list.push(snapshot.header.id);
  }
  const visited = new Set(seedIds);
  const queue = [...seedIds];
  const descendants = [];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const childId of byParent.get(current) || []) {
      if (!visited.has(childId)) {
        visited.add(childId);
        descendants.push(childId);
        queue.push(childId);
      }
    }
  }
  return descendants;
}

export function classify(snapshots, workspaces, archivedIds, history, live = new Map(), options = {}) {
  const autoInferDeleted = options.autoInferDeleted ?? false;
  const owned = new Set(workspaces.flatMap(workspace => workspace.sessionIds || []));
  const workspacePaths = new Set(workspaces.map(workspace => workspace.path).filter(Boolean));
  const archived = new Set(archivedIds);
  const byId = new Map(snapshots.map(snapshot => [snapshot.header.id, snapshot]));

  function rootAncestor(header) {
    let current = header;
    const seen = new Set([current.id]);
    while (current.parentSession && byId.has(current.parentSession) && !seen.has(current.parentSession)) {
      seen.add(current.parentSession);
      current = byId.get(current.parentSession).header;
    }
    return current;
  }

  return snapshots.map(snapshot => {
    const header = snapshot.header;
    const isSubagent = header.origin === 'subagent' || Boolean(header.parentSession);
    const root = rootAncestor(header);
    const activeOwnedSubagent = isSubagent && !archived.has(header.id) && !history.deletedSessions?.[header.id] && (
      (owned.has(root.id) && !archived.has(root.id)) ||
      (header.cwd && workspacePaths.has(header.cwd) && !archived.has(root.id))
    );

    let group;
    if (archived.has(header.id)) {
      group = 'archived';
    } else if (owned.has(header.id) || activeOwnedSubagent) {
      group = 'associated';
    } else if (history.deletedSessions?.[header.id]) {
      group = 'deleted';
    } else if (history.unassociated?.[header.id] || !header.cwd) {
      group = 'unassociated';
    } else if (autoInferDeleted && !workspacePaths.has(header.cwd)) {
      group = 'deleted';
    } else {
      group = 'unknown';
    }

    const title = live.get(header.id)?.projections?.values?.title;
    const shortId = header.id.replace(/^session-/, '').slice(0, 8);
    const fallbackTitle = (snapshot.sizeBytes || 0) < 1024 ? `空白对话 (${shortId})` : `未命名对话 (${shortId})`;
    const recordedFormer = history.deletedSessions?.[header.id]?.title || null;
    const inferredFormer = group === 'deleted' && !recordedFormer && header.cwd ? basename(header.cwd) || header.cwd : null;
    return {
      id: header.id,
      group,
      cwd: header.cwd || '',
      createdAt: header.createdAt,
      parentId: header.parentSession || null,
      origin: header.origin || null,
      isSeeded: !!header.isSeeded,
      bytes: snapshot.sizeBytes || 0,
      running: !!live.get(header.id)?.running,
      title: typeof title === 'string' && title.trim() ? title : fallbackTitle,
      formerWorkspace: recordedFormer || inferredFormer,
    };
  }).filter(row => row.group !== 'associated');
}

export function observeWorkspaces(history, current) {
  history.since ||= new Date().toISOString();
  const next = Object.fromEntries(current.map(workspace => [workspace.id, {
    path: workspace.path, title: workspace.title, sessionIds: [...workspace.sessionIds],
  }]));
  for (const [id, previous] of Object.entries(history.workspaces)) {
    if (!next[id]) for (const sessionId of previous.sessionIds) {
      history.deletedSessions[sessionId] = { workspaceId: id, title: previous.title, path: previous.path };
    }
  }
  history.workspaces = next;
  return history;
}

export async function snapshotFiles(dir) {
  const files = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error('会话目录含符号链接，请先人工检查。');
      if (info.isDirectory()) await walk(full);
      else if (info.isFile() && relative(dir, full) !== 'session.lock') {
        const bytes = await readFile(full);
        files.push({ path: relative(dir, full).split(sep).join('/'), size: bytes.length, sha256: digest(bytes) });
      } else if (!info.isFile()) throw new Error('会话目录含不支持的特殊文件。');
    }
  }
  await walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function canonical(path) {
  if (!path || !isAbsolute(path)) throw new Error('存储路径无效。');
  const actual = await realpath(path);
  if (resolve(path) !== actual) throw new Error('存储路径经过符号链接，请显式配置真实路径。');
  return actual;
}
