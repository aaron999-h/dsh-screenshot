# dsh-screenshot

Adds a **Screenshot** row to the composer's `+` menu. Pick a window or drag a region anywhere on the desktop — DSH itself stays visible — annotate it WeChat-style, then insert it into the draft, copy it, or save it.

## What you get

- One extra row in the `+` menu: **Screenshot** / 截图提问.
- Clicking it freezes the whole desktop (every monitor) into a borderless, top-most window in place: nothing flickers, no window is hidden or minimised, DSH stays exactly where it is.
- **Pick**: the window under the cursor is framed in green while everything else dims. Left-click it to take that window, or drag to draw your own region — while you drag, the region under the cursor stays bright and the rest dims live, with a `W × H` badge tracking the pointer.
- **Annotate** in the same window, over the frozen frame: rectangle, ellipse, line, arrow (the drag start is the arrow's tail, any direction), freehand pen, mosaic (pixelates the area under the drag) and text.
  - The toolbar is one white row, right-aligned to the selection: `矩形 椭圆 直线 箭头 画笔 马赛克 文字 ｜ 撤销 重做 ｜ 复制 另存为 ｜ ✕ 取消 ✓ 插入`.
  - The colour / width row appears underneath only when a shape tool is active (or such a shape is selected). For text it reads **小 / 中 / 大** and sets the font size instead.
  - Shapes stay selected after you draw them: drag the handles to resize, drag a line's endpoints to change length and direction, drag inside to move, `Delete` to remove. `Ctrl+Z` / `Ctrl+Y` walk undo and redo.
  - The toolbar also carries a **scrolling capture** button (page + down arrow, its own group right of 文字) — see below.
- **✓ 插入**: the composited crop is inserted into the current draft as a PNG attachment, through the very same intake a real Ctrl+V image paste uses (so the usual caps, busy refusal and upload staging apply). **复制** puts it on the clipboard, **另存为** writes PNG/JPEG/BMP.
- **Right-click** or **Esc** cancels; no attachment is created.

## Scrolling capture

For pages taller than the screen (chat history, long articles, long documents):

1. Pick the region through the normal flow, then press the **scrolling capture** button in the toolbar.
2. A small hint strip appears outside your selection and reports how many pixels have been stitched so far. Now scroll the window underneath (wheel, `PgDn`, whatever it uses).
3. Press **完成 / Done** on the strip (or `Enter`) when you reach the bottom.
4. The stitched image comes back **in the same annotator window** — scaled to fit, background dimmed, toolbar still there, nothing is inserted automatically. Annotate it if you want, then decide: `✓` inserts, `复制` copies, `另存为` saves, `✕` / `Esc` discards.
   - In this result view the scrolling button is greyed out, the other tools keep working, and annotations you already drew can still be selected with the 8 handles, stretched, moved and deleted — the mouse is mapped back to the original pixels, so the exported image stays full resolution.

How the stitching works: the region is sampled every 320 ms, adjacent frames are compared row by row (SAD) to measure how far the content moved up, and only the newly revealed bottom rows are appended. A frame that did not move, or a page that changed entirely, is ignored. Height is capped at 24000 px and one session may run 180 s. The detector has a standalone self-test (`[DshShot.Editor]::ScrollSelfTest($dir)`): it renders a long page, feeds it in as slices and compares pixels.

## Hotkey

**Alt + A** starts a capture on the Desktop, same as `+` → **Screenshot**:

- It is **global**: it fires while DSH is minimized or behind another application. The Host keeps a small helper alive that owns a Win32 `RegisterHotKey` registration, so the key never depends on window focus; after the region is chosen the main window is restored and raised so the attachment is right in front of you.
- The same combo is also registered as a normal `ctx.shortcuts` command, so it shows up in **Settings → Shortcuts** and can be rebound there — that in-window binding is what fires while DSH has focus. Starting twice is harmless.
- The system-wide registration is fixed to `Alt+A`. If another app already owns that combo, registration fails and the log at `%TEMP%\dsh-screenshot.log` records `hotkey unavailable: register-failed …`; the in-window binding still works.
- The browser build (`dsh web`) has neither: capturing needs the Desktop Host.

## Install

```bash
dsh plugin install dsh-screenshot
```

Or add `"dsh-screenshot"` to `dsh.profile.bundles` in your profile and let the loader fetch it. Requires DSH Desktop on **Windows** (the selection and annotation window is C# compiled at capture time); elsewhere the row is hidden.

## How it works

- **Host half** (`index.js`): registers `POST /screenshot/v7/capture` (guarded by a `x-dsh-screenshot: 1` header plus a same-origin check) and `GET /screenshot/v7/status`. One PowerShell script declares per-monitor DPI awareness, grabs the whole virtual screen (`SystemInformation.VirtualScreen`, so all monitors) as the frozen frame, compiles `editor.cs`, and runs it. The result — the annotated crop, or a cancel — comes back through a small JSON file; the Host answers with a base64 data URL. The page cannot capture pixels itself (its Electron session denies display media and blocks http(s) subresources), so the pixels have to come from the Host process.
- **Editor half** (`editor.cs`, shipped in the package and compiled with `Add-Type` at capture time): one borderless top-most WinForms window over the frozen frame does both phases — pick (`DwmGetWindowAttribute` window bounds, green frame + dim, drag rectangle with live dim and size badge, bottom hint), then annotate (floating white toolbar, on-demand colour/size row, GDI+ drawn icons, `Compose()` renders the selection at native resolution).
- **Client half** (`client.js`): registers one `ctx.commandUi` contribution (the row) and one `conversation.input.overlay` entry (the small failure card with a retry button). After the capture it first tries `inputActions.addFiles`, and otherwise dispatches a synthetic `ClipboardEvent('paste')` carrying a `DataTransfer` at the document — which is the supported door into the composer's document-level paste intake.

Every capture is journaled to `%TEMP%\dsh-screenshot.log` (`capture ok <w>x<h> in <ms>`), and the editor's own log is copied to `%TEMP%\dsh-screenshot-editor.log` (hover changes, `finish <action>`); those two files are the first place to look if a click ever does nothing.

## Why the row sits at the end of the Commands group

The `+` menu's grouping is hard-coded in `@deepseek-ai/dsh-client-ui-commands`:

```ts
const SECTION_ROWS = { add: ['file', 'goal', 'plan', 'feedback'], commands: ['compact', 'permission', 'model', 'export'] }
```

Only those four names land in the **Add** group; every other row — including plugin contributions — closes the **Commands** group. Taking one of the Add names is impossible: a contribution that collides with a built-in command throws while the menu is being built (`ui-commands: contribution /<name> collides with a host command`). So a plugin-owned row can appear in the Commands group only, and that is where this one is.

## Notes

- A second click while a selection window is already open answers `409 a selection is already open` and shows a hint instead of stacking windows.
- The annotator never captures the mouse outside its own window; `Alt+Tab` and other system shortcuts still work, and the frozen frame is what you get even if the desktop changes underneath.

## Uninstall

```bash
dsh plugin remove dsh-screenshot
```

It only adds one menu row, one overlay entry and two Host routes; nothing else is touched. The scrolling capture reuses the same window and the same route (`?mode=scroll`).
