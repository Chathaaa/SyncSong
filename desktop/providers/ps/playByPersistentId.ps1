param([string]$Pid)
$ErrorActionPreference = "Stop"

$it = New-Object -ComObject iTunes.Application
$lib = $it.LibraryPlaylist

for ($i=1; $i -le $lib.Tracks.Count; $i++) {
  $t = $lib.Tracks.Item($i)
  if ($null -ne $t -and $t.PersistentID -eq $Pid) {
    $t.Play()
    "OK"
    exit
  }
}

"NOT_FOUND"
exit 0
