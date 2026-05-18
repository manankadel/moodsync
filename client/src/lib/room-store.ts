import { createWithEqualityFn } from 'zustand/traditional';
import { io, Socket } from 'socket.io-client';
import { PlayerController } from './player-controller';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

if (!API_URL) {
    console.error("CRITICAL: NEXT_PUBLIC_API_URL is missing. Please set it in Vercel.");
}

export interface Song {
    name: string; artist: string; isUpload?: boolean;
    audioUrl: string | null; albumArt: string | null; lyrics?: string | null;
    videoId?: string | null; duration?: number | null;
}

interface AudioNodes {
    context: AudioContext | null;
    source: MediaElementAudioSourceNode | null;
    bass: BiquadFilterNode | null;
    mids: BiquadFilterNode | null;
    treble: BiquadFilterNode | null;
}

interface RoomState {
    socket: Socket | null;
    player: PlayerController | null;
    audioElement: HTMLAudioElement | null;  // kept for Web Audio EQ routing on upload tracks
    playlist: Song[]; 
    currentTrackIndex: number; 
    isPlaying: boolean; 
    roomCode: string; 
    playlistTitle: string; 
    users: any[]; 
    username: string; 
    isAdmin: boolean;
    volume: number; 
    isLoading: boolean; 
    currentTime: number; 
    duration: number; 
    statusMessage: string | null;
    clockOffset: number; 
    lastSyncTime: number;          // RESTORED property
    isCollaborative: boolean;
    needsInteraction: boolean;
    userId: string;
    error: string | null;
    isDisconnected: boolean;
    audioNodes: AudioNodes;
    equalizer: { bass: number; mids: number; treble: number };
    isSeeking: boolean;
    repeatMode: 'off' | 'one' | 'all';
    isShuffle: boolean;

    // Actions
    connect: (code: string, name: string) => void;
    disconnect: () => void;
    initPlayer: (container: HTMLElement) => void;
    primePlayer: () => void;
    setRoomData: (data: any) => void;
    setLoading: (l: boolean) => void;
    setError: (e: string | null) => void;
    setNeedsInteraction: (n: boolean) => void;
    setIsSeeking: (s: boolean) => void;
    setEqualizer: (eq: { bass: number; mids: number; treble: number }) => void;

    syncLoop: () => void;
    playPause: () => void;
    nextTrack: () => void;
    prevTrack: () => void;
    setVolume: (v: number) => void;
    selectTrack: (index: number) => void;
    removeTrack: (index: number) => void;
    toggleRepeat: () => void;
    toggleShuffle: () => void;
    uploadFile: (file: File, title?: string, artist?: string) => Promise<any>;
    toggleCollaborative: (val: boolean) => void;
    _emitStateUpdate: (s: any) => void;
    updateMediaSession: () => void;
}

const getUserId = () => {
    if (typeof window === 'undefined') return '';
    let id = localStorage.getItem('moodsync_uid');
    if (!id) {
        id = Math.random().toString(36).substring(2) + Date.now().toString(36);
        localStorage.setItem('moodsync_uid', id);
    }
    return id;
};

// --- Sync Engine Globals ---
let syncInterval: NodeJS.Timeout | null = null;
let ntpInterval: NodeJS.Timeout | null = null;
let lastKnownServerStart: number | null = null;
let isActuallyPlaying = false;

export const useRoomStore = createWithEqualityFn<RoomState>()((set, get) => ({
    socket: null,
    player: null,
    audioElement: null,
    playlist: [], currentTrackIndex: 0, isPlaying: false, 
    roomCode: '', playlistTitle: '', users: [], username: '',
    isAdmin: false, volume: 80, isLoading: false, 
    currentTime: 0, duration: 0, statusMessage: null,
    clockOffset: 0, lastSyncTime: Date.now(), // Initial value
    isCollaborative: false, needsInteraction: false,
    userId: getUserId(),
    error: null,
    isDisconnected: false,
    isSeeking: false,
    repeatMode: 'off',
    isShuffle: false,
    equalizer: { bass: 0, mids: 0, treble: 0 },
    audioNodes: { context: null, source: null, bass: null, mids: null, treble: null },

    setLoading: (l) => set({ isLoading: l }),
    setError: (e) => set({ error: e, isLoading: false }),
    setNeedsInteraction: (n) => set({ needsInteraction: n }),
    setIsSeeking: (s) => set({ isSeeking: s }),
    setEqualizer: (eq) => set({ equalizer: eq }),

    connect: (code, name) => {
        if (get().socket) return;
        set({ username: name, roomCode: code });
        
        console.log(`Connecting to socket at: ${API_URL}`);
        
        const socket = io(API_URL!, { 
            transports: ['websocket', 'polling'], 
            reconnection: true,
            reconnectionAttempts: 20,
        });
        set({ socket });

        // 1. NTP Logic
        const syncClock = () => {
            const start = Date.now();
            socket.emit('get_server_time', {}, (data: any) => {
                const end = Date.now();
                const latency = (end - start) / 2; 
                const preciseServerTime = (data.serverTime * 1000);
                const offset = preciseServerTime - (end - latency);
                
                const current = get().clockOffset;
                set({ 
                    clockOffset: current === 0 ? offset : (current * 0.8 + offset * 0.2),
                    lastSyncTime: Date.now() // Update sync time on heartbeat
                });
            });
        };

        socket.on('connect', () => {
            socket.emit('join_room', { room_code: code, username: name, uuid: get().userId });
            set({ isDisconnected: false });
            syncClock(); 
            ntpInterval = setInterval(syncClock, 5000); 
            
            if (syncInterval) clearInterval(syncInterval);
            syncInterval = setInterval(get().syncLoop, 200); 
        });

        const handleState = (state: any) => {
            const { player, currentTrackIndex } = get();

            set({ lastSyncTime: Date.now() });
            if (!player) return;

            if (state.isCollaborative !== undefined) set({ isCollaborative: state.isCollaborative });

            if (state.trackIndex !== undefined) {
                const freshPlaylist = get().playlist;
                const track = freshPlaylist[state.trackIndex];
                const sourceMissing = player.activeSource === 'none';
                if (state.trackIndex !== currentTrackIndex || sourceMissing) {
                    set({ currentTrackIndex: state.trackIndex });
                    if (track) player.loadTrack(track);
                    get().updateMediaSession();
                }
            }

            if (state.isPlaying !== undefined) {
                isActuallyPlaying = state.isPlaying;
                set({ isPlaying: state.isPlaying });

                if (!state.isPlaying) {
                    player.pause();
                    player.playbackRate = 1.0;
                    lastKnownServerStart = null;
                }
            }

            if (state.startTimestamp) {
                lastKnownServerStart = state.startTimestamp;
            }

            if (state.volume !== undefined) {
                player.volume = state.volume / 100;
                set({ volume: state.volume });
            }
        };

        socket.on('sync_player_state', handleState);
        socket.on('load_current_state', handleState);
        socket.on('refresh_playlist', (d) => {
            set({ playlist: d.playlist, playlistTitle: d.title });
            if (d.current_state) handleState(d.current_state);
        });
        socket.on('status_update', (d) => {
            set({ statusMessage: d.message });
            if(d.error) setTimeout(() => set({ statusMessage: null }), 3000);
        });
        socket.on('role_update', (d) => set({ isAdmin: d.isAdmin }));
        socket.on('update_user_list', (u) => set({ users: u }));
        socket.on('disconnect', () => set({ isDisconnected: true }));
        socket.on('admin_transferred', (d) => {
            if (d.new_admin_uuid === get().userId) set({ isAdmin: true });
            else set({ isAdmin: false });
        });
    },

    disconnect: () => {
        get().socket?.disconnect();
        get().player?.pause();
        if (syncInterval) clearInterval(syncInterval);
        if (ntpInterval) clearInterval(ntpInterval);
        set({ socket: null });
    },

    setRoomData: (data) => {
        if (data.serverTime) {
            const offset = (data.serverTime * 1000) - Date.now();
            set({ clockOffset: offset, playlistTitle: data.title, playlist: data.playlist, lastSyncTime: Date.now() });
        }
        if (data.current_state) {
            set({ isCollaborative: data.current_state.isCollaborative });
            if (data.current_state.startTimestamp) {
                lastKnownServerStart = data.current_state.startTimestamp;
                isActuallyPlaying = data.current_state.isPlaying;
                set({ isPlaying: data.current_state.isPlaying });
            }
        }
        const player = get().player;
        const trackIdx = data.current_state?.trackIndex ?? 0;
        const track = data.playlist?.[trackIdx];
        if (player && track && player.activeSource === 'none') {
            set({ currentTrackIndex: trackIdx });
            player.loadTrack(track);
        }
    },

    initPlayer: (container: HTMLElement) => {
        if (get().player) return;
        const player = new PlayerController(container);
        const audio = player.audioElement;

        player.on('timeupdate', () => set({ currentTime: player.currentTime }));
        player.on('loadedmetadata', () => {
            set({ duration: player.duration });
            get().updateMediaSession();
        });
        player.on('ended', () => { if (get().isAdmin) get().nextTrack(); });

        set({ player, audioElement: audio });
    },

    primePlayer: () => {
        const { player } = get();
        if (!player) return;
        const audio = player.audioElement;

        if (typeof window !== 'undefined' && window.AudioContext) {
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});

            try {
                if (!get().audioNodes.context) {
                    const source = audioContext.createMediaElementSource(audio);
                    const bass = audioContext.createBiquadFilter();
                    const mids = audioContext.createBiquadFilter();
                    const treble = audioContext.createBiquadFilter();

                    bass.type = 'lowshelf'; bass.frequency.value = 200;
                    mids.type = 'peaking'; mids.frequency.value = 3000; mids.Q.value = 1;
                    treble.type = 'highshelf'; treble.frequency.value = 3000;

                    source.connect(bass);
                    bass.connect(mids);
                    mids.connect(treble);
                    treble.connect(audioContext.destination);

                    set({ audioNodes: { context: audioContext, source, bass, mids, treble } });
                }
            } catch (e) { console.error("Audio nodes setup error:", e); }
        }

        // Best-effort unlock via the audio element. The YT iframe unlocks on first playVideo() call.
        audio.play().then(() => {
            if (!isActuallyPlaying) audio.pause();
            set({ needsInteraction: false });
        }).catch(() => set({ needsInteraction: true }));
    },

    syncLoop: () => {
        const { player, clockOffset, isSeeking } = get();
        if (!player || !isActuallyPlaying || !lastKnownServerStart || isSeeking) return;

        const serverNow = (Date.now() + clockOffset) / 1000;
        const expectedTime = serverNow - lastKnownServerStart;
        const actualTime = player.currentTime;
        const diff = expectedTime - actualTime;
        const isYT = player.activeSource === 'yt';

        set({ currentTime: actualTime });

        if (expectedTime >= player.duration && player.duration > 0) {
            if (get().isAdmin) get().nextTrack();
            return;
        }

        if (player.paused) {
            if (expectedTime > 0 && expectedTime < (player.duration || 1000)) {
                player.currentTime = expectedTime;
                player.play().catch(() => set({ needsInteraction: true }));
            }
            return;
        }

        // YT can't do micro rate-adjust → use a tighter seek-only threshold.
        const seekThreshold = isYT ? 0.5 : 2.0;
        if (Math.abs(diff) > seekThreshold) {
            player.currentTime = expectedTime;
        } else if (!isYT) {
            if (diff > 0.15) {
                if (player.playbackRate !== 1.05) player.playbackRate = 1.05;
            } else if (diff < -0.15) {
                if (player.playbackRate !== 0.95) player.playbackRate = 0.95;
            } else if (player.playbackRate !== 1.0) {
                player.playbackRate = 1.0;
            }
        }
    },

    playPause: () => {
        const { isPlaying, isAdmin, player, clockOffset } = get();
        if (!isAdmin || !player) return;

        if (isPlaying) {
            get()._emitStateUpdate({ isPlaying: false, pausedAt: player.currentTime });
        } else {
            const serverNow = (Date.now() + clockOffset) / 1000;
            const startTimestamp = (serverNow + 0.5) - player.currentTime;
            get()._emitStateUpdate({ isPlaying: true, startTimestamp });
        }
    },

    selectTrack: (index) => {
        if (!get().isAdmin) return;
        const serverNow = (Date.now() + get().clockOffset) / 1000;
        get()._emitStateUpdate({ 
            trackIndex: index, 
            isPlaying: true, 
            startTimestamp: serverNow + 1.0 
        });
    },

    uploadFile: async (file, title, artist) => {
        const fd = new FormData(); fd.append('file', file);
        const res = await fetch(`${API_URL}/api/upload-local`, { method: 'POST', body: fd });
        if (!res.ok) throw new Error('Upload failed');
        const { audioUrl } = await res.json();
        
        await fetch(`${API_URL}/api/room/${get().roomCode}/add-upload`, {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                title: title || file.name, 
                artist: artist || 'Local', 
                audioUrl, 
                uuid: get().userId 
            })
        });
    },

    nextTrack: () => {
        const { playlist, currentTrackIndex, repeatMode, isShuffle } = get();
        if (!playlist.length) return;
        if (repeatMode === 'one') { get().selectTrack(currentTrackIndex); return; }
        if (isShuffle) {
            let next = Math.floor(Math.random() * playlist.length);
            if (playlist.length > 1) while (next === currentTrackIndex) next = Math.floor(Math.random() * playlist.length);
            get().selectTrack(next);
            return;
        }
        const isLast = currentTrackIndex >= playlist.length - 1;
        if (isLast) {
            if (repeatMode === 'all') { get().selectTrack(0); }
            else { get()._emitStateUpdate({ isPlaying: false, pausedAt: 0, trackIndex: 0 }); }
        } else {
            get().selectTrack(currentTrackIndex + 1);
        }
    },
    prevTrack: () => { const p = get().playlist; if (p.length) get().selectTrack((get().currentTrackIndex - 1 + p.length) % p.length); },
    setVolume: (v) => { set({ volume: v }); const p = get().player; if (p) p.volume = v / 100; },
    removeTrack: (index) => {
        if (!get().isAdmin) return;
        get().socket?.emit('remove_track', { room_code: get().roomCode, track_index: index });
    },
    toggleRepeat: () => {
        const modes: Array<'off' | 'one' | 'all'> = ['off', 'all', 'one'];
        const current = get().repeatMode;
        const next = modes[(modes.indexOf(current) + 1) % modes.length];
        set({ repeatMode: next });
    },
    toggleShuffle: () => set(s => ({ isShuffle: !s.isShuffle })),
    toggleCollaborative: (val) => get().socket?.emit('toggle_settings', { room_code: get().roomCode, value: val }),
    _emitStateUpdate: (state) => get().socket?.emit('update_player_state', { room_code: get().roomCode, state }),
    updateMediaSession: () => {
        if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
        const track = get().playlist[get().currentTrackIndex];
        if (!track) return;
        navigator.mediaSession.metadata = new MediaMetadata({ title: track.name, artist: track.artist });
        navigator.mediaSession.playbackState = get().isPlaying ? "playing" : "paused";
    }
}));