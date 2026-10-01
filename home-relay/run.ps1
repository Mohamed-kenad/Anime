# AnimeWit home relay supervisor.
# Keeps the playback chain alive: node relay (home IP egress) + free quick
# tunnel, and pushes the current tunnel URL into the edge worker's
# HOME_UPSTREAM secret so Vercel's stable workers.dev address always routes
# here. If everything dies or the PC shuts down, the stale URL expires and
# the app falls back to catalog-only (reader) mode by itself.
$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
$LOG = Join-Path $here 'run.log'
$ACC = '19a3752e7d7497a995f0e0fedcc3d499'
$SCRIPT = 'animewit-relay'

Get-Content (Join-Path $here '.env') | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
    $parts = $line.Split('=', 2)
    Set-Item -Path "env:$($parts[0].Trim())" -Value $parts[1].Trim()
  }
}

function Write-Log([string]$msg) {
  $entry = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $LOG -Value $entry
  if ((Test-Path $LOG) -and ((Get-Item $LOG).Length -gt 1MB)) {
    Move-Item -Path $LOG -Destination "$LOG.old" -Force
  }
}

function Set-HomeSecret([string]$value) {
  $body = @{ name = 'HOME_UPSTREAM'; type = 'secret_text'; text = $value } | ConvertTo-Json
  try {
    $r = Invoke-RestMethod -Method Put `
      -Uri "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/$SCRIPT/secrets" `
      -Headers @{ authorization = "Bearer $env:CLOUDFLARE_API_TOKEN" } `
      -ContentType 'application/json' -Body $body -TimeoutSec 20
    if ($r.success) { Write-Log "HOME_UPSTREAM = '$value'"; return $true }
    Write-Log "secret update rejected: $($r.errors | ConvertTo-Json -Compress)"
  } catch { Write-Log "secret update failed: $($_.Exception.Message)" }
  return $false
}

function Stop-Proc($p) {
  if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
}

Write-Log 'supervisor starting'
$currentUrl = ''
try {
  while ($true) {
    Remove-Item "$here\cf.log", "$here\cf.err" -Force -ErrorAction SilentlyContinue

    $node = Start-Process node -ArgumentList "`"$here\server.mjs`"" -WorkingDirectory $repo -WindowStyle Hidden -PassThru
    Start-Sleep 2
    if ($node.HasExited) { Write-Log 'node failed to start'; Start-Sleep 10; continue }
    Write-Log "node relay pid $($node.Id)"

    $cf = Start-Process "$here\cloudflared.exe" `
      -ArgumentList 'tunnel', '--url', 'http://127.0.0.1:8787', '--no-autoupdate' `
      -WindowStyle Hidden -RedirectStandardOutput "$here\cf.log" `
      -RedirectStandardError "$here\cf.err" -PassThru
    Write-Log "cloudflared pid $($cf.Id)"

    $url = ''
    for ($i = 0; $i -lt 60 -and -not $url; $i++) {
      Start-Sleep 2
      $txt = ''
      foreach ($f in @("$here\cf.log", "$here\cf.err")) {
        if (Test-Path $f) { $txt += (Get-Content $f -Raw -ErrorAction SilentlyContinue) }
      }
      if ($txt -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $url = $Matches[0] }
      if ($cf.HasExited) { break }
    }

    if ($url) {
      if ($url -ne $currentUrl) { if (Set-HomeSecret $url) { $currentUrl = $url } }
    } else {
      Write-Log 'tunnel URL not found in 120s'
    }

    while (-not $cf.HasExited -and -not $node.HasExited) { Start-Sleep 15 }
    Write-Log "cycle ended (node exited=$($node.HasExited), tunnel exited=$($cf.HasExited)) ??? restarting"
    Stop-Proc $node
    Stop-Proc $cf
    Start-Sleep 3
  }
} finally {
  Stop-Proc $node
  Stop-Proc $cf
  if ($currentUrl) { Set-HomeSecret '' | Out-Null }
  Write-Log 'supervisor stopped'
}
