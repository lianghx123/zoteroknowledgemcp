param([int]$Port = 6404, [int]$DurationMs = 16000)
$ErrorActionPreference = 'Stop'
$env:ZOTERO_DEBUG_PORT = "$Port"
$folder = Join-Path (Resolve-Path .).Path '.scaffold/idle-refresh-diagnostic'
$runs = @(
  @{engine='baseline';round=1}, @{engine='candidate';round=1},
  @{engine='candidate';round=2}, @{engine='baseline';round=2},
  @{engine='baseline';round=3}, @{engine='candidate';round=3}
)
$summary = @()
foreach ($run in $runs) {
  node scripts/verify-idle-refresh.mjs install $run.engine
  $state = $null
  for ($attempt=0; $attempt -lt 100; $attempt++) {
    Start-Sleep -Milliseconds 200
    $state = node scripts/verify-idle-refresh.mjs state | ConvertFrom-Json
    if ($state.probe -and $state.ready) { break }
  }
  if (-not $state.probe -or -not $state.ready) { throw 'Instrumented application not ready.' }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)"
  if ($process.CommandLine -notlike '*ai-scientist zotero*\.scaffold\profile*') { throw 'Expected isolated profile only.' }
  Start-Sleep -Milliseconds 4500
  $modes = if ($run.round -eq 2) { @('evidence','plain') } else { @('plain','evidence') }
  foreach ($mode in $modes) {
    $label = "$($run.engine)-r$($run.round)"
    $output = Join-Path $folder "$label-$mode.json"
    $cpuBefore = (Get-Process -Id $state.pid).TotalProcessorTime.TotalMilliseconds
    $began = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    node scripts/verify-idle-refresh.mjs sample $label ignored $mode $DurationMs | Out-Null
    $result = $null
    for ($attempt=0; $attempt -lt 500; $attempt++) {
      if (Test-Path -LiteralPath $output) { $result = Get-Content -Raw -LiteralPath $output | ConvertFrom-Json; break }
      Start-Sleep -Milliseconds 100
    }
    if (-not $result -or $result.status -ne 'passed') { throw "Incomplete sample $label-$mode : $($result.error)" }
    $cpuAfter = (Get-Process -Id $state.pid).TotalProcessorTime.TotalMilliseconds
    $summary += [PSCustomObject]@{ engine=$run.engine; round=$run.round; mode=$mode; file="$label-$mode.json"; cpuMs=$cpuAfter-$cpuBefore; controllerElapsedMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$began }
    $summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $folder 'trials.json')
    $summary[-1] | ConvertTo-Json -Compress
  }
}
