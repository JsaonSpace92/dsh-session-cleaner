import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  GROUPS,
  atomicJson,
  canonical,
  classify,
  classifyAll,
  collectDescendants,
  createZipBuffer,
  digest,
  formatSessionJsonl,
  formatSessionMarkdown,
  inside,
  observeWorkspaces,
  optionalJson,
  sanitizeFileName,
  snapshotFiles,
  summarizeWorkspaces,
} from './core.js';

export const name = 'dsh-session-cleaner';
export const inject = ['webServer', 'connection', 'sessionPersistence', 'sessionController', 'workspaceRegistry', 'storageDomain', 'tools'];
const route = '/session-cleaner/v1';
const jsonEqual = (left, right) => isDeepStrictEqual(JSON.parse(JSON.stringify(left ?? null)), JSON.parse(JSON.stringify(right ?? null)));
const quote = value => "'" + value.replaceAll("'", `'"'"'`) + "'";

export class SessionCleaner {
  constructor(ctx, config) { this.ctx = ctx; this.config = config; this.tail = Promise.resolve(); }
  async start() {
    await mkdir(this.config.output, { recursive: true });
    this.historyPath = join(this.config.output, 'workspace-history.json');
    this.history = await optionalJson(this.historyPath, { version: 1, workspaces: {}, deletedSessions: {} });
    if (this.history.version !== 1) throw new Error('工作区历史版本不兼容。');
    await this.observe();
  }
  observe() {
    const operation = this.tail.then(async () => {
      observeWorkspaces(this.history, this.ctx.workspaceRegistry.list());
      await atomicJson(this.historyPath, this.history);
      this.historyError = null;
    });
    this.tail = operation.catch(error => { this.historyError = String(error); });
    return operation;
  }
  domain() {
    const domain = this.ctx.storageDomain.get('workspace');
    if (!domain) throw new Error('工作区服务尚未就绪，请稍后刷新。');
    return domain;
  }
  async scan(options = {}) {
    await this.observe();
    if (this.historyError) throw new Error(this.historyError);
    const snapshots = await this.ctx.sessionPersistence.list();
    const liveResult = await this.ctx.sessionController.list({}, new AbortController().signal);
    const live = new Map(liveResult.items.map(item => [item.sessionId, item]));
    const autoInferDeleted = options.autoInferDeleted ?? true;
    const workspaceList = this.ctx.workspaceRegistry.list();
    const archivedIds = this.domain().global.get().archivedSessionIds || [];
    const allRows = classifyAll(snapshots, workspaceList, archivedIds, this.history, live, { autoInferDeleted });
    const rows = allRows.filter(row => row.group !== 'associated');
    const allSessions = allRows
      .filter(row => !row.isSubagent || row.archived)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const workspaces = summarizeWorkspaces(workspaceList, allRows, snapshots);

    const formerWorkspacesMap = new Map();
    for (const row of rows) {
      if (row.group !== 'deleted') continue;
      const key = row.cwd || row.formerWorkspace || '未知工作区';
      let item = formerWorkspacesMap.get(key);
      if (!item) {
        item = { key, title: row.formerWorkspace || (row.cwd ? basename(row.cwd) : '已删除工作区'), cwd: row.cwd || '', sessionIds: [], bytes: 0 };
        formerWorkspacesMap.set(key, item);
      }
      item.sessionIds.push(row.id);
      item.bytes += row.bytes;
    }

    const counts = {
      ...Object.fromEntries(GROUPS.map(group => [group, rows.filter(row => row.group === group).length])),
      all_sessions: allSessions.length,
      all_workspaces: workspaces.length,
    };

    return {
      rows,
      allSessions,
      workspaces,
      counts,
      formerWorkspaces: [...formerWorkspacesMap.values()],
      trackedSince: this.history.since || null,
      limitations: ['删除后将永久移除 DSH 会话日志、归档/置顶引用及缓存；本地磁盘上的项目代码与文件夹始终保留。', '全局去重的共享附件保持保留；已派生的独立会话副本保持保留。'],
      historyError: this.historyError || null,
    };
  }
  async preview(ids, options = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string')) throw new Error('请选择 1–1000 个会话。');
    const scan = await this.scan();
    const pool = options.allowActiveWorkspace ? scan.allSessions : scan.rows;
    const byId = new Map(pool.map(row => [row.id, row]));
    const selected = [...new Set(ids)].map(id => {
      const row = byId.get(id);
      if (!row || row.running) throw new Error('所选会话已变化或仍在运行，请刷新后重选。');
      return row;
    });
    const all = await this.ctx.sessionPersistence.list();
    const selectedIds = new Set(selected.map(row => row.id));
    const retainedChildren = all.filter(item => selectedIds.has(item.header.parentSession) && !selectedIds.has(item.header.id)).map(item => item.header.id);
    const cascadeChildren = collectDescendants(all, selectedIds);
    let workspaceCheck;
    try { await this.workspaceSnapshot(); workspaceCheck = { ready: true }; }
    catch (error) { workspaceCheck = { ready: false, error: error.message }; }
    return { selected, retainedChildren, cascadeChildren, bytes: selected.reduce((sum, row) => sum + row.bytes, 0), limitations: scan.limitations, workspaceCheck };
  }
  async confirmCategory(ids, category) {
    if (!['deleted', 'unassociated'].includes(category)) throw new Error('分类无效。');
    const preview = await this.preview(ids);
    for (const row of preview.selected) {
      if (!['unknown', 'unassociated', 'deleted'].includes(row.group)) throw new Error('仅可确认未分组会话的归属。');
    }
    const operation = this.tail.then(async () => {
      for (const row of preview.selected) {
        if (category === 'deleted') { this.history.deletedSessions[row.id] = { title: row.cwd ? basename(row.cwd) : '用户确认的已删除工作区', path: row.cwd || '', manual: true }; delete this.history.unassociated?.[row.id]; }
        else { delete this.history.deletedSessions[row.id]; (this.history.unassociated ||= {})[row.id] = true; }
      }
      await atomicJson(this.historyPath, this.history);
    });
    this.tail = operation.catch(error => { this.historyError = String(error); });
    await operation;
    return this.scan();
  }
  async workspaceSnapshot() {
    const storage = await canonical(this.config.storage);
    const workspacePath = join(storage, 'workspace.json');
    const workspaceBytes = await readFile(workspacePath);
    const document = JSON.parse(workspaceBytes.toString('utf8'));
    const domain = this.domain();
    const workspaceRecords = Object.fromEntries(domain.table('workspaces').entries());
    if (document.unit?.name !== 'workspace' || document.unit.version !== 2 || document.global?.pendingMutation ||
      !jsonEqual(document.global, domain.global.get()) || !jsonEqual(document.tables?.workspaces, workspaceRecords)) {
      throw new Error('磁盘工作区状态与当前服务不一致；请核对实际 storage 路径，稍后重试。');
    }
    return { storage, workspacePath, workspaceBytes };
  }
  async readSessionEvents(id) {
    if (typeof this.ctx.sessionPersistence.open === 'function') {
      const handle = await this.ctx.sessionPersistence.open(id, 'read');
      try {
        const result = await handle.read();
        return Array.isArray(result?.events) ? result.events : [];
      } finally {
        await handle.close?.();
      }
    }
    const stat = await this.ctx.sessionPersistence.stat(id);
    if (stat?.location?.path && !stat.location.path.endsWith('.zstd')) {
      try {
        const raw = await readFile(stat.location.path, 'utf8');
        const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
        const events = [];
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed && parsed.type && parsed.type !== 'session/header') events.push(parsed);
          } catch {}
        }
        return events;
      } catch {}
    }
    return [];
  }
  async exportSessions(ids, options = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string')) {
      throw new Error('请选择 1–1000 个要导出的对话。');
    }
    const format = ['zip', 'md', 'jsonl'].includes(options.format) ? options.format : 'zip';
    await this.ctx.sessionPersistence.flush();
    const scan = await this.scan();
    const snapshots = await this.ctx.sessionPersistence.list();
    const snapshotById = new Map(snapshots.map(item => [item.header.id, item]));
    const rowById = new Map([...scan.allSessions, ...scan.rows].map(row => [row.id, row]));

    const uniqueIds = [...new Set(ids)];
    const records = [];
    for (const id of uniqueIds) {
      const snapshot = snapshotById.get(id);
      if (!snapshot) throw new Error(`未找到对话 ${id}，请刷新后重试。`);
      const row = rowById.get(id) || {
        id,
        title: id,
        cwd: snapshot.header.cwd || '',
        createdAt: snapshot.header.createdAt,
        archived: false,
        workspaceTitle: snapshot.header.cwd ? basename(snapshot.header.cwd) : null,
      };
      const events = await this.readSessionEvents(id);
      const md = formatSessionMarkdown(row, snapshot.header, events);
      const jsonl = formatSessionJsonl(snapshot.header, events);
      records.push({ id, row, header: snapshot.header, eventsCount: events.length, md, jsonl });
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    let filename;
    let mediaType;
    let buffer;

    if (records.length === 1 && !options.workspaceTitle && format === 'md') {
      const item = records[0];
      const shortId = item.id.replace(/^session-/, '').slice(0, 8);
      filename = `${sanitizeFileName(item.row.title, shortId)}-${shortId}.md`;
      mediaType = 'text/markdown; charset=utf-8';
      buffer = Buffer.from(item.md, 'utf8');
    } else if (records.length === 1 && !options.workspaceTitle && format === 'jsonl') {
      const item = records[0];
      const shortId = item.id.replace(/^session-/, '').slice(0, 8);
      filename = `${sanitizeFileName(item.row.title, shortId)}-${shortId}.jsonl`;
      mediaType = 'application/x-ndjson; charset=utf-8';
      buffer = Buffer.from(item.jsonl, 'utf8');
    } else {
      const entries = [];
      for (let i = 0; i < records.length; i++) {
        const item = records[i];
        const shortId = item.id.replace(/^session-/, '').slice(0, 8);
        const folder = `${String(i + 1).padStart(2, '0')}-${sanitizeFileName(item.row.title, shortId)}-${shortId}`;
        if (format !== 'jsonl') entries.push({ name: `${folder}/transcript.md`, data: item.md, mtime: item.header.createdAt });
        if (format !== 'md') entries.push({ name: `${folder}/events.jsonl`, data: item.jsonl, mtime: item.header.createdAt });
        entries.push({
          name: `${folder}/meta.json`,
          data: JSON.stringify({
            id: item.id,
            title: item.row.title,
            workspaceTitle: item.row.workspaceTitle,
            cwd: item.header.cwd || null,
            createdAt: item.header.createdAt,
            archived: !!item.row.archived,
            eventsCount: item.eventsCount,
          }, null, 2) + '\n',
          mtime: item.header.createdAt,
        });
      }
      entries.push({
        name: 'manifest.json',
        data: JSON.stringify({
          exportedAt: new Date().toISOString(),
          workspaceTitle: options.workspaceTitle || null,
          format,
          sessionCount: records.length,
          sessions: records.map(item => ({
            id: item.id,
            title: item.row.title,
            workspaceTitle: item.row.workspaceTitle,
            cwd: item.header.cwd || null,
            createdAt: item.header.createdAt,
            archived: !!item.row.archived,
            eventsCount: item.eventsCount,
          })),
        }, null, 2) + '\n',
      });
      if (options.workspaceTitle) {
        filename = `${sanitizeFileName(options.workspaceTitle, 'workspace')}-对话日志-${dateStr}.zip`;
      } else if (records.length === 1) {
        const shortId = records[0].id.replace(/^session-/, '').slice(0, 8);
        filename = `${sanitizeFileName(records[0].row.title, shortId)}-${shortId}.zip`;
      } else {
        filename = `dsh-对话导出-${records.length}条-${dateStr}.zip`;
      }
      mediaType = 'application/zip';
      buffer = createZipBuffer(entries);
    }

    const exportsDir = join(this.config.output, 'exports');
    await mkdir(exportsDir, { recursive: true });
    const savedPath = join(exportsDir, filename);
    await writeFile(savedPath, buffer, { mode: 0o600 });

    return {
      filename,
      mediaType,
      sizeBytes: buffer.length,
      savedPath,
      count: records.length,
      base64: buffer.toString('base64'),
      message: `已导出 ${records.length} 条对话至 ${filename}。`,
    };
  }
  async exportWorkspace(workspaceId, options = {}) {
    if (typeof workspaceId !== 'string' || !workspaceId) throw new Error('请指定工作区。');
    const scan = await this.scan();
    const ws = scan.workspaces.find(item => item.id === workspaceId);
    if (!ws) throw new Error('未找到指定工作区，请刷新后重试。');
    if (ws.sessionIds.length === 0) {
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `${sanitizeFileName(ws.title, 'workspace')}-对话日志-${dateStr}.zip`;
      const buffer = createZipBuffer([{
        name: 'manifest.json',
        data: JSON.stringify({
          exportedAt: new Date().toISOString(),
          workspaceId: ws.id,
          workspaceTitle: ws.title,
          path: ws.path,
          sessionCount: 0,
          sessions: [],
        }, null, 2) + '\n',
      }]);
      const exportsDir = join(this.config.output, 'exports');
      await mkdir(exportsDir, { recursive: true });
      const savedPath = join(exportsDir, filename);
      await writeFile(savedPath, buffer, { mode: 0o600 });
      return {
        filename,
        mediaType: 'application/zip',
        sizeBytes: buffer.length,
        savedPath,
        count: 0,
        base64: buffer.toString('base64'),
        message: `工作区「${ws.title}」暂无对话，已导出空清单压缩包 ${filename}。`,
      };
    }
    return this.exportSessions(ws.sessionIds, { format: options.format || 'zip', workspaceTitle: ws.title });
  }
  async deleteSessions(ids, options = {}) {
    const includeChildren = options.includeChildren !== false;
    const allowActiveWorkspace = options.allowActiveWorkspace === true;
    const preview = await this.preview(ids, { allowActiveWorkspace });
    await this.ctx.sessionPersistence.flush();
    const sessionsRoot = await canonical(this.config.sessions);
    const storageRoot = await canonical(this.config.storage);
    const allSnapshots = await this.ctx.sessionPersistence.list();
    const liveResult = await this.ctx.sessionController.list({}, new AbortController().signal);
    const live = new Map(liveResult.items.map(item => [item.sessionId, item]));
    const targetIdList = [...new Set([
      ...preview.selected.map(row => row.id),
      ...(includeChildren ? collectDescendants(allSnapshots, preview.selected.map(row => row.id)) : []),
    ])];
    const protectedPaths = new Set([
      ...this.ctx.workspaceRegistry.list().map(workspace => workspace.path).filter(Boolean),
      ...allSnapshots.map(item => item.header.cwd).filter(Boolean),
    ]);

    const targets = [];
    for (const id of targetIdList) {
      if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(id)) throw new Error(`会话标识 ${id} 含不支持的字符，请人工检查。`);
      if (live.get(id)?.running) throw new Error(`会话 ${id} 正在运行中，无法删除。`);
      const statBefore = await this.ctx.sessionPersistence.stat(id);
      if (!statBefore?.location?.path) throw new Error(`会话 ${id} 不提供本地文件位置。`);
      const dir = await canonical(dirname(statBefore.location.path));
      if (!inside(sessionsRoot, dir) || dirname(dirname(dir)) !== sessionsRoot || basename(dir) !== id) {
        throw new Error('会话位置不在已验证的存储根内，或目录与标识不匹配。');
      }
      for (const protectedPath of protectedPaths) {
        if (inside(dir, protectedPath) || inside(protectedPath, dir)) {
          throw new Error('目标会话目录与受保护的项目目录重叠，已拒绝删除。');
        }
      }
      targets.push({ id, dir });
    }

    const sessionStore = this.ctx.get?.('sessions') ?? this.ctx.sessions;
    const projDomain = this.ctx.storageDomain.get('session_projcache');
    const projTable = projDomain?.table?.('sessions');
    const projCacheDir = join(storageRoot, 'session_projcache', 'sessions');

    for (const { id, dir } of targets) {
      try { sessionStore?.store?.get?.(id)?.detach?.(); } catch {}
      if (typeof this.ctx.workspaceRegistry.unarchiveSession === 'function') {
        await this.ctx.workspaceRegistry.unarchiveSession(id);
      }
      if (typeof this.ctx.workspaceRegistry.unpinSession === 'function') {
        await this.ctx.workspaceRegistry.unpinSession(id);
      }
      for (const workspace of this.ctx.workspaceRegistry.list()) {
        if (typeof workspace.detachSession === 'function' && workspace.sessionIds?.includes(id)) {
          await workspace.detachSession(id);
        }
      }
      this.ctx.workspaceRegistry.headers?.delete?.(id);
      this.ctx.workspaceRegistry.sessionPaths?.delete?.(id);
      this.ctx.workspaceRegistry.missingSessionPaths?.delete?.(id);
      this.ctx.workspaceRegistry.invalidSessionPaths?.delete?.(id);
      this.ctx.sessionPersistence.coldLogMemo?.delete?.(id);
      this.ctx.sessionPersistence.migrationPreparations?.delete?.(id);
      try { await projTable?.delete?.(id); } catch {}
      try {
        const entries = await readdir(projCacheDir);
        for (const name of entries) {
          if (name === `${id}.json` || name.startsWith(`${id}.json.bak.`)) {
            await rm(join(projCacheDir, name), { force: true });
          }
        }
      } catch {}
      await rm(dir, { recursive: true, force: true });
    }

    const remainingSnapshots = await this.ctx.sessionPersistence.list();
    const existingIds = new Set(remainingSnapshots.map(item => item.header.id));
    const currentArchived = this.domain().global.get().archivedSessionIds || [];
    for (const archivedId of currentArchived) {
      if (!existingIds.has(archivedId) && typeof this.ctx.workspaceRegistry.unarchiveSession === 'function') {
        await this.ctx.workspaceRegistry.unarchiveSession(archivedId);
      }
    }
    const currentPinned = this.domain().global.get().pinnedSessionIds || [];
    for (const pinnedId of currentPinned) {
      if (!existingIds.has(pinnedId) && typeof this.ctx.workspaceRegistry.unpinSession === 'function') {
        await this.ctx.workspaceRegistry.unpinSession(pinnedId);
      }
    }

    const operation = this.tail.then(async () => {
      for (const { id } of targets) {
        delete this.history.deletedSessions?.[id];
        delete this.history.unassociated?.[id];
      }
      observeWorkspaces(this.history, this.ctx.workspaceRegistry.list());
      await atomicJson(this.historyPath, this.history);
    });
    this.tail = operation.catch(error => { this.historyError = String(error); });
    await operation;

    const refreshed = await this.scan();
    return {
      ...refreshed,
      deletedIds: targets.map(target => target.id),
      count: targets.length,
      selectedCount: preview.selected.length,
      message: `已永久删除 ${preview.selected.length} 个会话${targets.length > preview.selected.length ? `（含 ${targets.length - preview.selected.length} 个关联子会话）` : ''}，本地项目文件完好保留。`,
    };
  }
  async deleteWorkspace(workspaceId) {
    if (typeof workspaceId !== 'string' || !workspaceId) throw new Error('请指定要删除的工作区。');
    const scan = await this.scan();
    const ws = scan.workspaces.find(item => item.id === workspaceId);
    if (!ws) throw new Error('未找到指定工作区，请刷新后重试。');
    if (ws.runningCount > 0) {
      throw new Error(`工作区「${ws.title}」内有 ${ws.runningCount} 条对话正在运行中，请先停止运行或切换到其他工作区后再删除整个工作区。`);
    }

    let deletedIds = [];
    if (ws.deletableSessionIds.length > 0) {
      const delResult = await this.deleteSessions(ws.deletableSessionIds, {
        includeChildren: true,
        allowActiveWorkspace: true,
      });
      deletedIds = delResult.deletedIds || [];
    }

    if (typeof this.ctx.workspaceRegistry.delete === 'function') {
      await this.ctx.workspaceRegistry.delete(workspaceId);
    }

    const operation = this.tail.then(async () => {
      delete this.history.workspaces?.[workspaceId];
      for (const id of ws.sessionIds) {
        delete this.history.deletedSessions?.[id];
        delete this.history.unassociated?.[id];
      }
      observeWorkspaces(this.history, this.ctx.workspaceRegistry.list());
      await atomicJson(this.historyPath, this.history);
    });
    this.tail = operation.catch(error => { this.historyError = String(error); });
    await operation;

    const refreshed = await this.scan();
    return {
      ...refreshed,
      deletedWorkspaceId: workspaceId,
      deletedIds,
      count: deletedIds.length,
      message: `已移除工作区「${ws.title}」并彻底清理其 ${ws.deletableSessionIds.length} 条 DSH 对话记录（本地项目文件夹 ${ws.path} 完好保留）。`,
    };
  }
  async exportPlan(ids) {
    const preview = await this.preview(ids);
    await this.ctx.sessionPersistence.flush();
    const sessions = await canonical(this.config.sessions);
    const { storage, workspacePath, workspaceBytes } = await this.workspaceSnapshot();
    const targets = [];
    for (const row of preview.selected) {
      if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(row.id)) throw new Error('会话标识含不支持的字符，请人工检查。');
      const before = await this.ctx.sessionPersistence.stat(row.id);
      if (!before?.location?.path) throw new Error('当前会话后端不提供本地文件位置。');
      const dir = await canonical(dirname(before.location.path));
      if (!inside(sessions, dir) || dirname(dirname(dir)) !== sessions || basename(dir) !== row.id) throw new Error('会话位置不在已验证的存储根内，或目录与标识不匹配。');
      const files = await snapshotFiles(dir);
      const after = await this.ctx.sessionPersistence.stat(row.id);
      if (before.revision !== after?.revision) throw new Error('生成清单时会话发生变化，请重试。');
      targets.push({ id: row.id, dir, files });
    }
    const token = randomUUID();
    const output = join(this.config.output, 'plans', token);
    await mkdir(output, { recursive: true });
    const protectedPaths = [...new Set([...this.ctx.workspaceRegistry.list().map(workspace => workspace.path), ...(await this.ctx.sessionPersistence.list()).flatMap(item => item.header.cwd ? [item.header.cwd] : [])])];
    const manifest = { version: 1, token, createdAt: new Date().toISOString(), roots: { sessions, storage }, targets,
      workspace: { path: workspacePath, sha256: digest(workspaceBytes) }, protectedPaths };
    const path = join(output, 'manifest.json');
    await atomicJson(path, manifest);
    const helper = fileURLToPath(new URL('./offline.py', import.meta.url));
    const command = `python3 ${quote(helper)} ${quote(path)} --apply --confirm ${quote(token)}`;
    return { path, command, count: targets.length, token, retainedChildren: preview.retainedChildren,
      message: '清单已生成，尚未删除。完全退出所有 DSH 桌面端及 CLI 后，在终端运行命令。清理后保留备份，需显式清除备份才会永久删除备份中的记录。' };
  }
}

export async function apply(ctx, config) {
  if (!config?.sessions || !config.storage) throw new Error('会话清理缺少存储路径配置。');
  const cleaner = new SessionCleaner(ctx, { ...config, output: config.output || fileURLToPath(new URL('./runtime', import.meta.url)) });
  await cleaner.start();
  const nonce = randomUUID();
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  ctx.on('domain/changed', change => {
    if (change.domain === 'workspace') void cleaner.observe().catch(() => {});
  });
  const authorize = (request, peer) => {
    const admission = peer ? { peer } : ctx.connection.admit({ headers: request.headers });
    if ('rejection' in admission) return { error: admission.rejection === 401 ? 'DSH 登录状态已变化，请刷新整个 DSH 页面。' : '请求来源未通过 DSH 校验。', status: admission.rejection };
    if (admission.peer.principal.kind !== 'owner' || admission.peer.interactions !== 'answer') return { error: '请使用本人的 DSH 会话清理面板操作。', status: 403 };
  };
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route, resource: async (request, peer) => {
    if (request.headers.get('x-dsh-cleaner-panel') !== '1') return json({ error: '请从会话清理面板访问。' }, 403);
    const rejection = authorize(request, peer);
    if (rejection) return json({ error: rejection.error }, rejection.status);
    try { return json({ ...await cleaner.scan(), nonce, version: '0.3.0' }); }
    catch (error) { return json({ error: error.message }, 400); }
  } }));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route + '/action', handler: async (req, res) => {
    const respond = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.method !== 'POST') return respond({ error: '此操作只接受 POST 请求。' }, 405);
    const rejection = authorize(req);
    if (rejection) return respond({ error: rejection.error }, rejection.status);
    const credential = req.headers['x-dsh-cleaner'];
    if (typeof credential !== 'string' || Buffer.byteLength(credential) !== Buffer.byteLength(nonce) || !timingSafeEqual(Buffer.from(credential), Buffer.from(nonce))) return respond({ error: '面板已更新，请重新读取后操作。', code: 'PANEL_EXPIRED' }, 409);
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 100000) throw new Error('请求过大。'); }
      const input = JSON.parse(body);
      if (input.action === 'preview') return respond(await cleaner.preview(input.ids, { allowActiveWorkspace: input.allowActiveWorkspace === true }));
      if (input.action === 'confirm-category') return respond(await cleaner.confirmCategory(input.ids, input.category));
      if (input.action === 'delete' && input.confirmed === true) {
        return respond(await cleaner.deleteSessions(input.ids, {
          includeChildren: input.includeChildren !== false,
          allowActiveWorkspace: input.allowActiveWorkspace === true,
        }));
      }
      if (input.action === 'delete-workspace' && input.confirmed === true) {
        return respond(await cleaner.deleteWorkspace(input.workspaceId));
      }
      if (input.action === 'export-sessions') {
        return respond(await cleaner.exportSessions(input.ids, { format: input.format }));
      }
      if (input.action === 'export-workspace') {
        return respond(await cleaner.exportWorkspace(input.workspaceId, { format: input.format }));
      }
      if (input.action === 'export-plan' && input.confirmed === true) return respond(await cleaner.exportPlan(input.ids));
      return respond({ error: '操作无效。' }, 400);
    } catch (error) { respond({ error: error.message }, 400); }
  } }));
  ctx.effect(() => ctx.tools.register({
    name: 'session_cleaner_preview', description: '查看会话清理与工作区列表、导出对话或工作区压缩包，或在用户明确要求时永久删除指定会话或工作区（绝不触碰本地项目文件）。',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '要预览、导出或删除的会话 ID；省略时返回全部分类计数和列表摘要。' },
        workspaceId: { type: 'string', description: '要导出压缩包或删除的工作区 ID。' },
        format: { type: 'string', enum: ['zip', 'md', 'jsonl'], description: '导出对话格式，默认 zip。' },
        action: { type: 'string', enum: ['scan', 'preview', 'delete', 'delete_workspace', 'export_sessions', 'export_workspace'], description: '默认只读 scan/preview；支持 export_sessions、export_workspace、delete、delete_workspace。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      if (args?.action === 'delete') {
        if (!args.ids?.length) throw new Error('删除操作必须指定会话 ID。');
        return cleaner.deleteSessions(args.ids, { includeChildren: true, allowActiveWorkspace: true });
      }
      if (args?.action === 'delete_workspace') {
        if (!args.workspaceId) throw new Error('必须指定工作区 ID。');
        return cleaner.deleteWorkspace(args.workspaceId);
      }
      if (args?.action === 'export_sessions') {
        if (!args.ids?.length) throw new Error('导出对话必须指定会话 ID。');
        const exported = await cleaner.exportSessions(args.ids, { format: args.format });
        const { base64, ...summary } = exported;
        return summary;
      }
      if (args?.action === 'export_workspace') {
        if (!args.workspaceId) throw new Error('导出工作区必须指定工作区 ID。');
        const exported = await cleaner.exportWorkspace(args.workspaceId, { format: args.format });
        const { base64, ...summary } = exported;
        return summary;
      }
      if (args?.ids) return cleaner.preview(args.ids, { allowActiveWorkspace: true });
      const result = await cleaner.scan();
      return {
        ...result,
        total: result.rows.length,
        rows: result.rows.slice(0, 50),
        allSessions: result.allSessions.slice(0, 50),
        truncated: result.rows.length > 50 || result.allSessions.length > 50,
      };
    },
  }));
}
