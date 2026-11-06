# Read-only, loopback-only static practice server. No Python, admin, writes or API.
param([int]$Port = 5019, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$qbRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!(Test-Path -LiteralPath (Join-Path $qbRoot 'bank.json') -PathType Leaf)) { throw 'bank.json missing. Keep the launcher with the exported bank directory.' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid local port.' }
$qbListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
try { $qbListener.Start() } catch { throw "Port $Port is busy. Close the previous practice window/terminal, or start with -Port 5020. No existing service was changed." }
$qbUrl = "http://127.0.0.1:$Port/site/index.html"
Write-Host "Practice: $qbUrl"
Write-Host 'Keep this terminal open. Close it or press Ctrl+C to stop. Files are read-only; only browser progress is saved.'
if (!$NoBrowser) { Start-Process $qbUrl }
$qbTypes = @{ '.html'='text/html; charset=utf-8'; '.mjs'='text/javascript; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.json'='application/json; charset=utf-8'; '.jsonl'='application/json; charset=utf-8'; '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.bmp'='image/bmp'; '.svg'='image/svg+xml'; '.woff2'='font/woff2'; '.woff'='font/woff' }
try {
 while ($true) {
  $qbClient = $qbListener.AcceptTcpClient(); $qbStream = $null; $qbFile = $null
  try {
   $qbClient.ReceiveTimeout=5000; $qbClient.SendTimeout=30000; $qbStream=$qbClient.GetStream()
   $qbHeader=[Collections.Generic.List[byte]]::new()
   while ($qbHeader.Count -lt 8192) {
    $qbByte=$qbStream.ReadByte(); if ($qbByte -lt 0) { throw 'Incomplete request' }; $qbHeader.Add([byte]$qbByte)
    $qbN=$qbHeader.Count
    if ($qbN -ge 4 -and $qbHeader[$qbN-4] -eq 13 -and $qbHeader[$qbN-3] -eq 10 -and $qbHeader[$qbN-2] -eq 13 -and $qbHeader[$qbN-1] -eq 10) { break }
   }
   $qbRequest=[Text.Encoding]::ASCII.GetString($qbHeader.ToArray()); $qbLine=($qbRequest -split "`r`n")[0]; $qbMethod=''
   $qbStatus='400 Bad Request'; $qbMime='text/plain'; $qbBody=[Text.Encoding]::UTF8.GetBytes('Request rejected')
   if ($qbRequest.EndsWith("`r`n`r`n") -and $qbLine -match '^(GET|HEAD) (/[^ ]*) HTTP/1\.[01]$') {
    $qbMethod=$Matches[1]; $qbTarget=$Matches[2]
    # No cross-origin reads, request rewriting, CGI, directory listings or uploads.
    $qbHost=@($qbRequest -split "`r`n" | Where-Object { $_ -match '^Host:\s*' })
    $qbOrigin=@($qbRequest -split "`r`n" | Where-Object { $_ -match '^Origin:\s*' })
    $qbHostOk=$qbHost.Count -eq 1 -and $qbHost[0] -match "^Host:\s*127\.0\.0\.1:$Port\s*$"
    $qbOriginOk=$qbOrigin.Count -eq 0 -or ($qbOrigin.Count -eq 1 -and $qbOrigin[0] -match "^Origin:\s*http://127\.0\.0\.1:$Port\s*$")
    if ($qbHostOk -and $qbOriginOk) {
     $qbPath=[Uri]::UnescapeDataString(($qbTarget -split '\?',2)[0]).TrimStart('/')
     if (!$qbPath) { $qbPath='site/index.html' }
     $qbSafe=$qbPath -notmatch '[\x00-\x1f\\:]' -and @($qbPath.Split('/') | Where-Object { $_ -in @('..','.') -or $_ -match '[. ]$' }).Count -eq 0
     $qbAllowed=$qbPath -eq 'bank.json' -or $qbPath.StartsWith('site/') -or $qbPath.StartsWith('releases/')
     if ($qbSafe -and $qbAllowed) {
      $qbResolved=[IO.Path]::GetFullPath((Join-Path $qbRoot $qbPath))
      $qbInside=$qbResolved.StartsWith($qbRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)
      $qbWalk=$qbRoot
      foreach ($qbSegment in $qbPath.Split('/')) { $qbWalk=Join-Path $qbWalk $qbSegment; if (Test-Path -LiteralPath $qbWalk) { if ((Get-Item -Force -LiteralPath $qbWalk).Attributes -band [IO.FileAttributes]::ReparsePoint) { $qbInside=$false; break } } }
      $qbExt=[IO.Path]::GetExtension($qbResolved).ToLowerInvariant()
      if ($qbInside -and (Test-Path -LiteralPath $qbResolved -PathType Leaf) -and ($qbTypes.ContainsKey($qbExt) -or ($qbPath.StartsWith('releases/') -and $qbExt -eq '.bin'))) {
       $qbFile=[IO.File]::Open($qbResolved,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
       $qbStatus='200 OK'; $qbMime=if ($qbExt -eq '.bin') { 'application/octet-stream' } else { $qbTypes[$qbExt] }
      } else { $qbStatus='404 Not Found'; $qbBody=[Text.Encoding]::UTF8.GetBytes('Not found') }
     } else { $qbStatus='403 Forbidden' }
    } else { $qbStatus='403 Forbidden' }
   }
   $qbLength=if ($qbFile) { $qbFile.Length } else { $qbBody.Length }
   $qbResponse="HTTP/1.1 $qbStatus`r`nContent-Type: $qbMime`r`nContent-Length: $qbLength`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nCross-Origin-Resource-Policy: same-origin`r`nConnection: close`r`n`r`n"
   $qbBytes=[Text.Encoding]::ASCII.GetBytes($qbResponse); $qbStream.Write($qbBytes,0,$qbBytes.Length)
   if ($qbMethod -ne 'HEAD') { if ($qbFile) { $qbFile.CopyTo($qbStream,65536) } else { $qbStream.Write($qbBody,0,$qbBody.Length) } }
  } catch { # Client disconnects and malformed requests cannot stop the server.
  } finally { if ($qbFile) { $qbFile.Dispose() }; if ($qbStream) { $qbStream.Dispose() }; $qbClient.Dispose() }
 }
} finally { $qbListener.Stop() }
