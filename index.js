/**
 * Screenshot-to-draft plugin, Host half.
 *
 * The page runs in the Electron renderer, whose session denies display media
 * and blocks http(s) subresources, so the pixels and the desktop-wide selection
 * both have to come from the Host process. The Host freezes the whole virtual
 * screen into a bitmap, shows that bitmap in a borderless top-most window that
 * covers every monitor, and lets the user drag a rectangle there — the same
 * shape a native snipping tool uses, with the DSH window left visible and
 * unminimized underneath.
 *
 * After the rectangle is released the crop opens in a small annotation window
 * (rectangle, ellipse, arrow, pen, mosaic, text) where the result can be
 * inserted into the conversation, copied to the clipboard, or saved as a file.
 *
 * Routes (relative to the page origin, which works both on the desktop
 * `dsh-app://app/` scheme and on `dsh web`):
 *   GET  /screenshot/status   → capability probe
 *   POST /screenshot/capture  → select + annotate, return the result as PNG base64
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['webServer']

const EDITOR_FILE = fileURLToPath(new URL('./editor.cs', import.meta.url))
const HEADER = 'x-dsh-screenshot'
const ROUTE_PREFIX = '/screenshot/v7'
const SELECT_TIMEOUT_MS = 600000
const LOG_PATH = join(tmpdir(), 'dsh-screenshot.log')

/**
 * Global hotkey (Alt+A) support.
 *
 * A Desktop plugin lives in the Host child process and cannot ask Electron for
 * `globalShortcut`, so the shortcut is registered with Win32 `RegisterHotKey`
 * from a tiny .NET helper the Host compiles once and keeps alive. The helper is
 * outside the renderer, so it also fires while the window is minimized or
 * behind another application — exactly where an in-app key binding is dead.
 * A press only touches a signal file; the Host notices it, runs the same
 * capture pipeline, and parks the PNG for the page to claim.
 */
const HOTKEY_MODIFIERS = 1 // MOD_ALT
const HOTKEY_KEY = 0x41 // VK_A
const HOTKEY_SIGNAL = join(tmpdir(), 'dsh-screenshot-hotkey.signal')
const HOTKEY_SOURCE_FILE = join(tmpdir(), 'dsh-screenshot-hotkey.cs')
const HOTKEY_SCRIPT_FILE = join(tmpdir(), 'dsh-screenshot-hotkey.ps1')

const HOTKEY_SOURCE = `using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class DshHotkey
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);

    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out MSG message, IntPtr window, uint filterMin, uint filterMax, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
        public uint lPrivate;
    }

    public static int Run(string signal, int modifiers, int key)
    {
        string error = signal + ".error";
        try { File.Delete(error); } catch { }
        if (!RegisterHotKey(IntPtr.Zero, 1, (uint)modifiers, (uint)key))
        {
            try { File.WriteAllText(error, "register-failed " + Marshal.GetLastWin32Error().ToString()); } catch { }
            return 3;
        }
        for (;;)
        {
            MSG message;
            while (PeekMessage(out message, IntPtr.Zero, 0, 0, 1))
            {
                if (message.message == 0x0312)
                {
                    try { File.WriteAllText(signal, DateTime.Now.ToString("o")); } catch { }
                }
            }
            Thread.Sleep(25);
        }
    }
}
`

const HOTKEY_WRAPPER = `param([string]$Signal, [string]$Source, [int]$Modifiers, [int]$Key)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ([System.IO.File]::ReadAllText($Source)) -Language CSharp
[DshHotkey]::Run($Signal, $Modifiers, $Key) | Out-Null
`

/** Result parked for the page: a capture finished while the window was away. */
let pendingShot
/** Locale of the last page request, reused for a hotkey capture's hint text. */
let lastLocale

/** Selector hints per locale; the selection window is drawn by PowerShell. */
const HINTS = {
  zh: '单击窗口即可选中 · 拖动框选区域 · 右键或 Esc 取消',
  en: 'Click a window to select it · Drag to pick a region · Right-click or Esc cancels',
}

/**
 * Append one diagnostic line. Best effort: a failed write never breaks a shot.
 * @param message - text to record.
 */
function journal(message) {
  appendFile(LOG_PATH, `${new Date().toISOString()} ${message}\n`, 'utf8').catch(() => {})
}

/** Whether this Host is the desktop app rather than a plain `dsh web` server. */
function desktopHost() {
  return typeof process.send === 'function' && typeof process.execPath === 'string'
}

/** Hint copy for one locale id. */
function hintFor(locale) {
  return locale.toLowerCase().startsWith('zh') ? HINTS.zh : HINTS.en
}

/**
 * Compile-time text for the annotation window (C# 5, compiled by Add-Type).
 *
 * Kept as a plain source file next to the selector script so the compiler gets
 * a real file path instead of a here-string, which PowerShell would otherwise
 * have to quote for us.
 */
/**
 * Build the PowerShell selector script.
 *
 * The script grabs the virtual screen, paints it into a borderless top-most
 * form, dims everything outside the dragged rectangle, crops that rectangle
 * from the frozen bitmap, and then hands the crop to the annotation window.
 *
 * @returns script text.
 */
function selectorScript() {
  return String.raw`param([string]$ConfigPath)

$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$OutPath = [string]$config.out
$MetaPath = [string]$config.meta
$FullPath = [string]$config.full
$EditorPath = [string]$config.editor
$SelfTestRect = [string]$config.selfTest
$Scroll = [bool]$config.scroll
$Lang = [string]$config.lang
$StartedPath = [string]$config.started
$EditorLog = [string]$config.log
$Hint = [string]$config.hint

function Write-Meta($Value) {
  $Value | ConvertTo-Json -Compress | Set-Content -LiteralPath $MetaPath -Encoding UTF8
}

if ($StartedPath -ne '') { 'started' | Set-Content -LiteralPath $StartedPath -Encoding utf8 }

trap {
  $detail = $_.Exception.Message
  try { $detail = $detail + ' @line ' + $_.InvocationInfo.ScriptLineNumber } catch { }
  try { Write-Meta @{ ok = $false; cancelled = $false; error = $detail } } catch { }
  exit 1
}

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
try { [void][DshDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) }
catch { try { [void][DshDpi]::SetProcessDPIAware() } catch { } }

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$grab = [System.Drawing.Graphics]::FromImage($bmp)
$grab.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size, ([System.Drawing.CopyPixelOperation]::SourceCopy))
$grab.Dispose()
$bmp.Save($FullPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$px = 0; $py = 0; $pw = 0; $ph = 0
if ($SelfTestRect -ne '') {
  $parts = $SelfTestRect -split ','
  $px = [int]$parts[0]; $py = [int]$parts[1]; $pw = [int]$parts[2]; $ph = [int]$parts[3]
}

Add-Type -Path $EditorPath -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing'
$selfTestEditor = ($SelfTestRect -ne '')
if ($EditorLog -ne '') { $env:DSH_EDITOR_LOG = $EditorLog }
if ($Hint -ne '') { $env:DSH_EDITOR_HINT = $Hint }
try { Add-Content -LiteralPath $EditorLog -Value ('ps: editor.cs ' + (Get-Item -LiteralPath $EditorPath).Length + ' bytes, sel=' + $SelfTestRect) } catch { }
$result = [DshShot.Editor]::Run($FullPath, $px, $py, $pw, $ph, $OutPath, $selfTestEditor, $Scroll, $Lang)

if (($result.Action -eq 'insert' -or $result.Action -eq 'scroll') -and (Test-Path $OutPath)) {
  $png = [System.IO.File]::ReadAllBytes($OutPath)
  $img = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream (,$png)))
  $w = $img.Width
  $h = $img.Height
  $img.Dispose()
  Write-Meta @{ ok = $true; action = $result.Action; width = $w; height = $h }
} else {
  Write-Meta @{ ok = $false; cancelled = $true; action = $result.Action }
}
exit 0`
}

/** Wait for a moment. */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Run one helper process to completion.
 * @param command - executable.
 * @param args - argument list.
 * @param timeoutMs - kill the helper after this long.
 * @returns stdout, stderr and exit code.
 */
function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('the selector was closed after a timeout'))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }) })
  })
}

/**
 * Let the user select a region on the desktop, annotate it, and return the crop.
 * @param locale - client locale id, for window copy.
 * @param selfTestRect - optional "x,y,w,h" that skips the interaction.
 * @returns image data URL plus pixel size.
 */
async function selectRegion(locale, selfTestRect, keep = false, scroll = false) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-screenshot-'))
  const scriptPath = join(dir, 'select.ps1')
  const editorPath = join(dir, 'editor.cs')
  const cropPath = join(dir, 'crop.png')
  const fullPath = join(dir, 'full.png')
  const imagePath = join(dir, 'annotated.png')
  const metaPath = join(dir, 'region.json')
  const configPath = join(dir, 'config.json')
  const startedPath = join(dir, 'started.txt')
  const editorLogPath = join(dir, 'editor.log')
  try {
    await copyFile(EDITOR_FILE, editorPath)
    await writeFile(scriptPath, `\uFEFF${selectorScript()}`, 'utf8')
    await writeFile(configPath, JSON.stringify({
      out: imagePath,
      meta: metaPath,
      crop: cropPath,
      full: fullPath,
      editor: editorPath,
      hint: hintFor(locale),
      lang: locale.toLowerCase().startsWith('zh') ? 'zh' : 'en',
      scroll,
      selfTest: selfTestRect ?? '',
      started: startedPath,
      log: editorLogPath,
    }), 'utf8')

    // Spawn the helper directly and wait for it: this is the chain the window
    // has been verified with. Launching it through explorer/wscript instead can
    // put the windows on a hidden desktop, where the user sees nothing.
    journal('helper start')
    const result = await run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, '-ConfigPath', configPath,
    ], SELECT_TIMEOUT_MS)
    if (!existsSync(startedPath)) journal('helper exited without writing its start marker')
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || '').trim()
      journal(`helper exit=${String(result.code)} detail=${detail.slice(0, 400)}`)
      throw new Error(detail === '' ? `the screenshot helper exited with code ${String(result.code)}` : detail)
    }

    let meta
    try {
      const raw = (await readFile(metaPath, 'utf8')).replace(/^\uFEFF/u, '').trim()
      meta = JSON.parse(raw)
    } catch {
      throw new Error('the selector closed without reporting a region')
    }
    if (meta.error !== undefined) throw new Error(String(meta.error))
    if (meta.ok !== true) throw new Error('cancelled')
    const png = await readFile(imagePath)
    return {
      image: `data:image/png;base64,${png.toString('base64')}`,
      width: meta.width,
      height: meta.height,
    }
  } finally {
    try {
      if (existsSync(editorLogPath)) {
        await copyFile(editorLogPath, join(tmpdir(), 'dsh-screenshot-editor.log'))
      }
    } catch {
      // diagnostics only
    }
    if (keep) journal(`work dir kept at ${dir}`)
    else rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Platform entry: Windows today, a clear refusal elsewhere. */
async function capture(locale, selfTestRect, keep = false, scroll = false) {
  if (process.platform !== 'win32') {
    throw new Error(`screen capture is not implemented on ${process.platform} yet`)
  }
  return await selectRegion(locale, selfTestRect, keep, scroll)
}

/** Write one JSON response. */
function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/**
 * Gate a mutating request: POST only, this plugin's header only, same origin.
 *
 * The desktop shell relays page requests through its own protocol handler,
 * which strips `Origin`, so an absent origin is what the app itself looks
 * like here. A browser-initiated cross-origin POST always carries an origin
 * and is still refused, and the custom header keeps a simple form post out.
 *
 * @returns an error message, or undefined when the request may proceed.
 */
function rejection(context, request) {
  if (request.method !== 'POST') return 'POST required'
  if (request.headers[HEADER] !== '1') return `missing ${HEADER} header`
  const origin = request.headers.origin
  if (origin === undefined) return undefined
  if (origin === 'dsh-app://app') return undefined
  if (origin === context.webServer.getOrigin()) return undefined
  return 'unexpected origin'
}

/**
 * Gate a read: this plugin's header plus the same origin rules, without the
 * POST restriction, so the page can poll for a hotkey result.
 * @returns an error message, or undefined when the request may proceed.
 */
function readGuard(context, request) {
  if (request.headers[HEADER] !== '1') return `missing ${HEADER} header`
  const origin = request.headers.origin
  if (origin === undefined) return undefined
  if (origin === 'dsh-app://app') return undefined
  if (origin === context.webServer.getOrigin()) return undefined
  return 'unexpected origin'
}

/**
 * Register one exact route, tolerating a route table that already owns it.
 *
 * The loader can instantiate a bundle entry twice while a plugin is being
 * re-enabled, and the web server refuses a second registration for the same
 * path. The first owner already serves the identical handler, so a duplicate
 * is skipped instead of failing the whole activation.
 *
 * @param context - Host plugin context.
 * @param path - absolute route path.
 * @param handler - request handler.
 * @param label - effect label for diagnostics.
 */
function registerRoute(context, path, handler, label) {
  context.effect(() => {
    try {
      return context.webServer.register({ kind: 'exact', path, handler })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      journal(`route ${path} already registered: ${message}`)
      return () => {}
    }
  }, label)
}
const RAISE_SCRIPT_FILE = join(tmpdir(), 'dsh-screenshot-raise.ps1')

const RAISE_WRAPPER = `param([string]$ProcessName)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshRaise {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  // Windows only lets the foreground process take the foreground, so a
  // background helper has to (a) bounce itself into the z-order with a
  // TOPMOST/NOTOPMOST pass and (b) unlock the foreground lock with a synthetic
  // ALT tap, which is the documented workaround for SetForegroundWindow.
  public static void Raise(IntPtr window) {
    ShowWindow(window, 9);                       // SW_RESTORE: also un-minimizes
    SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
    SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
    BringWindowToTop(window);
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(window);
  }
}
'@
$process = Get-Process -Name $ProcessName | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($process -ne $null) {
  [void][DshRaise]::Raise($process.MainWindowHandle)
}
`

/**
 * Bring the Desktop window back to the front after a hotkey capture.
 *
 * The user asked for a shortcut that works while the app is minimized or
 * behind something else; once the pixels are in hand the composer has to be
 * visible to receive them, so the window is restored and raised again.
 * `AppActivate` alone leaves a minimized window minimized, hence ShowWindow.
 */
function activateApp() {
  if (!desktopHost()) return
  const name = basename(process.execPath, extname(process.execPath))
  spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', RAISE_SCRIPT_FILE, '-ProcessName', name,
  ], { windowsHide: true, stdio: 'ignore' })
}

/**
 * Keep a global Alt+A listener alive and hand each press to `onPress`.
 *
 * The helper is compiled once from {@link HOTKEY_SOURCE}; the signal file is
 * written by the helper and polled here, which avoids any HTTP round trip from
 * a process that has no business knowing the page token.
 *
 * @param onPress - called once per physical press.
 * @returns disposer stopping the helper and the poll.
 */
async function startHotkey(onPress) {
  if (process.platform !== 'win32' || !desktopHost()) return () => {}
  await writeFile(HOTKEY_SOURCE_FILE, HOTKEY_SOURCE, 'utf8')
  await writeFile(HOTKEY_SCRIPT_FILE, HOTKEY_WRAPPER, 'utf8')
  await writeFile(RAISE_SCRIPT_FILE, RAISE_WRAPPER, 'utf8')
  await rm(HOTKEY_SIGNAL, { force: true }).catch(() => {})
  await rm(`${HOTKEY_SIGNAL}.error`, { force: true }).catch(() => {})
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOTKEY_SCRIPT_FILE,
    '-Signal', HOTKEY_SIGNAL, '-Source', HOTKEY_SOURCE_FILE,
    '-Modifiers', String(HOTKEY_MODIFIERS), '-Key', String(HOTKEY_KEY),
  ], { windowsHide: true, stdio: 'ignore' })
  journal(`hotkey helper pid=${String(child.pid ?? 0)}`)
  child.on('exit', (code) => { journal(`hotkey helper exited code=${String(code)}`) })
  child.on('error', (error) => { journal(`hotkey helper error=${error instanceof Error ? error.message : String(error)}`) })

  let lastSignal
  const timer = setInterval(() => {
    readFile(HOTKEY_SIGNAL, 'utf8')
      .then((text) => {
        const stamp = text.trim()
        if (stamp === '' || stamp === lastSignal) return
        lastSignal = stamp
        onPress()
      })
      .catch(() => {})
    readFile(`${HOTKEY_SIGNAL}.error`, 'utf8')
      .then((text) => { journal(`hotkey unavailable: ${text.trim()}`) })
      .catch(() => {})
  }, 300)

  return () => {
    clearInterval(timer)
    try { child.kill() } catch { /* already gone */ }
  }
}

/**
 * Register the capture routes.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  let busy = false

  /** Capture started by the global hotkey: park the PNG for the page. */
  async function hotkeyCapture(selfTestRect) {
    if (busy) {
      journal('hotkey ignored: a selection is already open')
      return
    }
    busy = true
    const started = Date.now()
    try {
      const shot = await capture(lastLocale ?? 'zh', selfTestRect)
      pendingShot = { image: shot.image, width: shot.width, height: shot.height, at: Date.now() }
      journal(`hotkey capture ok ${String(shot.width)}x${String(shot.height)} in ${String(Date.now() - started)}ms`)
      activateApp()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      journal(`hotkey capture failed after ${String(Date.now() - started)}ms: ${message}`)
    } finally {
      busy = false
    }
  }

  ctx.effect(() => {
    let dispose = () => {}
    let stopped = false
    startHotkey(() => { void hotkeyCapture() })
      .then((off) => { if (stopped) off(); else dispose = off })
      .catch((error) => {
        journal(`hotkey start failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    return () => { stopped = true; dispose() }
  }, 'dsh-screenshot: global hotkey')

  registerRoute(ctx, ROUTE_PREFIX + '/status', (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    sendJson(response, 200, {
      desktop: desktopHost(),
      supported: process.platform === 'win32',
      platform: process.platform,
      busy,
      selfTest: url.searchParams.get('selftest') === '1',
    })
  }, 'dsh-screenshot: status route')

  registerRoute(ctx, ROUTE_PREFIX + '/pending', (request, response) => {
    const refused = readGuard(ctx, request)
    if (refused !== undefined) {
      sendJson(response, 403, { ok: false, error: refused })
      return
    }
    sendJson(response, 200, {
      ok: true,
      pending: pendingShot !== undefined,
      ...(pendingShot === undefined ? {} : {
        image: pendingShot.image, width: pendingShot.width, height: pendingShot.height, at: pendingShot.at,
      }),
    })
  }, 'dsh-screenshot: pending route')

  registerRoute(ctx, ROUTE_PREFIX + '/pending/ack', (request, response) => {
    const refused = rejection(ctx, request)
    if (refused !== undefined) {
      sendJson(response, 403, { ok: false, error: refused })
      return
    }
    pendingShot = undefined
    journal('pending shot claimed')
    sendJson(response, 200, { ok: true })
  }, 'dsh-screenshot: pending ack route')

  registerRoute(ctx, ROUTE_PREFIX + '/hotkey', async (request, response) => {
    const refused = rejection(ctx, request)
    if (refused !== undefined) {
      sendJson(response, 403, { ok: false, error: refused })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    await hotkeyCapture(url.searchParams.get('selftest') === '1' ? '120,160,600,360' : undefined)
    sendJson(response, 200, { ok: true, pending: pendingShot !== undefined })
  }, 'dsh-screenshot: hotkey route')

  registerRoute(ctx, ROUTE_PREFIX + '/capture', async (request, response) => {
    const refused = rejection(ctx, request)
    if (refused !== undefined) {
      journal(`capture refused: ${refused}`)
      sendJson(response, 403, { ok: false, error: refused })
      return
    }
    if (busy) {
      journal('capture refused: a selection is already open')
      sendJson(response, 409, { ok: false, error: 'a selection is already open' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const locale = url.searchParams.get('lang') ?? 'en'
    const selfTest = url.searchParams.get('selftest') === '1' ? '120,160,600,360' : ''
    const keep = url.searchParams.get('keep') === '1'
    const scroll = url.searchParams.get('mode') === 'scroll'
    busy = true
    const started = Date.now()
    try {
      const shot = await capture(locale, selfTest, keep, scroll)
      const mode = shot.action === 'scroll' ? 'scroll' : (scroll ? 'scroll' : 'plain')
      journal(`${mode === 'scroll' ? 'scroll' : 'capture'} ok ${String(shot.width)}x${String(shot.height)} in ${String(Date.now() - started)}ms`)
      sendJson(response, 200, { ok: true, mode, ...shot })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      journal(`capture failed after ${String(Date.now() - started)}ms: ${message}`)
      sendJson(response, message === 'cancelled' ? 409 : 500, {
        ok: false,
        cancelled: message === 'cancelled',
        error: message,
      })
    } finally {
      busy = false
    }
  }, 'dsh-screenshot: capture route')
}
