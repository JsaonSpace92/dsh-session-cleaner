import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { GROUPS, atomicJson, canonical, classify, collectDescendants, digest, inside, observeWorkspaces, optionalJson, snapshotFiles } from './core.js';

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
    const rows = classify(snapshots, this.ctx.workspaceRegistry.list(), this.domain().global.get().archivedSessionIds || [], this.history, live, { autoInferDeleted });
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
    return {
      rows,
      counts: Object.fromEntries(GROUPS.map(group => [group, rows.filter(row => row.group === group).length])),
      formerWorkspaces: [...formerWorkspacesMap.values()],
      trackedSince: this.history.since || null,
      limitations: ['删除后将永久移除 DSH 会话日志、归档/置顶引用及缓存；本地磁盘上的项目代码与文件夹始终保留。', '全局去重的共享附件保持保留；已派生的独立会话副本保持保留。'],
      historyError: this.historyError || null,
    };
  }
  async preview(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string')) throw new Error('请选择 1–1000 个会话。');
    const scan = await this.scan();
    const byId = new Map(scan.rows.map(row => [row.id, row]));
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
  async deleteSessions(ids, options = {}) {
    const includeChildren = options.includeChildren !== false;
    const preview = await this.preview(ids);
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
    try { return json({ ...await cleaner.scan(), nonce, version: '0.2.1' }); }
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
      if (input.action === 'preview') return respond(await cleaner.preview(input.ids));
      if (input.action === 'confirm-category') return respond(await cleaner.confirmCategory(input.ids, input.category));
      if (input.action === 'delete' && input.confirmed === true) return respond(await cleaner.deleteSessions(input.ids, { includeChildren: input.includeChildren !== false }));
      if (input.action === 'export-plan' && input.confirmed === true) return respond(await cleaner.exportPlan(input.ids));
      return respond({ error: '操作无效。' }, 400);
    } catch (error) { respond({ error: error.message }, 400); }
  } }));
  ctx.effect(() => ctx.tools.register({
    name: 'session_cleaner_preview', description: '查看会话清理分类、指定会话的删除预览，或在用户明确要求时永久删除指定归档/未分组会话（绝不触碰本地项目文件）。',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '要预览或删除的会话 ID；省略时返回分类计数和前 50 项。' },
        action: { type: 'string', enum: ['scan', 'preview', 'delete'], description: '默认只读 scan/preview；仅在用户明确要求删除指定会话时传 delete。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      if (args?.action === 'delete') {
        if (!args.ids?.length) throw new Error('删除操作必须指定会话 ID。');
        return cleaner.deleteSessions(args.ids, { includeChildren: true });
      }
      if (args?.ids) return cleaner.preview(args.ids);
      const result = await cleaner.scan();
      return { ...result, total: result.rows.length, rows: result.rows.slice(0, 50), truncated: result.rows.length > 50 };
    },
  }));
}
