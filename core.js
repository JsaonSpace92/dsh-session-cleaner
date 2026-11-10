import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, writeFile, rename, mkdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { deflateRawSync, crc32 as nativeCrc32 } from 'node:zlib';

export const GROUPS = ['archived', 'deleted', 'unassociated', 'unknown'];
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const inside = (root, path) => path === root || path.startsWith(root + sep);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  if (typeof nativeCrc32 === 'function') return nativeCrc32(buffer) >>> 0;
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function sanitizeFileName(value, fallback = 'untitled') {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u001f\u007f/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return (cleaned ? cleaned.slice(0, 80).trim() : fallback) || fallback;
}

function dosDateTime(input) {
  const date = input instanceof Date ? input : new Date(input || Date.now());
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    dosTime: ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f),
    dosDate: (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f),
  };
}

export function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const normalizedName = String(entry.name || 'file').replace(/^\/+/, '').replace(/\\/g, '/');
    const nameBuf = Buffer.from(normalizedName, 'utf8');
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const crc = crc32(rawBuf);
    const deflated = rawBuf.length > 0 ? deflateRawSync(rawBuf) : rawBuf;
    const useDeflate = rawBuf.length > 0 && deflated.length < rawBuf.length;
    const method = useDeflate ? 8 : 0;
    const dataBuf = useDeflate ? deflated : rawBuf;
    const { dosTime, dosDate } = dosDateTime(entry.mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, dataBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function renderContentParts(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      parts.push(item.text.trim());
    } else if ((item.type === 'thinking' || item.type === 'reasoning') && typeof (item.thinking || item.text) === 'string') {
      const thought = (item.thinking || item.text).trim();
      if (thought) parts.push(`<details><summary>思考过程</summary>\n\n${thought}\n\n</details>`);
    } else if (item.type === 'image') {
      parts.push(`![图片附件](${item.name || item.source?.sha256 || 'image'})`);
    } else if (item.type === 'file') {
      parts.push(`📎 文件附件：\`${item.name || item.path || 'file'}\``);
    }
  }
  return parts.join('\n\n');
}

export function formatSessionMarkdown(row, header, events = []) {
  const title = row?.title || header?.id || '未命名对话';
  const created = header?.createdAt ? new Date(header.createdAt).toISOString() : '未知';
  const lines = [
    `# ${title}`,
    '',
    `- **会话 ID**：\`${header?.id || row?.id || ''}\``,
    `- **所属工作区**：${row?.workspaceTitle || row?.formerWorkspace || '未绑定'}`,
    `- **工作目录**：\`${header?.cwd || row?.cwd || '未绑定'}\``,
    `- **创建时间**：${created}`,
    `- **状态**：${row?.archived ? '已归档' : '未归档'}`,
    `- **事件总数**：${events.length}`,
    '',
    '---',
    '',
  ];

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const timeLabel = event.timestamp ? ` _(${new Date(event.timestamp).toLocaleString('zh-CN')})_` : '';
    if (event.type === 'user/message') {
      const body = renderContentParts(event.data?.content);
      if (!body) continue;
      lines.push(`## 👤 用户${timeLabel}`, '', body, '');
    } else if (event.type === 'assistant/message') {
      const body = renderContentParts(event.data?.message?.content);
      if (!body) continue;
      lines.push(`## 🤖 助手${timeLabel}`, '', body, '');
    } else if (event.type === 'tool/call') {
      const toolName = event.data?.name || 'tool';
      let argsText = '';
      try {
        argsText = typeof event.data?.arguments === 'string'
          ? event.data.arguments
          : JSON.stringify(event.data?.arguments ?? {}, null, 2);
      } catch { argsText = String(event.data?.arguments ?? ''); }
      if (argsText.length > 2000) argsText = argsText.slice(0, 2000) + '\n... (已截断，完整内容见 JSONL)';
      lines.push(`### 🔧 工具调用：\`${toolName}\`${timeLabel}`, '', '```json', argsText, '```', '');
    } else if (event.type === 'tool/result') {
      const body = renderContentParts(event.data?.message?.content);
      if (!body) continue;
      const preview = body.length > 2000 ? body.slice(0, 2000) + '\n... (已截断，完整内容见 JSONL)' : body;
      lines.push(`<details><summary>📎 工具返回结果${event.data?.message?.isError ? '（错误）' : ''}</summary>\n\n\`\`\`text\n${preview}\n\`\`\`\n\n</details>`, '');
    }
  }

  return lines.join('\n').trim() + '\n';
}

export function formatSessionJsonl(header, events = []) {
  const lines = [JSON.stringify({ type: 'session/header', header })];
  for (const event of events) {
    lines.push(JSON.stringify(event));
  }
  return lines.join('\n') + '\n';
}

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

export function classifyAll(snapshots, workspaces, archivedIds, history, live = new Map(), options = {}) {
  const autoInferDeleted = options.autoInferDeleted ?? false;
  const owned = new Set(workspaces.flatMap(workspace => workspace.sessionIds || []));
  const workspaceBySessionId = new Map();
  const workspaceByPath = new Map();
  for (const workspace of workspaces) {
    if (workspace.path) workspaceByPath.set(workspace.path, workspace);
    for (const sessionId of workspace.sessionIds || []) {
      workspaceBySessionId.set(sessionId, workspace);
    }
  }
  const workspacePaths = new Set(workspaceByPath.keys());
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

    const activeWorkspace = workspaceBySessionId.get(header.id) || (header.cwd ? workspaceByPath.get(header.cwd) : null) || null;
    const title = live.get(header.id)?.projections?.values?.title;
    const shortId = header.id.replace(/^session-/, '').slice(0, 8);
    const fallbackTitle = (snapshot.sizeBytes || 0) < 1024 ? `空白对话 (${shortId})` : `未命名对话 (${shortId})`;
    const recordedFormer = history.deletedSessions?.[header.id]?.title || null;
    const inferredFormer = group === 'deleted' && !recordedFormer && header.cwd ? basename(header.cwd) || header.cwd : null;
    const formerWorkspace = recordedFormer || inferredFormer;
    return {
      id: header.id,
      group,
      archived: archived.has(header.id),
      isSubagent,
      cwd: header.cwd || '',
      createdAt: header.createdAt,
      parentId: header.parentSession || null,
      origin: header.origin || null,
      isSeeded: !!header.isSeeded,
      bytes: snapshot.sizeBytes || 0,
      events: snapshot.eventCount || 0,
      running: !!live.get(header.id)?.running,
      title: typeof title === 'string' && title.trim() ? title : fallbackTitle,
      formerWorkspace,
      workspaceId: activeWorkspace?.id || null,
      workspaceTitle: activeWorkspace?.title || (activeWorkspace?.path ? basename(activeWorkspace.path) : null) || formerWorkspace || null,
    };
  });
}

export function classify(snapshots, workspaces, archivedIds, history, live = new Map(), options = {}) {
  return classifyAll(snapshots, workspaces, archivedIds, history, live, options)
    .filter(row => row.group !== 'associated');
}

export function summarizeWorkspaces(workspaces, allRows, snapshots) {
  const rowById = new Map(allRows.map(row => [row.id, row]));
  return workspaces.map(workspace => {
    const ownedSet = new Set(workspace.sessionIds || []);
    const matchedTopRows = allRows.filter(row => !row.isSubagent && (
      ownedSet.has(row.id) || (workspace.path && row.cwd === workspace.path)
    ));
    const sessionIds = matchedTopRows.map(row => row.id);
    const activeCount = matchedTopRows.filter(row => !row.archived).length;
    const archivedCount = matchedTopRows.filter(row => row.archived).length;

    const deletableSessionIds = [];
    const runningSessionIds = [];
    for (const row of matchedTopRows) {
      const descendants = collectDescendants(snapshots, [row.id]);
      const anyRunning = row.running || descendants.some(childId => rowById.get(childId)?.running);
      if (anyRunning) runningSessionIds.push(row.id);
      else deletableSessionIds.push(row.id);
    }

    const allWithDescendants = new Set([...sessionIds, ...collectDescendants(snapshots, sessionIds)]);
    let bytes = 0;
    for (const id of allWithDescendants) {
      bytes += rowById.get(id)?.bytes || 0;
    }

    return {
      id: workspace.id,
      title: workspace.title || (workspace.path ? basename(workspace.path) : workspace.id),
      path: workspace.path || '',
      createdAt: workspace.createdAt || 0,
      updatedAt: workspace.updatedAt || 0,
      activeCount,
      archivedCount,
      totalCount: sessionIds.length,
      runningCount: runningSessionIds.length,
      sessionIds,
      deletableSessionIds,
      runningSessionIds,
      bytes,
    };
  });
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
