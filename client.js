window.__ModuleLoader__.load({
  id: 'dsh-session-cleaner',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const labels = {
      archived: '已归档对话',
      deleted: '已删除工作区',
      unassociated: '原本无关联',
      unknown: '归属待确认',
      all_sessions: '所有对话',
      all_workspaces: '所有工作区',
    };
    const descriptions = {
      archived: '来自 DSH「视图 → 已归档」的对话记录。支持一键导出备份或永久清理 DSH 对话历史，本地项目目录完好保留。',
      deleted: '原工作区从 DSH 移除后遗留在「未分组」中的对话历史。按原工作区分组排列，支持按工作区导出或一键清理。',
      unassociated: '创建时未绑定工作目录，或由你确认无关联工作区的独立对话记录。',
      unknown: '存在工作目录但尚未归类的未分组对话，可调整归属、导出对话或直接清理对话记录。',
      all_sessions: '汇总本机全部对话（无论未归档还是已归档）。支持按状态筛选、单条或批量一键导出对话记录（.zip / .md / .jsonl），或直接删除指定对话。',
      all_workspaces: '管理当前所有已注册的工作区。支持一键将整个工作区的所有对话日志打包导出为 .zip 压缩包，或连同其对话历史一并彻底删除（不留未分组残留，本地项目代码 100% 保留）。',
    };
    function formatBytes(bytes) {
      if (!bytes || bytes < 1024) return `${bytes || 0} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    async function triggerFileSave(exported) {
      if (!exported?.base64 || typeof atob !== 'function') return exported?.savedPath || '';
      try {
        const binary = atob(exported.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
          return exported.savedPath || '';
        }
        const blob = new Blob([bytes], { type: exported.mediaType || 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);
        try {
          if (typeof window !== 'undefined' && typeof window.dshDesktop?.fileActions?.save === 'function') {
            const res = await window.dshDesktop.fileActions.save({
              url: blobUrl,
              name: exported.filename,
              mediaType: exported.mediaType || 'application/octet-stream',
              mode: 'saveAs',
            });
            if (res?.status === 'saved' && res.path) return res.path;
            return exported.savedPath || '';
          }
          if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = exported.filename || 'export.zip';
            link.style.display = 'none';
            document.body?.appendChild?.(link);
            link.click?.();
            link.remove?.();
          }
        } finally {
          setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch {} }, 15000);
        }
      } catch {}
      return exported?.savedPath || '';
    }
    const css = `
.sc-root{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit}
.sc-wrap{max-width:1080px;margin:0 auto;padding:34px 36px 40px}
.sc-header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding-bottom:20px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sc-eyebrow{font-size:11px;letter-spacing:.12em;color:var(--dsw-alias-label-secondary);text-transform:uppercase}
.sc-title{font-family:Georgia,'Songti SC',serif;font-weight:500;font-size:27px;line-height:1.3;margin:6px 0 8px}
.sc-sub{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.65;margin:0}
.sc-seal{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:999px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.sc-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:20px 0 16px}
.sc-card{appearance:none;text-align:left;background:var(--dsw-alias-bg-layer-1);color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 14px;cursor:pointer;transition:border-color .15s,background .15s;position:relative}
.sc-card[aria-selected=true]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-layer-1))}
.sc-card span{display:block;font-size:12px;color:var(--dsw-alias-label-secondary)}
.sc-card[aria-selected=true] span{color:var(--dsw-alias-label-primary);font-weight:500}
.sc-card strong{display:block;font-family:Georgia,serif;font-size:26px;font-weight:400;margin-top:8px;line-height:1.1}
.sc-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:14px 0 14px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;flex-wrap:wrap}
.sc-toolbar-left{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:1;min-width:240px}
.sc-toolbar-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sc-pills{display:inline-flex;background:var(--dsw-alias-bg-layer-2);padding:3px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1)}
.sc-pill{appearance:none;border:0;background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);padding:4px 10px;border-radius:6px;cursor:pointer}
.sc-pill[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:500}
.sc-select{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font:inherit;font-size:12px;cursor:pointer}
.sc-button{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 11px;cursor:pointer;font:inherit;font-size:12px;line-height:1.4;white-space:nowrap;transition:background .15s,border-color .15s}
.sc-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.sc-button:disabled{opacity:.42;cursor:default}
.sc-button:focus-visible,.sc-card:focus-visible,.sc-input:focus-visible,.sc-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sc-export{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 38%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-base));font-weight:500}
.sc-export:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--dsw-alias-bg-base))}
.sc-danger-soft{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,var(--dsw-alias-bg-base))}
.sc-danger-soft:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 13%,var(--dsw-alias-bg-base))}
.sc-danger{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base);font-weight:500}
.sc-danger:hover:not(:disabled){opacity:.9}
.sc-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 12px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:12px;width:260px;max-width:100%}
.sc-stack{display:flex;flex-direction:column;gap:12px}
.sc-ws-group{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.sc-ws-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 16px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,var(--dsw-alias-bg-layer-1));border-bottom:1px solid var(--dsw-alias-border-l1)}
.sc-ws-card{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.sc-ws-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sc-ws-name{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.sc-badge{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.sc-ws-path{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:4px;overflow-wrap:anywhere}
.sc-list{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.sc-row{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:12px;padding:12px 16px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center}
.sc-row:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 35%,var(--dsw-alias-bg-layer-1))}
.sc-row:last-child{border-bottom:0}
.sc-row input{margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.sc-row-main{min-width:0}
.sc-row-title{font-size:13px;font-weight:500;line-height:1.4;overflow-wrap:anywhere;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sc-path{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5;margin-top:3px;overflow-wrap:anywhere}
.sc-row-meta{display:flex;align-items:center;gap:10px;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.sc-empty{padding:48px 24px;text-align:center;background:var(--dsw-alias-bg-layer-1)}
.sc-empty strong{display:block;font:400 20px Georgia,'Songti SC',serif;margin-bottom:8px}
.sc-bottom{display:flex;justify-content:space-between;align-items:center;gap:14px;margin:16px 0 20px;padding:12px 16px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;flex-wrap:wrap}
.sc-note{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);padding-top:16px}
.sc-alert{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:12px 16px;margin:12px 0;font-size:12px;line-height:1.6}
.sc-error{color:var(--dsw-alias-state-error-primary)}
.sc-dialog-backdrop{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent);padding:20px}
.sc-dialog{width:min(540px,100%);max-height:85vh;overflow:auto;padding:24px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;box-shadow:0 16px 64px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.sc-dialog h2{margin:0 0 10px;font:500 22px Georgia,'Songti SC',serif}
.sc-dialog p{font-size:13px;line-height:1.65;margin:8px 0}
.sc-safe-banner{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:1.6;margin:12px 0}
.sc-dialog ul{padding-left:18px;font-size:12px;line-height:1.7;margin:10px 0;color:var(--dsw-alias-label-secondary)}
.sc-dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px;flex-wrap:wrap}
@media(max-width:860px){.sc-wrap{padding:20px 16px}.sc-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.sc-header,.sc-toolbar,.sc-bottom,.sc-ws-head,.sc-ws-card{align-items:flex-start;flex-direction:column}.sc-input{width:100%}.sc-row-meta{flex-wrap:wrap}}
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
        const [sessionFilter, setSessionFilter] = React.useState('all');
        const [exportFormat, setExportFormat] = React.useState('zip');
        const [selected, setSelected] = React.useState(new Set());
        const [query, setQuery] = React.useState('');
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState('');
        const [preview, setPreview] = React.useState(null);
        const [wsPreview, setWsPreview] = React.useState(null);
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
          if (event.key === 'Escape' && !busy) { setPreview(null); setWsPreview(null); }
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

        const q = query.trim().toLowerCase();
        const sourceRows = group === 'all_sessions'
          ? (data?.allSessions || []).filter(row => {
              if (sessionFilter === 'active' && row.archived) return false;
              if (sessionFilter === 'archived' && !row.archived) return false;
              return true;
            })
          : (data?.rows || []).filter(row => row.group === group);

        const rows = sourceRows.filter(row => (row.cwd + row.title + row.id + (row.workspaceTitle || '') + (row.formerWorkspace || '')).toLowerCase().includes(q));
        const selectableRows = rows.filter(row => !row.running);
        const allSelected = selectableRows.length > 0 && selectableRows.every(row => selected.has(row.id));

        const workspacesList = (data?.workspaces || []).filter(ws => (ws.title + ws.path + ws.id).toLowerCase().includes(q));
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
          const allowActiveWorkspace = group === 'all_sessions';
          const value = await action({ action: 'preview', ids, allowActiveWorkspace });
          if (value) setPreview({ ...value, allowActiveWorkspace });
        }
        async function executeDelete(ids, allowActiveWorkspace = false) {
          const value = await action({ action: 'delete', ids, confirmed: true, includeChildren: true, allowActiveWorkspace });
          if (value) {
            setData(previous => ({ ...value, nonce: previous?.nonce, version: previous?.version || '0.3.0' }));
            setSelected(new Set());
            setPreview(null);
            setResult(value);
            syncClientSessions(value.deletedIds || ids);
          }
        }
        async function handleExportSessions(ids) {
          const targetIds = Array.isArray(ids) && ids.length ? ids : [...selected];
          if (!targetIds.length) return;
          const exported = await action({ action: 'export-sessions', ids: targetIds, format: exportFormat });
          if (exported) {
            const savedTo = await triggerFileSave(exported);
            setResult({
              message: `已导出 ${exported.count} 条对话（${exported.filename}）${savedTo ? ` · 保存位置：${savedTo}` : ''}`,
            });
          }
        }
        async function handleExportWorkspace(workspaceId) {
          const exported = await action({ action: 'export-workspace', workspaceId, format: 'zip' });
          if (exported) {
            const savedTo = await triggerFileSave(exported);
            setResult({
              message: `${exported.message}${savedTo ? ` · 保存位置：${savedTo}` : ''}`,
            });
          }
          return exported;
        }
        async function executeDeleteWorkspace(ws, exportFirst = false) {
          if (exportFirst) {
            const exported = await handleExportWorkspace(ws.id);
            if (!exported) return;
          }
          const value = await action({ action: 'delete-workspace', workspaceId: ws.id, confirmed: true });
          if (value) {
            setData(previous => ({ ...value, nonce: previous?.nonce, version: previous?.version || '0.3.0' }));
            setWsPreview(null);
            setResult(value);
            syncClientSessions(value.deletedIds || []);
          }
        }
        async function mark(category) {
          const value = await action({ action: 'confirm-category', ids: [...selected], category });
          if (value) { setData(previous => ({ ...value, nonce: previous.nonce, version: previous.version })); setSelected(new Set()); }
        }
        function renderRow(row, showPath = true) {
          const shortId = row.id.replace(/^session-/, '').slice(0, 8);
          return h('div', { className: 'sc-row', key: row.id },
            h('input', { type: 'checkbox', checked: selected.has(row.id), disabled: busy || row.running, 'aria-label': `选择会话 ${row.id}`, onChange: () => toggleRow(row.id) }),
            h('div', { className: 'sc-row-main' },
              h('div', { className: 'sc-row-title' },
                h('span', null, typeof row.title === 'string' ? row.title : shortId),
                row.workspaceTitle && h('span', { className: 'sc-badge' }, `📁 ${row.workspaceTitle}`),
                group === 'all_sessions' && h('span', { className: 'sc-badge' }, row.archived ? '已归档' : '未归档'),
                row.parentId && h('span', { className: 'sc-badge' }, '子代理记录'),
                row.running && h('span', { className: 'sc-badge' }, '运行中 · 已保护')),
              showPath && h('div', { className: 'sc-path' }, row.cwd ? `项目路径（仅删对话，保留本地文件夹）：${row.cwd}` : '无绑定工作目录')),
            h('div', { className: 'sc-row-meta' },
              h('span', null, `#${shortId}`),
              h('span', null, new Date(row.createdAt).toLocaleDateString('zh-CN')),
              h('span', null, formatBytes(row.bytes)),
              button('↓ 导出对话', () => handleExportSessions([row.id]), { disabled: busy, className: 'sc-button sc-export' }),
              !row.running && button('删除', () => openPreview([row.id]), { disabled: busy, className: 'sc-button sc-danger-soft' })));
        }

        const groupedWorkspaces = group === 'deleted' ? (data?.formerWorkspaces || []).map(ws => ({
          ...ws,
          matchedRows: rows.filter(row => ws.sessionIds.includes(row.id)),
        })).filter(ws => ws.matchedRows.length > 0) : [];

        return h('section', { className: 'sc-root', 'aria-label': '会话清理' }, h('style', null, css),
          h('div', { className: 'sc-wrap' },
            h('header', { className: 'sc-header' }, h('div', null,
              h('div', { className: 'sc-eyebrow' }, `DSH · 会话与工作区管理 · ${data?.version || '0.3.0'}`),
              h('h1', { className: 'sc-title' }, '会话清理与工作区导出'),
              h('p', { className: 'sc-sub' }, '一站式管理 DSH 对话历史与工作区：一键导出单条对话或整工作区 .zip 压缩包，安全清理遗留对话与工作区。')),
              h('span', { className: 'sc-seal' }, '✓ 仅操作 DSH 对话记录 · 本地项目文件 100% 保留')),
            h('div', { className: 'sc-grid', role: 'tablist', 'aria-label': '清理分类' }, Object.entries(labels).map(([key, label]) => h('button', {
              key, className: 'sc-card', role: 'tab', type: 'button', 'aria-selected': group === key,
              onClick: () => { setGroup(key); setSelected(new Set()); setResult(null); setError(''); },
            }, h('span', null, label), h('strong', null, data ? (data.counts?.[key] ?? 0) : '—')))),
            h('p', { className: 'sc-sub' }, descriptions[group]),
            error && h('div', { className: 'sc-alert sc-error', role: 'alert' }, error),
            result && h('div', { className: 'sc-alert', role: 'status' },
              h('strong', null, result.message || `已成功处理 ${result.count || 0} 条记录`)),
            h('div', { className: 'sc-toolbar' },
              h('div', { className: 'sc-toolbar-left' },
                h('input', { className: 'sc-input', type: 'search', placeholder: group === 'all_workspaces' ? '搜索工作区名称或本地路径…' : '搜索对话标题、工作区名称或路径…', 'aria-label': '搜索会话', value: query, onChange: event => setQuery(event.target.value) }),
                group === 'all_sessions' && h('div', { className: 'sc-pills', role: 'group', 'aria-label': '归档状态筛选' },
                  [['all', '全部'], ['active', '未归档'], ['archived', '已归档']].map(([key, text]) => h('button', {
                    key, type: 'button', className: 'sc-pill', 'aria-pressed': sessionFilter === key,
                    onClick: () => { setSessionFilter(key); setSelected(new Set()); },
                  }, text)))),
              group !== 'all_workspaces'
                ? h('div', { className: 'sc-toolbar-actions' },
                    h('select', { className: 'sc-select', 'aria-label': '导出格式', value: exportFormat, onChange: event => setExportFormat(event.target.value) },
                      h('option', { value: 'zip' }, '导出格式：Markdown + JSONL (.zip)'),
                      h('option', { value: 'md' }, '导出格式：仅可读对话 (.md)'),
                      h('option', { value: 'jsonl' }, '导出格式：仅原始日志 (.jsonl)')),
                    button('刷新', () => refresh(), { disabled: busy }),
                    button(allSelected ? '取消全选' : '全选列表', () => setSelected(allSelected ? new Set() : new Set(selectableRows.map(row => row.id))), { disabled: busy || !selectableRows.length }),
                    selected.size > 0 && button(`↓ 导出所选对话 (${selected.size})`, () => handleExportSessions([...selected]), { disabled: busy, className: 'sc-button sc-export' }),
                    group !== 'all_sessions' && selectableRows.length > 0 && button(`一键清空当前分类 (${selectableRows.length})`, () => openPreview(selectableRows.map(row => row.id)), { disabled: busy, className: 'sc-button sc-danger-soft' }))
                : h('div', { className: 'sc-toolbar-actions' },
                    button('刷新工作区列表', () => refresh(), { disabled: busy }))),
            group === 'all_workspaces'
              ? (workspacesList.length > 0
                ? h('div', { className: 'sc-stack', role: 'tabpanel', 'aria-label': labels[group], 'aria-busy': busy },
                    workspacesList.map(ws => h('div', { className: 'sc-ws-card', key: ws.id },
                      h('div', null,
                        h('div', { className: 'sc-ws-title-row' },
                          h('span', { className: 'sc-ws-name' }, ws.title),
                          h('span', { className: 'sc-badge' }, `${ws.totalCount} 条对话（未归档 ${ws.activeCount} · 已归档 ${ws.archivedCount}）`),
                          h('span', { className: 'sc-badge' }, `日志 ${formatBytes(ws.bytes)}`),
                          ws.runningCount > 0 && h('span', { className: 'sc-badge' }, `${ws.runningCount} 条运行中`)),
                        h('div', { className: 'sc-ws-path' }, `本地项目目录（受保护，绝不删除）：${ws.path || '未知'}`)),
                      h('div', { className: 'sc-toolbar-actions' },
                        button('↓ 导出工作区压缩包 (.zip)', () => handleExportWorkspace(ws.id), { disabled: busy, className: 'sc-button sc-export' }),
                        button('删除工作区及对话', () => setWsPreview(ws), { disabled: busy || ws.runningCount > 0, className: 'sc-button sc-danger-soft', title: ws.runningCount > 0 ? '该工作区有正在运行的对话，请先停止后再删除整个工作区' : '' })))))
                : h('div', { className: 'sc-list', role: 'tabpanel', 'aria-label': labels[group], 'aria-busy': busy },
                    h('div', { className: 'sc-empty' }, h('strong', null, busy ? '正在读取工作区…' : '暂无匹配的工作区'), h('span', { className: 'sc-sub' }, '当前没有已注册的工作区。'))))
              : group === 'deleted'
                ? (groupedWorkspaces.length > 0
                  ? h('div', { className: 'sc-stack', role: 'tabpanel', 'aria-label': labels[group], 'aria-busy': busy },
                    groupedWorkspaces.map(ws => h('div', { className: 'sc-ws-group', key: ws.key },
                      h('div', { className: 'sc-ws-head' },
                        h('div', null,
                          h('div', { className: 'sc-ws-title-row' },
                            h('span', { className: 'sc-ws-name' }, ws.title),
                            h('span', { className: 'sc-badge' }, `${ws.matchedRows.length} 条 DSH 对话 · ${formatBytes(ws.bytes)}`)),
                          h('div', { className: 'sc-ws-path' }, `原工作区路径：${ws.cwd || '未知'}（仅清理 DSH 对话记录，本地磁盘文件完全保留）`)),
                        h('div', { className: 'sc-toolbar-actions' },
                          button('↓ 导出该组对话 (.zip)', () => handleExportSessions(ws.matchedRows.map(row => row.id)), { disabled: busy, className: 'sc-button sc-export' }),
                          button('删除该工作区会话', () => openPreview(ws.matchedRows.filter(row => !row.running).map(row => row.id)), { disabled: busy, className: 'sc-button sc-danger-soft' }))),
                      h('div', null, ws.matchedRows.map(row => renderRow(row, false))))))
                  : h('div', { className: 'sc-list', role: 'tabpanel', 'aria-label': labels[group], 'aria-busy': busy },
                    h('div', { className: 'sc-empty' }, h('strong', null, busy ? '正在整理对话…' : '没有遗留工作区对话'), h('span', { className: 'sc-sub' }, '所有已删除工作区的遗留对话均已清理完毕。'))))
                : h('div', { className: 'sc-list', role: 'tabpanel', 'aria-label': labels[group], 'aria-busy': busy },
                  rows.length ? rows.map(row => renderRow(row, true))
                    : h('div', { className: 'sc-empty' }, h('strong', null, busy ? '正在整理对话…' : '当前列表为空'), h('span', { className: 'sc-sub' }, data ? '当前筛选条件下没有对话记录。' : '正在读取 DSH 会话记录。'))),
            group !== 'all_workspaces' && h('div', { className: 'sc-bottom' },
              h('span', { className: 'sc-sub', 'aria-live': 'polite' }, `已勾选 ${selected.size} 条对话记录`),
              h('div', { className: 'sc-toolbar-actions' },
                ['unknown', 'unassociated'].includes(group) && button('标记为已删除工作区', () => mark('deleted'), { disabled: busy || !selected.size }),
                ['unknown', 'deleted'].includes(group) && button('标记为原本无关联', () => mark('unassociated'), { disabled: busy || !selected.size }),
                button('↓ 导出所选对话', () => handleExportSessions([...selected]), { disabled: busy || !selected.size, className: 'sc-button sc-export' }),
                button('删除所选会话', () => openPreview([...selected]), { disabled: busy || !selected.size, className: 'sc-button sc-danger' }))),
            h('footer', { className: 'sc-note' }, '安全说明：无论删除单条对话还是删除整个工作区，均只移除 DSH 内部的会话日志与注册信息（~/.dsh/sessions 与缓存），绝不会删除或修改本地磁盘项目目录中的任何源代码、文档或文件夹。')),
          preview && h('div', { className: 'sc-dialog-backdrop' }, h('div', { className: 'sc-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'sc-confirm-title', onKeyDown: dialogKeys },
            h('h2', { id: 'sc-confirm-title' }, `确认清理 ${preview.selected.length} 条 DSH 对话记录`),
            h('div', { className: 'sc-safe-banner' }, '✓ 仅删除 DSH 本机存储里的对话历史记录，不会删除项目文件夹里的任何本地文件。'),
            h('ul', null, preview.selected.slice(0, 8).map(row => h('li', { key: row.id }, `${row.title || row.id.replace(/^session-/, '').slice(0, 8)}（${row.workspaceTitle || row.formerWorkspace || row.cwd || '无目录'}）`)), preview.selected.length > 8 && h('li', null, `另有 ${preview.selected.length - 8} 条对话将一并清理。`)),
            preview.cascadeChildren?.length > 0 && h('p', { className: 'sc-sub' }, `包含 ${preview.cascadeChildren.length} 条关联的子代理（Subagent）对话记录。`),
            h('div', { className: 'sc-dialog-actions' },
              button('取消', () => setPreview(null), { disabled: busy, autoFocus: true }),
              button('确定', () => executeDelete(preview.selected.map(row => row.id), preview.allowActiveWorkspace), { className: 'sc-button sc-danger', disabled: busy })),
            error && h('p', { className: 'sc-error', role: 'alert' }, error))),
          wsPreview && h('div', { className: 'sc-dialog-backdrop' }, h('div', { className: 'sc-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'sc-ws-confirm-title', onKeyDown: dialogKeys },
            h('h2', { id: 'sc-ws-confirm-title' }, `确认删除工作区「${wsPreview.title}」及对话`),
            h('div', { className: 'sc-safe-banner' }, `✓ 仅从 DSH 移除工作区注册并清理其 ${wsPreview.totalCount} 条 DSH 对话历史（${formatBytes(wsPreview.bytes)}），不会变为“未分组”。本地硬盘文件夹 ${wsPreview.path} 中的所有代码与文件 100% 保留。`),
            h('div', { className: 'sc-dialog-actions' },
              button('取消', () => setWsPreview(null), { disabled: busy, autoFocus: true }),
              button('↓ 先导出备份 (.zip) 再删除', () => executeDeleteWorkspace(wsPreview, true), { className: 'sc-button sc-export', disabled: busy }),
              button('确定删除工作区及对话', () => executeDeleteWorkspace(wsPreview, false), { className: 'sc-button sc-danger', disabled: busy })),
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
