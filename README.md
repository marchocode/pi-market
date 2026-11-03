# pi-market

[![npm version](https://img.shields.io/npm/v/pi-market.svg)](https://www.npmjs.com/package/pi-market)
[![license](https://img.shields.io/npm/l/pi-market.svg)](LICENSE)

在 Pi 里直接浏览 [pi.dev/packages](https://pi.dev/packages) 包市场，搜索、查看详情并一键安装扩展、技能、主题和提示词包。

```
 Pi Market pi.dev/packages                                    5,748 packages · 2m ago
 / powerline
 type all · sort downloads · scope user · show 14/5,748
 ──────────────────────────────────────────────────────────────────────────────────────
 ▸ pi-powerline-footer                              50.5K/mo│pi-powerline-footer
   pi-powerline                                         877/mo│nicopreme · 50.5K/mo · 4d ago
   @talex-touch/pi-powerline-footer                     255/mo│extension · not installed
   @lokiyou/pi-nano-footer                            2,748/mo│
   pi-tui-status-beautifier                           1,826/mo│Powerline-style status bar extension for pi coding
   @underactive/pi-topping-statusline                 1,482/mo│agent
   @juanibiapina/pi-powerbar                          1,198/mo│
   @groeponline/pi-wishcraft                           853/mo│$ pi install npm:pi-powerline-footer
   @wishx127/pi-tokyo-night                             764/mo│https://pi.dev/packages/pi-powerline-footer
   ────────────────────────────────────────────────────────────────────────────────────
   ↑↓ move · ⏎ install · ctrl+r remove · ctrl+l scope · ctrl+t type · tab sort · esc close
```

## 安装

发布到 npm 后：

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

- 目录来自 `https://pi.dev/packages` 的服务端渲染 HTML，共 ~115 页，首次打开会并发抓取并显示进度。
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

## 发布（维护者）

```bash
npm login
npm run typecheck && npm test
npm version patch        # 更新版本号并创建 git tag
git push --follow-tags   # 推送 tag 后 GitHub Actions 自动发布
```

GitHub Actions（`.github/workflows/publish.yml`）在推送 `v*` tag 时执行
`npm publish --provenance --access public`，需要在仓库 Secrets 中配置 `NPM_TOKEN`
（npm 账号的 Automation token）。

手动发布：

```bash
npm publish --access public
```

## License

MIT
