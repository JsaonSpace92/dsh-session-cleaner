# 存储分工说明

源码、图标、多语言文案、测试、许可证和文档均位于项目根目录。项目无第三方运行依赖，无需额外构建工具或外部运行包。

## 项目内目录结构

- `index.js` / `core.js`：Host 端插件入口、会话分类、安全边界校验与在线永久删除逻辑。
- `client.js`：Web / Desktop 客户端面板 UI（挂载在左侧栏“记忆系统”下方）。
- `offline.py`：可选的离线维护与备份恢复脚本（仅使用 Python 3 标准库）。
- `runtime/`：运行期生成的本地状态目录（含 `workspace-history.json`），已列入 `.gitignore`，不纳入版本控制。
- `.cache/npm/`：项目级 npm 缓存目录，已列入 `.gitignore`。
- `test/`：JavaScript 与 Python 自动化测试套件，测试夹具在运行结束后自动清理。

## DSH 运行与数据边界

- 插件通过 DSH `plugin_manager`（`install_bundle`）或 `dsh plugin add` 安装到当前 profile（如 `~/.dsh/profiles/desktop`）。
- 默认会话与元数据根目录由 bundle 的 `dshHomePath('sessions')` 与 `dshHomePath('storages')` 解析（默认对应 `~/.dsh/sessions` 与 `~/.dsh/storages`）。
- 项目目录保护范围涵盖所有已注册工作区路径及会话 `header.cwd` 工作目录，清理操作严格限制在 `sessions/<projectKey>/<sessionId>` 与 `session_projcache` 内，绝不触碰本地磁盘项目文件夹。
