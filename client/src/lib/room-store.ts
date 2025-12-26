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

interface RoomState {
  socket: Socket | null; 
  audioElement: HTMLAudioElement | null;
  playlist: Song[]; 
  currentTrackIndex: number; 
  isPlaying: boolean; 
  isSeeking: boolean; // <--- FIXED: Explicitly defined
  isAudioGraphConnected: boolean; 
  roomCode: string; 
  playlistTitle: string; 
  users: any[]; 
  username: string;
  volume: number; 
  isLoading: boolean; 
  error: string | null; 
  isAdmin: boolean;
  currentTime: number; 
  duration: number; 
  isDisconnected: boolean;
  statusMessage: string | null; // <--- FIXED: Explicitly defined
  clockOffset: number;

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
  setLoading: (l: boolean) => void;
  setError: (e: string | null) => void;
  setIsSeeking: (s: boolean) => void;
  updateMediaSession: () => void;
  _emitStateUpdate: (s: any) => void;
}

export const useRoomStore = createWithEqualityFn<RoomState>()((set, get) => ({
  socket: null,
  audioElement: (typeof window !== 'undefined') ? new Audio() : null,
  playlist: [], currentTrackIndex: 0, isPlaying: false, isSeeking: false,
  isAudioGraphConnected: false, roomCode: '', playlistTitle: '', users: [], username: '',
  volume: 80, isLoading: false, error: null, isAdmin: false,
  currentTime: 0, duration: 0, isDisconnected: false, 
  statusMessage: null,
  clockOffset: 0,

  setLoading: (l) => set({ isLoading: l }),
  setError: (e) => set({ error: e, isLoading: false }),
  setIsSeeking: (s) => set({ isSeeking: s }),

  connect: (code, name) => {
    if (get().socket) return;
    set({ username: name, roomCode: code });
    const socket = io(API_URL, { transports: ['polling', 'websocket'] });
    set({ socket });

    socket.on('connect', () => {
        socket.emit('join_room', { room_code: code, username: name });
        set({ isDisconnected: false });
    });
    
    socket.on('update_user_list', (users: any) => set({ users, isAdmin: users.find((u: any) => u.name === name)?.isAdmin ?? false }));
    
    socket.on('status_update', (data: any) => {
        set({ statusMessage: data.message });
        if(data.error) setTimeout(() => set({ statusMessage: null }), 3000);
    });

    socket.on('sync_player_state', (s: any) => get().syncPlayerState(s));
    
    socket.on('refresh_playlist', (d: any) => {
        set({ playlist: d.playlist, playlistTitle: d.title });
        if (d.current_state) get().syncPlayerState(d.current_state);
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
    if (!audio) return;
    audio.crossOrigin = "anonymous";
    audio.ontimeupdate = () => set({ currentTime: audio.currentTime });
    audio.onloadedmetadata = () => {
        set({ duration: audio.duration });
        get().updateMediaSession();
    };
    audio.onended = () => get().isAdmin && get().nextTrack();
    
    audio.play().then(() => audio.pause()).catch(() => {});
  },

  setRoomData: (data) => {
      if (data.serverTime) {
          const offset = (data.serverTime * 1000) - Date.now();
          set({ clockOffset: offset, playlistTitle: data.title, playlist: data.playlist });
      } else {
          set({ playlistTitle: data.title, playlist: data.playlist });
      }
  },

  syncPlayerState: (state: any) => {
    const { audioElement, currentTrackIndex, isPlaying, playlist } = get();
    if (!audioElement) return;

    if (state.serverTime) {
        const offset = (state.serverTime * 1000) - Date.now();
        set({ clockOffset: offset });
    }

    if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
        set({ currentTrackIndex: state.trackIndex });
        if (playlist[state.trackIndex]?.audioUrl) {
            audioElement.src = playlist[state.trackIndex].audioUrl!;
            audioElement.load();
        }
        get().updateMediaSession();
    }

    if (state.isPlaying) {
        set({ isPlaying: true });
        
        // Wall-Clock Sync Calculation
        if (state.startTimestamp) {
            const serverNow = Date.now() / 1000;
            // Apply simple offset correction if needed
            const correctTime = serverNow - state.startTimestamp; 
            
            if (Math.abs(audioElement.currentTime - correctTime) > 0.5) {
                audioElement.currentTime = correctTime;
            }
        }
        
        audioElement.play().catch(() => {});
    } else {
        set({ isPlaying: false });
        audioElement.pause();
        if (state.pausedAt !== undefined) {
             if (Math.abs(audioElement.currentTime - state.pausedAt) > 0.5) {
                 audioElement.currentTime = state.pausedAt;
             }
        }
    }
    
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
        get()._emitStateUpdate({ isPlaying: false, pausedAt: audioElement.currentTime });
    } else {
        get()._emitStateUpdate({ isPlaying: true, pausedAt: audioElement.currentTime });
    }
  },

  selectTrack: (index) => {
    if (!get().isAdmin) return;
    get()._emitStateUpdate({ trackIndex: index, isPlaying: true, currentTime: 0 });
  },

  nextTrack: () => get().selectTrack((get().currentTrackIndex + 1) % get().playlist.length),
  prevTrack: () => get().selectTrack((get().currentTrackIndex - 1 + get().playlist.length) % get().playlist.length),
  
  setVolume: (v) => {
    set({ volume: v });
    if (get().audioElement) get().audioElement!.volume = v / 100;
    get()._emitStateUpdate({ volume: v });
  },

  uploadFile: async (file, title, artist) => {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_URL}/api/upload-local`, { method: 'POST', body: fd });
      const { audioUrl } = await res.json();
      await fetch(`${API_URL}/api/room/${get().roomCode}/add-upload`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title || file.name, artist: artist || 'Local', audioUrl })
      });
  },

  _emitStateUpdate: (state) => {
      get().socket?.emit('update_player_state', { room_code: get().roomCode, state });
  },
  
  updateMediaSession: () => {
      if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
      const { playlist, currentTrackIndex, isPlaying } = get();
      const track = playlist[currentTrackIndex];
      if (!track) return;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name, artist: track.artist,
        artwork: [{ src: '/favicon.ico', sizes: '96x96', type: 'image/png' }]
      });
      navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }
}));