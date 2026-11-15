# dsh-screenshot — implementation detail

## Shape of the bundle

```
dsh-screenshot/
  package.json        dsh.bundle.patch + dsh.client (web, immediately)
  cordis.patch.yml    inserts the loader entry `dsh-screenshot`
  index.js            Host half: the HTTP routes, the frozen-frame script, the work dir
  client.js           Client half: the `+` menu row and the failure card
  editor.cs           The whole selection + annotation window (C# 5, compiled at capture time)
  locale/{en,zh}.json marketplace metadata
  assets/icon.svg     icon (also shipped as a 180 px PNG in the release)
  docs/DETAIL.md      this file
```

## Flow of one capture

1. The user picks **截图提问** in the `+` menu. `CommandUi` dispatches the
   contribution's `ui.kind === 'action'` callback with the session context, so
   the row consumes its own trigger token and never blocks a draft that already
   carries an attachment.
2. The client posts to `screenshot/v6/capture?lang=<locale>` on the same origin
   (`document.baseURI`), with the `x-dsh-screenshot: 1` header.
3. The Host serialises the request (`busy` latch), creates a fresh
   `%TEMP%\dsh-screenshot-*` directory, copies `editor.cs` into it and writes
   `config.json` + `select.ps1`, then spawns PowerShell (`-STA`) and waits.
4. The script only declares per-monitor DPI awareness, captures
   `SystemInformation.VirtualScreen` into `full.png`, compiles `editor.cs` with
   `Add-Type`, and calls `[DshShot.Editor]::Run(full, x, y, w, h, out, selfTest)`.
5. `EditorForm` is one borderless, top-most window over the frozen frame and does
   both phases in place:
   - **pick** — `EnumWindows` + `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`
     finds the window under the cursor, frames it green and dims the rest; a
     left click takes that window, a drag draws its own rectangle and **updates
     it on every mouse move**, so the dim follows the drag live (plus the
     `W × H` badge);
   - **annotate** — the selection stays put, everything outside it is dimmed, a
     floating white toolbar (hand-drawn GDI+ icons) and an on-demand colour/size
     row appear; ops are re-editable (handles for rect/ellipse, endpoints for
     line/arrow, move/delete, undo + redo); `Compose()` renders the selection at
     native resolution.
6. On `insert|copy|save` the form saves/returns the composite; on cancel it
   reports `{ ok: false, cancelled: true }`. The script writes one JSON file,
   and the Host reads it after PowerShell exits.
7. The Host base64-encodes the PNG into a `data:image/png` URL and answers
   `{ ok: true, image, width, height }`; it copies the editor log to
   `%TEMP%\dsh-screenshot-editor.log`, appends one line to
   `%TEMP%\dsh-screenshot.log` and removes the work directory.
8. The client turns the data URL into a `File` named
   `screenshot-YYYYMMDD-HHMMSS.png` and hands it to the composer: through
   `inputActions.addFiles` when the shell projects it, otherwise through a
   synthetic `ClipboardEvent('paste')` carrying a `DataTransfer`, which the
   composer's document-level paste intake picks up exactly like a real Ctrl+V.

## Why the pixels come from the Host

The desktop page loads `dsh-app://app/` and its Electron session installs
`setPermissionRequestHandler(() => false)`,
`setDisplayMediaRequestHandler((_r, cb) => cb({}))` and blocks http(s)
subresources. A renderer-side `getDisplayMedia`, canvas capture or remote
screenshot service is therefore not available to a plugin. The Host process is
plain Node inside the desktop app, so it can shell out to PowerShell and use
GDI+ to read the screen.

## Guard rails

- `POST` only, `x-dsh-screenshot: 1` required, and the `Origin` header must be
  either `dsh-app://app` (the desktop protocol handler strips it, so it is also
  allowed when absent) or the Host's own origin.
- A second request while one selection is open answers `409 busy`
  (`a selection is already open`), which the client shows as a hint.
- `SELECT_TIMEOUT_MS` bounds a forgotten selector window.
- Cancelling is not an error: the client closes silently.
- `DSH_EDITOR_LOG`, `DSH_EDITOR_HINT`, `DSH_EDITOR_TOOL`, `DSH_EDITOR_SCRIPT`,
  `DSH_EDITOR_DIAG` and `DSH_EDITOR_PICKDRAG` exist for diagnosis: they log
  hover/finish events, override the hint line, preselect a tool, or render the
  window to a PNG instead of showing it.

## Gotchas worth keeping

- Inside a PowerShell `GetNewClosure()` scriptblock, `$script:` no longer
  resolves to the file's script scope; a closure once silently swallowed the
  first assignment and left the form open forever. Use plain scriptblocks and
  script-scope fields.
- PowerShell 5.1 reads a BOM-less script file as ANSI, so the generated script is
  written with a leading `U+FEFF`; `Set-Content -Encoding UTF8` emits a BOM in
  the JSON it writes, so the Host strips `^\uFEFF` before `JSON.parse`.
- PowerShell error text comes back in the console's ANSI code page, so the
  script sets `[Console]::OutputEncoding = UTF8` first; otherwise a Chinese
  Windows reports unreadable bytes.
- `$form.DoubleBuffered` has a protected setter and throws
  `PropertyAssignmentException`; set it through reflection on the non-public
  property instead.
- Under `Add-Type`, an unused private field is a compile error, and `void Layout()`
  / `Rectangle Resize(...)` hide inherited `Control` members — rename instead.
- Route registrations leak when the loader reloads a bundle
  (`webserver: duplicate exact route "…"`), so the route prefix is versioned
  (`/screenshot/v6`); bump it whenever Host code changes, or restart the app.
- Do not launch the helper through `explorer.exe`/`wscript`: those chains put
  the window on a desktop the user cannot see (the self test still passes,
  because it never needs a human to look at it).
