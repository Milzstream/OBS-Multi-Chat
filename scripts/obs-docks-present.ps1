$ErrorActionPreference = 'SilentlyContinue'
function Canonical([string]$Url) {
  try {
    $uri = [Uri]$Url
    $hostName = $uri.Host
    if ($hostName -eq 'localhost' -or $hostName -eq '::1') { $hostName = '127.0.0.1' }
    $path = $uri.AbsolutePath.TrimEnd('/')
    return ('{0}:{1}{2}' -f $hostName.ToLowerInvariant(), $uri.Port, $path.ToLowerInvariant())
  } catch {
    return $Url.Trim().TrimEnd('/').ToLowerInvariant()
  }
}
$chat = Canonical 'http://127.0.0.1:4173/'
$activity = Canonical 'http://127.0.0.1:4173/activity'
$candidates = @()
if ($env:APPDATA) {
  $candidates += (Join-Path $env:APPDATA 'obs-studio\user.ini')
  $candidates += (Join-Path $env:APPDATA 'obs-studio\global.ini')
}
foreach ($file in $candidates) {
  if (-not (Test-Path -LiteralPath $file)) { continue }
  $raw = Get-Content -LiteralPath $file -Raw
  $match = [regex]::Match($raw, '(?m)^ExtraBrowserDocks=(.*)$')
  if (-not $match.Success) { continue }
  try {
    $docks = $match.Groups[1].Value | ConvertFrom-Json
  } catch {
    continue
  }
  $urls = @($docks | ForEach-Object { Canonical $_.url })
  if (($urls -contains $chat) -and ($urls -contains $activity)) { exit 0 }
}
exit 1
