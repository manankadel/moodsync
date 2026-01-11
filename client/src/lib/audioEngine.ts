"use client";

export class AudioEngine {
  ctx: AudioContext;
  buffer: AudioBuffer | null = null;
  source: AudioBufferSourceNode | null = null;
  startTimeLocal: number | null = null;
  startTimeGlobal: number | null = null;

  constructor() {
    this.ctx = new AudioContext();
  }

  async load(url: string) {
    const resp = await fetch(url);
    const arr = await resp.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(arr);
  }

  playAt(globalStartMs: number, globalNow: () => number) {
    if (!this.buffer) return;

    const localDelay = (globalStartMs - globalNow()) / 1000;
    if (localDelay < -0.05) return;

    this.cleanup();

    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.ctx.destination);
    this.source.start(this.ctx.currentTime + localDelay);

    this.startTimeLocal = this.ctx.currentTime + localDelay;
    this.startTimeGlobal = globalStartMs;

    this.beginSyncLoop(globalNow);
  }

  beginSyncLoop(globalNow: () => number) {
    const tick = () => {
      if (!this.source || !this.startTimeLocal || !this.startTimeGlobal) return;

      const expected = (globalNow() - this.startTimeGlobal) / 1000;
      const actual = this.ctx.currentTime - this.startTimeLocal;
      const drift = actual - expected;

      if (Math.abs(drift) > 0.03) {
        console.log("drift correction:", drift);
        this.seek(expected);
      }

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }

  seek(sec: number) {
    if (!this.buffer) return;
    this.cleanup();
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.ctx.destination);
    this.source.start(0, sec);
    this.startTimeLocal = this.ctx.currentTime - sec;
    this.startTimeGlobal = performance.now() - sec * 1000;
  }

  cleanup() {
    if (this.source) {
      try { this.source.stop(); } catch {}
      this.source.disconnect();
      this.source = null;
    }
  }

  pause() {
    this.cleanup();
  }
}
