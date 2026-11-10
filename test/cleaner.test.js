import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, rename, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { classify, observeWorkspaces, snapshotFiles, atomicJson, canonical } from '../core.js';
import { SessionCleaner, apply } from '../index.js';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';

const id = number => `session-00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const snap = (number, extra = {}) => ({ header: { id: id(number), cwd: '/旧项目', createdAt: 1, ...extra }, sizeBytes: 42, revision: 'a' });
const history = () => ({ version: 1, workspaces: {}, deletedSessions: {} });

test('归档优先，现有工作区及所属子会话保留，自动识别已删除工作区会话', () => {
  const memo = history();
  memo.deletedSessions[id(3)] = { title: '已删除项目' };
  memo.unassociated = { [id(5)]: true };
  const rows = classify([
    snap(1),
    snap(2, { cwd: '/现存项目' }),
    snap(3),
    snap(4, { cwd: undefined }),
    snap(5),
    snap(6),
    snap(7, { cwd: '/现存项目', parentSession: id(2), origin: 'subagent' }),
  ], [{ path: '/现存项目', sessionIds: [id(1), id(2)] }], [id(1)], memo);
  assert.deepEqual(rows.map(row => [row.id, row.group]), [[id(1), 'archived'], [id(3), 'deleted'], [id(4), 'unassociated'], [id(5), 'unassociated'], [id(6), 'unknown']]);

  const inferred = classify([snap(6, { cwd: '/已删工作区目录' })], [{ path: '/现存项目', sessionIds: [] }], [], memo, new Map(), { autoInferDeleted: true });
  assert.equal(inferred[0].group, 'deleted');
  assert.equal(inferred[0].formerWorkspace, '已删工作区目录');
});

test('标题读取公开 projection hints 的字符串值', () => {
  const live = new Map([[id(1), { projections: { kind: 'cached', values: { title: '我的归档对话' } } }]]);
  assert.equal(classify([snap(1)], [], [], history(), live)[0].title, '我的归档对话');
});

test('工作区移除后记录删除事实；重命名不标记删除', () => {
  const memo = history();
  observeWorkspaces(memo, [{ id: 'w', path: '/项目', title: '旧名', sessionIds: [id(1)] }]);
  observeWorkspaces(memo, [{ id: 'w', path: '/项目', title: '新名', sessionIds: [id(1)] }]);
  assert.deepEqual(memo.deletedSessions, {});
  observeWorkspaces(memo, []);
  assert.equal(memo.deletedSessions[id(1)].title, '新名');
  assert.ok(memo.since);
});

async function fixture(t) {
  const root = await mkdtemp(fileURLToPath(new URL('./.fixture-', import.meta.url)));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions');
  const storage = join(root, 'storage');
  const project = join(root, 'project');
  const dir1 = join(sessions, 'project-key', id(1));
  const dir3 = join(sessions, 'project-key', id(3));
  for (const path of [dir1, dir3, storage, project]) await mkdir(path, { recursive: true });
  await writeFile(join(dir1, 'session.v4.jsonl'), '测试对话\n');
  await writeFile(join(dir3, 'session.v4.jsonl'), '子会话对话\n');
  const global = { initialized: true, workspaceIds: ['w'], archivedSessionIds: [id(1)], pinnedSessionIds: [] };
  const workspaces = { w: { path: project, title: '项目', sessionIds: [id(1), id(2)], createdAt: 1, updatedAt: 1 } };
  const domain = { global: { get: () => global }, table: () => ({ entries: () => Object.entries(workspaces) }) };
  await atomicJson(join(storage, 'workspace.json'), { tables: { workspaces }, global: { ...global, workspaceIds: ['w'] }, unit: { name: 'workspace', version: 2 } });
  const snapshots = [
    { ...snap(1, { cwd: project }), location: { kind: 'jsonl', path: join(dir1, 'session.v4.jsonl') } },
    snap(2, { cwd: project }),
    { ...snap(3, { cwd: project, parentSession: id(1), origin: 'subagent' }), location: { kind: 'jsonl', path: join(dir3, 'session.v4.jsonl') } },
  ];
  const ctx = {
    workspaceRegistry: {
      list: () => Object.entries(workspaces).map(([wid, w]) => ({
        id: wid,
        ...w,
        detachSession: async sid => { w.sessionIds = w.sessionIds.filter(item => item !== sid); },
      })),
      delete: async wid => {
        if (!workspaces[wid]) return false;
        delete workspaces[wid];
        global.workspaceIds = global.workspaceIds.filter(item => item !== wid);
        return true;
      },
      unarchiveSession: async sid => { global.archivedSessionIds = global.archivedSessionIds.filter(item => item !== sid); },
      unpinSession: async sid => { global.pinnedSessionIds = global.pinnedSessionIds.filter(item => item !== sid); },
    },
    storageDomain: { get: name => (name === 'workspace' ? domain : null) },
    sessionPersistence: {
      list: async () => snapshots,
      flush: async () => {},
      stat: async sid => snapshots.find(item => item.header.id === sid) || null,
      open: async sid => ({
        read: async () => ({
          events: [
            { seq: 1, type: 'user/message', timestamp: 1700000000000, data: { role: 'user', content: [{ type: 'text', text: `来自 ${sid} 的提问` }] } },
            { seq: 2, type: 'assistant/message', timestamp: 1700000001000, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'thinking', thinking: '思考过程' }, { type: 'text', text: '回答内容' }] } } },
          ],
        }),
        close: async () => {},
      }),
    },
    sessionController: { list: async () => ({ items: [] }) },
  };
  const cleaner = new SessionCleaner(ctx, { sessions, storage, output: join(root, 'output') });
  await cleaner.start();
  return { cleaner, ctx, root, dir: dir1, dir3, snapshots, storage, project, global, workspaces };
}

test('在线删除直接移除会话与子会话目录、更新归档与工作区引用并保留项目目录', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'README.md'), '重要源码');
  const result = await f.cleaner.deleteSessions([id(1)], { includeChildren: true });
  assert.deepEqual(result.deletedIds, [id(1), id(3)]);
  assert.equal(f.global.archivedSessionIds.includes(id(1)), false);
  assert.equal(f.workspaces.w.sessionIds.includes(id(1)), false);
  await assert.rejects(stat(f.dir));
  await assert.rejects(stat(f.dir3));
  assert.equal(await readFile(join(f.project, 'README.md'), 'utf8'), '重要源码');
});

test('导出清单与 Python dry-run 兼容，保留分支并保持原始记录', async t => {
  const f = await fixture(t);
  const preview = await f.cleaner.preview([id(1), id(1)]);
  assert.equal(preview.selected.length, 1);
  assert.deepEqual(preview.retainedChildren, [id(3)]);
  const result = await f.cleaner.exportPlan([id(1)]);
  const manifest = JSON.parse(await readFile(result.path, 'utf8'));
  assert.equal(manifest.targets[0].dir, f.dir);
  assert.ok(manifest.protectedPaths.includes(f.project));
  const response = execFileSync('python3', [fileURLToPath(new URL('../offline.py', import.meta.url)), result.path], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
  assert.match(response, /未修改/);
  assert.equal(await readFile(join(f.dir, 'session.v4.jsonl'), 'utf8'), '测试对话\n');
});

test('插件生成的安全自定义会话标识可导出并交给 Python 核验', async t => {
  const f = await fixture(t);
  const custom = 'mnemon-run-v1-12345678-1234-1234-1234-123456789abc';
  const directory = join(f.dir, '..', custom);
  await rename(f.dir, directory);
  f.snapshots[0].header.id = custom;
  f.snapshots[0].location.path = join(directory, 'session.v4.jsonl');
  f.global.archivedSessionIds = [custom];
  await atomicJson(join(f.storage, 'workspace.json'), { unit: { name: 'workspace', version: 2 }, global: f.global, tables: { workspaces: Object.fromEntries(f.cleaner.domain().table('workspaces').entries()) } });
  const result = await f.cleaner.exportPlan([custom]);
  const response = execFileSync('python3', [fileURLToPath(new URL('../offline.py', import.meta.url)), result.path], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
  assert.match(response, /未修改/);
});

test('会话标识与真实目录不一致时拒绝导出与删除', async t => {
  const f = await fixture(t);
  f.snapshots[0].header.id = id(9);
  f.global.archivedSessionIds = [id(9)];
  await atomicJson(join(f.storage, 'workspace.json'), { unit: { name: 'workspace', version: 2 }, global: f.global, tables: { workspaces: Object.fromEntries(f.cleaner.domain().table('workspaces').entries()) } });
  await assert.rejects(f.cleaner.exportPlan([id(9)]), /不匹配/);
  await assert.rejects(f.cleaner.deleteSessions([id(9)]), /不匹配/);
});

test('运行中会话与当前工作区非归档会话不可选', async t => {
  const f = await fixture(t);
  f.ctx.sessionController.list = async () => ({ items: [{ sessionId: id(1), running: true }] });
  await assert.rejects(f.cleaner.preview([id(1)]), /运行/);
  await assert.rejects(f.cleaner.preview([id(2)]), /变化/);
});

test('workspace 文件变化或位置不符时拒绝导出', async t => {
  const f = await fixture(t);
  await atomicJson(join(f.storage, 'workspace.json'), { unit: { name: 'workspace', version: 2 }, global: {}, tables: { workspaces: {} } });
  await assert.rejects(f.cleaner.exportPlan([id(1)]), /不一致/);
});

test('工作区 JSON 数据一致时兼容跨上下文对象与未写入 JSON 的可选字段', async t => {
  const f = await fixture(t);
  const original = f.cleaner.domain();
  const global = runInNewContext(`(${JSON.stringify(f.global)})`);
  global.defaultWorkspaceId = undefined;
  const records = runInNewContext(`(${JSON.stringify(Object.fromEntries(original.table('workspaces').entries()))})`);
  f.ctx.storageDomain.get = () => ({ global: { get: () => global }, table: () => ({ entries: () => Object.entries(records) }) });
  assert.equal((await f.cleaner.preview([id(1)])).workspaceCheck.ready, true);
  const result = await f.cleaner.exportPlan([id(1)]);
  assert.equal(result.count, 1);
  global.pinnedSessionIds = [id(9)];
  assert.equal((await f.cleaner.preview([id(1)])).workspaceCheck.ready, false);
  await assert.rejects(f.cleaner.exportPlan([id(1)]), /不一致/);
});

test('生成期间会话 revision 改变时拒绝导出', async t => {
  const f = await fixture(t);
  let n = 0;
  f.ctx.sessionPersistence.stat = async () => ({ ...f.snapshots[0], revision: String(n++) });
  await assert.rejects(f.cleaner.exportPlan([id(1)]), /发生变化/);
});

test('分类确认与并行扫描不会损坏历史文件', async t => {
  const f = await fixture(t);
  await Promise.all([f.cleaner.confirmCategory([id(3)], 'deleted'), f.cleaner.scan(), f.cleaner.scan()]);
  assert.equal((await f.cleaner.scan()).rows.find(row => row.id === id(3)).group, 'deleted');
  await f.cleaner.confirmCategory([id(3)], 'unassociated');
  assert.equal((await f.cleaner.scan()).rows.find(row => row.id === id(3)).group, 'unassociated');
  assert.ok(JSON.parse(await readFile(f.cleaner.historyPath, 'utf8')));
});

async function mounted(t) {
  const f = await fixture(t);
  const routes = new Map();
  let tool;
  Object.assign(f.ctx, {
    on() {}, effect: callback => callback(),
    connection: { admit({ headers }) {
      const values = headers instanceof Headers ? headers : { get: name => headers[name] ?? null, has: name => headers[name] !== undefined };
      if (values.get('host') !== '127.0.0.1:61752' || (values.has('origin') && values.get('origin') !== 'http://127.0.0.1:61752') || values.get('sec-fetch-site') === 'cross-site') return { rejection: 403 };
      if (values.get('cookie') !== 'test-session=owner') return { rejection: 401 };
      return { peer: { principal: { kind: 'owner' }, interactions: 'answer' } };
    } },
    webServer: { getOrigin: () => 'http://127.0.0.1:61752', register: route => { routes.set(route.path, route); return () => {}; } },
    tools: { register: value => { tool = value; return () => {}; } },
  });
  await apply(f.ctx, f.cleaner.config);
  const read = (headers = {}, peer) => routes.get('/session-cleaner/v1').resource(new Request('http://placeholder/session-cleaner/v1', {
    headers: { host: '127.0.0.1:61752', cookie: 'test-session=owner', 'x-dsh-cleaner-panel': '1', ...headers },
  }), peer);
  const nonce = (await (await read()).json()).nonce;
  async function action(body, headers = {}, method = 'POST') {
    const request = Readable.from([JSON.stringify(body)]);
    Object.assign(request, { method, headers: Object.fromEntries(Object.entries({ host: '127.0.0.1:61752', cookie: 'test-session=owner', origin: 'http://127.0.0.1:61752', 'x-dsh-cleaner': nonce, ...headers }).filter(([, value]) => value !== undefined)) });
    let status; let value;
    await routes.get('/session-cleaner/v1/action').handler(request, {
      writeHead(code) { status = code; }, end(data) { value = JSON.parse(data); },
    });
    return { status, value };
  }
  return { ...f, read, action, tool };
}

test('普通 HTTP 没有 Peer 仍可同源读取，跨站及错误 Host 被拒绝', async t => {
  const f = await mounted(t);
  assert.equal((await f.read()).status, 200);
  assert.equal((await f.read({ cookie: '' })).status, 401);
  for (const headers of [{ host: 'attacker.test' }, { origin: 'https://attacker.test' }, { 'x-dsh-cleaner-panel': '' }]) {
    assert.equal((await f.read(headers)).status, 403);
  }
  assert.equal((await f.read({}, { principal: { kind: 'owner' }, interactions: 'answer' })).status, 200);
  assert.equal((await f.read({}, { principal: { kind: 'owner' }, interactions: 'none' })).status, 403);
  assert.equal((await f.read({}, { principal: { kind: 'guest' }, interactions: 'answer' })).status, 403);
});

test('操作接口验证令牌和来源，支持在线删除及离线导出', async t => {
  const f = await mounted(t);
  assert.equal((await f.action({ action: 'preview', ids: [id(1)] })).status, 200);
  assert.equal((await f.action({ action: 'preview', ids: [id(1)] }, { origin: 'https://attacker.test' })).status, 403);
  const expired = await f.action({ action: 'preview', ids: [id(1)] }, { 'x-dsh-cleaner': '中'.repeat(36) });
  assert.equal(expired.status, 409);
  assert.equal(expired.value.code, 'PANEL_EXPIRED');
  assert.equal((await f.action({ action: 'delete', ids: [id(1)] })).status, 400);
  assert.equal((await f.action({ action: 'preview', ids: [id(2)] })).status, 400);
  const result = await f.action({ action: 'delete', ids: [id(1)], confirmed: true });
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.deletedIds, [id(1), id(3)]);
  await assert.rejects(stat(f.dir));
});

test('桌面转发移除 Origin 后仍按 DSH 身份校验，不能缺少登录或操作令牌', async t => {
  const f = await mounted(t);
  const input = { action: 'preview', ids: [id(1)] };
  const desktop = { origin: undefined, 'sec-fetch-site': undefined };
  assert.equal((await f.action(input, desktop)).status, 200);
  assert.equal((await f.action(input, { ...desktop, cookie: undefined })).status, 401);
  assert.equal((await f.action(input, { ...desktop, 'x-dsh-cleaner': undefined })).status, 409);
  assert.equal((await f.action(input, { ...desktop, host: 'attacker.test' })).status, 403);
  assert.equal((await f.action(input, { ...desktop, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.action(input, { origin: 'null' })).status, 403);
  assert.equal((await f.action(input, desktop, 'GET')).status, 405);
  f.ctx.connection.admit = () => ({ peer: { principal: { kind: 'owner' }, interactions: 'none' } });
  assert.equal((await f.action(input, desktop)).status, 403);
});

test('模型工具复用业务预览与删除且不暴露面板令牌', async t => {
  const f = await mounted(t);
  const result = await f.tool.execute({});
  assert.equal(result.counts.archived, 1);
  assert.equal(result.nonce, undefined);
  assert.equal((await f.tool.execute({ ids: [id(1)] })).selected.length, 1);
  const deleted = await f.tool.execute({ action: 'delete', ids: [id(1)] });
  assert.deepEqual(deleted.deletedIds, [id(1), id(3)]);
});

test('会话符号链接和非规范存储路径被拒绝', async t => {
  const f = await fixture(t);
  await symlink(join(f.dir, 'session.v4.jsonl'), join(f.dir, 'link'));
  await assert.rejects(snapshotFiles(f.dir), /符号链接/);
  const alias = join(f.root, 'alias');
  await symlink(f.storage, alias);
  await assert.rejects(canonical(alias), /符号链接/);
});

test('所有对话与所有工作区计数、导出对话 (.zip / .md / .jsonl) 与导出整工作区压缩包', async t => {
  const f = await fixture(t);
  const scan = await f.cleaner.scan();
  assert.equal(scan.counts.all_sessions, 2);
  assert.equal(scan.counts.all_workspaces, 1);
  assert.equal(scan.workspaces[0].title, '项目');
  assert.equal(scan.workspaces[0].totalCount, 2);

  const mdExport = await f.cleaner.exportSessions([id(1)], { format: 'md' });
  assert.match(mdExport.filename, /\.md$/);
  const mdText = Buffer.from(mdExport.base64, 'base64').toString('utf8');
  assert.match(mdText, /来自 session-00000000-0000-0000-0000-000000000001 的提问/);
  assert.match(mdText, /回答内容/);

  const jsonlExport = await f.cleaner.exportSessions([id(1)], { format: 'jsonl' });
  assert.match(jsonlExport.filename, /\.jsonl$/);
  const jsonlLines = Buffer.from(jsonlExport.base64, 'base64').toString('utf8').trim().split('\n');
  assert.equal(jsonlLines.length, 3);

  const wsZip = await f.cleaner.exportWorkspace('w');
  assert.match(wsZip.filename, /^项目-对话日志-.*\.zip$/);
  const verifyPy = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'r') as zf:
    assert zf.testzip() is None
    names = zf.namelist()
    assert 'manifest.json' in names
    assert any(n.endswith('/transcript.md') for n in names)
    assert any(n.endswith('/events.jsonl') for n in names)
print('ZIP_OK')
`;
  const checkOut = execFileSync('python3', ['-c', verifyPy, wsZip.savedPath], { encoding: 'utf8' });
  assert.match(checkOut, /ZIP_OK/);
});

test('删除工作区同时移除工作区注册与其所有会话，且保护运行中工作区与本地项目目录', async t => {
  const f = await fixture(t);
  const dir2 = join(f.root, 'sessions', 'project-key', id(2));
  await mkdir(dir2, { recursive: true });
  await writeFile(join(dir2, 'session.v4.jsonl'), '未归档工作区对话\n');
  f.snapshots[1].location = { kind: 'jsonl', path: join(dir2, 'session.v4.jsonl') };
  await writeFile(join(f.project, 'main.py'), 'print(1)');

  f.ctx.sessionController.list = async () => ({ items: [{ sessionId: id(2), running: true }] });
  await assert.rejects(f.cleaner.deleteWorkspace('w'), /正在运行/);

  f.ctx.sessionController.list = async () => ({ items: [] });
  const res = await f.cleaner.deleteWorkspace('w');
  assert.equal(res.counts.all_workspaces, 0);
  assert.deepEqual(new Set(res.deletedIds), new Set([id(1), id(2), id(3)]));
  await assert.rejects(stat(f.dir));
  await assert.rejects(stat(dir2));
  await assert.rejects(stat(f.dir3));
  assert.equal(await readFile(join(f.project, 'main.py'), 'utf8'), 'print(1)');
});

