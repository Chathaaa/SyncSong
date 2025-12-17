$ErrorActionPreference = "Stop"

$it = New-Object -ComObject iTunes.Application
$pls = @()

for ($i=1; $i -le $it.LibrarySource.Playlists.Count; $i++) {
  $p = $it.LibrarySource.Playlists.Item($i)
  $pls += [pscustomobject]@{
    index = $i
    name  = $p.Name
  }
}

$pls | ConvertTo-Json -Compress
