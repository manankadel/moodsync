/**
 * Unified player abstracting an <audio> element + YouTube IFrame Player behind one API.
 * Switches the underlying source on loadTrack(); the store talks only to this controller.
 */

declare global {
    interface Window {
        YT: any;
        onYouTubeIframeAPIReady?: () => void;
    }
}

type Listener = () => void;
type PlayerSource = 'audio' | 'yt' | 'none';

export interface TrackLike {
    audioUrl?: string | null;
    videoId?: string | null;
    duration?: number | null;
}

let ytApiPromise: Promise<void> | null = null;
const loadYTApi = (): Promise<void> => {
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve) => {
        if (typeof window === 'undefined') return resolve();
        if (window.YT && window.YT.Player) return resolve();
        const prior = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { prior?.(); resolve(); };
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
    });
    return ytApiPromise;
};

export class PlayerController {
    private audio: HTMLAudioElement;
    private yt: any = null;
    private ytReadyPromise: Promise<void> | null = null;
    private ytPendingVideoId: string | null = null;
    private ytIsPlaying = false;
    private ytCurrentTime = 0;
    private ytDuration = 0;
    private ytPollInterval: ReturnType<typeof setInterval> | null = null;
    private source: PlayerSource = 'none';
    private listeners: Record<string, Set<Listener>> = {
        timeupdate: new Set(), play: new Set(), pause: new Set(),
        waiting: new Set(), playing: new Set(), canplay: new Set(),
        ended: new Set(), loadedmetadata: new Set(),
    };

    constructor(container: HTMLElement) {
        this.audio = new Audio();
        this.audio.crossOrigin = 'anonymous';
        ['timeupdate','play','pause','waiting','playing','canplay','ended','loadedmetadata'].forEach(ev => {
            this.audio.addEventListener(ev, () => this.source === 'audio' && this.emit(ev));
        });
        this.initYT(container);
    }

    private initYT(container: HTMLElement) {
        const div = document.createElement('div');
        div.id = 'yt-player-' + Math.random().toString(36).slice(2, 8);
        container.appendChild(div);

        this.ytReadyPromise = loadYTApi().then(() => new Promise<void>((resolve) => {
            this.yt = new window.YT.Player(div.id, {
                height: '1', width: '1',
                playerVars: { autoplay: 0, controls: 0, disablekb: 1, modestbranding: 1, playsinline: 1, fs: 0, rel: 0 },
                events: {
                    onReady: () => {
                        if (this.ytPendingVideoId) {
                            this.yt.cueVideoById(this.ytPendingVideoId);
                            this.ytPendingVideoId = null;
                        }
                        resolve();
                    },
                    onStateChange: (e: any) => {
                        // 1=playing, 2=paused, 3=buffering, 0=ended, 5=cued
                        if (this.source !== 'yt') return;
                        if (e.data === 1) { this.ytIsPlaying = true; this.emit('playing'); this.emit('play'); this.startPolling(); }
                        else if (e.data === 2) { this.ytIsPlaying = false; this.emit('pause'); this.stopPolling(); }
                        else if (e.data === 3) { this.emit('waiting'); }
                        else if (e.data === 0) { this.ytIsPlaying = false; this.stopPolling(); this.emit('ended'); }
                        else if (e.data === 5) {
                            this.ytDuration = this.yt.getDuration?.() || 0;
                            this.emit('loadedmetadata');
                            this.emit('canplay');
                        }
                    },
                    onError: (e: any) => { console.error('[YT error]', e?.data); this.emit('ended'); },
                },
            });
        }));
    }

    private startPolling() {
        this.stopPolling();
        this.ytPollInterval = setInterval(() => {
            if (!this.yt || this.source !== 'yt') return;
            try {
                this.ytCurrentTime = this.yt.getCurrentTime?.() || 0;
                this.ytDuration = this.yt.getDuration?.() || this.ytDuration;
                this.emit('timeupdate');
            } catch { /* iframe not ready */ }
        }, 200);
    }
    private stopPolling() {
        if (this.ytPollInterval) { clearInterval(this.ytPollInterval); this.ytPollInterval = null; }
    }

    private emit(ev: string) { this.listeners[ev]?.forEach(fn => fn()); }
    on(ev: string, fn: Listener) { this.listeners[ev]?.add(fn); return () => this.listeners[ev]?.delete(fn); }

    /** Get the raw <audio> element — only safe to use for Web Audio routing when source==='audio'. */
    get audioElement() { return this.audio; }
    get activeSource(): PlayerSource { return this.source; }

    loadTrack(track: TrackLike | null) {
        if (!track) return;
        if (track.videoId) {
            if (this.source === 'audio') { this.audio.pause(); this.audio.src = ''; }
            this.source = 'yt';
            this.ytCurrentTime = 0;
            this.ytDuration = track.duration || 0;
            if (this.yt?.cueVideoById) {
                this.yt.cueVideoById(track.videoId);
            } else {
                this.ytPendingVideoId = track.videoId;
            }
        } else if (track.audioUrl) {
            if (this.source === 'yt' && this.yt?.pauseVideo) this.yt.pauseVideo();
            this.source = 'audio';
            if (this.audio.src !== track.audioUrl) {
                this.audio.src = track.audioUrl;
                this.audio.load();
            }
        }
    }

    play(): Promise<void> {
        if (this.source === 'yt') {
            if (this.yt?.playVideo) { this.yt.playVideo(); return Promise.resolve(); }
            return Promise.reject(new Error('YT not ready'));
        }
        return this.audio.play();
    }
    pause() {
        if (this.source === 'yt') this.yt?.pauseVideo?.();
        else this.audio.pause();
    }
    get paused() {
        if (this.source === 'yt') return !this.ytIsPlaying;
        return this.audio.paused;
    }
    get currentTime() {
        if (this.source === 'yt') return this.ytCurrentTime;
        return this.audio.currentTime;
    }
    set currentTime(t: number) {
        if (this.source === 'yt') {
            this.ytCurrentTime = t;
            this.yt?.seekTo?.(t, true);
        } else {
            this.audio.currentTime = t;
        }
    }
    get duration() {
        if (this.source === 'yt') return this.ytDuration;
        return this.audio.duration;
    }
    get volume() {
        if (this.source === 'yt') return (this.yt?.getVolume?.() ?? 100) / 100;
        return this.audio.volume;
    }
    set volume(v: number) {
        const clamped = Math.max(0, Math.min(1, v));
        this.audio.volume = clamped;
        this.yt?.setVolume?.(Math.round(clamped * 100));
    }
    /** YT only supports discrete rates; for tiny drift we just no-op on YT and rely on hard seeks. */
    set playbackRate(r: number) {
        if (this.source === 'audio') this.audio.playbackRate = r;
        // For YT we don't change rate — drift correction happens via seek in the syncLoop.
    }
    get playbackRate() {
        if (this.source === 'yt') return 1;
        return this.audio.playbackRate;
    }
}
