import { createWithEqualityFn } from 'zustand/traditional';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

export interface Song { 
    name: string; 
    artist: string; 
    isUpload: boolean; 
    audioUrl: string | null; 
    albumArt: string | null; 
    lyrics?: string | null;
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
    error: string | null;
    currentTime: number; 
    duration: number; 
    isDisconnected: boolean;
    statusMessage: string | null;
    clockOffset: number;
    lastSyncTime: number;
    isSeeking: boolean;
    isCollaborative: boolean;
    needsInteraction: boolean;
    userId: string;
    audioNodes: AudioNodes;
    equalizer: { bass: number; mids: number; treble: number };
    
    connect: (code: string, name: string) => void;
    disconnect: () => void;
    primePlayer: () => void;
    syncPlayerState: (state: any) => void;
    setRoomData: (data: any) => void;
    selectTrack: (index: number) => void;
    playPause: () => void;
    nextTrack: () => void;
    prevTrack: () => void;
    setVolume: (v: number) => void;
    uploadFile: (file: File, title?: string, artist?: string) => Promise<any>;
    toggleCollaborative: (val: boolean) => void;
    setLoading: (l: boolean) => void;
    setError: (e: string | null) => void;
    setIsSeeking: (s: boolean) => void;
    setNeedsInteraction: (n: boolean) => void;
    setEqualizer: (eq: { bass: number; mids: number; treble: number }) => void;
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

export const useRoomStore = createWithEqualityFn<RoomState>()((set, get) => ({
    socket: null,
    audioElement: (typeof window !== 'undefined') ? new Audio() : null,
    playlist: [], 
    currentTrackIndex: 0, 
    isPlaying: false, 
    isSeeking: false,
    roomCode: '', 
    playlistTitle: '', 
    users: [], 
    username: '',
    volume: 80, 
    isLoading: false, 
    error: null, 
    isAdmin: false,
    currentTime: 0, 
    duration: 0, 
    isDisconnected: false, 
    statusMessage: null, 
    clockOffset: 0,
    lastSyncTime: 0,
    isCollaborative: false, 
    needsInteraction: false,
    userId: getUserId(),
    audioNodes: {
        context: null,
        source: null,
        bass: null,
        mids: null,
        treble: null,
    },
    equalizer: { bass: 0, mids: 0, treble: 0 },

    setLoading: (l) => set({ isLoading: l }),
    setError: (e) => set({ error: e, isLoading: false }),
    setIsSeeking: (s) => set({ isSeeking: s }),
    setNeedsInteraction: (n) => set({ needsInteraction: n }),
    setEqualizer: (eq) => set({ equalizer: eq }),

    connect: (code, name) => {
        if (get().socket) return;
        set({ username: name, roomCode: code });
        
        const socket = io(API_URL, { 
            transports: ['polling', 'websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: 5
        });
        
        set({ socket });

        socket.on('connect', () => {
            socket.emit('join_room', { 
                room_code: code, 
                username: name, 
                uuid: get().userId 
            });
            set({ isDisconnected: false });
        });
        
        socket.on('role_update', (data: { isAdmin: boolean }) => {
            set({ isAdmin: data.isAdmin });
        });
        
        socket.on('update_user_list', (users: any[]) => {
            set({ users });
        });
        
        socket.on('status_update', (data: any) => {
            set({ statusMessage: data.message });
            if (data.error) {
                setTimeout(() => set({ statusMessage: null }), 3000);
            }
        });

        socket.on('sync_player_state', (s: any) => {
            get().syncPlayerState(s);
        });

        socket.on('sync_heartbeat', (s: any) => {
            get().syncPlayerState(s);
        });
        
        socket.on('refresh_playlist', (d: any) => {
            set({ playlist: d.playlist, playlistTitle: d.title });
            if (d.current_state) {
                get().syncPlayerState(d.current_state);
            }
        });
        
        socket.on('disconnect', () => {
            set({ isDisconnected: true });
        });

        socket.on('load_current_state', (state: any) => {
            get().syncPlayerState(state);
        });
    },

    disconnect: () => {
        get().socket?.disconnect();
        get().audioElement?.pause();
        set({ socket: null });
    },

    primePlayer: () => {
        const audio = get().audioElement;
        if (!audio) return;
        
        audio.crossOrigin = "anonymous";
        
        audio.ontimeupdate = () => {
            set({ currentTime: audio.currentTime });
        };
        
        audio.onloadedmetadata = () => {
            set({ duration: audio.duration });
            get().updateMediaSession();
        };
        
        audio.onended = () => {
            if (get().isAdmin) {
                get().nextTrack();
            }
        };

        // Initialize audio context for visualization
        if (typeof window !== 'undefined' && window.AudioContext) {
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            
            if (audioContext.state === 'suspended') {
                document.addEventListener('click', () => {
                    audioContext.resume().catch(() => {});
                }, { once: true });
            }

            try {
                const source = audioContext.createMediaElementSource(audio);
                const bass = audioContext.createBiquadFilter();
                const mids = audioContext.createBiquadFilter();
                const treble = audioContext.createBiquadFilter();

                bass.type = 'lowshelf';
                bass.frequency.value = 200;
                
                mids.type = 'peaking';
                mids.frequency.value = 3000;
                mids.Q.value = 1;
                
                treble.type = 'highshelf';
                treble.frequency.value = 3000;

                source.connect(bass);
                bass.connect(mids);
                mids.connect(treble);
                treble.connect(audioContext.destination);

                set({
                    audioNodes: {
                        context: audioContext,
                        source,
                        bass,
                        mids,
                        treble,
                    },
                });
            } catch (e) {
                console.error("Audio nodes setup error:", e);
            }
        }

        audio.play()
            .then(() => {
                audio.pause();
                set({ needsInteraction: false });
            })
            .catch(() => {
                set({ needsInteraction: true });
            });
    },

    setRoomData: (data) => {
        if (data.serverTime) {
            const latency = (Date.now() - performance.now()) / 1000;
            const offset = (data.serverTime * 1000) - Date.now();
            set({ 
                clockOffset: offset, 
                playlistTitle: data.title, 
                playlist: data.playlist,
                lastSyncTime: Date.now()
            });
        }
        if (data.current_state) {
            set({ isCollaborative: data.current_state.isCollaborative });
        }
    },

    syncPlayerState: (state: any) => {
        const { audioElement, currentTrackIndex, isPlaying, clockOffset } = get();
        if (!audioElement) return;

        // Update collaborative setting
        if (state.isCollaborative !== undefined) {
            set({ isCollaborative: state.isCollaborative });
        }

        // Recalibrate clock offset
        if (state.serverTime) {
            const newOffset = (state.serverTime * 1000) - Date.now();
            set({ 
                clockOffset: newOffset,
                lastSyncTime: Date.now()
            });
        }

        // Track index change
        if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
            set({ currentTrackIndex: state.trackIndex });
            if (get().playlist[state.trackIndex]?.audioUrl) {
                audioElement.src = get().playlist[state.trackIndex].audioUrl!;
                audioElement.load();
            }
            get().updateMediaSession();
        }

        // Playback sync logic
        if (state.isPlaying === true) {
            set({ isPlaying: true });
            
            if (state.startTimestamp !== undefined) {
                const serverNow = (Date.now() + get().clockOffset) / 1000;
                const expectedTime = serverNow - state.startTimestamp;
                
                // Only correct if drift is significant (> 500ms)
                if (Math.abs(audioElement.currentTime - expectedTime) > 0.5) {
                    if (expectedTime >= 0 && expectedTime < (audioElement.duration || Infinity)) {
                        audioElement.currentTime = expectedTime;
                        console.log(`[SYNC] Corrected drift: ${(audioElement.currentTime - expectedTime).toFixed(3)}s`);
                    }
                }
            }
            
            audioElement.play().catch(() => {
                set({ needsInteraction: true });
            });
        } else if (state.isPlaying === false) {
            set({ isPlaying: false });
            audioElement.pause();
            
            if (state.pausedAt !== undefined) {
                if (Math.abs(audioElement.currentTime - state.pausedAt) > 0.1) {
                    audioElement.currentTime = state.pausedAt;
                }
            }
        }
        
        // Volume sync
        if (state.volume !== undefined) {
            set({ volume: state.volume });
            audioElement.volume = state.volume / 100;
        }

        get().updateMediaSession();
    },

    playPause: () => {
        const { isPlaying, isAdmin, audioElement } = get();
        if (!isAdmin || !audioElement) return;
        
        if (isPlaying) {
            get()._emitStateUpdate({ 
                isPlaying: false, 
                pausedAt: audioElement.currentTime 
            });
        } else {
            get()._emitStateUpdate({ 
                isPlaying: true, 
                currentTime: audioElement.currentTime 
            });
        }
    },

    selectTrack: (index: number) => {
        if (!get().isAdmin) return;
        get()._emitStateUpdate({ 
            trackIndex: index, 
            isPlaying: true, 
            currentTime: 0 
        });
    },

    nextTrack: () => {
        const { playlist, currentTrackIndex } = get();
        if (playlist.length === 0) return;
        get().selectTrack((currentTrackIndex + 1) % playlist.length);
    },

    prevTrack: () => {
        const { playlist, currentTrackIndex } = get();
        if (playlist.length === 0) return;
        get().selectTrack((currentTrackIndex - 1 + playlist.length) % playlist.length);
    },
    
    setVolume: (v) => {
        set({ volume: v });
        if (get().audioElement) {
            get().audioElement!.volume = v / 100;
        }
    },

    toggleCollaborative: (val: boolean) => {
        if (!get().isAdmin) return;
        get().socket?.emit('toggle_settings', { 
            room_code: get().roomCode, 
            value: val 
        });
    },

    uploadFile: async (file, title, artist) => {
        const fd = new FormData();
        fd.append('file', file);
        
        const res = await fetch(`${API_URL}/api/upload-local`, { 
            method: 'POST', 
            body: fd 
        });
        
        if (!res.ok) {
            throw new Error('Upload failed');
        }
        
        const { audioUrl } = await res.json();
        const uuid = get().userId;
        
        const uploadRes = await fetch(`${API_URL}/api/room/${get().roomCode}/add-upload`, {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                title: title || file.name, 
                artist: artist || 'Local', 
                audioUrl, 
                uuid 
            })
        });

        if (!uploadRes.ok) {
            throw new Error('Failed to add track');
        }
    },

    _emitStateUpdate: (state) => {
        get().socket?.emit('update_player_state', { 
            room_code: get().roomCode, 
            state 
        });
    },
    
    updateMediaSession: () => {
        if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
        
        const { playlist, currentTrackIndex, isPlaying } = get();
        const track = playlist[currentTrackIndex];
        
        if (!track) return;
        
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.name, 
            artist: track.artist,
            artwork: [{ 
                src: '/favicon.ico', 
                sizes: '96x96', 
                type: 'image/png' 
            }]
        });
        
        navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
    }
}));