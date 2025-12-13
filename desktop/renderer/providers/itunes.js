const { spawn } = require("child_process");

function runPS(script, args = []) {
  return new Promise((resolve, reject) => {
    const ps = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
      ...args,
    ]);

    let out = "";
    let err = "";

    ps.stdout.on("data", (d) => (out += d.toString()));
    ps.stderr.on("data", (d) => (err += d.toString()));

    ps.on("close", (code) => {
      if (code !== 0) return reject(new Error(err || `powershell exit ${code}`));
      resolve(out.trim());
    });
  });
}

async function itunesAvailable() {
  const script = `try { $it = New-Object -ComObject iTunes.Application; "OK" } catch { "NO_ITUNES" }`;
  const res = await runPS(script);
  return res.includes("OK");
}

async function listPlaylists() {
  const script = `
    $it = New-Object -ComObject iTunes.Application
    $pls = @()
    for ($i=1; $i -le $it.LibrarySource.Playlists.Count; $i++) {
      $p = $it.LibrarySource.Playlists.Item($i)
      $pls += [pscustomobject]@{ name = $p.Name }
    }
    $pls | ConvertTo-Json -Compress
  `;
  const raw = await runPS(script);
  try { return JSON.parse(raw || "[]"); } catch { return []; }
}

async function listTracks(playlistName) {
  const script = `
    param([string]$PlaylistName)
    $it = New-Object -ComObject iTunes.Application
    $target = $null
    for ($i=1; $i -le $it.LibrarySource.Playlists.Count; $i++) {
      $p = $it.LibrarySource.Playlists.Item($i)
      if ($p.Name -eq $PlaylistName) { $target = $p; break }
    }
    if ($null -eq $target) { "[]"; exit }
    $tracks = @()
    for ($i=1; $i -le $target.Tracks.Count; $i++) {
      $t = $target.Tracks.Item($i)
      $tracks += [pscustomobject]@{
        title = $t.Name
        artist = $t.Artist
        album = $t.Album
        durationMs = [int]($t.Duration * 1000)
        persistentId = $t.PersistentID
      }
    }
    $tracks | ConvertTo-Json -Compress
  `;
  const raw = await runPS(script, [playlistName]);
  try { return JSON.parse(raw || "[]"); } catch { return []; }
}

async function getNowPlaying() {
  const script = `
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
  `;
  const raw = await runPS(script);
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

async function playByPersistentId(persistentId) {
  const script = `
    param([string]$Pid)
    $it = New-Object -ComObject iTunes.Application
    $lib = $it.LibraryPlaylist
    for ($i=1; $i -le $lib.Tracks.Count; $i++) {
      $t = $lib.Tracks.Item($i)
      if ($t.PersistentID -eq $Pid) { $t.Play(); "OK"; exit }
    }
    "NOT_FOUND"
  `;
  const res = await runPS(script, [persistentId]);
  return res.includes("OK");
}

async function pause() {
  const script = `$it = New-Object -ComObject iTunes.Application; $it.Pause(); "OK"`;
  await runPS(script);
}
async function play() {
  const script = `$it = New-Object -ComObject iTunes.Application; $it.Play(); "OK"`;
  await runPS(script);
}
async function nextTrack() {
  const script = `$it = New-Object -ComObject iTunes.Application; $it.NextTrack(); "OK"`;
  await runPS(script);
}

module.exports = {
  itunesAvailable,
  listPlaylists,
  listTracks,
  getNowPlaying,
  playByPersistentId,
  pause,
  play,
  nextTrack,
};
