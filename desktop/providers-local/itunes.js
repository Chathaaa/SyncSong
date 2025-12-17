const { spawn } = require("child_process");
const path = require("path");

function runPSFile(ps1Name, args = []) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, "ps", ps1Name);

    const ps = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-STA",
      "-File", scriptPath,
      ...args,
    ]);

    let out = "";
    let err = "";

    ps.stdout.on("data", (d) => (out += d.toString()));
    ps.stderr.on("data", (d) => (err += d.toString()));

    ps.on("close", (code) => {
      if (code !== 0) return reject(new Error(err || out || `powershell exit ${code}`));
      if (err.trim()) return reject(new Error(err.trim()));
      resolve(out.trim());
    });
  });
}

async function itunesAvailable() {
  try {
    const res = await runPSFile("itunesAvailable.ps1");
    return res.includes("OK");
  } catch {
    return false;
  }
}

async function listPlaylists() {
  const raw = await runPSFile("listPlaylists.ps1");
  try { return JSON.parse(raw || "[]"); } catch { return []; }
}

async function listTracksByIndex(playlistIndex) {
  const raw = await runPSFile("listTracksByIndex.ps1", [String(playlistIndex)]);
  try { return JSON.parse(raw || "[]"); } catch { return []; }
}

async function getNowPlaying() {
  const raw = await runPSFile("nowPlaying.ps1");
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

async function playFromPlaylist(playlistIndex, trackIndex) {
  const res = await runPSFile("playFromPlaylist.ps1", [
    String(playlistIndex),
    String(trackIndex),
  ]);
  return res.includes("OK");
}


// async function playByPersistentId(persistentId) {
//   const res = await runPSFile("playByPersistentId.ps1", [String(persistentId)]);
//   return res.includes("OK");
// }

// async function playByDatabaseId(dbId) {
//   const res = await runPSFile("playByDatabaseId.ps1", [String(dbId)]);
//   return res.includes("OK");
// }

// async function playByTrackId(trackId) {
//   const res = await runPSFile("playByTrackId.ps1", [String(trackId)]);
//   return res.includes("OK");
// }

async function pause() {
  await runPSFile("pause.ps1");
  return true;
}

async function play() {
  await runPSFile("play.ps1");
  return true;
}

async function nextTrack() {
  await runPSFile("nextTrack.ps1");
  return true;
}


module.exports = {
  itunesAvailable,
  listPlaylists,
  listTracksByIndex,
  getNowPlaying,
  playFromPlaylist,
  // playByPersistentId,
  // playByDatabaseId,
  // playByTrackId,
  pause,
  play,
  nextTrack,
};
