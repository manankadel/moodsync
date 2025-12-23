import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

// --- INTERFACES ---
export interface Song { 
    name: string; 
    artist: string; 
    isUpload: boolean; 
    audioUrl: string | null; 
    albumArt: string | null; 
    lyrics?: string | null;
}
interface User { name: string; isAdmin: boolean; }
interface EqualizerSettings { bass: number; mids: number; treble: number; }
interface AudioNodes { context: AudioContext | null; source: MediaElementAudioSourceNode | null; bass: BiquadFilterNode | null; mids: BiquadFilterNode | null; treble: BiquadFilterNode | null; }
interface SyncState { isPlaying?: boolean; trackIndex?: number; volume?: number; equalizer?: EqualizerSettings; currentTime?: number; serverTimestamp?: number; }

declare global { 
    interface Window { webkitAudioContext: any; } 
}

interface RoomState {
  socket: Socket | null; audioElement: HTMLAudioElement | null;
  playlist: Song[]; currentTrackIndex: number; isPlaying: boolean; isSeeking: boolean;
  isAudioGraphConnected: boolean; roomCode: string; playlistTitle: string; username: string;
  users: User[]; volume: number; isLoading: boolean; error: string | null; isAdmin: boolean;
  equalizer: EqualizerSettings; audioNodes: AudioNodes; currentTime: number; duration: number;
  isConnecting: boolean; isDisconnected: boolean;
  connect: (roomCode: string, username: string) => void;
  disconnect: () => void;
  primePlayer: () => void;
  _emitStateUpdate: (overrideState?: Partial<SyncState>) => void;
  syncPlayerState: (state: SyncState) => void;
  setRoomData: (data: { title: string | undefined; playlistTitle: string; playlist: Song[] }) => void;
  selectTrack: (index: number) => void;
  playPause: () => void;
  nextTrack: () => void;
  prevTrack: () => void;
  setVolume: (volume: number) => void;
  setEqualizer: (settings: EqualizerSettings) => void;
  uploadFile: (file: File, title?: string, artist?: string) => Promise<any>;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setIsSeeking: (seeking: boolean) => void;
  updateMediaSession: () => void; 
}

let audioEl: HTMLAudioElement | null = null;
if (typeof window !== 'undefined') {
  audioEl = new Audio();
  audioEl.crossOrigin = 'anonymous';
  audioEl.preload = "auto";
}

export const useRoomStore = create<RoomState>()((set, get) => ({
  socket: null, audioElement: audioEl,
  playlist: [], currentTrackIndex: 0, isPlaying: false, isSeeking: false,
  isAudioGraphConnected: false, roomCode: '', playlistTitle: '', users: [], username: '',
  volume: 80, isLoading: false, error: null, isAdmin: false,
  equalizer: { bass: 0, mids: 0, treble: 0 },
  audioNodes: { context: null, source: null, bass: null, mids: null, treble: null },
  currentTime: 0, duration: 0, isConnecting: false, isDisconnected: false,

  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error, isLoading: false }),
  setIsSeeking: (seeking) => set({ isSeeking: seeking }),

  connect: (code, name) => {
    if (get().socket) return;
    set({ username: name, roomCode: code });
    
    // Allow polling to fix Render connection issues
    const socket = io(API_URL, { 
        transports: ['polling', 'websocket'], 
        reconnection: true,
        timeout: 20000,
    });
    set({ socket });

    socket.on('connect', () => {
        console.log("✅ Socket connected");
        socket.emit('join_room', { room_code: code, username: name });
        set({ isDisconnected: false });
    });
    
    socket.on('update_user_list', (users) => set({ users, isAdmin: users.find((u: User) => u.name === get().username)?.isAdmin ?? false }));
    socket.on('load_current_state', (state) => get().syncPlayerState(state));
    socket.on('sync_player_state', (state) => get().syncPlayerState(state));
    socket.on('refresh_playlist', (data) => {
        get().setRoomData(data);
        get().updateMediaSession();
    });
    socket.on('disconnect', () => set({ isDisconnected: true }));
  },

  disconnect: () => {
    get().socket?.disconnect();
    get().audioElement?.pause();
    set({ socket: null });
  },

  primePlayer: () => {
    const audio = get().audioElement;
    if (!audio || get().isAudioGraphConnected) return;

    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const context = new AudioContext();
        if (context.state === 'suspended') context.resume();
        
        const source = context.createMediaElementSource(audio);
        const bass = context.createBiquadFilter(); bass.type = "lowshelf"; bass.frequency.value = 250;
        const mids = context.createBiquadFilter(); mids.type = "peaking"; mids.frequency.value = 1000; mids.Q.value = 0.8;
        const treble = context.createBiquadFilter(); treble.type = "highshelf"; treble.frequency.value = 3000;
        
        source.connect(bass).connect(mids).connect(treble).connect(context.destination);
        set({ audioNodes: { context, source, bass, mids, treble }, isAudioGraphConnected: true });
        console.log("✅ Audio Graph Primed");

        if ('wakeLock' in navigator) {
            // @ts-ignore
            navigator.wakeLock.request('screen').catch(() => {});
        }

        audio.ontimeupdate = () => set({ currentTime: audio.currentTime });
        audio.onloadedmetadata = () => {
            set({ duration: audio.duration });
            get().updateMediaSession();
        };
        audio.onended = () => { if(get().isAdmin) get().nextTrack(); };
        // Sync state when audio actually starts playing/pausing to avoid loops
        audio.onplay = () => set({ isPlaying: true });
        audio.onpause = () => set({ isPlaying: false });

    } catch (e) { console.error("Audio Prime Failed:", e); }
  },

  updateMediaSession: () => {
    if (!('mediaSession' in navigator)) return;
    const { playlist, currentTrackIndex, isPlaying } = get();
    const track = playlist[currentTrackIndex];
    if (!track) return;

    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.name,
            artist: track.artist,
            artwork: [{ src: '/favicon.ico', sizes: '96x96', type: 'image/png' }]
        });
        navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
        
        navigator.mediaSession.setActionHandler('play', () => get().isAdmin && get().playPause());
        navigator.mediaSession.setActionHandler('pause', () => get().isAdmin && get().playPause());
        navigator.mediaSession.setActionHandler('nexttrack', () => get().isAdmin && get().nextTrack());
        navigator.mediaSession.setActionHandler('previoustrack', () => get().isAdmin && get().prevTrack());
    } catch(e) {}
  },
  
  _emitStateUpdate: (overrideState?: Partial<SyncState>) => {
    const state = get();
    if (!state.socket || !state.isAdmin) return;
    state.socket.emit('update_player_state', { 
        room_code: state.roomCode, 
        state: { 
            isPlaying: state.isPlaying, 
            trackIndex: state.currentTrackIndex, 
            currentTime: state.audioElement?.currentTime ?? 0, 
            volume: state.volume, 
            equalizer: state.equalizer, 
            serverTimestamp: Date.now() / 1000, 
            ...overrideState 
        } 
    });
  },

  syncPlayerState: (state) => {
    const { audioElement, currentTrackIndex, isPlaying, isAdmin, playlist } = get();
    if (!audioElement || isAdmin) return;

    // 1. Sync Track
    if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
        const track = playlist[state.trackIndex];
        if (track?.audioUrl) { 
            audioElement.src = track.audioUrl; 
            // Important: Don't call play() here. Wait for isPlaying check.
        }
        set({ currentTrackIndex: state.trackIndex });
        get().updateMediaSession();
    }

    // 2. Sync Time (Drift Correction)
    if (state.currentTime !== undefined) {
        const drift = Math.abs(state.currentTime - audioElement.currentTime);
        if (drift > 2.0) audioElement.currentTime = state.currentTime; 
    }

    // 3. Sync Play/Pause (SAFE PLAY)
    if (state.isPlaying !== undefined && state.isPlaying !== isPlaying) {
        set({ isPlaying: state.isPlaying });
        if (state.isPlaying) {
            const playPromise = audioElement.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.log("Autoplay prevented or interrupted:", error);
                });
            }
        } else {
            audioElement.pause();
        }
        get().updateMediaSession();
    }
  },

  setRoomData: (data) => set({ playlistTitle: data.title, playlist: data.playlist, isLoading: false, error: null }),

  playPause: () => {
    if (!get().isAdmin) return;
    const { audioElement, isPlaying } = get();
    // Optimistic UI update
    set({ isPlaying: !isPlaying });
    
    if (!isPlaying) {
        audioElement?.play().catch(console.error);
    } else {
        audioElement?.pause();
    }
    
    get()._emitStateUpdate({ isPlaying: !isPlaying, currentTime: audioElement?.currentTime });
    get().updateMediaSession();
  },
  
  selectTrack: (index) => {
    if (!get().isAdmin) return;
    const { playlist, audioElement } = get();
    const track = playlist[index];
    if (track?.audioUrl && audioElement) {
      audioElement.src = track.audioUrl;
      audioElement.play().catch(console.error);
      set({ currentTrackIndex: index, isPlaying: true });
      get()._emitStateUpdate({ trackIndex: index, currentTime: 0, isPlaying: true });
      get().updateMediaSession();
    }
  },

  nextTrack: () => get().selectTrack((get().currentTrackIndex + 1) % get().playlist.length),
  prevTrack: () => get().selectTrack((get().currentTrackIndex - 1 + get().playlist.length) % get().playlist.length),
  
  setVolume: (volume) => {
    const { audioElement } = get();
    set({ volume });
    if (audioElement) audioElement.volume = volume / 100;
    if(get().isAdmin) get()._emitStateUpdate({ volume });
  },

  setEqualizer: (settings) => {
    set({equalizer: settings})
    const { bass, mids, treble } = get().audioNodes;
    if (bass && mids && treble) {
        bass.gain.value = settings.bass;
        mids.gain.value = settings.mids;
        treble.gain.value = settings.treble;
    }
    get()._emitStateUpdate({ equalizer: settings });
  },

  uploadFile: async (file: File, title?: string, artist?: string) => {
      const state = get();
      const formData = new FormData();
      formData.append('file', file);
      
      const res = await fetch(`${API_URL}/api/upload-local`, { method: 'POST', body: formData });
      if (!res.ok) throw new Error(`Upload failed: ${await res.text()}`);
      const { audioUrl } = await res.json();
      
      await fetch(`${API_URL}/api/room/${state.roomCode}/add-upload`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title || file.name.replace(/\.[^/.]+$/, ''), artist: artist || 'Unknown Artist', audioUrl })
      });
  },
}));