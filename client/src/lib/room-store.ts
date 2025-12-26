import { createWithEqualityFn } from 'zustand/traditional';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

export interface Song { 
    name: string; artist: string; isUpload: boolean; 
    audioUrl: string | null; albumArt: string | null; lyrics?: string | null;
}

interface RoomState {
  socket: Socket | null; 
  audioElement: HTMLAudioElement | null;
  playlist: Song[]; currentTrackIndex: number; isPlaying: boolean; 
  roomCode: string; playlistTitle: string; 
  users: any[]; username: string; isAdmin: boolean;
  volume: number; isLoading: boolean; error: string | null;
  currentTime: number; duration: number; isDisconnected: boolean;
  statusMessage: string | null;
  clockOffset: number; 
  isSeeking: boolean;
  isCollaborative: boolean; // NEW
  needsInteraction: boolean; // NEW: Triggers "Tap to Join"
  
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
  _emitStateUpdate: (s: any) => void;
  updateMediaSession: () => void;
}

export const useRoomStore = createWithEqualityFn<RoomState>()((set, get) => ({
  socket: null,
  audioElement: (typeof window !== 'undefined') ? new Audio() : null,
  playlist: [], currentTrackIndex: 0, isPlaying: false, isSeeking: false,
  isAudioGraphConnected: false, roomCode: '', playlistTitle: '', users: [], username: '',
  volume: 80, isLoading: false, error: null, isAdmin: false,
  currentTime: 0, duration: 0, isDisconnected: false, 
  statusMessage: null, clockOffset: 0, 
  isCollaborative: false, needsInteraction: false,

  setLoading: (l) => set({ isLoading: l }),
  setError: (e) => set({ error: e, isLoading: false }),
  setIsSeeking: (s) => set({ isSeeking: s }),
  setNeedsInteraction: (n) => set({ needsInteraction: n }),

  connect: (code, name) => {
    if (get().socket) return;
    set({ username: name, roomCode: code });
    const socket = io(API_URL, { transports: ['polling', 'websocket'] });
    set({ socket });

    socket.on('connect', () => {
        socket.emit('join_room', { room_code: code, username: name });
        set({ isDisconnected: false });
    });
    
    socket.on('role_update', (data: { isAdmin: boolean }) => {
        set({ isAdmin: data.isAdmin });
    });
    
    socket.on('update_user_list', (users: any[]) => set({ users }));
    
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
    
    // Attempt silent unlock
    audio.play().then(() => {
        audio.pause();
        set({ needsInteraction: false });
    }).catch(() => {
        set({ needsInteraction: true });
    });
  },

  setRoomData: (data) => {
      if (data.serverTime) {
          const latency = 0.2; 
          const offset = (data.serverTime * 1000) - Date.now() + (latency * 1000);
          set({ clockOffset: offset, playlistTitle: data.title, playlist: data.playlist });
      }
      if (data.current_state) {
          set({ isCollaborative: data.current_state.isCollaborative });
      }
  },

  syncPlayerState: (state: any) => {
    const { audioElement, currentTrackIndex, isPlaying } = get();
    if (!audioElement) return;

    if (state.isCollaborative !== undefined) set({ isCollaborative: state.isCollaborative });
    if (state.serverTime) set({ clockOffset: (state.serverTime * 1000) - Date.now() });

    if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
        set({ currentTrackIndex: state.trackIndex });
        if (get().playlist[state.trackIndex]?.audioUrl) {
            audioElement.src = get().playlist[state.trackIndex].audioUrl!;
            audioElement.load();
        }
        get().updateMediaSession();
    }

    if (state.isPlaying) {
        set({ isPlaying: true });
        if (state.startTimestamp) {
            const serverNow = (Date.now() + get().clockOffset) / 1000;
            const targetTime = serverNow - state.startTimestamp;
            if (Math.abs(audioElement.currentTime - targetTime) > 0.3) {
                if (targetTime >= 0 && targetTime < audioElement.duration) {
                    audioElement.currentTime = targetTime;
                }
            }
        }
        // Critical: Handle Browser Auto-Play Policy
        audioElement.play().catch((e: any) => {
            console.log("Autoplay prevented:", e);
            set({ needsInteraction: true }); // Show "Tap to Join" overlay
        });
    } else {
        set({ isPlaying: false });
        audioElement.pause();
        if (state.pausedAt !== undefined) {
             if (Math.abs(audioElement.currentTime - state.pausedAt) > 0.1) {
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
    if (isPlaying) get()._emitStateUpdate({ isPlaying: false, pausedAt: audioElement.currentTime });
    else get()._emitStateUpdate({ isPlaying: true, pausedAt: audioElement.currentTime });
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
    // Don't emit volume, keep it local preference
  },

  toggleCollaborative: (val: boolean) => {
      if (!get().isAdmin) return;
      get().socket?.emit('toggle_settings', { room_code: get().roomCode, setting: 'isCollaborative', value: val });
  },

  uploadFile: async (file, title, artist) => {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_URL}/api/upload-local`, { method: 'POST', body: fd });
      const { audioUrl } = await res.json();
      
      // SEND SOCKET ID for permission check
      const sid = get().socket?.id;
      
      await fetch(`${API_URL}/api/room/${get().roomCode}/add-upload`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title || file.name, artist: artist || 'Local', audioUrl, sid })
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