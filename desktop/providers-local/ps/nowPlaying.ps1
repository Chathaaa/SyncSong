$ErrorActionPreference = "Stop"
$it = New-Object -ComObject iTunes.Application
$t = $it.CurrentTrack

if ($null -eq $t) { "{}"; exit }

[pscustomobject]@{
  title = $t.Name
  artist = $t.Artist
  album = $t.Album
  durationMs = [int]($t.Duration * 1000)
  persistentId = $t.PersistentID
  playerPositionMs = [int]($it.PlayerPosition * 1000)
  playerState = [int]$it.PlayerState
} | ConvertTo-Json -Compress
