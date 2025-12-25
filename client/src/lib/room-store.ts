import { create } from 'zustand';
import { createWithEqualityFn } from 'zustand/traditional';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

export const useRoomStore = createWithEqualityFn<any>()((set, get) => ({
  socket: null,
  audioElement: (typeof window !== 'undefined') ? new Audio() : null,
  playlist: [], currentTrackIndex: 0, isPlaying: false,
  roomCode: '', playlistTitle: '', users: [], username: '',
  volume: 80, isLoading: false, error: null, isAdmin: false,
  currentTime: 0, duration: 0, isDisconnected: false,

  setLoading: (l: boolean) => set({ isLoading: l }),
  setError: (e: string) => set({ error: e, isLoading: false }),

  connect: (code: string, name: string) => {
    if (get().socket) return;
    set({ username: name, roomCode: code });
    const socket = io(API_URL, { transports: ['polling', 'websocket'] });
    set({ socket });

    socket.on('connect', () => {
        socket.emit('join_room', { room_code: code, username: name });
        set({ isDisconnected: false });
    });
    socket.on('update_user_list', (users: any) => set({ users, isAdmin: users.find((u: any) => u.name === get().username)?.isAdmin ?? false }));
    socket.on('sync_player_state', (s: any) => get().syncPlayerState(s));
    socket.on('refresh_playlist', (d: any) => set({ playlist: d.playlist, playlistTitle: d.title }));
    socket.on('disconnect', () => set({ isDisconnected: true }));
  },

  primePlayer: () => {
    const audio = get().audioElement;
    if (!audio) return;
    audio.crossOrigin = "anonymous";
    audio.ontimeupdate = () => set({ currentTime: audio.currentTime });
    audio.onloadedmetadata = () => set({ duration: audio.duration });
    audio.onended = () => get().isAdmin && get().nextTrack();
    // Silent play to unlock iOS
    audio.play().then(() => audio.pause()).catch(() => {});
  },

  syncPlayerState: (state: any) => {
    const { audioElement, currentTrackIndex, isPlaying, playlist } = get();
    if (!audioElement) return;

    // Sync Track
    if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
        set({ currentTrackIndex: state.trackIndex });
        if (playlist[state.trackIndex]?.audioUrl) {
            audioElement.src = playlist[state.trackIndex].audioUrl;
            audioElement.load();
        }
    }
    // Sync Time
    if (state.currentTime !== undefined && Math.abs(audioElement.currentTime - state.currentTime) > 2) {
        audioElement.currentTime = state.currentTime;
    }
    // Sync PlayState
    if (state.isPlaying !== undefined && state.isPlaying !== isPlaying) {
        set({ isPlaying: state.isPlaying });
        if (state.isPlaying) {
            const p = audioElement.play();
            if (p) p.catch((e: any) => console.log("Play interrupted", e));
        } else {
            audioElement.pause();
        }
    }
  },

  playPause: () => {
    const { isPlaying, isAdmin } = get();
    if (!isAdmin) return;
    get()._emit({ isPlaying: !isPlaying, currentTime: get().audioElement.currentTime });
  },

  selectTrack: (index: number) => {
    if (!get().isAdmin) return;
    get()._emit({ trackIndex: index, isPlaying: true, currentTime: 0 });
  },

  nextTrack: () => get().selectTrack((get().currentTrackIndex + 1) % get().playlist.length),
  prevTrack: () => get().selectTrack((get().currentTrackIndex - 1 + get().playlist.length) % get().playlist.length),
  
  setVolume: (v: number) => {
    set({ volume: v });
    if (get().audioElement) get().audioElement.volume = v / 100;
  },

  uploadFile: async (file: File, title: string, artist: string) => {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_URL}/api/upload-local`, { method: 'POST', body: fd });
      const { audioUrl } = await res.json();
      await fetch(`${API_URL}/api/room/${get().roomCode}/add-upload`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title || file.name, artist: artist || 'Local', audioUrl })
      });
  },

  _emit: (state: any) => {
      get().socket?.emit('update_player_state', { room_code: get().roomCode, state });
  }
}));