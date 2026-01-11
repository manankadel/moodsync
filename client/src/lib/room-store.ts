"use client";

import { create } from "zustand";
import { io, Socket } from "socket.io-client";
import { PlayerController } from "./playerController";

interface RoomState {
  room: string | null;
  user: string | null;
  socket: Socket | null;
  player: PlayerController | null;
  status: "idle" | "playing" | "paused";
  currentTrack: { url: string; duration: number | null } | null;
  startAt: number | null;
  pausedAt: number | null;
  members: string[];

  connect: (room: string, user: string) => void;
  play: (url: string, duration?: number | null) => void;
  pause: () => void;
  resume: () => void;
}

export const useRoomStore = create<RoomState>((set, get) => ({
  room: null,
  user: null,
  socket: null,
  player: null,
  status: "idle",
  currentTrack: null,
  startAt: null,
  pausedAt: null,
  members: [],

  connect(room, user) {
    const backend = process.env.NEXT_PUBLIC_BACKEND_URL || "https://moodsync-yckk.onrender.com";
    const socket = io(backend, { transports: ["websocket"] });

    const player = new PlayerController(socket);

    socket.emit("join_room", { room, user });

    socket.on("room_update", (state: any) => {
      set({
        status: state.status,
        currentTrack: state.currentTrack,
        startAt: state.startAt,
        pausedAt: state.pausedAt,
        members: state.members || []
      });
    });

    set({ room, user, socket, player });
  },

  play(url, duration = null) {
    const { socket, room } = get();
    if (!socket || !room) return;
    socket.emit("play_track", { room, url, duration });
  },

pause() {
  const { socket, room } = get();
  if (!socket || !room) return;
  socket.emit("pause_track", { room });
},

  resume() {
    const { socket, room, pausedAt } = get();
    if (!socket || !room) return;
    socket.emit("resume_track", { room, pausedAt });
  }
}));
