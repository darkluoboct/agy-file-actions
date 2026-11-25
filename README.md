# agy-file-actions (File Actions)

Google Antigravity 2.0 开源插件：解决 Antigravity 对话中无法直接右键打开所在文件夹的痛点。在对话里的文件链接、行内路径或选中路径上点击右键，即可快速在资源管理器中定位文件、打开所在文件夹、使用外部编辑器精准跳行、在目录打开终端或复制多种格式路径。零第三方依赖，原生极简无 emoji 风格。

## 核心特性

1. **在资源管理器中定位 / 打开所在文件夹**
   - 对文件调用 `explorer.exe /select,"<path>"`（macOS `open -R` / Linux `xdg-open`）打开目录并高亮选中目标文件；
   - 对目录直接打开；
   - 若目标文件已被删除，自动回退打开最近存在的上级目录。
2. **外部编辑器精准跳行**
   - 自动探测本机已安装编辑器（优先 VS Code，其次 Cursor、系统默认程序），识别 `#L10-L20` 与 `:line:col` 并通过 `--goto` 精准跳转到对应行列；
   - 支持在侧边栏中配置自定义编辑器路径与参数模板（支持 `{path}`、`{line}`、`{col}`、`{dir}` 占位符）。
3. **在此处打开终端**
   - 自动探测并支持 Windows Terminal (`wt.exe`)、PowerShell 7 (`pwsh.exe`)、Windows PowerShell 与 `cmd`（macOS 支持 Terminal.app，Linux 支持常见终端），直接在目标目录启动。
4. **多格式一键复制**
   - 复制绝对路径（支持系统默认 / 统一正斜杠 `/` / 统一反斜杠 `\`）
   - 复制相对路径（自动查询当前对话工作区根目录）
   - 复制带行号引用（如 `src/server.mjs:42`）
   - 复制文件名
5. **精准右键触发与双模无感降级**
   - 仅在右键命中 `file://` 链接、行内代码路径或手动选中的有效路径时接管菜单，普通正文与空白区域保留原生右键菜单；
   - 按住 `Shift + 右键` 可随时强制呼出系统原生右键菜单；
   - 未检测到本地调试端口时自动降级为 Mode 1 官方侧边栏工作台（支持手动粘贴路径与最近操作列表）。
6. **安全防护**
   - 全部外部进程调用均使用 `shell: false` 参数数组并校验非法控制字符与引号，杜绝命令注入；
   - 环回 IPC 仅绑定 `127.0.0.1` 随机端口并校验每次启动生成的随机 Token。

## 环境要求

- Google Antigravity 2.0（App）
- Node.js `>= 22`（Antigravity Sidecar 自带 Node 24，零外部 `npm` 依赖）
- （可选）若启用对话内右键菜单增强（Mode 2），启动 Antigravity 时需附带 `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1`

## 安装与卸载

```bash
git clone https://github.com/darkluoboct/agy-file-actions.git
cd agy-file-actions
```

| 操作 | Windows | macOS / Linux |
| :--- | :--- | :--- |
| 安装 / 更新 | `install.bat` | `sh install.sh` |
| 卸载 | `uninstall.bat` | `sh uninstall.sh` |

安装脚本会将插件同步至 `~/.gemini/config/plugins/agy-file-actions/`，Antigravity 自动发现生效。个人偏好保存在 `~/.gemini/config/agy-file-actions/settings.json`，更新或卸载均会保留。

## 目录结构

```text
agy-file-actions/
├── plugin.json                            # 插件清单与元信息
├── mcp_config.json                        # MCP 工具服务注册
├── assets/logo.svg                        # 插件图标
├── mcp/server.mjs                         # 标准 stdio MCP 工具服务
├── sidecars/file_actions/
│   ├── sidecar.json                       # Sidecar 清单（AUX_PANE）
│   ├── server.mjs                         # 主服务、工作区追踪与环回 IPC
│   ├── path_resolver.mjs                  # 多格式路径解析与工作区相对化
│   ├── launcher.mjs                       # 编辑器/终端探测与安全 OS 启动器
│   ├── context_menu_overlay.mjs           # Mode 2 对话内 Shadow DOM 右键菜单
│   ├── sidebar_ui.mjs                     # Mode 1 官方侧边栏设置与直达工作台
│   ├── settings.mjs                       # 原子持久化配置
│   └── host_bridge.mjs                    # 异步宿主桥接与热重载监听
└── tests/file_actions.test.mjs            # 单元与集成测试套件
```

## 运行测试

```bash
npm test
# 或
node --test tests/file_actions.test.mjs
```

## 开源协议

[MIT](./LICENSE)
