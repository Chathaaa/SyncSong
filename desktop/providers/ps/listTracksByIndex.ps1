param([int]$Idx)
$ErrorActionPreference = "Stop"

$it = New-Object -ComObject iTunes.Application
$p = $it.LibrarySource.Playlists.Item($Idx)
if ($null -eq $p) { "[]"; exit }

$null = $p.Tracks.Count

$tracks = @()
$count = $p.Tracks.Count

for ($i=1; $i -le $count; $i++) {
  $t = $p.Tracks.Item($i)
  if ($null -ne $t) {
    $tracks += [pscustomobject]@{
      title      = $t.Name
      artist     = $t.Artist
      album      = $t.Album
      durationMs = [int]($t.Duration * 1000)

      # identifiers (optional)
      persistentId = $t.PersistentID
      databaseId   = $t.DatabaseID
      trackId      = $t.TrackID

      # this is the key
      trackIndex = $i
    }
  }
}

$tracks | ConvertTo-Json -Compress
