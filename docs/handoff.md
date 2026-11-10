# 会话清理插件交接说明

当前版本：`0.2.1`。

## 核心架构与变更记录

1. **在线一键永久删除（`SessionCleaner.deleteSessions`）**：
   - 在确认会话处于非运行状态、目录严格位于 `sessions/<projectKey>/<sessionId>` 二级目录且与任何受保护项目路径（`protectedPaths`）无重叠后，直接在 Host 进程内执行永久删除：
     - 从 `ctx.sessions` 卸载内存会话实例；
     - 调用 `workspaceRegistry.unarchiveSession`、`unpinSession` 及各工作区 `detachSession`，同步清理 `workspaceRegistry` 与 `sessionPersistence` 内存缓存，并清理 `workspace.json` 中残留的失效归档/置顶引用；
     - 调用 `storageDomain.get('session_projcache').table('sessions').delete(id)` 并清理 `<id>.json*` 磁盘缓存文件；
     - 删除 `sessions/<projectKey>/<sessionId>` 目录（默认级联删除其派生的 subagent 子会话）。
   - 前端注入 `@deepseek-ai/dsh-api-session-controller` 的 `sessions` 服务，删除成功后立即调用 `ctx.sessions.handleSessionRemoved(id)` 与 `ctx.sessions.refresh()`，使 DSH 左侧栏列表实时刷新。
2. **已删除工作区遗留会话自动识别与分组清理**：
   - 自动识别未归档、不属于现存工作区且带有历史工作区 `cwd` 的遗留会话，归入 **“已删除工作区”** 分类（同时过滤现存工作区正常会话派生的 subagent 子会话）。
   - 在“已删除工作区”标签页按原工作区分组展示全宽卡片，支持按原工作区一键删除，以及工具栏一键清空当前分类全部会话。
3. **本地项目文件安全保障**：
   - 仅删除 DSH 会话存储目录（`~/.dsh/sessions`）与投影缓存（`~/.dsh/storages/session_projcache`）中的对话数据，绝不修改或删除本地磁盘项目目录中的任何文件。

## 验证状态

- 22 项 JavaScript 单元测试与 30 项 Python 单元测试（共 52 项）全部通过。
- 已在 DSH Desktop 环境中完成真实归档会话与已删除工作区遗留会话的在线清理及反向核验。
