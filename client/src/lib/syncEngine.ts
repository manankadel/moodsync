"use client";

import { io, Socket } from "socket.io-client";

export class SyncEngine {
  socket: Socket;
  offset: number = 0;  // serverTime - localTime
  rtt: number = 0;
  lastSync: number = performance.now();

  constructor(socket: Socket) {
    this.socket = socket;

    this.socket.on("clock_sync_response", (msg: any) => {
      const t3 = performance.now();
      const { t1, serverTime } = msg;
      const rtt = t3 - t1;
      const oneWay = rtt / 2;
      this.rtt = rtt;
      this.offset = serverTime + oneWay - t3;
      this.lastSync = t3;
    });

    setInterval(() => this.sync(), 1500);
  }

  sync() {
    const t1 = performance.now();
    this.socket.emit("clock_sync_request", { t1 });
  }

  now() {
    return performance.now() + this.offset;
  }
}
