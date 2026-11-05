# pi-market

[English](README.md) | [简体中文](README_zh.md)

[![npm version](https://img.shields.io/npm/v/pi-market.svg)](https://www.npmjs.com/package/pi-market)
[![license](https://img.shields.io/npm/l/pi-market.svg)](LICENSE)

在 Pi 里直接浏览 [pi.dev/packages](https://pi.dev/packages) 包市场，搜索、查看详情并一键安装扩展、技能、主题和提示词包。

```
Pi Market pi.dev/packages                                                   5,649 packages · 2m ago
/   type to filter · package name, description, author
type all · sort downloads · scope user · show 5,649/5,649
────────────────────────────────────────────────────────────────────────────────────────────────────
▸ billion-context                                2.8M/mo│billion-context
  pi-mcp-adapter                                 1.4M/mo│ranxianglei · 2.8M/mo · 2d ago
  pi-web-access                           1.1M/mo ✓user │package · not installed
  pi-mcp-extension                             823.8K/mo│
  pi-subagents                          726.4K/mo ✓user │A context-compression plugin — small
  @postman/postman-plugin                        426K/mo│context windows (a 100K context is enough),
  openwiki                                     209.9K/mo│5x fewer tokens, month-long single sessions
  @juicesharp/rpiv-ask-user-question           149.3K/mo│(billions of tokens), and compression
  @dietrichgebert/ponytail                     130.6K/mo│quality — for all agents: pi, OpenCode,
  cc-safety-net                                108.5K/mo│Codex, Claude Code, and more.
  context-mode                                 103.9K/mo│billion-context is all
  @langchain/langsmith-pi-extension             96.1K/mo│
  @plannotator/pi-extension                     89.7K/mo│$ pi install npm:billion-context
  @juicesharp/rpiv-todo                         87.4K/mo│https://pi.dev/packages/billion-context
  @onkernel/browser-loop                        86.4K/mo│
  1-15 of 5,649
────────────────────────────────────────────────────────────────────────────────────────────────────
↑↓ move · ⏎ install · ctrl+r remove · ctrl+l scope · ctrl+t type · tab sort · esc close
```

宽终端下左侧为包列表、右侧为选中包的详情；窄终端会把摘要堆叠在列表下方。每行显示包名、月下载量，已安装的包带 `✓user` / `✓project` 标记；底部显示当前可见范围，例如 `1-15 of 5,649`。

## 安装

从 npm 安装：

```bash
pi install npm:pi-market
```

本地开发/试用：

```bash
git clone git@github.com:marchocode/pi-market.git
cd pi-market
pi -e ./src/index.ts        # 仅本次启动加载
# 或
pi install ./               # 写入设置，之后每次启动自动加载
```

装好后运行 `/reload` 或重启 Pi。

## 使用

### `/market` — 交互式市场

| 操作 | 说明 |
| --- | --- |
| 直接输入 | 实时过滤，支持多关键词；先匹配名称，再匹配描述/作者/关键词 |
| `↑` / `↓` | 移动选择（支持鼠标滚轮） |
| `Enter` | 安装选中的包（按当前 scope） |
| **鼠标点击** | 点击任意一行即安装该包（全屏模式下） |
| `ctrl+r` | 移除已安装的包；连按两次确认 |
| `ctrl+l` | 切换安装范围：`user`（全局）⇄ `project`（`.pi/settings.json`） |
| `ctrl+t` | 切换类型过滤：all / extension / skill / theme / prompt |
| `Tab` | 切换排序：下载量 / 最近更新 / 名称 |
| `Esc` | 清空搜索；搜索为空时关闭市场 |
| `Enter`（关闭后） | 若本次有安装/卸载，会询问是否立即 `/reload` |

### 其他命令

```bash
/market                      # 打开交互式市场
/market <关键词>              # 打开市场并带上搜索词
/market search <关键词>       # 直接打印匹配结果（非 TUI 也可用）
/market refresh              # 强制重新下载市场目录
/market install <包名> [-l]   # 直接安装；-l 表示安装到项目 (.pi/settings.json)
/market help                 # 帮助
```

### 给模型的工具

- `market_search` — 搜索市场目录，返回包名、描述、安装命令、是否已安装
- `market_install` — 执行 `pi install`（交互模式下会先弹窗确认）

## 数据与缓存

- 目录来自 `https://pi.dev/packages` 的服务端渲染 HTML，共 ~113 页，首次打开会并发抓取并显示进度。
- 解析结果缓存到 `~/.pi/agent/cache/pi-market/catalog.json`（默认 6 小时有效；部分失败时 10 分钟）。
- `/market refresh` 可随时强制刷新；网络失败会在 TUI 中显示错误并支持 `Enter` 重试。
- 已安装状态读取 `~/.pi/agent/settings.json` 和当前目录 `.pi/settings.json`。

## 安装实际执行什么

`pi-market` 不直接改配置，而是调用 Pi CLI：

```bash
pi install npm:<name>            # user scope
pi install npm:<name> --local    # project scope
pi remove  npm:<name> [--local]
```

因此版本锁定、npm/git 源处理和设置格式都与手动安装完全一致。

安全提示：Pi 扩展以你的系统权限运行，请只安装你信任的包。项目级安装受 Pi 的项目信任机制保护；当项目未受信任时，市场会提示你改用手动 `--approve` 或切换到 user scope。

## 开发

```bash
npm install            # 安装 typescript（仅用于类型检查）
npm run typecheck      # tsc --noEmit
npm test               # 解析/搜索/源归一化单元测试
npm run preview        # 不开 TUI，直接打印市场目录（支持 --cached / --query）
```

扩展入口为 `src/index.ts`，使用 jiti 直接加载 TypeScript，无需构建。

## License

MIT
