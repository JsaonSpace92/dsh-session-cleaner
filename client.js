window.__ModuleLoader__.load({
  id: 'dsh-session-cleaner',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const labels = { archived: '已归档对话', deleted: '已删除工作区', unassociated: '原本无关联', unknown: '归属待确认' };
    const descriptions = {
      archived: '来自 DSH「视图 → 已归档」的对话记录。清理后仅移除 DSH 对话历史，本地项目目录完好保留。',
      deleted: '原工作区从 DSH 移除后遗留在「未分组」中的对话历史。按原工作区分组排列，清理时绝不触碰磁盘上的项目文件。',
      unassociated: '创建时未绑定工作目录，或由你确认无关联工作区的独立对话记录。',
      unknown: '存在工作目录但尚未归类的未分组对话，可调整归属或直接清理对话记录。',
    };
    function formatBytes(bytes) {
      if (!bytes || bytes < 1024) return `${bytes || 0} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    const css = `
.sc-root{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit}
.sc-wrap{max-width:980px;margin:0 auto;padding:36px 36px 40px}
.sc-header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding-bottom:22px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sc-eyebrow{font-size:11px;letter-spacing:.12em;color:var(--dsw-alias-label-secondary);text-transform:uppercase}
.sc-title{font-family:Georgia,'Songti SC',serif;font-weight:500;font-size:28px;line-height:1.3;margin:6px 0 8px}
.sc-sub{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.65;margin:0}
.sc-seal{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:999px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.sc-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:22px 0 18px}
.sc-card{appearance:none;text-align:left;background:var(--dsw-alias-bg-layer-1);color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:15px 16px;cursor:pointer;transition:border-color .15s,background .15s}
.sc-card[aria-selected=true]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-layer-1))}
.sc-card span{display:block;font-size:12px;color:var(--dsw-alias-label-secondary)}
.sc-card[aria-selected=true] span{color:var(--dsw-alias-label-primary);font-weight:500}
.sc-card strong{display:block;font-family:Georgia,serif;font-size:28px;font-weight:400;margin-top:8px;line-height:1.1}
.sc-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:16px 0 14px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px}
.sc-toolbar-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sc-button{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 12px;cursor:pointer;font:inherit;font-size:12px;line-height:1.4;white-space:nowrap;transition:background .15s,border-color .15s}
.sc-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.sc-button:disabled{opacity:.42;cursor:default}
.sc-button:focus-visible,.sc-card:focus-visible,.sc-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sc-danger-soft{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,var(--dsw-alias-bg-base))}
.sc-danger-soft:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 13%,var(--dsw-alias-bg-base))}
.sc-danger{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base);font-weight:500}
.sc-danger:hover:not(:disabled){opacity:.9}
.sc-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 12px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:12px;width:280px;max-width:100%}
.sc-stack{display:flex;flex-direction:column;gap:14px}
.sc-ws-group{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.sc-ws-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 16px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 60%,var(--dsw-alias-bg-layer-1));border-bottom:1px solid var(--dsw-alias-border-l1)}
.sc-ws-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sc-ws-name{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.sc-badge{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.sc-ws-path{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:4px;overflow-wrap:anywhere}
.sc-list{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.sc-row{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:12px;padding:12px 16px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;cursor:pointer}
.sc-row:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 35%,var(--dsw-alias-bg-layer-1))}
.sc-row:last-child{border-bottom:0}
.sc-row input{margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.sc-row-main{min-width:0}
.sc-row-title{font-size:13px;font-weight:500;line-height:1.4;overflow-wrap:anywhere;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sc-path{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5;margin-top:3px;overflow-wrap:anywhere}
.sc-row-meta{display:flex;align-items:center;gap:12px;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.sc-empty{padding:48px 24px;text-align:center;background:var(--dsw-alias-bg-layer-1)}
.sc-empty strong{display:block;font:400 20px Georgia,'Songti SC',serif;margin-bottom:8px}
.sc-bottom{display:flex;justify-content:space-between;align-items:center;gap:14px;margin:16px 0 20px;padding:12px 16px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px}
.sc-note{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);padding-top:16px}
.sc-alert{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:12px 16px;margin:12px 0;font-size:12px;line-height:1.6}
.sc-error{color:var(--dsw-alias-state-error-primary)}
.sc-dialog-backdrop{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent);padding:20px}
.sc-dialog{width:min(520px,100%);max-height:85vh;overflow:auto;padding:24px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;box-shadow:0 16px 64px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.sc-dialog h2{margin:0 0 10px;font:500 22px Georgia,'Songti SC',serif}
.sc-dialog p{font-size:13px;line-height:1.65;margin:8px 0}
.sc-safe-banner{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:1.6;margin:12px 0}
.sc-dialog ul{padding-left:18px;font-size:12px;line-height:1.7;margin:10px 0;color:var(--dsw-alias-label-secondary)}
.sc-dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
@media(max-width:720px){.sc-wrap{padding:20px 16px}.sc-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.sc-header,.sc-toolbar,.sc-bottom,.sc-ws-head{align-items:flex-start;flex-direction:column}.sc-input{width:100%}.sc-row-meta{display:none}}
`;
    function Icon({ size = 20 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
        h('path', { d: 'M4 5.5h16v4H4zM6 9.5V20h12V9.5M9 13h6M15.5 3l2-2M20.5 4l2-1' }));
    }
    async function readPanel(signal) {
      const response = await fetch('/session-cleaner/v1', { signal, credentials: 'same-origin', cache: 'no-store', headers: { 'x-dsh-cleaner-panel': '1' } });
      const value = await response.json();
      if (!response.ok || value.error) throw new Error(value.error || '读取失败。');
      return value;
    }
    async function panelAction(input, nonce, update) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch('/session-cleaner/v1/action', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dsh-cleaner': nonce }, body: JSON.stringify(input) });
        const value = await response.json();
        if (response.status === 409 && value.code === 'PANEL_EXPIRED' && attempt === 0) {
          const current = await readPanel();
          nonce = current.nonce;
          update(current);
          continue;
        }
        if (!response.ok || value.error) throw new Error(value.error || '操作失败。');
        return value;
      }
    }
    function createPanel(clientCtx) {
      return function Panel() {
        const [data, setData] = React.useState(null);
        const [group, setGroup] = React.useState('archived');
        const [selected, setSelected] = React.useState(new Set());
        const [query, setQuery] = React.useState('');
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState('');
        const [preview, setPreview] = React.useState(null);
        const [result, setResult] = React.useState(null);
        async function refresh(signal) {
          setBusy(true); setError('');
          try {
            setData(await readPanel(signal)); setSelected(new Set());
          } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
          finally { setBusy(false); }
        }
        React.useEffect(() => { const controller = new AbortController(); refresh(controller.signal); return () => controller.abort(); }, []);
        function dialogKeys(event) {
          if (event.key === 'Escape' && !busy) setPreview(null);
          if (event.key !== 'Tab') return;
          const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled),input:not(:disabled)')];
          const target = event.shiftKey ? controls.at(-1) : controls[0];
          if (event.target === (event.shiftKey ? controls[0] : controls.at(-1))) { event.preventDefault(); target?.focus(); }
        }
        async function action(input) {
          setBusy(true); setError('');
          try {
            return await panelAction(input, data.nonce, setData);
          } catch (failure) { setError(failure.message); return null; }
          finally { setBusy(false); }
        }
        function syncClientSessions(deletedIds) {
          try {
            if (Array.isArray(deletedIds)) {
              for (const id of deletedIds) clientCtx?.sessions?.handleSessionRemoved?.(id);
            }
            void clientCtx?.sessions?.refresh?.();
          } catch {}
        }
        const rows = (data?.rows || []).filter(row => row.group === group && (row.cwd + row.title + row.id + (row.formerWorkspace || '')).toLowerCase().includes(query.toLowerCase()));
        const selectableRows = rows.filter(row => !row.running);
        const allSelected = selectableRows.length > 0 && selectableRows.every(row => selected.has(row.id));
        const button = (text, onClick, options = {}) => h('button', { type: 'button', className: 'sc-button', onClick, ...options }, text);
        function toggleRow(id) {
          setSelected(previous => {
            const next = new Set(previous);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
          });
        }
        async function openPreview(targetIds) {
          const ids = Array.isArray(targetIds) ? targetIds : [...selected];
          const value = await action({ action: 'preview', ids });
          if (value) { setPreview(value); }
        }
        async function executeDelete(ids) {
          const value = await action({ action: 'delete', ids, confirmed: true, includeChildren: true });
          if (value) {
            setData(previous => ({ ...value, nonce: previous?.nonce, version: previous?.version || '0.2.1' }));
            setSelected(new Set());
            setPreview(null);
            setResult(value);
            syncClientSessions(value.deletedIds || ids);
          }
        }
        async function mark(category) {
          const value = await action({ action: 'confirm-category', ids: [...selected], category });
          if (value) { setData(previous => ({ ...value, nonce: previous.nonce, version: previous.version })); setSelected(new Set()); }
        }
        function renderRow(row, showPath = true) {
          const shortId = row.id.replace(/^session-/, '').slice(0, 8);
          return h('label', { className: 'sc-row', key: row.id },
            h('input', { type: 'checkbox', checked: selected.has(row.id), disabled: busy || row.running, 'aria-label': `选择会话 ${row.id}`, onChange: () => toggleRow(row.id) }),
            h('div', { className: 'sc-row-main' },
              h('div', { className: 'sc-row-title' },
                h('span', null, typeof row.title === 'string' ? row.title : shortId),
                row.parentId && h('span', { className: 'sc-badge' }, '子代理记录')),
              showPath && h('div', { className: 'sc-path' }, row.cwd ? `项目路径（仅删对话，保留本地文件夹）：${row.cwd}` : '无绑定工作目录')),
            h('div', { className: 'sc-row-meta' },
              h('span', null, `#${shortId}`),
              h('span', null, new Date(row.createdAt).toLocaleDateString('zh-CN')),
              h('span', null, row.running ? '运行中 · 已保护' : formatBytes(row.bytes))));
        }

        const groupedWorkspaces = group === 'deleted' ? (data?.formerWorkspaces || []).map(ws => ({
          ...ws,
          matchedRows: rows.filter(row => ws.sessionIds.includes(row.id)),
        })).filter(ws => ws.matchedRows.length > 0) : [];

        return h('section', { className: 'sc-root', 'aria-label': '会话清理' }, h('style', null, css),
          h('div', { className: 'sc-wrap' },
            h('header', { className: 'sc-header' }, h('div', null,
              h('div', { className: 'sc-eyebrow' }, `DSH · 会话清理 · ${data?.version || '0.2.1'}`),
              h('h1', { className: 'sc-title' }, '会话与归档清理'),
              h('p', { className: 'sc-sub' }, '清理 DSH 本机存储中的已归档对话与已删除工作区遗留对话历史。')),
              h('span', { className: 'sc-seal' }, '✓ 仅删 DSH 对话历史 · 本地项目文件 100% 保留')),
            h('div', { className: 'sc-grid', role: 'tablist', 'aria-label': '清理分类' }, Object.entries(labels).map(([key, label]) => h('button', {
              key, className: 'sc-card', role: 'tab', type: 'button', 'aria-selected': group === key,
              onClick: () => { setGroup(key); setSelected(new Set()); setResult(null); },
            }, h('span', null, label), h('strong', null, data ? data.counts[key] : '—')))),
            h('p', { className: 'sc-sub' }, descriptions[group]),
            error && h('div', { className: 'sc-alert sc-error', role: 'alert' }, error),
            result && h('div', { className: 'sc-alert', role: 'status' },
              h('strong', null, result.message || `已成功清理 ${result.count} 条 DSH 对话记录（本地项目文件未改动）`)),
            h('div', { className: 'sc-toolbar' },
              h('input', { className: 'sc-input', type: 'search', placeholder: '搜索对话标题、工作区名称或路径…', 'aria-label': '搜索会话', value: query, onChange: event => setQuery(event.target.value) }),
              h('div', { className: 'sc-toolbar-actions' },
                button('刷新', () => refresh(), { disabled: busy }),
                button(allSelected ? '取消全选' : '选择当前列表', () => setSelected(allSelected ? new Set() : new Set(selectableRows.map(row => row.id))), { disabled: busy || !selectableRows.length }),
                selectableRows.length > 0 && button(`一键清空当前分类 (${selectableRows.length})`, () => openPreview(selectableRows.map(row => row.id)), { disabled: busy, className: 'sc-button sc-danger-soft' }))),
            group === 'deleted'
              ? (groupedWorkspaces.length > 0
                ? h('div', { className: 'sc-stack', role: 'tabpanel', 'aria-label': labels[group], 'aria-busy': busy },
                  groupedWorkspaces.map(ws => h('div', { className: 'sc-ws-group', key: ws.key },
                    h('div', { className: 'sc-ws-head' },
                      h('div', null,
                        h('div', { className: 'sc-ws-title-row' },
                          h('span', { className: 'sc-ws-name' }, ws.title),
                          h('span', { className: 'sc-badge' }, `${ws.matchedRows.length} 条 DSH 对话 · ${formatBytes(ws.bytes)}`)),
                        h('div', { className: 'sc-ws-path' }, `原工作区路径：${ws.cwd || '未知'}（仅清理 DSH 对话记录，本地磁盘文件完全保留）`)),
                      button('删除该工作区会话', () => openPreview(ws.matchedRows.filter(row => !row.running).map(row => row.id)), { disabled: busy, className: 'sc-button sc-danger-soft' })),
                    h('div', null, ws.matchedRows.map(row => renderRow(row, false))))))
                : h('div', { className: 'sc-list', role: 'tabpanel', 'aria-label': labels[group], 'aria-busy': busy },
                  h('div', { className: 'sc-empty' }, h('strong', null, busy ? '正在整理对话…' : '没有遗留工作区对话'), h('span', { className: 'sc-sub' }, '所有已删除工作区的遗留对话均已清理完毕。'))))
              : h('div', { className: 'sc-list', role: 'tabpanel', 'aria-label': labels[group], 'aria-busy': busy },
                rows.length ? rows.map(row => renderRow(row, true))
                  : h('div', { className: 'sc-empty' }, h('strong', null, busy ? '正在整理对话…' : '当前分类已清空'), h('span', { className: 'sc-sub' }, data ? '当前分类下没有待清理的对话记录。' : '正在读取 DSH 会话记录。'))),
            h('div', { className: 'sc-bottom' },
              h('span', { className: 'sc-sub', 'aria-live': 'polite' }, `已勾选 ${selected.size} 条对话记录`),
              h('div', { className: 'sc-toolbar-actions' },
                ['unknown', 'unassociated'].includes(group) && button('标记为已删除工作区', () => mark('deleted'), { disabled: busy || !selected.size }),
                ['unknown', 'deleted'].includes(group) && button('标记为原本无关联', () => mark('unassociated'), { disabled: busy || !selected.size }),
                button('删除所选会话', () => openPreview([...selected]), { disabled: busy || !selected.size, className: 'sc-button sc-danger' }))),
            h('footer', { className: 'sc-note' }, '安全说明：点击删除仅清除 DSH 本机内部的对话历史记录（~/.dsh/sessions 与缓存），绝不会删除或修改本地磁盘项目目录中的任何源代码、文档或文件夹。')),
          preview && h('div', { className: 'sc-dialog-backdrop' }, h('div', { className: 'sc-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'sc-confirm-title', onKeyDown: dialogKeys },
            h('h2', { id: 'sc-confirm-title' }, `确认清理 ${preview.selected.length} 条 DSH 对话记录`),
            h('div', { className: 'sc-safe-banner' }, '✓ 仅删除 DSH 本机存储里的对话历史记录，不会删除项目文件夹里的任何本地文件。'),
            h('ul', null, preview.selected.slice(0, 8).map(row => h('li', { key: row.id }, `${row.title || row.id.replace(/^session-/, '').slice(0, 8)}（${row.formerWorkspace || row.cwd || '无目录'}）`)), preview.selected.length > 8 && h('li', null, `另有 ${preview.selected.length - 8} 条对话将一并清理。`)),
            preview.cascadeChildren?.length > 0 && h('p', { className: 'sc-sub' }, `包含 ${preview.cascadeChildren.length} 条关联的子代理（Subagent）对话记录。`),
            h('div', { className: 'sc-dialog-actions' },
              button('取消', () => setPreview(null), { disabled: busy, autoFocus: true }),
              button('确定', () => executeDelete(preview.selected.map(row => row.id)), { className: 'sc-button sc-danger', disabled: busy })),
            error && h('p', { className: 'sc-error', role: 'alert' }, error))));
      };
    }
    return { inject: ['slots', 'locale', 'sessions'], apply(ctx) {
      ctx.effect(() => ctx.locale.register('dsh-session-cleaner', 'zh-CN', { title: '会话清理' }));
      ctx.effect(() => ctx.locale.register('dsh-session-cleaner', 'en', { title: '会话清理' }));
      const t = ctx.locale.bind('dsh-session-cleaner');
      const Panel = createPanel(ctx);
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'dsh-session-cleaner', order: 40, label: () => t('title') }, Icon));
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-session-cleaner' }, Panel));
    } };
  },
});
