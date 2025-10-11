import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

// --- INTERFACES ---
interface Song { name: string; artist: string; albumArt: string | null; isUpload: boolean; audioUrl: string | null; }
interface User { name: string; isAdmin: boolean; }
declare global { interface Window { webkitAudioContext: any; } }
interface EqualizerSettings { bass: number; mids: number; treble: number; }
interface AudioNodes { context: AudioContext | null; source: MediaElementAudioSourceNode | null; bass: BiquadFilterNode | null; mids: BiquadFilterNode | null; treble: BiquadFilterNode | null; }
interface SyncState { isPlaying?: boolean; trackIndex?: number; volume?: number; isCollaborative?: boolean; equalizer?: EqualizerSettings; currentTime?: number; serverTimestamp?: number; }

interface RoomState {
  socket: Socket | null; audioElement: HTMLAudioElement | null;
  playlist: Song[]; currentTrackIndex: number; isPlaying: boolean; isSeeking: boolean;
  isAudioGraphConnected: boolean; roomCode: string; playlistTitle: string; username: string;
  users: User[]; volume: number; isCollaborative: boolean; isLoading: boolean; error: string | null;
  isAdmin: boolean; equalizer: EqualizerSettings; audioNodes: AudioNodes;
  currentTime: number; duration: number; isConnecting: boolean; isDisconnected: boolean;
  connect: (roomCode: string, username: string) => void; disconnect: () => void;
  primePlayer: () => void; _emitStateUpdate: (overrideState?: Partial<Omit<SyncState, 'serverTimestamp'>>) => void;
  syncPlayerState: (state: SyncState) => void;
  setRoomData: (data: { playlistTitle: string; playlist: Song[] }) => void;
  selectTrack: (index: number) => void; playPause: () => void; nextTrack: () => void; prevTrack: () => void;
  setVolume: (volume: number) => void; setEqualizer: (settings: EqualizerSettings) => void;
  uploadFile: (file: File, title?: string, artist?: string) => Promise<any>;
  setLoading: (loading: boolean) => void; setError: (error: string | null) => void;
  setIsSeeking: (seeking: boolean) => void;
}

let singletonAudioElement: HTMLAudioElement | null = null;
if (typeof window !== 'undefined') {
  singletonAudioElement = new Audio();
  singletonAudioElement.crossOrigin = 'anonymous';
}

export const useRoomStore = create<RoomState>()((set, get) => ({
  socket: null, audioElement: singletonAudioElement,
  playlist: [], currentTrackIndex: 0, isPlaying: false, isSeeking: false,
  isAudioGraphConnected: false, roomCode: '', playlistTitle: '', users: [], username: '',
  volume: 80, isCollaborative: true, isLoading: true, error: null, isAdmin: false,
  equalizer: { bass: 0, mids: 0, treble: 0 },
  audioNodes: { context: null, source: null, bass: null, mids: null, treble: null },
  currentTime: 0, duration: 0, isConnecting: false, isDisconnected: false,

  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error, isLoading: false }),
  setIsSeeking: (seeking) => set({ isSeeking: seeking }),

  connect: (roomCode, username) => {
    if (get().socket) return;
    set({ isConnecting: true, isDisconnected: false, username });
    const socket = io(API_URL, { transports: ['websocket'] });
    set({ socket, roomCode });

    socket.on('connect', () => {
      set({ isConnecting: false });
      socket.emit('join_room', { room_code: roomCode, username: get().username });
    });
    
    socket.on('disconnect', () => set({ isDisconnected: true }));
    socket.on('error', (data) => get().setError(data.message));
    socket.on('update_user_list', (users: User[]) => set({ users, isAdmin: !!users.find((u: User) => u.name === get().username)?.isAdmin }));
    socket.on('load_current_state', (state) => get().syncPlayerState(state));
    socket.on('sync_player_state', (state) => get().syncPlayerState(state));
    socket.on('refresh_playlist', (data) => get().setRoomData(data));
  },

  disconnect: () => {
    get().audioElement?.pause();
    get().socket?.disconnect();
    set({ socket: null, isAudioGraphConnected: false, playlist: [], currentTrackIndex: 0, isPlaying: false });
  },

  primePlayer: () => {
    if (get().isAudioGraphConnected) return;
    const audioEl = get().audioElement;
    if (!audioEl) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContext();
      if (context.state === 'suspended') context.resume();
      const source = context.createMediaElementSource(audioEl);
      const bass = context.createBiquadFilter(); bass.type = "lowshelf"; bass.frequency.value = 250;
      const mids = context.createBiquadFilter(); mids.type = "peaking"; mids.frequency.value = 1000; mids.Q.value = 0.8;
      const treble = context.createBiquadFilter(); treble.type = "highshelf"; treble.frequency.value = 3000;
      source.connect(bass).connect(mids).connect(treble).connect(context.destination);
      set({ audioNodes: { context, source, bass, mids, treble }, isAudioGraphConnected: true });
      audioEl.ontimeupdate = () => { if (!get().isSeeking) set({ currentTime: audioEl.currentTime }); };
      audioEl.onloadedmetadata = () => set({ duration: audioEl.duration });
      audioEl.onended = () => { if (get().isAdmin) get().nextTrack(); };
      audioEl.onplaying = () => { if(!get().isPlaying) set({ isPlaying: true }); };
      audioEl.onpause = () => { if(get().isPlaying) set({ isPlaying: false }); };
    } catch (e) { console.error("Critical error setting up Web Audio API.", e); }
  },

  _emitStateUpdate: (overrideState) => {
    const state = get();
    if (!state.socket || !state.isAdmin) return;
    const liveState: SyncState = {
      isPlaying: state.isPlaying, trackIndex: state.currentTrackIndex,
      currentTime: state.audioElement?.currentTime ?? 0, volume: state.volume,
      equalizer: state.equalizer, isCollaborative: state.isCollaborative, ...overrideState
    };
    state.socket.emit('update_player_state', { 
        room_code: state.roomCode, state: { ...liveState, serverTimestamp: Date.now() / 1000 } 
    });
  },
  
  syncPlayerState: (state) => {
    const { audioElement, currentTrackIndex, isPlaying, playlist, volume, equalizer, audioNodes } = get();
    if (!audioElement) return;

    if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
        const track = playlist[state.trackIndex];
        if (track?.audioUrl) { audioElement.src = track.audioUrl; audioElement.load(); }
        set({ currentTrackIndex: state.trackIndex });
    }
    
    if(state.currentTime !== undefined && Math.abs(state.currentTime - audioElement.currentTime) > 1.5) {
        audioElement.currentTime = state.currentTime;
    }
    
    if (state.isPlaying !== undefined && state.isPlaying !== isPlaying) {
        state.isPlaying ? audioElement.play().catch(e => console.warn("Autoplay was blocked by browser", e)) : audioElement.pause();
        set({ isPlaying: state.isPlaying });
    }
    
    if (state.volume !== undefined && state.volume !== volume) {
      set({ volume: state.volume });
      audioElement.volume = state.volume / 100;
    }

    if (state.equalizer && JSON.stringify(state.equalizer) !== JSON.stringify(equalizer)) { 
      set({ equalizer: state.equalizer });
      const { bass, mids, treble } = audioNodes;
      if (bass && mids && treble) {
        bass.gain.value = state.equalizer.bass;
        mids.gain.value = state.equalizer.mids;
        treble.gain.value = state.equalizer.treble;
      }
    }
  },

  setRoomData: (data) => set({ playlistTitle: data.playlistTitle, playlist: data.playlist, isLoading: false, error: null }),

  // --- SURGICAL FIX: "Act Locally First" Pattern ---
  playPause: () => {
    const { audioElement, isPlaying } = get();
    if (!audioElement) return;
    
    isPlaying ? audioElement.pause() : audioElement.play().catch(e => console.warn("Autoplay blocked by browser", e));
    set({isPlaying: !isPlaying}); // Update local state instantly for UI feedback
    get()._emitStateUpdate({ isPlaying: !isPlaying }); // Then, inform the server
  },

  selectTrack: (index) => {
      const { audioElement, playlist, currentTrackIndex } = get();
      if (!audioElement || index === currentTrackIndex) return;

      const track = playlist[index];
      if (track?.audioUrl) {
        audioElement.src = track.audioUrl;
        audioElement.load();
        audioElement.play().catch(e => console.warn("Autoplay blocked by browser", e));
        set({currentTrackIndex: index, isPlaying: true}); // Update local state instantly
        get()._emitStateUpdate({ trackIndex: index, currentTime: 0, isPlaying: true }); // Then, inform the server
      }
  },

  nextTrack: () => { const newIndex = (get().currentTrackIndex + 1) % get().playlist.length; get().selectTrack(newIndex); },
  prevTrack: () => { const newIndex = (get().currentTrackIndex - 1 + get().playlist.length) % get().playlist.length; get().selectTrack(newIndex); },
  
  setVolume: (volume) => {
    const { audioElement } = get();
    if (audioElement) audioElement.volume = volume / 100;
    set({ volume });
    get()._emitStateUpdate({ volume });
  },

  setEqualizer: (settings) => { 
    const { bass, mids, treble } = get().audioNodes;
    if (bass && mids && treble) {
      bass.gain.value = settings.bass;
      mids.gain.value = settings.mids;
      treble.gain.value = settings.treble;
    }
    set({ equalizer: settings });
    get()._emitStateUpdate({ equalizer: settings }); 
  },
  
  uploadFile: async (file, title, artist) => {
    const { roomCode } = get();
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API_URL}/api/upload`, { method: 'POST', body: formData });
    if (!res.ok) throw new Error('Upload failed');
    const { audioUrl } = await res.json();
    await fetch(`${API_URL}/api/room/${roomCode}/add-upload`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title || file.name.replace(/\.[^/.]+$/, ''), artist: artist || 'Unknown Artist', audioUrl })
    });
  },
}));