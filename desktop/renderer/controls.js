// controls.js
import { ensureSpotifyWebPlayer, spotifyApi } from "./providers/spotify.js";
import { applePlay, applePause, appleNext } from "./providers/apple.js";

// IMPORTANT: app.js must pass in getters so controls knows current state.
export function makeControls({ getPlaybackSource, getNowPlaying, onNextShared, onPrevShared }) {
  async function playerPlay() {
    const src = getPlaybackSource();
    if (src === "spotify") {
      const p = await ensureSpotifyWebPlayer();
      await p.resume();
      return;
    }
    if (src === "apple") {
      await applePlay();
      return;
    }
  }

  async function playerPause() {
    const src = getPlaybackSource();
    if (src === "spotify") {
      const p = await ensureSpotifyWebPlayer();
      await p.pause();
      return;
    }
    if (src === "apple") {
      await applePause();
      return;
    }
  }

  async function playerSeek(seconds) {
    const src = getPlaybackSource();
    if (src === "spotify") {
      const p = await ensureSpotifyWebPlayer();
      await p.seek(Math.max(0, Math.floor(seconds * 1000)));
      return;
    }
    if (src === "apple") {
      // implement appleSeek(seconds) in providers/apple.js using MusicKit seekToTime
      const { appleSeek } = await import("./providers/apple.js");
      await appleSeek(seconds);
      return;
    }
  }

  async function playerNext() {
    // Always: advance shared queue (host) OR do nothing (guest)
    if (typeof onNextShared === "function") return onNextShared();
   }

  async function playerPrev() {
    if (typeof onPrevShared === "function") return onPrevShared();
   }

  async function playerToggle() {
    // optional: read current state and toggle
    return playerPlay();
  }

  return { playerPlay, playerPause, playerSeek, playerNext, playerPrev, playerToggle };
}
