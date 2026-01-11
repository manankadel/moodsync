"use client";

import { SyncEngine } from "./syncEngine";
import { AudioEngine } from "./audioEngine";
import type { Socket } from "socket.io-client";

export class PlayerController {
  socket: Socket;
  sync: SyncEngine;
  audio: AudioEngine;

  constructor(socket: Socket) {
    this.socket = socket;
    this.sync = new SyncEngine(socket);
    this.audio = new AudioEngine();

    this.register();
  }

  register() {
    this.socket.on("play", async (msg: any) => {
      const { url, startAt } = msg;
      await this.audio.load(url);
      this.audio.playAt(startAt, () => this.sync.now());
    });

    this.socket.on("pause", () => {
      this.audio.pause();
    });

    this.socket.on("resume", (msg: any) => {
      const { startAt } = msg;
      if (this.audio.buffer) {
        this.audio.playAt(startAt, () => this.sync.now());
      }
    });

    this.socket.on("seek", async (msg: any) => {
      console.warn("Seeking not fully implemented yet", msg);
    });
  }
}
