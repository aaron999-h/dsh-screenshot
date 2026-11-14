# dsh-screenshot — implementation detail

## Shape of the bundle

```
dsh-screenshot/
  package.json        dsh.bundle.patch + dsh.client (web, immediately)
  cordis.patch.yml    inserts the loader entry `dsh-screenshot`
  index.js            Host half: the HTTP routes and the capture script
  client.js           Client half: the menu row and the failure card
  locale/{en,zh}.json marketplace metadata
  assets/icon.svg     icon (also shipped as a 180 px PNG in the release)
  docs/DETAIL.md      this file
```

## Flow of one capture

1. The user picks **截图提问** in the `+` menu. `CommandUi` dispatches the
   contribution's `ui.kind === 'action'` callback with the session context, so
   the row consumes its own trigger token and never blocks a draft that already
   carries an attachment.
2. The client posts to `screenshot/capture?lang=<locale>` on the same origin
   (`document.baseURI`), with the `x-dsh-screenshot: 1` header.
3. The Host serialises the request (`busy` latch), writes a PowerShell script
   into a fresh `%TEMP%\dsh-screenshot-*` directory and runs it.
4. The script declares per-monitor DPI awareness, captures
   `SystemInformation.VirtualScreen` into an ARGB bitmap, then opens a
   borderless, top-most, `ShowInTaskbar = $false` WinForms window whose bounds
   equal the virtual screen and whose `Paint` handler draws the frozen bitmap
   scaled into the client area plus the dimming around the current drag
   rectangle. DSH keeps running underneath, untouched.
5. Left drag selects; right click or Esc cancels. When the form closes, the
   script maps the client rectangle back to bitmap pixels, clamps it, clones
   the crop and saves it as PNG, then prints one JSON line
   (`{ ok, left, top, width, height }`) or, on cancel, `{ ok: false, cancelled: true }`.
6. The Host base64-encodes the PNG into a `data:image/png` URL and answers
   `{ ok: true, image, width, height }`; it deletes the temporary directory and
   appends one line to `%TEMP%\dsh-screenshot.log`.
7. The client turns the data URL into a `File` named
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
- A second request while one selection is open answers `409 busy`.
- `SELECT_TIMEOUT_MS = 300000` bounds a forgotten selector window.
- Cancelling is not an error: the client closes silently.

## Gotchas worth keeping

- Inside a PowerShell `GetNewClosure()` scriptblock, `$script:` no longer
  resolves to the file's script scope; the timer handler therefore uses plain
  scriptblocks and script-scope variables (a closure here silently swallowed the
  first assignment, which left the self-test form open forever).
- PowerShell 5.1 reads a BOM-less script file as ANSI, so the generated script is
  written with a leading `U+FEFF`; `Set-Content -Encoding UTF8` emits a BOM in
  the JSON it writes, so the Host strips `^\uFEFF` before `JSON.parse`.
- PowerShell error text comes back in the console's ANSI code page, so the
  script sets `[Console]::OutputEncoding = UTF8` first; otherwise a Chinese
  Windows reports unreadable bytes.
- `$form.DoubleBuffered` has a protected setter and throws
  `PropertyAssignmentException`; set it through reflection on the non-public
  property instead.
