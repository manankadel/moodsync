import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

// --- CONSTANTS FOR THE NEW SMART SYNC LOGIC ---
// We will ignore any time difference smaller than this (250 milliseconds).
const SYNC_TOLERANCE_SECONDS = 0.25; 
// We will only perform a hard seek if the client is behind by more than this.
const HARD_SEEK_THRESHOLD_SECONDS = 1.0; 

// ... (interfaces are the same) ...
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
  isSeeking: boolean; // To prevent sync fighting user input
  setIsSeeking: (isSeeking: boolean) => void;

  connect: (roomCode: string, username: string) => void;
  disconnect: () => void;
  initializePlayer: (domId: string) => void;
  // ... rest of the interface is the same
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
  uploadFile: (file: File, title?: string, artist?: string) => Promise<{ filename: string, audioUrl: string }>;
  addUploadToPlaylist: (filename: string, title: string, artist: string, audioUrl: string) => Promise<void>;
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
  isSeeking: false,
  setIsSeeking: (isSeeking) => set({ isSeeking }),

  connect: (roomCode, username) => {
    if (get().socket) return;
    const socket = io(API_URL, {
      transports: ['websocket'], upgrade: false, reconnectionDelay: 50,
      reconnectionDelayMax: 200, timeout: 3000, forceNew: true
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
    if (audioNodes.source) {
      audioNodes.source.disconnect();
      set(state => ({ audioNodes: { ...state.audioNodes, source: null }}));
    }
    if (audioNodes.context?.state === 'suspended') {
        audioNodes.context.resume().catch(e => console.error("Failed to resume AudioContext:", e));
    }
    if (!audioNodes.context || !audioNodes.bass || !audioNodes.mids || !audioNodes.treble) return;
    try {
      if (audioElement) {
        const source = audioNodes.context.createMediaElementSource(audioElement);
        source.connect(audioNodes.bass);
        audioNodes.bass.connect(audioNodes.mids);
        audioNodes.mids.connect(audioNodes.treble);
        audioNodes.treble.connect(audioNodes.context.destination);
        set(state => ({ audioNodes: { ...state.audioNodes, source }}));
        get().setEqualizer(get().equalizer, false);
      }
    } catch (e) {
      console.error("Failed to connect audio graph:", e);
    }
  },
  _startSyncLoop: () => {
    get()._stopSyncLoop();
    const interval = setInterval(() => {
      const { isAdmin, socket, roomCode, player, audioElement, isPlaying, currentTrackIndex, playlist, isSeeking } = get();
      if (!isAdmin || !socket || !isPlaying || isSeeking) return;
      try {
        const currentTrack = playlist[currentTrackIndex];
        let currentTime = 0;
        if (currentTrack?.isUpload && audioElement) currentTime = audioElement.currentTime;
        else if (player && typeof player.getCurrentTime === 'function') currentTime = player.getCurrentTime();
        
        socket.emit('update_player_state', {
          room_code: roomCode,
          state: { isPlaying, trackIndex: currentTrackIndex, currentTime, timestamp: Date.now() / 1000 }
        });
      } catch (error) { console.error('Sync loop error:', error); }
    }, 250); // Slowed down the sync loop slightly to be less aggressive
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
    const audioEl = new Audio();
    audioEl.preload = 'auto';
    audioEl.crossOrigin = 'anonymous';
    audioEl.addEventListener('timeupdate', () => { if (!get().isLoading && !get().isSeeking) { set({ currentTime: audioEl.currentTime }); } });
    audioEl.addEventListener('play', () => { if (get()._canControl()) { set({ isPlaying: true }); get()._startSyncLoop(); } });
    audioEl.addEventListener('pause', () => { if (get()._canControl()) { set({ isPlaying: false }); get()._stopSyncLoop(); } });
    audioEl.addEventListener('ended', () => { if (get()._canControl()) { get().nextTrack(); } });
    audioEl.addEventListener('error', (e) => {
      console.error('Audio element error:', e);
      if (get()._canControl()) { alert('Error playing audio file. Skipping to next track.'); get().nextTrack(); }
    });
    set({ audioElement: audioEl });
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ latencyHint: 'interactive', sampleRate: 48000 });
      const bass = audioContext.createBiquadFilter(); bass.type = "lowshelf"; bass.frequency.value = 250;
      const mids = audioContext.createBiquadFilter(); mids.type = "peaking"; mids.frequency.value = 1000; mids.Q.value = 1;
      const treble = audioContext.createBiquadFilter(); treble.type = "highshelf"; treble.frequency.value = 4000;
      set({ audioNodes: { context: audioContext, source: null, bass, mids, treble } });
    } catch (e) { console.error("Could not create Web Audio Context:", e); }
    const onPlayerReady = (event: any) => {
      const player = event.target;
      player.setVolume(get().volume);
      set({ player });
      const { playlist, currentTrackIndex } = get();
      if (playlist.length > 0 && !playlist[currentTrackIndex]?.isUpload) {
        player.cueVideoById(playlist[currentTrackIndex].youtubeId);
      }
    };
    const onPlayerStateChange = (event: any) => {
      const state = get();
      if (!state._canControl() || state.isSeeking) return;
      let newIsPlaying = state.isPlaying;
      if (event.data === window.YT.PlayerState.PLAYING) { newIsPlaying = true; state._startSyncLoop(); } 
      else if (event.data === window.YT.PlayerState.PAUSED) { newIsPlaying = false; state._stopSyncLoop(); } 
      else if (event.data === window.YT.PlayerState.ENDED) { state.nextTrack(); return; }
      if (newIsPlaying !== state.isPlaying) set({ isPlaying: newIsPlaying });
    };
    window.onYouTubeIframeAPIReady = () => {
      new window.YT.Player(domId, {
        height: '0', width: '0',
        playerVars: { origin: window.location.origin, controls: 0 },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
      });
    };
    if (window.YT && window.YT.Player) { window.onYouTubeIframeAPIReady(); }
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
    if (audioElement) { audioElement.pause(); audioElement.currentTime = 0; }
    if (player && typeof player.stopVideo === 'function') { player.stopVideo(); }
    set({ currentTrackIndex: index, isPlaying: false, currentTime: 0 });
    if (newTrack.isUpload && newTrack.audioUrl && audioElement) {
      audioElement.src = newTrack.audioUrl;
      audioElement.load();
      get()._connectAudioGraph();
      audioElement.play().then(() => { set({ isPlaying: true }); get()._startSyncLoop(); }).catch(e => console.error('Play error:', e));
    } else if (newTrack.youtubeId && player) {
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
      if (isPlaying) { audioElement.pause(); } 
      else { if (audioNodes.context?.state === 'suspended') { audioNodes.context.resume(); } audioElement.play().catch(e => console.error('Play error:', e)); }
    } else if (player) {
      if (isPlaying) { player.pauseVideo(); } 
      else { if (audioNodes.context?.state === 'suspended') { audioNodes.context.resume(); } player.playVideo(); }
    }
  },
  nextTrack: () => get()._changeTrack((get().currentTrackIndex + 1) % get().playlist.length),
  prevTrack: () => get()._changeTrack((get().currentTrackIndex - 1 + get().playlist.length) % get().playlist.length),
  selectTrack: (index) => { if (index !== get().currentTrackIndex) get()._changeTrack(index); else get().playPause(); },
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
      socket?.emit('update_player_state', { room_code: roomCode, state: { equalizer: settings } });
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

  // =================================================================
  // =============== NEW "SMART SYNC" LOGIC STARTS HERE ==============
  // =================================================================
  syncPlayerState: (state) => {
    const { player, audioElement, playlist, currentTrackIndex, isPlaying, volume, isCollaborative, equalizer, audioNodes, isSeeking } = get();
    
    // Ignore sync commands if this client is the one seeking
    if (isSeeking) return;

    // --- State updates that don't affect playback timing ---
    if (state.equalizer && JSON.stringify(state.equalizer) !== JSON.stringify(equalizer)) { get().setEqualizer(state.equalizer, false); }
    if (state.isCollaborative !== undefined && state.isCollaborative !== isCollaborative) { set({ isCollaborative: state.isCollaborative }); }
    if (state.volume !== undefined && state.volume !== volume) {
      if (audioElement) audioElement.volume = state.volume / 100;
      if (player) player.setVolume(state.volume);
      set({ volume: state.volume });
    }
    
    // --- Track Change Logic ---
    if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
      if (state.trackIndex >= 0 && state.trackIndex < playlist.length) {
        set({ currentTrackIndex: state.trackIndex, isPlaying: false, currentTime: 0 }); // Pre-emptively set state
        const track = playlist[state.trackIndex];
        if (track.isUpload && track.audioUrl && audioElement) {
          audioElement.src = track.audioUrl;
          audioElement.load();
          get()._connectAudioGraph();
        } else if (track.youtubeId && player) {
          player.loadVideoById(track.youtubeId);
          get().fetchLyrics(track.youtubeId);
        }
      }
    }

    // --- High-Precision Timing and Play/Pause Sync ---
    const currentTrack = playlist[get().currentTrackIndex];
    const targetPlayer = currentTrack?.isUpload ? audioElement : player;
    if (!targetPlayer) return;

    if (state.currentTime !== undefined) {
      const now = Date.now() / 1000;
      const latency = now - (state.timestamp || now);
      const serverTime = state.currentTime + latency;
      
      const clientTime = currentTrack?.isUpload ? targetPlayer.currentTime : (targetPlayer.getCurrentTime?.() || 0);
      const drift = serverTime - clientTime;

      // 1. If we are within the tolerance window, DO NOTHING. This prevents micro-stutters.
      if (Math.abs(drift) < SYNC_TOLERANCE_SECONDS) {
        // All good, just make sure the playing state is correct.
        if (state.isPlaying !== undefined && state.isPlaying !== isPlaying) {
          state.isPlaying ? targetPlayer.play() : targetPlayer.pause();
          set({ isPlaying: state.isPlaying });
        }
        return; 
      }

      // 2. If we are significantly behind, perform a HARD SEEK.
      if (drift > HARD_SEEK_THRESHOLD_SECONDS) {
        console.log(`🎯 Hard Sync: Client is behind by ${drift.toFixed(2)}s. Seeking.`);
        if (currentTrack?.isUpload) targetPlayer.currentTime = serverTime;
        else targetPlayer.seekTo(serverTime, true);
        
      // 3. If we are ahead, perform a SOFT SYNC (pause and resume).
      } else if (drift < 0) {
        console.log(`🎯 Soft Sync: Client is ahead by ${Math.abs(drift).toFixed(2)}s. Pausing.`);
        targetPlayer.pause();
        setTimeout(() => {
          if (get().isPlaying) targetPlayer.play();
        }, Math.abs(drift) * 1000);
      }
    }
    
    // Final state check for isPlaying, especially after a seek
    if (state.isPlaying !== undefined && state.isPlaying !== get().isPlaying) {
      state.isPlaying ? targetPlayer.play() : targetPlayer.pause();
      set({ isPlaying: state.isPlaying });
    }
  },
  // =================================================================
  // =================== NEW "SMART SYNC" LOGIC ENDS =================
  // =================================================================


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
    if (audioNodes.context?.state === 'suspended') { audioNodes.context.resume(); }
    if (audioElement) { audioElement.volume = volume / 100; }
    if (player && typeof player.playVideo === 'function') {
      player.mute(); player.playVideo();
      setTimeout(() => { player.pauseVideo(); player.unMute(); player.setVolume(volume); }, 250);
    }
  },
  uploadFile: async (file: File, title?: string, artist?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await fetch(`${API_URL}/api/upload`, { method: 'POST', body: formData });
      if (!response.ok) throw new Error('Upload failed');
      const data = await response.json();
      await get().addUploadToPlaylist(data.filename, title || file.name.replace(/\.[^/.]+$/, ""), artist || 'Unknown Artist', data.audioUrl);
      return data;
    } catch (error) { console.error('Upload error:', error); throw error; }
  },
  addUploadToPlaylist: async (filename: string, title: string, artist: string, audioUrl: string) => {
    const { roomCode } = get();
    try {
      const response = await fetch(`${API_URL}/api/room/${roomCode}/add-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, title, artist, audioUrl })
      });
      if (!response.ok) throw new Error('Failed to add to playlist');
    } catch (error) { console.error('Add to playlist error:', error); throw error; }
  },
  refreshPlaylist: async () => {
    const { roomCode, playlist } = get();
    if (!roomCode) return;
    try {
      const response = await fetch(`${API_URL}/api/room/${roomCode}`);
      if (response.ok) {
        const data = await response.json();
        if (JSON.stringify(data.playlist) !== JSON.stringify(playlist)) {
             set({ playlist: data.playlist });
        }
      }
    } catch (error) { console.error('Error refreshing playlist:', error); }
  }
}));