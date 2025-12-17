param([int]$PlaylistIdx, [int]$TrackIdx)
$ErrorActionPreference = "Stop"

$it = New-Object -ComObject iTunes.Application
$p = $it.LibrarySource.Playlists.Item($PlaylistIdx)

if ($null -eq $p) { "NO_PLAYLIST"; exit 0 }

# Force tracks
$null = $p.Tracks.Count

$t = $p.Tracks.Item($TrackIdx)
if ($null -eq $t) { "NO_TRACK"; exit 0 }

$t.Play()
"OK"
