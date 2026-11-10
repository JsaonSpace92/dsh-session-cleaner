import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const row = { id: 'session-test', title: '归档测试', group: 'archived', archived: true, cwd: '/项目', workspaceTitle: '项目', bytes: 42, createdAt: 1, running: false };
const deletedRow = { id: 'session-del', title: '遗留对话', group: 'deleted', archived: false, cwd: '/已删工作区', formerWorkspace: '已删工作区', bytes: 84, createdAt: 1, running: false };
const activeRow = { id: 'session-act', title: '未归档对话', group: 'associated', archived: false, cwd: '/项目', workspaceTitle: '项目', bytes: 120, createdAt: 2, running: false };
const scan = nonce => ({
  rows: [row, deletedRow],
  allSessions: [activeRow, row, deletedRow],
  workspaces: [{ id: 'ws-1', title: '项目', path: '/项目', sessionIds: ['session-act', 'session-test'], totalCount: 2, activeCount: 1, archivedCount: 1, runningCount: 0, bytes: 162 }],
  counts: { archived: 1, deleted: 1, unassociated: 0, unknown: 0, all_sessions: 3, all_workspaces: 1 },
  formerWorkspaces: [{ key: '/已删工作区', title: '已删工作区', cwd: '/已删工作区', sessionIds: ['session-del'], bytes: 84 }],
  nonce,
  version: '0.3.0',
});
const preview = { selected: [row], retainedChildren: [], cascadeChildren: [], bytes: 42 };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });

async function mount(fetch, sessions = {}) {
  const state = [];
  const effects = [];
  let cursor = 0;
  let first = true;
  let component;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = cursor++;
      if (first) state[index] = initial;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useEffect(effect) { if (first) effects.push(effect); },
  };
  const ctx = {
    effect: callback => callback(),
    locale: { register() {}, bind: () => () => '会话清理' },
    sessions,
    slots: { inject: (_slot, callback) => callback(), register: (options, value) => { if (options.name === 'main') component = value; } },
  };
  runInNewContext(source, { window: { __ModuleLoader__: { load: definition => definition.factory(() => React).apply(ctx) } }, fetch, AbortController });
  const render = () => { cursor = 0; const tree = component(); first = false; return tree; };
  render();
  for (const effect of effects) effect();
  await new Promise(resolve => setImmediate(resolve));
  return { render };
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  for (const child of node.children || []) { const value = find(child, predicate); if (value) return value; }
}

const button = (tree, text) => find(tree, node => node.type === 'button' && node.children.includes(text));

async function selectAndPreview(ui) {
  const checkbox = find(ui.render(), node => node.type === 'input' && node.props.type === 'checkbox');
  checkbox.props.onChange();
  const selected = ui.render();
  const open = button(selected, '删除所选会话');
  assert.equal(open.props.disabled, false);
  await open.props.onClick();
  return ui.render();
}

test('实际按钮在旧令牌失效后重新读取并打开预览，不重复执行已成功操作', async () => {
  let reads = 0;
  let posts = 0;
  const ui = await mount(async (url, options) => {
    assert.equal(options.credentials, 'same-origin');
    if (url === '/session-cleaner/v1') {
      assert.equal(options.headers['x-dsh-cleaner-panel'], '1');
      return response(scan(++reads === 1 ? '旧令牌' : '新令牌'));
    }
    posts++;
    assert.deepEqual(JSON.parse(options.body), { action: 'preview', ids: ['session-test'], allowActiveWorkspace: false });
    assert.equal(options.headers['x-dsh-cleaner'], posts === 1 ? '旧令牌' : '新令牌');
    return posts === 1 ? response({ code: 'PANEL_EXPIRED', error: '面板已更新' }, 409) : response(preview);
  });
  const tree = await selectAndPreview(ui);
  assert.ok(find(tree, node => node.props.role === 'dialog'));
  assert.equal(reads, 2);
  assert.equal(posts, 2);
});

test('确认对话框直接点确定执行删除，并通知 Client sessions 刷新侧边栏', async () => {
  let deletes = 0;
  const removed = [];
  let refreshed = 0;
  const ui = await mount(async (url, options) => {
    if (url === '/session-cleaner/v1') return response(scan('令牌'));
    const input = JSON.parse(options.body);
    if (input.action === 'preview') return response(preview);
    assert.equal(input.action, 'delete');
    assert.equal(input.confirmed, true);
    assert.equal(input.includeChildren, true);
    deletes++;
    return response({
      rows: [],
      counts: { archived: 0, deleted: 0, unassociated: 0, unknown: 0 },
      formerWorkspaces: [],
      deletedIds: ['session-test'],
      count: 1,
      message: '已永久删除 1 个会话。',
    });
  }, {
    handleSessionRemoved: id => removed.push(id),
    refresh: async () => { refreshed++; },
  });
  const tree = await selectAndPreview(ui);
  const dialog = find(tree, node => node.props.role === 'dialog');
  assert.equal(find(dialog, node => node.type === 'input'), undefined);
  const confirm = button(dialog, '确定');
  assert.equal(confirm.props.disabled, false);
  await confirm.props.onClick();
  assert.equal(deletes, 1);
  assert.deepEqual(removed, ['session-test']);
  assert.equal(refreshed, 1);
  assert.equal(find(ui.render(), node => node.props.role === 'dialog'), undefined);
  assert.ok(find(ui.render(), node => node.props.role === 'status'));
});

test('已删除工作区视图支持按原工作区一键触发清理预览', async () => {
  const previewed = [];
  const ui = await mount(async (url, options) => {
    if (url === '/session-cleaner/v1') return response(scan('令牌'));
    const input = JSON.parse(options.body);
    previewed.push(input);
    return response({ selected: [deletedRow], retainedChildren: [], cascadeChildren: [], bytes: 84 });
  });
  const tab = find(ui.render(), node => node.props.role === 'tab' && find(node, child => child.children?.includes('已删除工作区')));
  tab.props.onClick();
  const wsBtn = button(ui.render(), '删除该工作区会话');
  assert.ok(wsBtn);
  await wsBtn.props.onClick();
  assert.deepEqual(previewed, [{ action: 'preview', ids: ['session-del'], allowActiveWorkspace: false }]);
  assert.ok(find(ui.render(), node => node.props.role === 'dialog'));
});

test('所有对话与所有工作区板块支持一键导出对话、导出整工作区压缩包与删除工作区', async () => {
  const actions = [];
  const removed = [];
  const ui = await mount(async (url, options) => {
    if (url === '/session-cleaner/v1') return response(scan('令牌'));
    const input = JSON.parse(options.body);
    actions.push(input);
    if (input.action === 'export-sessions') {
      return response({ filename: '测试导出.zip', mediaType: 'application/zip', base64: '', savedPath: '/exports/测试导出.zip', count: 1 });
    }
    if (input.action === 'export-workspace') {
      return response({ filename: '项目-对话日志.zip', mediaType: 'application/zip', base64: '', savedPath: '/exports/项目-对话日志.zip', count: 2, message: '已导出工作区「项目」' });
    }
    if (input.action === 'delete-workspace') {
      return response({
        ...scan('令牌'),
        workspaces: [],
        counts: { archived: 0, deleted: 1, unassociated: 0, unknown: 0, all_sessions: 1, all_workspaces: 0 },
        deletedIds: ['session-act', 'session-test'],
        message: '已删除工作区「项目」及其 2 条对话记录。',
      });
    }
  }, {
    handleSessionRemoved: id => removed.push(id),
    refresh: async () => {},
  });

  const allSessionsTab = find(ui.render(), node => node.props.role === 'tab' && find(node, child => child.children?.includes('所有对话')));
  allSessionsTab.props.onClick();
  const exportBtn = button(ui.render(), '↓ 导出对话');
  assert.ok(exportBtn);
  await exportBtn.props.onClick();
  assert.deepEqual(actions[0], { action: 'export-sessions', ids: ['session-act'], format: 'zip' });

  const allWsTab = find(ui.render(), node => node.props.role === 'tab' && find(node, child => child.children?.includes('所有工作区')));
  allWsTab.props.onClick();
  const exportWsBtn = button(ui.render(), '↓ 导出工作区压缩包 (.zip)');
  assert.ok(exportWsBtn);
  await exportWsBtn.props.onClick();
  assert.deepEqual(actions[1], { action: 'export-workspace', workspaceId: 'ws-1', format: 'zip' });

  const delWsBtn = button(ui.render(), '删除工作区及对话');
  assert.ok(delWsBtn);
  delWsBtn.props.onClick();
  const dialog = find(ui.render(), node => node.props.role === 'dialog');
  assert.ok(dialog);
  const confirmDelWs = button(dialog, '确定删除工作区及对话');
  await confirmDelWs.props.onClick();
  assert.deepEqual(actions[2], { action: 'delete-workspace', workspaceId: 'ws-1', confirmed: true });
  assert.deepEqual(removed, ['session-act', 'session-test']);
});

test('登录或权限失败直接显示原因，不重试操作', async () => {
  let posts = 0;
  const ui = await mount(async url => {
    if (url === '/session-cleaner/v1') return response(scan('令牌'));
    posts++;
    return response({ error: '请求来源未通过 DSH 校验。' }, 403);
  });
  const tree = await selectAndPreview(ui);
  assert.equal(posts, 1);
  assert.ok(find(tree, node => node.props.role === 'alert' && node.children.includes('请求来源未通过 DSH 校验。')));
  assert.equal(find(tree, node => node.props.role === 'dialog'), undefined);
});

test('再次失效最多重试一次，避免循环刷新和重复提交', async () => {
  let reads = 0;
  let posts = 0;
  const ui = await mount(async url => {
    if (url === '/session-cleaner/v1') return response(scan(String(++reads)));
    posts++;
    return response({ code: 'PANEL_EXPIRED', error: '面板仍在更新，请稍后重试。' }, 409);
  });
  const tree = await selectAndPreview(ui);
  assert.equal(reads, 2);
  assert.equal(posts, 2);
  assert.ok(find(tree, node => node.props.role === 'alert'));
  assert.equal(find(tree, node => node.props.role === 'dialog'), undefined);
});
