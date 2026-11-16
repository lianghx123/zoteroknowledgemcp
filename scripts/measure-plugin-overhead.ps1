param(
  [int]$Port = 4792,
  [int]$DurationMs = 30000,
  [int]$Pairs = 6,
  [switch]$Resume,
  [string]$Directory = '.scaffold/plugin-overhead-20261029'
)
$ErrorActionPreference = 'Stop'
$env:ZOTERO_DEBUG_PORT = "$Port"
$workspace = (Resolve-Path .).Path
$folder = (Resolve-Path -LiteralPath $Directory).Path
$env:ZOTERO_OVERHEAD_DIR = $folder
if (-not $folder.StartsWith((Join-Path $workspace '.scaffold') + [IO.Path]::DirectorySeparatorChar)) { throw 'Only a workspace-owned benchmark copy is permitted.' }
$profilePath = Join-Path $folder 'profile'
$dataPath = Join-Path $folder 'data'
$logPath = Join-Path $folder 'startup.jsonl'
if (-not (Test-Path -LiteralPath (Join-Path $folder 'setup.json'))) { throw 'Prepare and install the monitor in the benchmark copy first.' }

function Invoke-Probe([string[]]$Arguments) {
  $probeOutput = & node scripts/measure-plugin-overhead.mjs @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Probe failed: $Arguments" }
  return $probeOutput
}
function Get-State { return (Invoke-Probe @('state') | ConvertFrom-Json) }
function Assert-Isolated($state) {
  if ($state.data -ne $dataPath) { throw 'Debugger is not attached to the benchmark copy.' }
  $native = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)"
  if ($native.CommandLine -notlike "*$profilePath*") { throw 'Profile command line mismatch.' }
}
function Get-ProcessTree([int]$rootID) {
  $all = @(Get-CimInstance Win32_Process -Filter "name='zotero.exe'")
  $ids = [Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($rootID)
  do {
    $changed = $false
    foreach ($native in $all) {
      if ($ids.Contains([int]$native.ParentProcessId) -and $ids.Add([int]$native.ProcessId)) { $changed = $true }
    }
  } while ($changed)
  return @($ids)
}
function Get-Counters([int[]]$processIDs, [int]$mainID, [double]$elapsedMs) {
  $processRows = @()
  foreach ($processID in $processIDs) {
    $process = Get-Process -Id $processID -ErrorAction Stop
    $process.Refresh()
    $processRows += [pscustomobject]@{
      pid = $processID
      cpuMs = $process.TotalProcessorTime.TotalMilliseconds
      workingSetBytes = $process.WorkingSet64
      privateBytes = $process.PrivateMemorySize64
    }
  }
  $main = $processRows | Where-Object pid -eq $mainID
  return [pscustomobject]@{
    at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    elapsedMs = $elapsedMs
    cpuMs = ($processRows | Measure-Object cpuMs -Sum).Sum
    mainCpuMs = $main.cpuMs
    workingSetBytes = ($processRows | Measure-Object workingSetBytes -Sum).Sum
    privateBytes = ($processRows | Measure-Object privateBytes -Sum).Sum
    mainWorkingSetBytes = $main.workingSetBytes
    mainPrivateBytes = $main.privateBytes
    processes = $processRows
  }
}

$runs = @(
  @{label='disabled';warmup=$true;pair=0},
  @{label='enabled';warmup=$true;pair=0}
)
for ($pair=1; $pair -le $Pairs; $pair++) {
  $order = if ($pair % 2) { @('disabled','enabled') } else { @('enabled','disabled') }
  foreach ($condition in $order) { $runs += @{label=$condition;warmup=$false;pair=$pair} }
}
$trialsPath = Join-Path $folder 'trials.json'
$trials = @()
if ($Resume) {
  $trials = @(Get-Content -Raw -LiteralPath $trialsPath | ConvertFrom-Json)
  for ($i=0;$i -lt $trials.Count;$i++) {
    if ($trials[$i].label -ne $runs[$i].label -or $trials[$i].pair -ne $runs[$i].pair) { throw 'Completed trials do not match the requested schedule.' }
  }
} elseif (Test-Path -LiteralPath $trialsPath) { throw 'Archive existing trials or use -Resume.' }
foreach ($run in ($runs | Select-Object -Skip $trials.Count)) {
  $before = Get-State
  Assert-Isolated $before
  Invoke-Probe @('condition', $run.label) | Out-Null
  if ($run.label -eq 'enabled') {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $configured = Get-State
    while ($configured.recovery.state -ne 'ready' -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 200
      $configured = Get-State
    }
    if ($configured.recovery.state -ne 'ready') { throw 'Recovery incomplete before closing.' }
  }
  Start-Sleep -Milliseconds 1000
  Invoke-Probe @('close') | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ((Get-Process -Id $before.pid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (Get-Process -Id $before.pid -ErrorAction SilentlyContinue) { throw 'Previous Zotero did not close; concurrent startup refused.' }
  $otherRoots = @(Get-CimInstance Win32_Process -Filter "name='zotero.exe'" | Where-Object CommandLine -NotMatch '-contentproc')
  if ($otherRoots.Count) { throw 'Another Zotero root is running; benchmark stopped.' }
  $launched = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $trialID = ('run-{0:d2}-{1}' -f ($trials.Count+1), $run.label)
  Start-Process -FilePath 'C:\Program Files\Zotero\zotero.exe' -WindowStyle Hidden -ArgumentList @(
    '-no-remote','-profile',('"'+$profilePath+'"'),'--dataDir',('"'+$dataPath+'"'),'-start-debugger-server',"$Port"
  )
  Invoke-Probe @('watch-startup', $trialID) | Out-Null
  $ready = $null
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $logPath) {
      $ready = Get-Content -LiteralPath $logPath | ForEach-Object { $_ | ConvertFrom-Json } |
        Where-Object { $_.at -ge $launched -and $_.event -eq 'native-list-ready' } | Select-Object -Last 1
    }
    if ($ready) { break }
    Start-Sleep -Milliseconds 100
  }
  if (-not $ready) { throw 'Native list readiness was not observed.' }
  $state = Get-State
  Assert-Isolated $state
  if ($run.label -eq 'enabled') {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ($state.recovery.state -ne 'ready' -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 200
      $state = Get-State
    }
    if (-not $state.plugin -or $state.index -ne 'ready' -or $state.recovery.state -ne 'ready') { throw 'Plugin was not fully ready.' }
  } elseif ($state.plugin) { throw 'Disabled condition still has an active plugin.' }
  Start-Sleep -Milliseconds 5000
  $trial = [pscustomobject]@{
    id=$trialID;label=$run.label;warmup=$run.warmup;pair=$run.pair;pid=$state.pid;launched=$launched
    nativeListMs=($ready.at-$launched);startup=$ready.startup;rows=$ready.rows;state=$state
  }
  if (-not $run.warmup) {
    Invoke-Probe @('idle-start', "$trialID-idle-start") | Out-Null
    $processIDs = Get-ProcessTree $state.pid
    $samples = @()
    $clock = [Diagnostics.Stopwatch]::StartNew()
    do {
      $samples += Get-Counters $processIDs $state.pid $clock.Elapsed.TotalMilliseconds
      if ($clock.ElapsedMilliseconds -ge $DurationMs) { break }
      Start-Sleep -Milliseconds 250
    } while ($true)
    $clock.Stop()
    $samples | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $folder "$trialID-processes.json")
    $afterIDs = Get-ProcessTree $state.pid
    $beforeList = ($processIDs | Sort-Object) -join ','
    $afterList = ($afterIDs | Sort-Object) -join ','
    if ($beforeList -ne $afterList) { throw 'Process tree changed during idle observation.' }
    Invoke-Probe @('idle-end', "$trialID-idle-end") | Out-Null
  }
  Invoke-Probe @('operations', "$trialID-operations") | Out-Null
  $trials += $trial
  $trials | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $folder 'trials.json')
  [pscustomobject]@{run=$trials.Count;label=$run.label;warmup=$run.warmup;pair=$run.pair;nativeListMs=$trial.nativeListMs;completed=[DateTimeOffset]::Now.ToString('o')} | ConvertTo-Json -Compress
}
Invoke-Probe @('condition','enabled') | Out-Null
$deadline = [DateTime]::UtcNow.AddSeconds(45)
$restored = Get-State
while ($restored.recovery.state -ne 'ready' -and [DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 200
  $restored = Get-State
}
if ($restored.recovery.state -ne 'ready') { throw 'Final enabled state did not finish recovery.' }
Invoke-Probe @('facts') | Out-Null
