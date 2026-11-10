# 会话清理 · dsh-session-cleaner

为 DeepSeek Harness 提供归档会话与已删除工作区遗留会话的一键永久清理面板。安装后的中文名称为 **会话清理**，入口排在左侧栏“记忆系统”之后。界面采用 Anthropic Claude 风格的克制卡片、衬线标题和 DSH 原生亮暗主题。

## 核心功能

| 分类 | 判断依据与清理能力 |
| --- | --- |
| **已归档** | 对应 DSH“视图 → 已归档”中的归档会话（`archivedSessionIds`），支持批量勾选或一键清空已归档 |
| **已删除工作区** | 自动识别已从 DSH 移除工作区后遗留在“未分组”中的会话，按原工作区分组展示卡片，支持按工作区一键删除或一键清空全部遗留会话 |
| **原本无关联** | 原本未绑定工作目录（无 `cwd`）或手动标记为无关联的独立会话 |
| **归属待确认** | 供手动归类调整的候选视图 |

## 在线一键永久删除

1. 打开左侧栏 **会话清理**，切换“已归档”或“已删除工作区”分类。
2. 在“已删除工作区”标签页下，可直接点击某张原工作区卡片上的 **“删除该工作区会话”**，或点击工具栏 **“一键清空当前分类”** / 勾选后点击 **“删除所选会话”**。
3. 在弹出的确认框中直接点击 **“确定”**，插件即在 Host 内直接完成永久删除，并实时通知前端 `sessions` 服务刷新左侧栏（无需重启 DSH 或手动跑终端脚本）。

### 删除范围与安全保护

- **彻底清理 DSH 内部会话数据**：卸载内存 `SessionStore` 会话、移除 `workspaceRegistry` 中的归档/置顶/工作区引用与残留幽灵 ID、清理 `sessionPersistence` 内存缓存、删除 `session_projcache` 投影缓存记录与磁盘缓存文件，并删除 `sessions/<projectKey>/<sessionId>` 会话目录（默认连带清理其派生的 subagent 子会话）。
- **绝不触碰本地磁盘项目文件**：严格校验会话目录必须位于 `sessions` 二级子目录内，且与所有工作区及会话的 `cwd` 项目路径无任何交叠；本地硬盘上的代码、文档和项目文件夹完好保留。
- **运行中会话保护**：正在运行或等待输入的会话禁止删除。

## 安装与测试

可通过 DSH CLI 或内置 `plugin_manager` 安装：

```bash
dsh plugin --profile desktop add github:JsaonSpace92/dsh-session-cleaner
```

或在本地克隆仓库后，使用 DSH `plugin_manager` 的 `install_bundle`（`target` 设为本地仓库目录绝对路径）安装。

```bash
npm run check
npm test
```

`0.2.1` 包含 22 项 JavaScript 测试与 30 项 Python 测试（保留 `offline.py` 作为可选离线维护工具），合计 52 项测试全部通过。
