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
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['webServer']

const EDITOR_FILE = fileURLToPath(new URL('./editor.cs', import.meta.url))
const HEADER = 'x-dsh-screenshot'
const ROUTE_PREFIX = '/screenshot/v6'
const SELECT_TIMEOUT_MS = 600000
const LOG_PATH = join(tmpdir(), 'dsh-screenshot.log')

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
$result = [DshShot.Editor]::Run($FullPath, $px, $py, $pw, $ph, $OutPath, $selfTestEditor)

if ($result.Action -eq 'insert' -and (Test-Path $OutPath)) {
  $png = [System.IO.File]::ReadAllBytes($OutPath)
  $img = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream (,$png)))
  $w = $img.Width
  $h = $img.Height
  $img.Dispose()
  Write-Meta @{ ok = $true; action = 'insert'; width = $w; height = $h }
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
async function selectRegion(locale, selfTestRect, keep = false) {
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
async function capture(locale, selfTestRect, keep = false) {
  if (process.platform !== 'win32') {
    throw new Error(`screen capture is not implemented on ${process.platform} yet`)
  }
  return await selectRegion(locale, selfTestRect, keep)
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
/**
 * Register the capture routes.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  let busy = false

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
    busy = true
    const started = Date.now()
    try {
      const shot = await capture(locale, selfTest, keep)
      journal(`capture ok ${String(shot.width)}x${String(shot.height)} in ${String(Date.now() - started)}ms`)
      sendJson(response, 200, { ok: true, ...shot })
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
