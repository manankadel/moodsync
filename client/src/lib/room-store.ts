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

interface SyncState {
  isPlaying?: boolean;
  trackIndex?: number;
  volume?: number;
  isCollaborative?: boolean;
  equalizer?: EqualizerSettings;
  currentTime?: number;
  timestamp?: number;
}

interface AudioNodes {
  context: AudioContext | null;
  source: MediaElementAudioSourceNode | null;
  bass: BiquadFilterNode | null;
  mids: BiquadFilterNode | null;
  treble: BiquadFilterNode | null;
}

interface LyricLine { time: number; text: string; }

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
  audioNodes: AudioNodes;
  currentTime: number;
  lyrics: { lines: LyricLine[]; isLoading: boolean; };
  audioElement: HTMLAudioElement | null;
  syncInterval: NodeJS.Timeout | null;

  connect: (roomCode: string, username: string) => void;
  disconnect: () => void;
  initializePlayer: (domId: string) => void;
  setPlaylistData: (title: string, playlist: Song[]) => void;
  playPause: () => void;
  nextTrack: () => void;
  prevTrack: () => void;
  selectTrack: (index: number) => void;
  setVolume: (volume: number) => void;
  setEqualizer: (settings: EqualizerSettings, emit?: boolean) => void;
  toggleCollaborative: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  syncPlayerState: (state: SyncState) => void;
  _changeTrack: (index: number) => void;
  _canControl: () => boolean;
  _connectAudioGraph: () => void;
  _startSyncLoop: () => void;
  _stopSyncLoop: () => void;
  fetchLyrics: (youtubeId: string) => void;
  setCurrentTime: (time: number) => void;
  primePlayer: () => void;
  uploadFile: (file: File, title?: string, artist?: string) => Promise<{ filename: string, audioUrl: string }>; // UPDATED RETURN TYPE
  addUploadToPlaylist: (filename: string, title: string, artist: string, audioUrl: string) => Promise<void>; // ADDED audioUrl
  refreshPlaylist: () => void;
}

export const useRoomStore = create<RoomState>((set, get) => ({
  roomCode: '', playlistTitle: '', playlist: [], users: [],
  currentTrackIndex: 0, isPlaying: false, volume: 80, isCollaborative: false, 
  isLoading: true, error: null, player: null,
  socket: null, isAdmin: false, username: '',
  equalizer: { bass: 0, mids: 0, treble: 0 },
  audioNodes: { context: null, source: null, bass: null, mids: null, treble: null },
  currentTime: 0,
  lyrics: { lines: [], isLoading: false },
  audioElement: null,
  syncInterval: null,

  connect: (roomCode, username) => {
    if (get().socket) return;
    
    // Ultra-low latency socket configuration
    const socket = io(API_URL, {
      transports: ['websocket'],
      upgrade: false,
      reconnectionDelay: 50,
      reconnectionDelayMax: 200,
      timeout: 3000,
      forceNew: true
    });
    
    set({ socket, username, roomCode });
    
    socket.on('connect', () => {
      console.log('✅ Connected with ultra-low latency');
      socket.emit('join_room', { room_code: roomCode, username });
    });
    
    socket.on('disconnect', () => set({ users: [], isAdmin: false }));
    socket.on('error', (data) => get().setError(data.message));
    
    socket.on('update_user_list', (users: User[]) => {
      const self = users.find(u => u.name === get().username);
      set({ users, isAdmin: self?.isAdmin || false });
    });
    
    socket.on('load_current_state', (state) => get().syncPlayerState(state));
    socket.on('sync_player_state', (state) => get().syncPlayerState(state));
    socket.on('refresh_playlist', () => get().refreshPlaylist());
  },

  disconnect: () => { 
    get()._stopSyncLoop();
    get().socket?.disconnect(); 
    get().audioElement?.pause();
    set({ socket: null, audioElement: null }); 
  },

  _connectAudioGraph: () => {
    const { audioElement, audioNodes } = get();
    
    // CRITICAL: Ensure the AudioContext is resumed before attempting to connect the graph
    if (audioNodes.context?.state === 'suspended') {
        audioNodes.context.resume().catch(e => console.error("Failed to resume AudioContext:", e));
    }
    
    if (!audioNodes.context || !audioNodes.bass || !audioNodes.mids || !audioNodes.treble) {
      return;
    }
    
    try {
      // CRITICAL: Only connect the audio element if it is an upload track
      // YouTube video is in an iframe and cannot be connected directly for processing
      if (audioElement && !audioNodes.source) {
        const source = audioNodes.context.createMediaElementSource(audioElement);
        source.connect(audioNodes.bass);
        audioNodes.bass.connect(audioNodes.mids);
        audioNodes.mids.connect(audioNodes.treble);
        audioNodes.treble.connect(audioNodes.context.destination);
        
        set(state => ({ audioNodes: { ...state.audioNodes, source }}));
        get().setEqualizer(get().equalizer, false);
        console.log("✅ Audio graph connected");
      }
    } catch (e) {
      console.error("Failed to connect audio graph:", e);
    }
  },

  _startSyncLoop: () => {
    get()._stopSyncLoop();
    
    // Continuous sync loop for admin (every 100ms for ultra-low latency)
    const interval = setInterval(() => {
      const { isAdmin, socket, roomCode, player, audioElement, isPlaying, currentTrackIndex, playlist } = get();
      
      if (!isAdmin || !socket || !isPlaying) return;
      
      try {
        const currentTrack = playlist[currentTrackIndex];
        let currentTime = 0;
        
        if (currentTrack?.isUpload && audioElement) {
          currentTime = audioElement.currentTime;
        } else if (player && typeof player.getCurrentTime === 'function') {
          currentTime = player.getCurrentTime();
        }
        
        socket.emit('update_player_state', {
          room_code: roomCode,
          state: {
            isPlaying: true,
            trackIndex: currentTrackIndex,
            currentTime,
            timestamp: Date.now() / 1000
          }
        });
      } catch (error) {
        console.error('Sync loop error:', error);
      }
    }, 100); // Ultra-fast 100ms sync
    
    set({ syncInterval: interval });
  },

  _stopSyncLoop: () => {
    const interval = get().syncInterval;
    if (interval) {
      clearInterval(interval);
      set({ syncInterval: null });
    }
  },

  initializePlayer: (domId) => {
    // Initialize audio element for uploads
    const audioEl = new Audio();
    audioEl.preload = 'auto';
    audioEl.crossOrigin = 'anonymous'; // CRITICAL for Web Audio API to work
    
    audioEl.addEventListener('timeupdate', () => {
      if (!get().isLoading) {
        set({ currentTime: audioEl.currentTime });
      }
    });
    
    audioEl.addEventListener('play', () => {
      // Only set isPlaying/sync loop if the user can control or it's a sync event
      if (get()._canControl() || !get().isAdmin) { 
        set({ isPlaying: true });
        get()._startSyncLoop();
      }
    });
    
    audioEl.addEventListener('pause', () => {
      if (get()._canControl() || !get().isAdmin) { 
        set({ isPlaying: false });
        get()._stopSyncLoop();
      }
    });
    
    audioEl.addEventListener('ended', () => {
      if (get()._canControl()) {
        get().nextTrack();
      }
    });
    
    audioEl.addEventListener('error', (e) => {
      console.error('Audio element error:', e);
      if (get()._canControl()) {
        alert('Error playing audio file. Skipping to next track.');
        get().nextTrack();
      }
    });
    
    set({ audioElement: audioEl });
    
    // Setup Web Audio API with optimized settings
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        latencyHint: 'interactive', // Lowest latency mode
        sampleRate: 48000
      });
      
      const bass = audioContext.createBiquadFilter();
      bass.type = "lowshelf";
      bass.frequency.value = 250;

      const mids = audioContext.createBiquadFilter();
      mids.type = "peaking";
      mids.frequency.value = 1000;
      mids.Q.value = 1;

      const treble = audioContext.createBiquadFilter();
      treble.type = "highshelf";
      treble.frequency.value = 4000;

      set({ audioNodes: { context: audioContext, source: null, bass, mids, treble } });
    } catch (e) {
      console.error("Could not create Web Audio Context:", e);
    }
    
    // YouTube player initialization
    const onPlayerReady = (event: any) => {
      const player = event.target;
      player.setVolume(get().volume);
      set({ player });
      
      const { playlist, currentTrackIndex } = get();
      if (playlist.length > 0 && !playlist[currentTrackIndex].isUpload) {
        player.cueVideoById(playlist[currentTrackIndex].youtubeId);
      }
    };
    
    const onPlayerStateChange = (event: any) => {
      const state = get();
      if (!state._canControl()) return;
      
      let newIsPlaying = state.isPlaying;
      if (event.data === window.YT.PlayerState.PLAYING) {
        newIsPlaying = true;
        state._startSyncLoop();
      } else if (event.data === window.YT.PlayerState.PAUSED) {
        newIsPlaying = false;
        state._stopSyncLoop();
      } else if (event.data === window.YT.PlayerState.ENDED) {
        state.nextTrack();
        return;
      }

      if (newIsPlaying !== state.isPlaying) {
        set({ isPlaying: newIsPlaying });
      }
    };
    
    window.onYouTubeIframeAPIReady = () => {
      new window.YT.Player(domId, {
        height: '0',
        width: '0',
        playerVars: { 
            origin: window.location.origin, 
            controls: 0,
            // CRITICAL: Disable HTML5 for YouTube to avoid MediaElement-related CORS issues
            html5: 0 
        },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
      });
    };
    
    if (window.YT && window.YT.Player) {
      window.onYouTubeIframeAPIReady();
    }
  },

  setPlaylistData: (title, playlist) => {
    set({ playlistTitle: title, playlist, isLoading: false, error: null, currentTrackIndex: 0, isPlaying: false });
    if (playlist.length > 0) {
      const track = playlist[0];
      if (track.youtubeId) get().fetchLyrics(track.youtubeId);
    }
  },
  
  _canControl: () => get().isAdmin || get().isCollaborative,

  _changeTrack: (index: number) => {
    const { player, audioElement, playlist } = get();
    if (!get()._canControl() || playlist.length === 0) return;
    
    get()._stopSyncLoop();
    const newTrack = playlist[index];
    
    // Stop current playback
    if (audioElement) {
      audioElement.pause();
      audioElement.currentTime = 0;
    }
    if (player && typeof player.stopVideo === 'function') {
      player.stopVideo();
    }
    
    set({ currentTrackIndex: index, isPlaying: false, currentTime: 0 });
    
    if (newTrack.isUpload && newTrack.audioUrl) {
      // Play uploaded file
      if (audioElement) {
        audioElement.src = newTrack.audioUrl;
        audioElement.load();
        
        get()._connectAudioGraph();
        
        audioElement.play().then(() => {
          set({ isPlaying: true });
          get()._startSyncLoop();
        }).catch(e => console.error('Play error:', e));
      }
    } else if (newTrack.youtubeId && player) {
      // Play YouTube video
      get().fetchLyrics(newTrack.youtubeId);
      player.loadVideoById(newTrack.youtubeId);
      set({ isPlaying: true });
      get()._startSyncLoop();
    }
  },

  playPause: () => {
    if (!get()._canControl()) return;
    const { player, audioElement, isPlaying, audioNodes, playlist, currentTrackIndex } = get();
    const currentTrack = playlist[currentTrackIndex];
    
    if (currentTrack?.isUpload && audioElement) {
      if (isPlaying) {
        audioElement.pause();
        get()._stopSyncLoop();
      } else {
        if (audioNodes.context?.state === 'suspended') {
          audioNodes.context.resume();
        }
        audioElement.play().then(() => {
          get()._startSyncLoop();
        }).catch(e => console.error('Play error:', e));
      }
    } else if (player) {
      if (isPlaying) {
        player.pauseVideo();
        get()._stopSyncLoop();
      } else {
        if (audioNodes.context?.state === 'suspended') {
          audioNodes.context.resume();
        }
        player.playVideo();
        get()._startSyncLoop();
      }
    }
  },
  
  nextTrack: () => get()._changeTrack((get().currentTrackIndex + 1) % get().playlist.length),
  prevTrack: () => get()._changeTrack((get().currentTrackIndex - 1 + get().playlist.length) % get().playlist.length),
  
  selectTrack: (index) => {
    if (index !== get().currentTrackIndex) get()._changeTrack(index);
    else get().playPause();
  },
  
  setVolume: (volume: number) => {
    const { player, audioElement } = get();
    if (audioElement) audioElement.volume = volume / 100;
    if (player) player.setVolume(volume);
    set({ volume });
  },

  setEqualizer: (settings, emit = true) => {
    const { audioNodes, socket, roomCode, _canControl } = get();
    
    if (audioNodes.bass) audioNodes.bass.gain.value = settings.bass;
    if (audioNodes.mids) audioNodes.mids.gain.value = settings.mids;
    if (audioNodes.treble) audioNodes.treble.gain.value = settings.treble;

    set({ equalizer: settings });
    
    if (emit && _canControl()) {
      socket?.emit('update_player_state', { 
        room_code: roomCode, 
        state: { equalizer: settings } 
      });
    }
  },

  toggleCollaborative: () => {
    const { isAdmin, socket, roomCode, isCollaborative } = get();
    if (isAdmin) {
      const newState = !isCollaborative;
      set({ isCollaborative: newState });
      socket?.emit('update_player_state', { room_code: roomCode, state: { isCollaborative: newState }});
    }
  },

  syncPlayerState: (state) => {
    const { player, audioElement, playlist, currentTrackIndex, isPlaying, volume, isCollaborative, equalizer } = get();
    if (!playlist || playlist.length === 0) return;

    const now = Date.now() / 1000;
    const latency = now - (state.timestamp || now);
    
    if (state.equalizer && JSON.stringify(state.equalizer) !== JSON.stringify(equalizer)) {
      get().setEqualizer(state.equalizer, false);
    }
    
    if (state.isCollaborative !== undefined && state.isCollaborative !== isCollaborative) {
      set({ isCollaborative: state.isCollaborative });
    }
    
    if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
      if (state.trackIndex >= 0 && state.trackIndex < playlist.length) {
        const track = playlist[state.trackIndex];
        
        if (track.isUpload && track.audioUrl && audioElement) {
          audioElement.src = track.audioUrl;
          audioElement.load();
          get()._connectAudioGraph();
        } else if (track.youtubeId && player) {
          player.loadVideoById(track.youtubeId);
          get().fetchLyrics(track.youtubeId);
        }
        
        set({ currentTrackIndex: state.trackIndex });
      }
    }
    
    if (state.volume !== undefined && state.volume !== volume) {
      if (audioElement) audioElement.volume = state.volume / 100;
      if (player) player.setVolume(state.volume);
      set({ volume: state.volume });
    }

    // ULTRA-PRECISE SYNC (target: <50ms drift)
    if (state.currentTime !== undefined) {
      const targetTime = state.currentTime + latency;
      const currentTrack = playlist[currentTrackIndex];
      
      if (currentTrack?.isUpload && audioElement) {
        const drift = Math.abs(audioElement.currentTime - targetTime);
        
        // Only sync if drift > 30ms (ultra-precise)
        if (drift > 0.03) {
          audioElement.currentTime = targetTime;
          // console.log(`🎯 Synced upload: ${(drift * 1000).toFixed(0)}ms drift`);
        }
      } else if (player && typeof player.seekTo === 'function') {
        const playerTime = player.getCurrentTime() || 0;
        const drift = Math.abs(playerTime - targetTime);
        
        if (drift > 0.03) {
          player.seekTo(targetTime, true);
          // console.log(`🎯 Synced YouTube: ${(drift * 1000).toFixed(0)}ms drift`);
        }
      }
    }

    if (state.isPlaying !== undefined && state.isPlaying !== isPlaying) {
      const currentTrack = playlist[currentTrackIndex];
      
      setTimeout(() => {
        if (state.isPlaying) {
          // CRITICAL: Ensure AudioContext is not suspended before playing uploaded audio
          if (audioNodes.context?.state === 'suspended') {
            audioNodes.context.resume();
          }
          
          if (currentTrack?.isUpload && audioElement) {
            audioElement.play().catch(e => console.error('Sync play error:', e));
          } else if (player) {
            player.playVideo();
          }
          get()._startSyncLoop();
        } else {
          if (currentTrack?.isUpload && audioElement) {
            audioElement.pause();
          } else if (player) {
            player.pauseVideo();
          }
          get()._stopSyncLoop();
        }
      }, 20); // Minimal delay for sync
      
      set({ isPlaying: state.isPlaying });
    }
  },

  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error, isLoading: false }),

  setCurrentTime: (time) => set({ currentTime: time }),

  fetchLyrics: async (youtubeId) => {
    set(state => ({ lyrics: { ...state.lyrics, isLoading: true } }));
    try {
      const response = await fetch(`${API_URL}/api/lyrics/${youtubeId}`);
      if (!response.ok) throw new Error('Lyrics not found.');
      const lines: LyricLine[] = await response.json();
      set({ lyrics: { lines, isLoading: false } });
    } catch (error) {
      console.error("Failed to fetch lyrics:", error);
      set({ lyrics: { lines: [], isLoading: false } });
    }
  },

  primePlayer: () => {
    const { player, audioElement, volume, audioNodes } = get();
    
    // Resume audio context for both players when user interacts
    if (audioNodes.context?.state === 'suspended') {
      audioNodes.context.resume();
    }
    
    if (audioElement) {
      audioElement.volume = volume / 100;
    }
    
    if (player && typeof player.playVideo === 'function') {
      console.log("Priming YouTube player...");
      player.mute();
      player.playVideo();
      setTimeout(() => {
        player.pauseVideo();
        player.unMute();
        player.setVolume(volume);
      }, 250);
    }
  },

  // UPDATED to return the full response data
  uploadFile: async (file: File, title?: string, artist?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      // CRITICAL: The API endpoint needs to support CORS for this to work (fixed in app.py)
      const response = await fetch(`${API_URL}/api/upload`, {
        method: 'POST',
        body: formData
      });
      
      if (!response.ok) throw new Error('Upload failed');
      
      const data = await response.json();
      
      // CRITICAL: Pass the audioUrl received from the backend
      await get().addUploadToPlaylist(
        data.filename,
        title || file.name.replace(/\.[^/.]+$/, ""),
        artist || 'Unknown Artist',
        data.audioUrl
      );
      
      return data; // Return the full data as promised in the original modal logic
    } catch (error) {
      console.error('Upload error:', error);
      throw error;
    }
  },

  // UPDATED to accept audioUrl
  addUploadToPlaylist: async (filename: string, title: string, artist: string, audioUrl: string) => {
    const { roomCode } = get();
    
    try {
      const response = await fetch(`${API_URL}/api/room/${roomCode}/add-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, title, artist, audioUrl }) // Pass audioUrl to backend
      });
      
      if (!response.ok) throw new Error('Failed to add to playlist');
      
      // The backend should now emit 'refresh_playlist', so local update is not strictly necessary 
      // but we keep a simplified local update for responsiveness.
      // NOTE: The server now emits 'refresh_playlist' which will trigger refreshPlaylist()
      
    } catch (error) {
      console.error('Add to playlist error:', error);
      throw error;
    }
  },

  refreshPlaylist: async () => {
    const { roomCode, playlist } = get();
    try {
      const response = await fetch(`${API_URL}/api/room/${roomCode}`);
      if (response.ok) {
        const data = await response.json();
        
        // CRITICAL: Only update the playlist if the content has actually changed
        // This prevents unnecessary re-renders when a non-playlist update occurs.
        if (data.playlist.length !== playlist.length) {
             set({ playlist: data.playlist });
        }
      }
    } catch (error) {
      console.error('Error refreshing playlist:', error);
    }
  }
}));