import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

interface Song { 
  name: string; 
  artist: string; 
  albumArt: string | null; 
  youtubeId?: string;
  isUpload?: boolean;
  audioUrl?: string;
}

interface User { name: string; isAdmin: boolean; }
declare global { interface Window { onYouTubeIframeAPIReady: () => void; YT: any; }}

interface EqualizerSettings { bass: number; mids: number; treble: number; }

interface RoomState {
  roomCode: string; 
  playlistTitle: string; 
  playlist: Song[]; 
  users: User[];
  currentTrackIndex: number; 
  isPlaying: boolean; 
  volume: number; 
  isCollaborative: boolean;
  isLoading: boolean; 
  error: string | null; 
  player: any; 
  socket: Socket | null; 
  isAdmin: boolean; 
  username: string;
  equalizer: EqualizerSettings;
  currentTime: number;
  audioElement: HTMLAudioElement | null;
  audioContext: AudioContext | null;
  lastSyncTime: number;
  syncCounter: number;

  connect: (roomCode: string, username: string) => void;
  disconnect: () => void;
  initializePlayer: (domId: string) => void;
  setPlaylistData: (title: string, playlist: Song[]) => void;
  playPause: () => void;
  nextTrack: () => void;
  prevTrack: () => void;
  selectTrack: (index: number) => void;
  setVolume: (volume: number) => void;
  setEqualizer: (settings: EqualizerSettings) => void;
  toggleCollaborative: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  syncPlayerState: (state: any) => void;
  _changeTrack: (index: number) => void;
  _canControl: () => boolean;
  fetchLyrics: (youtubeId: string) => void;
  setCurrentTime: (time: number) => void;
  primePlayer: () => void;
  uploadFile: (file: File, title?: string, artist?: string) => Promise<void>;
  addUploadToPlaylist: (filename: string, title: string, artist: string) => Promise<void>;
  refreshPlaylist: () => void;
}

export const useRoomStore = create<RoomState>((set, get) => ({
  roomCode: '', playlistTitle: '', playlist: [], users: [],
  currentTrackIndex: 0, isPlaying: false, volume: 80, isCollaborative: false, 
  isLoading: true, error: null, player: null,
  socket: null, isAdmin: false, username: '',
  equalizer: { bass: 0, mids: 0, treble: 0 },
  currentTime: 0,
  audioElement: null,
  audioContext: null,
  lastSyncTime: 0,
  syncCounter: 0,

  connect: (roomCode, username) => {
    if (get().socket) return;
    
    const socket = io(API_URL, {
      transports: ['websocket'],
      upgrade: false,
      reconnectionDelay: 100,
      reconnectionDelayMax: 300,
      timeout: 5000,
      forceNew: true
    });
    
    set({ socket, username, roomCode });
    
    socket.on('connect', () => {
      console.log('✅ Connected to sync server');
      socket.emit('join_room', { room_code: roomCode, username });
    });
    
    socket.on('disconnect', () => {
      console.warn('⚠️ Disconnected from sync server');
      set({ users: [], isAdmin: false });
    });
    
    socket.on('error', (data) => {
      console.error('Socket error:', data);
      get().setError(data.message);
    });
    
    socket.on('update_user_list', (users: User[]) => {
      const self = users.find(u => u.name === get().username);
      set({ users, isAdmin: self?.isAdmin || false });
    });
    
    socket.on('load_current_state', (state) => {
      console.log('📥 Loaded initial state');
      get().syncPlayerState(state);
    });
    
    socket.on('sync_player_state', (state) => {
      get().syncPlayerState(state);
    });
    
    socket.on('playlist_updated', () => {
      console.log('📝 Playlist updated - refreshing');
      get().refreshPlaylist();
    });
  },

  disconnect: () => { 
    get().socket?.disconnect(); 
    get().audioElement?.pause();
    set({ socket: null, audioElement: null }); 
  },

  initializePlayer: (domId) => {
    // Audio element for uploads
    const audioEl = new Audio();
    audioEl.preload = 'auto';
    audioEl.crossOrigin = 'anonymous';
    
    audioEl.addEventListener('timeupdate', () => {
      set({ currentTime: audioEl.currentTime });
    });
    
    audioEl.addEventListener('play', () => {
      set({ isPlaying: true });
    });
    
    audioEl.addEventListener('pause', () => {
      set({ isPlaying: false });
    });
    
    audioEl.addEventListener('ended', () => {
      if (get()._canControl()) {
        get().nextTrack();
      }
    });
    
    audioEl.addEventListener('error', (e) => {
      console.error('Audio error:', e);
      alert('Error playing audio. Skipping...');
      if (get()._canControl()) {
        get().nextTrack();
      }
    });
    
    set({ audioElement: audioEl });
    
    // Web Audio Context
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        latencyHint: 'interactive',
        sampleRate: 48000
      });
      set({ audioContext });
    } catch (e) {
      console.error("Audio context error:", e);
    }
    
    // YouTube player
    window.onYouTubeIframeAPIReady = () => {
      new window.YT.Player(domId, {
        height: '0',
        width: '0',
        playerVars: { origin: window.location.origin, controls: 0 },
        events: { 
          'onReady': (event: any) => {
            const player = event.target;
            player.setVolume(get().volume);
            set({ player });
            const { playlist, currentTrackIndex } = get();
            if (playlist.length > 0 && !playlist[currentTrackIndex].isUpload) {
              player.cueVideoById(playlist[currentTrackIndex].youtubeId);
            }
          },
          'onStateChange': (event: any) => {
            const state = get();
            if (!state._canControl()) return;
            
            if (event.data === window.YT.PlayerState.PLAYING) {
              set({ isPlaying: true });
            } else if (event.data === window.YT.PlayerState.PAUSED) {
              set({ isPlaying: false });
            } else if (event.data === window.YT.PlayerState.ENDED) {
              state.nextTrack();
            }
          }
        }
      });
    };
    
    if (window.YT && window.YT.Player) {
      window.onYouTubeIframeAPIReady();
    }
  },

  setPlaylistData: (title, playlist) => {
    set({ playlistTitle: title, playlist, isLoading: false, error: null, currentTrackIndex: 0, isPlaying: false });
  },
  
  _canControl: () => get().isAdmin || get().isCollaborative,

  _changeTrack: (index: number) => {
    const { player, audioElement, playlist } = get();
    if (!get()._canControl() || playlist.length === 0) return;
    
    const newTrack = playlist[index];
    
    if (audioElement) {
      audioElement.pause();
      audioElement.currentTime = 0;
    }
    if (player && typeof player.stopVideo === 'function') {
      player.stopVideo();
    }
    
    set({ currentTrackIndex: index, isPlaying: false, currentTime: 0 });
    
    if (newTrack.isUpload && newTrack.audioUrl) {
      if (audioElement) {
        audioElement.src = newTrack.audioUrl;
        audioElement.load();
        audioElement.play().catch(e => console.error('Play error:', e));
      }
    } else if (newTrack.youtubeId && player) {
      player.loadVideoById(newTrack.youtubeId);
      set({ isPlaying: true });
    }
  },

  playPause: () => {
    if (!get()._canControl()) return;
    const { player, audioElement, isPlaying, playlist, currentTrackIndex } = get();
    const currentTrack = playlist[currentTrackIndex];
    
    if (currentTrack?.isUpload && audioElement) {
      if (isPlaying) {
        audioElement.pause();
      } else {
        audioElement.play().catch(e => console.error('Play error:', e));
      }
    } else if (player) {
      if (isPlaying) {
        player.pauseVideo();
      } else {
        player.playVideo();
      }
    }
  },
  
  nextTrack: () => {
    if (get()._canControl()) {
      const nextIndex = (get().currentTrackIndex + 1) % get().playlist.length;
      get()._changeTrack(nextIndex);
    }
  },
  
  prevTrack: () => {
    if (get()._canControl()) {
      const prevIndex = (get().currentTrackIndex - 1 + get().playlist.length) % get().playlist.length;
      get()._changeTrack(prevIndex);
    }
  },
  
  selectTrack: (index) => {
    if (!get()._canControl()) return;
    if (index !== get().currentTrackIndex) {
      get()._changeTrack(index);
    } else {
      get().playPause();
    }
  },
  
  setVolume: (volume: number) => {
    const { player, audioElement } = get();
    if (audioElement) audioElement.volume = volume / 100;
    if (player) player.setVolume(volume);
    set({ volume });
  },

  setEqualizer: (settings) => {
    set({ equalizer: settings });
  },

  toggleCollaborative: () => {
    const { isAdmin, socket, roomCode, isCollaborative } = get();
    if (isAdmin) {
      const newState = !isCollaborative;
      set({ isCollaborative: newState });
      socket?.emit('update_player_state', { 
        room_code: roomCode, 
        state: { isCollaborative: newState }
      });
    }
  },

  syncPlayerState: (state) => {
    const { player, audioElement, playlist, currentTrackIndex, volume, isCollaborative, equalizer } = get();
    if (!playlist || playlist.length === 0) return;

    const now = Date.now() / 1000;
    const serverTime = state.timestamp || now;
    const networkLatency = now - serverTime;
    
    // Update collaborative mode
    if (state.isCollaborative !== undefined && state.isCollaborative !== isCollaborative) {
      set({ isCollaborative: state.isCollaborative });
    }
    
    // Switch tracks if needed
    if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
      if (state.trackIndex >= 0 && state.trackIndex < playlist.length) {
        const track = playlist[state.trackIndex];
        
        if (track.isUpload && track.audioUrl && audioElement) {
          audioElement.src = track.audioUrl;
          audioElement.load();
        } else if (track.youtubeId && player) {
          player.loadVideoById(track.youtubeId);
        }
        
        set({ currentTrackIndex: state.trackIndex });
      }
    }
    
    // Update volume
    if (state.volume !== undefined && state.volume !== volume) {
      if (audioElement) audioElement.volume = state.volume / 100;
      if (player) player.setVolume(state.volume);
      set({ volume: state.volume });
    }

    // PERFECT SYNC - Critical for mass concurrent users
    if (state.currentTime !== undefined) {
      const targetTime = state.currentTime + networkLatency;
      const currentTrack = playlist[currentTrackIndex];
      
      if (currentTrack?.isUpload && audioElement) {
        const drift = Math.abs(audioElement.currentTime - targetTime);
        
        // Sync if drift > 50ms (allows natural variation, prevents jitter)
        if (drift > 0.05) {
          audioElement.currentTime = targetTime;
          console.log(`✓ Sync: ${(drift * 1000).toFixed(0)}ms`);
        }
      } else if (player && typeof player.getCurrentTime === 'function') {
        const playerTime = player.getCurrentTime() || 0;
        const drift = Math.abs(playerTime - targetTime);
        
        if (drift > 0.05) {
          player.seekTo(targetTime, true);
          console.log(`✓ Sync: ${(drift * 1000).toFixed(0)}ms`);
        }
      }
    }

    // Handle play/pause
    if (state.isPlaying !== undefined) {
      const currentTrack = playlist[currentTrackIndex];
      
      if (state.isPlaying) {
        if (currentTrack?.isUpload && audioElement) {
          audioElement.play().catch(e => console.error('Play error:', e));
        } else if (player) {
          player.playVideo();
        }
      } else {
        if (currentTrack?.isUpload && audioElement) {
          audioElement.pause();
        } else if (player) {
          player.pauseVideo();
        }
      }
      
      set({ isPlaying: state.isPlaying });
    }
    
    set({ lastSyncTime: now, syncCounter: get().syncCounter + 1 });
  },

  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error, isLoading: false }),
  setCurrentTime: (time) => set({ currentTime: time }),

  fetchLyrics: async (youtubeId) => {
    try {
      const response = await fetch(`${API_URL}/api/lyrics/${youtubeId}`);
      if (!response.ok) throw new Error('Lyrics not found');
      // Implement as needed
    } catch (error) {
      console.error("Failed to fetch lyrics:", error);
    }
  },

  primePlayer: () => {
    const { player, audioElement, volume } = get();
    
    if (audioElement) {
      audioElement.volume = volume / 100;
    }
    
    if (player && typeof player.playVideo === 'function') {
      console.log("Priming YouTube player");
      player.mute();
      player.playVideo();
      setTimeout(() => {
        player.pauseVideo();
        player.unMute();
        player.setVolume(volume);
      }, 250);
    }
  },

  uploadFile: async (file: File, title?: string, artist?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const response = await fetch(`${API_URL}/api/upload`, {
        method: 'POST',
        body: formData
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Upload failed');
      }
      
      const data = await response.json();
      
      await get().addUploadToPlaylist(
        data.filename,
        title || file.name.replace(/\.[^/.]+$/, ""),
        artist || 'Unknown Artist'
      );
    } catch (error) {
      console.error('Upload error:', error);
      throw error;
    }
  },

  addUploadToPlaylist: async (filename: string, title: string, artist: string) => {
    const { roomCode } = get();
    
    try {
      const response = await fetch(`${API_URL}/api/room/${roomCode}/add-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, title, artist })
      });
      
      if (!response.ok) throw new Error('Failed to add to playlist');
      
      const data = await response.json();
      
      set(state => ({
        playlist: [...state.playlist, data.track]
      }));
      
      get().socket?.emit('playlist_updated', { room_code: roomCode });
      console.log(`Added to playlist: ${title}`);
    } catch (error) {
      console.error('Add to playlist error:', error);
      throw error;
    }
  },

  refreshPlaylist: async () => {
    const { roomCode } = get();
    try {
      const response = await fetch(`${API_URL}/api/room/${roomCode}`);
      if (response.ok) {
        const data = await response.json();
        set({ playlist: data.playlist });
      }
    } catch (error) {
      console.error('Error refreshing playlist:', error);
    }
  }
}));