# dsh-screencap - full-screen capture helper.
#
# This file is deliberately PURE ASCII so it parses identically no matter which
# code page Windows PowerShell 5.1 picks when no BOM is present. Keep it that
# way: a stray non-ASCII character in a comment can desynchronise GBK decoding
# and break the script.
#
# Invoked by the host plugin as:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File capture.ps1 `
#     -OutDir <dir> -MaxWidth <n> -Quality <n> -IdleSeconds <n>
#
# Prints the absolute path of the written JPEG on stdout (nothing else).
# Prints "SKIP_IDLE" on stdout and exits 0 when the desktop is in use.
param(
    [Parameter(Mandatory = $true)][string]$OutDir,
    [int]$MaxWidth = 1600,
    [int]$Quality = 80,
    # Skip the shot when the last user input is more recent than this many
    # seconds. 0 disables the check entirely.
    [int]$IdleSeconds = 0
)

$ErrorActionPreference = 'Stop'

# -- DPI awareness ------------------------------------------------------------
# This MUST run before any screen metric is queried, otherwise Windows lies to a
# DPI-unaware process. On a 2560x1600 panel at 125% scaling it reports a
# 2048x1280 virtual screen, and CopyFromScreen then captures only the top-left
# corner of the real desktop: everything right of that - including the taskbar
# clock - is silently lost. Opting into per-monitor-v2 awareness (falling back
# to system DPI awareness on older builds) makes the reported metrics, the grab
# rectangle and the physical pixels agree again.
if (-not ('DshScreencap.Dpi' -as [type])) {
    Add-Type -Namespace DshScreencap -Name Dpi -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
private static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);
[System.Runtime.InteropServices.DllImport("user32.dll")]
private static extern bool SetProcessDPIAware();
public static string Enable() {
    // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == -4 (Windows 10 1703+).
    // The entry point only resolves on first call, so on an older build the
    // exception surfaces here and the system-DPI fallback below takes over.
    try {
        if (SetProcessDpiAwarenessContext(new System.IntPtr(-4))) return "per-monitor-v2";
    } catch { }
    try {
        if (SetProcessDPIAware()) return "system";
    } catch { }
    return "none";
}
'@
}
try { $null = [DshScreencap.Dpi]::Enable() } catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# -- idle probe (GetLastInputInfo) --------------------------------------------
# Only compiled when needed: Add-Type costs ~0.3s and the plugin default has
# the check off.
if ($IdleSeconds -gt 0) {
    try {
        if (-not ('DshScreencap.IdleProbe' -as [type])) {
            Add-Type -Namespace DshScreencap -Name IdleProbe -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
private struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
}
[System.Runtime.InteropServices.DllImport("user32.dll")]
private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
public static uint IdleMilliseconds() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return 0;
    // Unsigned subtraction on purpose: it stays correct across the
    // 32-bit TickCount wrap (about 49.7 days).
    return (uint)System.Environment.TickCount - info.dwTime;
}
'@
        }
        $idleMs = [DshScreencap.IdleProbe]::IdleMilliseconds()
        if ($idleMs -lt ($IdleSeconds * 1000)) {
            Write-Output 'SKIP_IDLE'
            exit 0
        }
    } catch {
        # The probe is a nicety, never a reason to lose a capture: on failure
        # fall through and take the shot.
        Write-Warning "idle probe unavailable: $($_.Exception.Message)"
    }
}

if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

# -- grab every monitor as one virtual screen ---------------------------------
# VirtualScreen is now expressed in physical pixels because of the DPI opt-in
# above, so the bitmap matches the desktop one to one.
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
    } finally {
        $g.Dispose()
    }

    # -- optional downscale (MaxWidth 0 = keep native size) -------------------
    if ($MaxWidth -gt 0 -and $bmp.Width -gt $MaxWidth) {
        $ratio = $MaxWidth / $bmp.Width
        $nw = [int][Math]::Round($bmp.Width * $ratio)
        $nh = [int][Math]::Round($bmp.Height * $ratio)
        if ($nw -lt 1) { $nw = 1 }
        if ($nh -lt 1) { $nh = 1 }
        $small = New-Object System.Drawing.Bitmap($nw, $nh)
        try {
            $g2 = [System.Drawing.Graphics]::FromImage($small)
            try {
                $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $g2.DrawImage($bmp, 0, 0, $nw, $nh)
            } finally {
                $g2.Dispose()
            }
            $bmp.Dispose()
            $bmp = $small
        } catch {
            $small.Dispose()
            throw
        }
    }

    # -- write JPEG with an explicit quality encoder parameter ----------------
    $name = 'shot_' + (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss') + '.jpg'
    $path = Join-Path $OutDir $name

    $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq 'image/jpeg' }
    if ($null -eq $enc) { throw 'no JPEG encoder available' }
    $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
    try {
        $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
            [System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
        $bmp.Save($path, $enc, $ep)
    } finally {
        $ep.Dispose()
    }
} finally {
    $bmp.Dispose()
}

Write-Output $path
