# 会话清理插件交接说明

当前版本：`0.3.0`。

## 核心架构与变更记录

1. **六板块全景管理**：
   - 在原有 4 个清理分类（`已归档对话`、`已删除工作区`、`原本无关联`、`归属待确认`）后新增第 5 板块 **「所有对话」**（`all_sessions`）与第 6 板块 **「所有工作区」**（`all_workspaces`）。
2. **单条/批量对话导出与整工作区 `.zip` 压缩包导出**：
   - `core.js` 内置纯 Node.js 标准库实现的 ZIP 打包器（`createZipBuffer`，支持 Deflate 压缩、UTF-8 文件名标记与 CRC32 校验）以及可读 Markdown 渲染器（`formatSessionMarkdown`）和 JSONL 导出器（`formatSessionJsonl`）。
   - `SessionCleaner.exportSessions` 与 `SessionCleaner.exportWorkspace` 通过 `sessionPersistence.open(id, 'read')` 读取任意未归档或已归档会话事件流，支持导出 `.zip`、`.md`、`.jsonl`，并在客户端优先调用 `window.dshDesktop.fileActions.save` 触发原生保存对话框。
3. **连根删除工作区（`SessionCleaner.deleteWorkspace`）**：
   - 先删除目标工作区关联的全部会话记录（含派生的 subagent 子会话），再调用 `workspaceRegistry.delete(workspaceId)` 移除工作区注册，避免删除工作区后遗留大量“未分组”会话。
4. **本地项目文件安全保障**：
   - 仅操作 DSH 会话存储目录（`~/.dsh/sessions`）、工作区注册表与投影缓存（`~/.dsh/storages/session_projcache`），绝不修改或删除本地磁盘项目目录中的任何文件。

## 验证状态

- 25 项 JavaScript 单元测试与 30 项 Python 单元测试（共 55 项）全部通过，含 Python `zipfile.ZipFile.testzip()` 压缩包完整性校验。
