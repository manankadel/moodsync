"use client";

import { useRoomStore } from "../lib/room-store";

export default function Player() {
  const { currentTrack, status, play, pause, resume } = useRoomStore();

  if (!currentTrack) {
    return (
      <div className="p-4 text-center text-white/60">
        No track playing
      </div>
    );
  }

  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="text-white font-bold truncate">
        {currentTrack.url}
      </div>

      <div className="flex gap-2">
        {status !== "playing" && (
          <button
            className="px-3 py-2 bg-white text-black rounded"
            onClick={() => resume()}
          >
            Play
          </button>
        )}

        {status === "playing" && (
          <button
            className="px-3 py-2 bg-white text-black rounded"
            onClick={() => pause()}
          >
            Pause
          </button>
        )}
      </div>
    </div>
  );
}
