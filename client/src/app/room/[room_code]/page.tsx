"use client";

import { useEffect } from "react";
import Player from "../../../components/player";
import { useRoomStore } from "../../../lib/room-store";
import AudioUnlocker from "../../../components/AudioUnlocker";


export default function RoomPage({ params }: { params: { room_code: string } }) {
  const room = params.room_code;
  const { connect, currentTrack, play, members } = useRoomStore();

  useEffect(() => {
    const user = `user-${Math.random().toString(36).slice(2, 8)}`;
    connect(room, user);
  }, [room]);

  return (
    <div className="min-h-screen bg-black text-white p-4">
      <div className="text-xl font-bold mb-4">
        Room: {room}
      </div>

      <div className="mb-4">
        Members: {members.join(", ") || "None"}
      </div>

      <div className="mb-4">
        <input
          type="text"
          placeholder="Paste MP3 URL"
          className="px-3 py-2 rounded text-black w-full"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              play((e.target as HTMLInputElement).value);
            }
          }}
        />
      </div>

<AudioUnlocker />
      <Player />
    </div>
  );
}
