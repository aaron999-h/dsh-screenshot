# dsh-screenshot

Adds a **Screenshot** row to the composer's `+` menu. Pick a region anywhere on the desktop — DSH itself stays visible — and the crop is attached to the current draft, ready to send with your question.

## What you get

- One extra row in the `+` menu: **Screenshot** / 截图提问.
- Clicking it freezes the whole desktop (every monitor) into a borderless, top-most selection window in place: nothing flickers, no window is hidden or minimised, DSH stays exactly where it is.
- Drag to select; the live badge shows the region size in pixels. Everything outside the selection dims only while you drag.
- Release the mouse: the region is cropped at native resolution and inserted into the composer as a PNG attachment, through the very same intake a real Ctrl+V image paste uses (so the usual caps, busy refusal and upload staging apply).
- **Right-click** or **Esc** cancels; no attachment is created.

## Install

```bash
dsh plugin install dsh-screenshot
```

Or add `"dsh-screenshot"` to `dsh.profile.bundles` in your profile and let the loader fetch it. Requires DSH Desktop on **Windows** (capture is implemented with PowerShell + WinForms); on other platforms the row is hidden.

## How it works

- **Host half** (`index.js`): registers `POST /screenshot/capture` (guarded by an `x-dsh-screenshot: 1` header plus a same-origin check) and `GET /screenshot/status`. The capture itself is one PowerShell script: it declares per-monitor DPI awareness, grabs the whole virtual screen (`SystemInformation.VirtualScreen`, so all monitors) as the frozen frame, shows that frame in a borderless top-most WinForms window that covers the desktop, dims everything outside the drag rectangle, accepts right-click/Esc as cancel, then crops the frozen bitmap at native resolution and hands the PNG back through stdout JSON. The desktop page cannot capture pixels itself — its Electron session denies display media and blocks http(s) subresources — so the pixels have to come from the Host process.
- **Client half** (`client.js`): registers one `ctx.commandUi` contribution (the row) and one `conversation.input.overlay` entry (the small failure card with a retry button). After the capture it first tries `inputActions.addFiles`, and otherwise dispatches a synthetic `ClipboardEvent('paste')` carrying a `DataTransfer` at the document — which is the supported door into the composer's document-level paste intake.

Every capture is journaled to `%TEMP%\dsh-screenshot.log` (`capture ok <w>x<h> in <ms>`), which is the first place to look if a click ever does nothing.

## Why the row sits at the end of the Commands group

The `+` menu's grouping is hard-coded in `@deepseek-ai/dsh-client-ui-commands`:

```ts
const SECTION_ROWS = { add: ['file', 'goal', 'plan', 'feedback'], commands: ['compact', 'permission', 'model', 'export'] }
```

Only those four names land in the **Add** group; every other row — including plugin contributions — closes the **Commands** group. Taking one of the Add names is impossible: a contribution that collides with a built-in command throws while the menu is being built (`ui-commands: contribution /<name> collides with a host command`). So a plugin-owned row can appear in the Commands group only, and that is where this one is.

## Uninstall

```bash
dsh plugin remove dsh-screenshot
```

It only adds one menu row, one overlay entry and two Host routes; nothing else is touched.
