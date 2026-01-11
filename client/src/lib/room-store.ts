import { createWithEqualityFn } from 'zustand/traditional';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

if (!API_URL) {
    console.error("CRITICAL: NEXT_PUBLIC_API_URL is missing. Please set it in Vercel.");
}

export interface Song { 
    name: string; artist: string; isUpload: boolean; 
    audioUrl: string | null; albumArt: string | null; lyrics?: string | null;
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
    audioElement: HTMLAudioElement | null;
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
    
    // Actions
    connect: (code: string, name: string) => void;
    disconnect: () => void;
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
    audioElement: (typeof window !== 'undefined') ? new Audio() : null,
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
            const { audioElement, currentTrackIndex, playlist } = get();
            
            // Mark sync as active
            set({ lastSyncTime: Date.now() });

            if (!audioElement) return;

            if (state.isCollaborative !== undefined) set({ isCollaborative: state.isCollaborative });

            if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
                set({ currentTrackIndex: state.trackIndex });
                if (playlist[state.trackIndex]?.audioUrl) {
                    audioElement.src = playlist[state.trackIndex].audioUrl!;
                    audioElement.load();
                }
                get().updateMediaSession();
            }

            if (state.isPlaying !== undefined) {
                isActuallyPlaying = state.isPlaying;
                set({ isPlaying: state.isPlaying });
                
                if (!state.isPlaying) {
                    audioElement.pause();
                    audioElement.playbackRate = 1.0;
                    lastKnownServerStart = null;
                }
            }

            if (state.startTimestamp) {
                lastKnownServerStart = state.startTimestamp;
            }

            if (state.volume !== undefined) {
                audioElement.volume = state.volume / 100;
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
    },

    disconnect: () => {
        get().socket?.disconnect();
        get().audioElement?.pause();
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
    },

    primePlayer: () => {
        const audio = get().audioElement;
        if (!audio) return;
        
        audio.crossOrigin = "anonymous";
        audio.ontimeupdate = () => set({ currentTime: audio.currentTime });
        
        audio.onloadedmetadata = () => {
            set({ duration: audio.duration });
            get().updateMediaSession();
        };
        
        audio.onended = () => { if (get().isAdmin) get().nextTrack(); };

        if (typeof window !== 'undefined' && window.AudioContext) {
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            if (audioContext.state === 'suspended') {
                audioContext.resume().catch(() => {});
            }

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

        audio.play().then(() => { 
            if (!isActuallyPlaying) audio.pause(); 
            set({ needsInteraction: false }); 
        })
        .catch(() => set({ needsInteraction: true }));
    },

    syncLoop: () => {
        const { audioElement, clockOffset, isSeeking } = get();
        if (!audioElement || !isActuallyPlaying || !lastKnownServerStart || isSeeking) return;

        const serverNow = (Date.now() + clockOffset) / 1000;
        const expectedTime = serverNow - lastKnownServerStart;
        const actualTime = audioElement.currentTime;
        const diff = expectedTime - actualTime;

        set({ currentTime: actualTime });

        if (expectedTime >= audioElement.duration && audioElement.duration > 0) {
            if (get().isAdmin) get().nextTrack();
            return;
        }

        if (audioElement.paused) {
            if (expectedTime > 0 && expectedTime < (audioElement.duration || 1000)) {
                audioElement.currentTime = expectedTime;
                audioElement.play().catch(() => set({ needsInteraction: true }));
            }
            return;
        }

        if (Math.abs(diff) > 2.0) {
            audioElement.currentTime = expectedTime;
        } else if (diff > 0.15) {
            if (audioElement.playbackRate !== 1.05) audioElement.playbackRate = 1.05;
        } else if (diff < -0.15) {
            if (audioElement.playbackRate !== 0.95) audioElement.playbackRate = 0.95;
        } else {
            if (audioElement.playbackRate !== 1.0) audioElement.playbackRate = 1.0;
        }
    },

    playPause: () => {
        const { isPlaying, isAdmin, audioElement, clockOffset } = get();
        if (!isAdmin || !audioElement) return;

        if (isPlaying) {
            get()._emitStateUpdate({ isPlaying: false, pausedAt: audioElement.currentTime });
        } else {
            const serverNow = (Date.now() + clockOffset) / 1000;
            const startTimestamp = (serverNow + 0.5) - audioElement.currentTime;
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

    nextTrack: () => { const p = get().playlist; if (p.length) get().selectTrack((get().currentTrackIndex + 1) % p.length); },
    prevTrack: () => { const p = get().playlist; if (p.length) get().selectTrack((get().currentTrackIndex - 1 + p.length) % p.length); },
    setVolume: (v) => { set({ volume: v }); if (get().audioElement) get().audioElement!.volume = v / 100; },
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