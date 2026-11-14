# dsh-screenshot

在对话输入框左下角的 `+` 菜单里加一行 **截图提问**：点一下就能在整个桌面上自由框选区域（DSH 窗口不隐藏、不最小化，就显示在冻结画面里），松手后按原始分辨率裁切成 PNG，作为附件放进当前输入框，可以接着打字一起发送。

## 功能

- `+` 菜单里多一行 **截图提问**。
- 点击后桌面被「冻结」成一张覆盖全部显示器的截图，并在这张画面上直接弹出无边框、置顶的选区窗口：不闪烁，不隐藏、不最小化任何窗口，DSH 保持原样。
- 按住鼠标拖动框选，选区旁实时显示像素尺寸；拖动时选区之外才变暗。
- 松手即按原始分辨率裁切成 PNG，通过与「Ctrl+V 贴图」完全相同的通道进入输入框（附件上限、发送中拒绝、上传暂存等规则都由 composer 把关）。
- **右键** 或 **Esc** 取消，不产生任何附件。

## 安装

```bash
dsh plugin install dsh-screenshot
```

或在 profile 的 `dsh.profile.bundles` 里加入 `dsh-screenshot`，由 loader 拉取。截屏实现依赖 **Windows**（PowerShell + WinForms）；其他平台该行不显示。

## 实现

- **Host 半（`index.js`）**：注册 `POST /screenshot/capture`（要求 `x-dsh-screenshot: 1` 头且同源）与 `GET /screenshot/status`。截图由一段 PowerShell 脚本完成：先声明 per-monitor DPI 感知，抓取整个虚拟屏幕（`SystemInformation.VirtualScreen`，含多显示器）作为「冻结帧」，再用无边框置顶的 WinForms 窗口覆盖桌面显示这张帧，拖动时把选区之外变暗，右键 / Esc 视为取消，最后从冻结位图上按原始分辨率裁切，并通过 stdout 的 JSON 把结果交回 Host。页面自身无法截屏——Electron 会话禁止 display media 且拦截 http(s) 子资源——所以像素只能由 Host 进程提供。
- **Client 半（`client.js`）**：注册一个 `ctx.commandUi` 贡献（即菜单里那一行）和一个 `conversation.input.overlay` 条目（失败时的小卡片，带重试）。拿到 PNG 后先尝试 `inputActions.addFiles`，否则向文档派发一次合成的 `ClipboardEvent('paste')`（携带 `DataTransfer`），走 composer 自己的文档级粘贴入口。

每次截图都会写一行日志到 `%TEMP%\dsh-screenshot.log`（`capture ok <w>x<h> in <ms>`），点下去没反应时先看这里。

## 为什么这一行排在「命令」分组末尾

`+` 菜单的分组在 `@deepseek-ai/dsh-client-ui-commands` 里写死：

```ts
const SECTION_ROWS = { add: ['file', 'goal', 'plan', 'feedback'], commands: ['compact', 'permission', 'model', 'export'] }
```

只有这四个命令名会进「添加」分组；其余（包括插件贡献）一律排在「命令」分组末尾。占用「添加」里的名字也不可能：与内置命令重名会在菜单构建时直接抛错（`ui-commands: contribution /<name> collides with a host command`）。所以插件自己的行只能落在「命令」分组，本插件就是如此。

## 卸载

```bash
dsh plugin remove dsh-screenshot
```

它只增加一行菜单、一个覆盖层条目和两个 Host 路由，不动其他任何东西。
