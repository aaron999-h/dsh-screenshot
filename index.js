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
 * Routes (relative to the page origin, which works both on the desktop
 * `dsh-app://app/` scheme and on `dsh web`):
 *   GET  /screenshot/status   → capability probe
 *   POST /screenshot/capture  → select a region on the desktop, return that
 *                               crop as PNG base64
 */
import { spawn } from 'node:child_process'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const inject = ['webServer']

const HEADER = 'x-dsh-screenshot'
const SELECT_TIMEOUT_MS = 300000
const LOG_PATH = join(tmpdir(), 'dsh-screenshot.log')

/** Cropped-output hints per locale; the selector window is drawn by PowerShell. */
const HINTS = {
  zh: '拖动鼠标框选区域 · 右键或 Esc 取消',
  en: 'Drag to select a region · Right-click or Esc cancels',
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
 * Build the PowerShell selector script.
 *
 * The script grabs the virtual screen, paints it into a borderless top-most
 * form, dims everything outside the dragged rectangle, and crops the frozen
 * bitmap afterwards, so the saved pixels come from the screen as it was before
 * the selector appeared.
 *
 * @param hint - instruction line drawn while idle.
 * @returns script text.
 */
function selectorScript(hint) {
  return String.raw`param([string]$OutPath, [string]$MetaPath, [string]$Hint, [string]$SelfTestRect)

$ErrorActionPreference = 'Stop'
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
$script:bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$grab = [System.Drawing.Graphics]::FromImage($script:bmp)
$grab.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $script:bmp.Size, ([System.Drawing.CopyPixelOperation]::SourceCopy))
$grab.Dispose()

$script:state = @{ dragging = $false; x0 = 0; y0 = 0; x1 = 0; y1 = 0; cancelled = $false; done = $false }
$script:dim = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 0, 0, 0))
$script:edge = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 77, 107, 254)), 2
$script:label = New-Object System.Drawing.Font 'Microsoft YaHei UI', 13
$script:labelBg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(220, 20, 22, 28))
$script:labelFg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Bounds = $bounds
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::Black
$form.Cursor = [System.Windows.Forms.Cursors]::Cross
try {
  $flags = [System.Reflection.BindingFlags]'Instance,NonPublic'
  $prop = $form.GetType().GetProperty('DoubleBuffered', $flags)
  if ($prop -ne $null) { $prop.SetValue($form, $true, $null) }
} catch { }
$form.KeyPreview = $true

$form.Add_Paint({
  param($sender, $e)
  $size = $sender.ClientSize
  $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $e.Graphics.DrawImage($script:bmp, (New-Object System.Drawing.Rectangle 0, 0, $size.Width, $size.Height))
  $state = $script:state
  $left = [math]::Min($state.x0, $state.x1)
  $top = [math]::Min($state.y0, $state.y1)
  $width = [math]::Abs($state.x1 - $state.x0)
  $height = [math]::Abs($state.y1 - $state.y0)
  if ($width -ge 2 -and $height -ge 2) {
    $e.Graphics.FillRectangle($script:dim, 0, 0, $size.Width, [int]$top)
    $e.Graphics.FillRectangle($script:dim, 0, [int]($top + $height), $size.Width, [int]($size.Height - $top - $height))
    $e.Graphics.FillRectangle($script:dim, 0, [int]$top, [int]$left, [int]$height)
    $e.Graphics.FillRectangle($script:dim, [int]($left + $width), [int]$top, [int]($size.Width - $left - $width), [int]$height)
    $e.Graphics.DrawRectangle($script:edge, [int]$left, [int]$top, [int]$width, [int]$height)
    $sx = $script:bmp.Width / [double]$size.Width
    $sy = $script:bmp.Height / [double]$size.Height
    $text = '{0} x {1}' -f [int][math]::Round($width * $sx), [int][math]::Round($height * $sy)
    $textSize = $e.Graphics.MeasureString($text, $script:label)
    $tx = [math]::Max(6, [math]::Min($left, $size.Width - $textSize.Width - 12))
    $ty = [math]::Max(6, $top - $textSize.Height - 8)
    $e.Graphics.FillRectangle($script:labelBg, $tx, $ty, $textSize.Width + 10, $textSize.Height + 4)
    $e.Graphics.DrawString($text, $script:label, $script:labelFg, $tx + 5, $ty + 2)
  } else {
    $textSize = $e.Graphics.MeasureString($Hint, $script:label)
    $tx = ($size.Width - $textSize.Width) / 2
    $ty = ($size.Height - $textSize.Height) / 2
    $e.Graphics.FillRectangle($script:labelBg, $tx - 12, $ty - 8, $textSize.Width + 24, $textSize.Height + 16)
    $e.Graphics.DrawString($Hint, $script:label, $script:labelFg, $tx, $ty)
  }
})

$form.Add_MouseDown({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
    $script:state.cancelled = $true
    $sender.Close()
    return
  }
  if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  $script:state.dragging = $true
  $script:state.x0 = $e.X
  $script:state.y0 = $e.Y
  $script:state.x1 = $e.X
  $script:state.y1 = $e.Y
  [void]$sender.Invalidate()
})

$form.Add_MouseMove({
  param($sender, $e)
  if (-not $script:state.dragging) { return }
  $script:state.x1 = $e.X
  $script:state.y1 = $e.Y
  [void]$sender.Invalidate()
})

$form.Add_MouseUp({
  param($sender, $e)
  if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  if (-not $script:state.dragging) { return }
  $script:state.dragging = $false
  $script:state.done = $true
  $sender.Close()
})

$form.Add_KeyDown({
  param($sender, $e)
  if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
    $script:state.cancelled = $true
    $sender.Close()
  }
})

$script:selfTest = $null
if ($SelfTestRect -ne '') {
  $parts = $SelfTestRect -split ','
  $script:selfTest = @{ x = [double]$parts[0]; y = [double]$parts[1]; w = [double]$parts[2]; h = [double]$parts[3] }
}

$selfTestTimer = New-Object System.Windows.Forms.Timer
$selfTestTimer.Interval = 700
$selfTestTimer.add_Tick({
  $self = $script:selfTest
  if ($null -ne $self) {
    $size = $form.ClientSize
    $sx = $size.Width / [double]$script:bmp.Width
    $sy = $size.Height / [double]$script:bmp.Height
    $script:state.dragging = $true
    $script:state.x0 = [int]($self.x * $sx)
    $script:state.y0 = [int]($self.y * $sy)
    $script:state.x1 = [int](($self.x + $self.w) * $sx)
    $script:state.y1 = [int](($self.y + $self.h) * $sy)
    $script:state.dragging = $false
    $script:state.done = $true
  }
  $selfTestTimer.Stop()
  $form.Close()
})

$form.Add_Shown({
  if ($null -ne $script:selfTest) {
    $selfTestTimer.Start()
    return
  }
  $form.Activate()
})

[void]$form.Show()
[System.Windows.Forms.Application]::Run($form)

$clientWidth = [int]$form.ClientSize.Width
$clientHeight = [int]$form.ClientSize.Height
$form.Dispose()

$state = $script:state
$left = [math]::Min($state.x0, $state.x1)
$top = [math]::Min($state.y0, $state.y1)
$width = [math]::Abs($state.x1 - $state.x0)
$height = [math]::Abs($state.y1 - $state.y0)
if ($state.cancelled -or $width -lt 2 -or $height -lt 2 -or $clientWidth -le 0 -or $clientHeight -le 0) {
  @{ ok = $false; cancelled = $true } | ConvertTo-Json -Compress | Set-Content -Path $MetaPath -Encoding UTF8
  exit 0
}

$sx = $script:bmp.Width / [double]$clientWidth
$sy = $script:bmp.Height / [double]$clientHeight
$px = [int][math]::Round($left * $sx)
$py = [int][math]::Round($top * $sy)
$pw = [int][math]::Round($width * $sx)
$ph = [int][math]::Round($height * $sy)
$px = [math]::Max(0, [math]::Min($px, $script:bmp.Width - 2))
$py = [math]::Max(0, [math]::Min($py, $script:bmp.Height - 2))
$pw = [math]::Max(1, [math]::Min($pw, $script:bmp.Width - $px))
$ph = [math]::Max(1, [math]::Min($ph, $script:bmp.Height - $py))

$rect = New-Object System.Drawing.Rectangle $px, $py, $pw, $ph
$crop = $script:bmp.Clone($rect, $script:bmp.PixelFormat)
$crop.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$crop.Dispose()
$script:bmp.Dispose()
@{ ok = $true; width = $pw; height = $ph } | ConvertTo-Json -Compress | Set-Content -Path $MetaPath -Encoding UTF8
`
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
 * Let the user select a region on the desktop and return that crop.
 * @param locale - client locale id, for the instruction line.
 * @param selfTestRect - optional "x,y,w,h" that skips the interaction.
 * @returns image data URL plus pixel size.
 */
async function selectRegion(locale, selfTestRect) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-screenshot-'))
  const scriptPath = join(dir, 'select.ps1')
  const imagePath = join(dir, 'region.png')
  const metaPath = join(dir, 'region.json')
  try {
    await writeFile(scriptPath, `\uFEFF${selectorScript(hintFor(locale))}`, 'utf8')
    const result = await run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-OutPath', imagePath,
      '-MetaPath', metaPath,
      '-Hint', hintFor(locale),
      '-SelfTestRect', selfTestRect ?? '',
    ], SELECT_TIMEOUT_MS)
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || '').trim()
      journal(`selector exit=${String(result.code)} stderr=${detail.slice(0, 400)}`)
      throw new Error(detail === '' ? `the selector failed with exit code ${String(result.code)}` : detail)
    }
    let meta
    try {
      const raw = (await readFile(metaPath, 'utf8')).replace(/^\uFEFF/u, '').trim()
      meta = JSON.parse(raw)
    } catch {
      throw new Error('the selector closed without reporting a region')
    }
    if (meta.ok !== true) throw new Error('cancelled')
    const png = await readFile(imagePath)
    return {
      image: `data:image/png;base64,${png.toString('base64')}`,
      width: meta.width,
      height: meta.height,
    }
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Platform entry: Windows today, a clear refusal elsewhere. */
async function capture(locale, selfTestRect) {
  if (process.platform !== 'win32') {
    throw new Error(`screen capture is not implemented on ${process.platform} yet`)
  }
  return await selectRegion(locale, selfTestRect)
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
 * Register the capture routes.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  let busy = false

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/screenshot/status',
    handler: (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      sendJson(response, 200, {
        desktop: desktopHost(),
        supported: process.platform === 'win32',
        platform: process.platform,
        busy,
        selfTest: url.searchParams.get('selftest') === '1',
      })
    },
  }), 'dsh-screenshot: status route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/screenshot/capture',
    handler: async (request, response) => {
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
      busy = true
      const started = Date.now()
      try {
        const shot = await capture(locale, selfTest)
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
    },
  }), 'dsh-screenshot: capture route')
}
