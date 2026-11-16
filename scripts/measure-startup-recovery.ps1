param([int]$Port = 9022, [switch]$PurgeCaches)
$ErrorActionPreference = 'Stop'
$env:ZOTERO_DEBUG_PORT = "$Port"
$workspace = (Resolve-Path .).Path
$profileDirectory = Join-Path $workspace '.scaffold/profile'
$data = Join-Path $workspace '.scaffold/data'
$extension = Join-Path $profileDirectory 'extensions/zotero-knowledge-mcp@local.dev.xpi'
$folder = Join-Path $workspace '.scaffold/startup-optimization'
if (-not (Test-Path -LiteralPath $profileDirectory)) { throw 'Existing isolated profile required.' }
$trials = @()
# One warmup per package, then alternating ABBA blocks to reduce order bias.
$conditions = @('baseline', 'candidate', 'baseline', 'candidate', 'candidate', 'baseline', 'baseline', 'candidate', 'candidate', 'baseline')
foreach ($label in $conditions) {
  if (-not $PurgeCaches) {
    # Same-version raw file replacement leaves Gecko caches/installation metadata stale.
    # Use the ordinary addon update path before a launch that preserves host caches.
    node scripts/verify-startup-recovery.mjs install $label | Out-Null
    $installed = $false
    for ($attempt = 0; $attempt -lt 300; $attempt++) {
      $resultFile = Join-Path $folder "$label-install.json"
      if (Test-Path -LiteralPath $resultFile) {
        $result = Get-Content -Raw -LiteralPath $resultFile | ConvertFrom-Json
        if ($result.status -ne 'passed') { throw $result.error }
        $installed = $true
        break
      }
      Start-Sleep -Milliseconds 100
    }
    if (-not $installed) { throw 'Addon update timed out; test is incomplete.' }
    Start-Sleep -Seconds 5
  }
  $before = node scripts/verify-startup-recovery.mjs state | ConvertFrom-Json
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($before.pid)"
  if ($process.CommandLine -notlike "*$profileDirectory*") { throw 'Debugger is not the intended isolated Zotero.' }
  node scripts/verify-startup-recovery.mjs close
  for ($attempt = 0; $attempt -lt 150; $attempt++) {
    if (-not (Get-Process -Id $before.pid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 200
  }
  if (Get-Process -Id $before.pid -ErrorAction SilentlyContinue) { throw 'Previous Zotero did not close; no concurrent launch.' }
  if ($PurgeCaches) { Copy-Item -LiteralPath (Join-Path $folder "$label-probe.xpi") -Destination $extension }
  $launched = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $arguments = @('-no-remote', '-profile', "`"$profileDirectory`"", '--dataDir', "`"$data`"", '-start-debugger-server', "$Port")
  if ($PurgeCaches) { $arguments += '--purgecaches' }
  Start-Process -FilePath 'C:\Program Files\Zotero\zotero.exe' -WindowStyle Hidden -ArgumentList $arguments
  $indexReady = $null
  for ($attempt = 0; $attempt -lt 300; $attempt++) {
    $events = Get-Content -LiteralPath (Join-Path $folder "$label.jsonl") | ForEach-Object { $_ | ConvertFrom-Json }
    $indexReady = $events | Where-Object { $_.at -ge $launched -and $_.event -eq 'index-ready' } | Select-Object -Last 1
    if ($indexReady) { break }
    Start-Sleep -Milliseconds 200
  }
  if (-not $indexReady) { throw 'Index readiness timeout; test is incomplete.' }
  Start-Sleep -Seconds 5
  $state = node scripts/verify-startup-recovery.mjs state | ConvertFrom-Json
  if (-not $state.plugin -or -not $state.ui -or $state.index -ne 'ready') { throw 'Actual readiness check failed.' }
  if ($label -eq 'candidate' -and $state.recovery.state -ne 'ready') { throw 'Candidate recovery incomplete.' }
  $trials += [PSCustomObject]@{ trial = $trials.Count + 1; warmup = $trials.Count -lt 2; label = $label; purgeCaches = [bool]$PurgeCaches; pid = $state.pid; launched = $launched; indexReady = $indexReady.at }
  $trials | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $folder 'trials.json')
  $trials[-1] | ConvertTo-Json -Compress
}
# Caller restores the ordinary package after inspecting native functionality.
