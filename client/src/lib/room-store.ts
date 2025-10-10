import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

// ==========================================
// ZERO-LATENCY CONSTANTS (RE-TUNED FOR HIGH-PERFORMANCE SYNC)
// ==========================================
const NETWORK_JITTER_THRESHOLD = 0.08; // 80ms - allow for minor network fluctuations before correcting
const HARD_SYNC_THRESHOLD = 0.3;       // 300ms - force seek if drift is larger than this
const SOFT_SYNC_PAUSE_DURATION = 70;   // 70ms - a very short pause for soft-syncing, less noticeable
const SYNC_HEARTBEAT_INTERVAL = 1000;  // 1s - admin's periodic "heartbeat" to correct long-term drift.

interface Song {
  name: string;
  artist: string;
  albumArt: string | null;
  youtubeId?: string;
  isUpload?: boolean;
  audioUrl?: string;
}

interface User {
  name: string;
  isAdmin: boolean;
}

declare global {
  interface Window {
    onYouTubeIframeAPIReady: () => void;
    YT: any;
  }
}

interface EqualizerSettings {
  bass: number;
  mids: number;
  treble: number;
}

interface SyncState {
  isPlaying?: boolean;
  trackIndex?: number;
  volume?: number;
  isCollaborative?: boolean;
  equalizer?: EqualizerSettings;
  currentTime?: number;
  timestamp?: number;
  serverTimestamp?: number;
}

interface AudioNodes {
  context: AudioContext | null;
  source: MediaElementAudioSourceNode | null;
  bass: BiquadFilterNode | null;
  mids: BiquadFilterNode | null;
  treble: BiquadFilterNode | null;
}

interface LyricLine {
  time: number;
  text: string;
}

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
  lyrics: { lines: LyricLine[]; isLoading: boolean };
  audioElement: HTMLAudioElement | null;
  syncInterval: NodeJS.Timeout | null;
  isSeeking: boolean;
  manualLatencyOffset: number; // NEW: for manual adjustment

  setIsSeeking: (isSeeking: boolean) => void;
  setManualLatencyOffset: (offset: number) => void; // NEW: setter for latency
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
  _changeTrack: (index: number, newState: Partial<SyncState>) => void;
  _canControl: () => boolean;
  _connectAudioGraph: () => void;
  _startSyncLoop: () => void;
  _stopSyncLoop: () => void;
  fetchLyrics: (youtubeId: string) => void;
  setCurrentTime: (time: number) => void;
  primePlayer: () => void;
  uploadFile: (file: File, title?: string, artist?: string) => Promise<{ filename: string; audioUrl: string }>;
  addUploadToPlaylist: (filename: string, title: string, artist: string, audioUrl: string) => Promise<void>;
  refreshPlaylist: () => void;
  _emitStateUpdate: (overrideState?: Partial<SyncState>) => void;
}

export const useRoomStore = create<RoomState>((set, get) => ({
  roomCode: '',
  playlistTitle: '',
  playlist: [],
  users: [],
  currentTrackIndex: 0,
  isPlaying: false,
  volume: 80,
  isCollaborative: false,
  isLoading: true,
  error: null,
  player: null,
  socket: null,
  isAdmin: false,
  username: '',
  equalizer: { bass: 0, mids: 0, treble: 0 },
  audioNodes: { context: null, source: null, bass: null, mids: null, treble: null },
  currentTime: 0,
  lyrics: { lines: [], isLoading: false },
  audioElement: null,
  syncInterval: null,
  isSeeking: false,
  manualLatencyOffset: 0, // NEW: Default offset is 0

  setIsSeeking: (isSeeking) => set({ isSeeking }),
  setManualLatencyOffset: (offset) => set({ manualLatencyOffset: offset }), // NEW

  connect: (roomCode, username) => {
    if (get().socket) return;
    const socket = io(API_URL, {
      transports: ['websocket'],
      upgrade: false,
    });
    set({ socket, username, roomCode });
    socket.on('connect', () => {
      console.log('✅ Connected with High-Performance Sync');
      socket.emit('join_room', { room_code: roomCode, username });
    });
    socket.on('disconnect', () => set({ users: [], isAdmin: false }));
    socket.on('error', (data) => get().setError(data.message));
    socket.on('update_user_list', (users: User[]) => {
      const self = users.find((u) => u.name === get().username);
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
    if (!audioNodes.context) return;
    if (audioNodes.source) {
      audioNodes.source.disconnect();
    }
    if (audioNodes.context.state === 'suspended') {
      audioNodes.context.resume().catch((e) => console.error('Failed to resume AudioContext:', e));
    }
    try {
      if (audioElement && audioNodes.bass && audioNodes.mids && audioNodes.treble) {
        const source = audioNodes.context.createMediaElementSource(audioElement);
        source.connect(audioNodes.bass);
        audioNodes.bass.connect(audioNodes.mids);
        audioNodes.mids.connect(audioNodes.treble);
        audioNodes.treble.connect(audioNodes.context.destination);
        set((state) => ({ audioNodes: { ...state.audioNodes, source } }));
        get().setEqualizer(get().equalizer, false);
      }
    } catch (e) {
      console.error('Failed to connect audio graph:', e);
    }
  },
  
  _emitStateUpdate: (overrideState) => {
    const { socket, roomCode, isPlaying, currentTrackIndex, volume, isCollaborative, equalizer, _canControl, playlist, audioElement, player } = get();
    if (!_canControl() || !socket) return;
    
    const currentTrack = playlist[currentTrackIndex];
    let currentTime = 0;
    try {
      if (currentTrack?.isUpload && audioElement) {
        currentTime = audioElement.currentTime;
      } else if (player && typeof player.getCurrentTime === 'function') {
        currentTime = player.getCurrentTime();
      }
    } catch(e) { /* player not ready */ }

    const baseState: SyncState = {
        isPlaying, trackIndex: currentTrackIndex, currentTime, volume,
        isCollaborative, equalizer, timestamp: Date.now() / 1000,
    };
    const stateToSend = { ...baseState, ...overrideState };
    
    socket.emit('update_player_state', { room_code: roomCode, state: stateToSend });
  },

  _startSyncLoop: () => {
    get()._stopSyncLoop();
    const interval = setInterval(() => { get()._emitStateUpdate({}); }, SYNC_HEARTBEAT_INTERVAL);
    set({ syncInterval: interval });
  },

  _stopSyncLoop: () => {
    const { syncInterval } = get();
    if (syncInterval) {
      clearInterval(syncInterval);
      set({ syncInterval: null });
    }
  },

  initializePlayer: (domId) => {
    const audioEl = new Audio();
    audioEl.preload = 'auto';
    audioEl.crossOrigin = 'anonymous';
    audioEl.addEventListener('timeupdate', () => { if (!get().isSeeking) set({ currentTime: audioEl.currentTime }); });
    audioEl.addEventListener('play', () => { if (get()._canControl()) get()._emitStateUpdate({ isPlaying: true }); get()._startSyncLoop(); });
    audioEl.addEventListener('pause', () => { if (get()._canControl()) get()._emitStateUpdate({ isPlaying: false }); get()._stopSyncLoop(); });
    audioEl.addEventListener('ended', () => { if (get()._canControl()) get().nextTrack(); });
    audioEl.addEventListener('error', (e) => {
      console.error('Audio element error:', e);
      if (get()._canControl()) { alert('Error playing audio file. Skipping.'); get().nextTrack(); }
    });
    set({ audioElement: audioEl });

    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const bass = audioContext.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 250;
      const mids = audioContext.createBiquadFilter(); mids.type = 'peaking'; mids.frequency.value = 1000; mids.Q.value = 1;
      const treble = audioContext.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 4000;
      set({ audioNodes: { context: audioContext, source: null, bass, mids, treble } });
    } catch (e) { console.error('Could not create Web Audio Context:', e); }

    const onPlayerReady = (event: any) => {
      const player = event.target;
      player.setVolume(get().volume);
      set({ player });
    };

    const onPlayerStateChange = (event: any) => {
      const state = get();
      if (!state._canControl() || state.isSeeking) return;
      
      let newIsPlaying = state.isPlaying;
      if (event.data === window.YT.PlayerState.PLAYING) newIsPlaying = true;
      else if (event.data === window.YT.PlayerState.PAUSED) newIsPlaying = false;
      else if (event.data === window.YT.PlayerState.ENDED) { state.nextTrack(); return; }

      if (newIsPlaying !== state.isPlaying) {
        set({ isPlaying: newIsPlaying });
        state._emitStateUpdate({ isPlaying: newIsPlaying });
        if (newIsPlaying) state._startSyncLoop();
        else state._stopSyncLoop();
      }
    };

    window.onYouTubeIframeAPIReady = () => {
      new window.YT.Player(domId, {
        height: '0', width: '0',
        playerVars: { origin: window.location.origin, controls: 0, disablekb: 1 },
        events: { onReady: onPlayerReady, onStateChange: onPlayerStateChange },
      });
    };

    if (window.YT && window.YT.Player) window.onYouTubeIframeAPIReady();
  },

  setPlaylistData: (title, playlist) => {
    set({ playlistTitle: title, playlist, isLoading: false, error: null, currentTrackIndex: 0, isPlaying: false });
    if (playlist.length > 0 && playlist[0].youtubeId) get().fetchLyrics(playlist[0].youtubeId);
  },

  _canControl: () => get().isAdmin || get().isCollaborative,

  _changeTrack: (index, newState) => {
    const { player, audioElement, playlist } = get();
    if (!get()._canControl() || index < 0 || index >= playlist.length) return;
    
    get()._stopSyncLoop();
    const newTrack = playlist[index];
    audioElement?.pause();
    if (audioElement) audioElement.currentTime = 0;
    player?.stopVideo();
    
    set({ currentTrackIndex: index, isPlaying: false, currentTime: 0 });
    
    get()._emitStateUpdate({ trackIndex: index, isPlaying: false, currentTime: 0, ...newState });

    if (newTrack.isUpload && newTrack.audioUrl && audioElement) {
      audioElement.src = newTrack.audioUrl;
      audioElement.load();
      get()._connectAudioGraph();
      audioElement.play().catch((e) => console.error('Play error:', e));
    } else if (newTrack.youtubeId && player) {
      get().fetchLyrics(newTrack.youtubeId);
      player.loadVideoById(newTrack.youtubeId, newState.currentTime || 0);
    }
  },
  
  playPause: () => {
    if (!get()._canControl()) return;
    const { player, audioElement, isPlaying, playlist, currentTrackIndex } = get();
    const currentTrack = playlist[currentTrackIndex];

    const targetPlayer = currentTrack?.isUpload ? audioElement : player;
    if (!targetPlayer) return;

    if (isPlaying) targetPlayer.pause();
    else targetPlayer.play()?.catch((e:any) => console.error("Play error:", e));
  },

  nextTrack: () => get()._changeTrack((get().currentTrackIndex + 1) % get().playlist.length, {}),
  prevTrack: () => get()._changeTrack((get().currentTrackIndex - 1 + get().playlist.length) % get().playlist.length, {}),
  selectTrack: (index) => {
    if (index !== get().currentTrackIndex) get()._changeTrack(index, { isPlaying: true });
    else get().playPause();
  },

  setVolume: (volume: number) => {
    const { player, audioElement } = get();
    if (audioElement) audioElement.volume = volume / 100;
    if (player?.setVolume) player.setVolume(volume);
    set({ volume });
    if (get()._canControl()) get()._emitStateUpdate({ volume });
  },

  setEqualizer: (settings, emit = true) => {
    const { audioNodes, _canControl } = get();
    if (audioNodes.bass) audioNodes.bass.gain.value = settings.bass;
    if (audioNodes.mids) audioNodes.mids.gain.value = settings.mids;
    if (audioNodes.treble) audioNodes.treble.gain.value = settings.treble;
    set({ equalizer: settings });
    if (emit && _canControl()) get()._emitStateUpdate({ equalizer: settings });
  },

  toggleCollaborative: () => {
    if (get().isAdmin) {
      const newState = !get().isCollaborative;
      set({ isCollaborative: newState });
      get()._emitStateUpdate({ isCollaborative: newState });
    }
  },

  syncPlayerState: (state) => {
    const { player, audioElement, playlist, currentTrackIndex, isPlaying, volume, isCollaborative, equalizer, isSeeking, manualLatencyOffset } = get();

    if (isSeeking) return;

    if (state.equalizer && JSON.stringify(state.equalizer) !== JSON.stringify(equalizer)) get().setEqualizer(state.equalizer, false);
    if (state.isCollaborative !== undefined && state.isCollaborative !== isCollaborative) set({ isCollaborative: state.isCollaborative });
    if (state.volume !== undefined && state.volume !== volume) get().setVolume(state.volume);

    const isNewTrack = state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex;
    if (isNewTrack && state.trackIndex! >= 0 && state.trackIndex! < playlist.length) {
        set({ currentTrackIndex: state.trackIndex!, isPlaying: false, currentTime: 0 });
        const track = playlist[state.trackIndex!];
        if (track.isUpload && track.audioUrl && audioElement) {
            audioElement.src = track.audioUrl;
            audioElement.load();
            get()._connectAudioGraph();
        } else if (track.youtubeId && player) {
            player.cueVideoById(track.youtubeId, state.currentTime);
            get().fetchLyrics(track.youtubeId);
        }
    }

    const currentTrack = playlist[get().currentTrackIndex];
    const targetPlayer = currentTrack?.isUpload ? audioElement : player;
    if (!targetPlayer) return;

    if (state.currentTime !== undefined && state.serverTimestamp !== undefined) {
        const serverSendTime = state.serverTimestamp;
        const clientReceiveTime = Date.now() / 1000;
        const networkLatency = clientReceiveTime - serverSendTime;

        if (networkLatency < 0 || networkLatency > 3.0) return; // Ignore stale packet

        // FIX: The manual offset should adjust for being *ahead* or *behind*.
        // A negative offset means "I am behind, play sooner for me".
        // A positive offset means "I am ahead, play later for me".
        // The current implementation is correct: adding the offset adjusts the target time appropriately.
        const projectedTime = state.currentTime + (state.isPlaying ? networkLatency : 0) + manualLatencyOffset;

        let playerTime = 0;
        try { playerTime = currentTrack?.isUpload && audioElement ? audioElement.currentTime : (player?.getCurrentTime?.() || 0); } catch (e) { /* Player not ready */ }
        
        const drift = projectedTime - playerTime;

        if (Math.abs(drift) > NETWORK_JITTER_THRESHOLD) {
            if (Math.abs(drift) > HARD_SYNC_THRESHOLD) {
                console.log(`🎯 HARD SYNC | Drift: ${drift.toFixed(3)}s | Seeking to ${projectedTime.toFixed(2)}s`);
                if (currentTrack?.isUpload && audioElement) audioElement.currentTime = projectedTime;
                else player?.seekTo(projectedTime, true);
            } else if (drift < -NETWORK_JITTER_THRESHOLD) {
                console.log(`🎯 SOFT SYNC (AHEAD) | Drift: ${drift.toFixed(3)}s | Pausing briefly`);
                targetPlayer.pause();
                setTimeout(() => { if (get().isPlaying) targetPlayer.play()?.catch(()=>{}); }, SOFT_SYNC_PAUSE_DURATION);
            }
        }
    }

    if (state.isPlaying !== undefined && state.isPlaying !== get().isPlaying) {
        console.log(`Syncing play state: ${get().isPlaying} -> ${state.isPlaying}`);
        state.isPlaying ? targetPlayer.play()?.catch(()=>{}) : targetPlayer.pause();
        set({ isPlaying: state.isPlaying });
    }
  },

  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error, isLoading: false }),
  setCurrentTime: (time) => set({ currentTime: time }),

  fetchLyrics: async (youtubeId) => {
    set((state) => ({ lyrics: { ...state.lyrics, isLoading: true } }));
    try {
      const response = await fetch(`${API_URL}/api/lyrics/${youtubeId}`);
      if (!response.ok) throw new Error('Lyrics not found.');
      const lines: LyricLine[] = await response.json();
      set({ lyrics: { lines, isLoading: false } });
    } catch (error) {
      console.error('Failed to fetch lyrics:', error);
      set({ lyrics: { lines: [], isLoading: false } });
    }
  },

  primePlayer: () => {
    const { player, audioElement, volume, audioNodes } = get();
    if (audioNodes.context?.state === 'suspended') {
      audioNodes.context.resume();
    }
    if (audioElement) audioElement.volume = 0; // Mute for priming
    if (player?.playVideo) {
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
      const response = await fetch(`${API_URL}/api/upload`, { method: 'POST', body: formData });
      if (!response.ok) throw new Error('Upload failed');
      const data = await response.json();
      await get().addUploadToPlaylist(data.filename, title || file.name.replace(/\.[^/.]+$/, ''), artist || 'Unknown Artist', data.audioUrl);
      return data;
    } catch (error) { console.error('Upload error:', error); throw error; }
  },

  addUploadToPlaylist: async (filename: string, title: string, artist: string, audioUrl: string) => {
    const { roomCode } = get();
    try {
      // FIX: Corrected typo from API__URL to API_URL
      const response = await fetch(`${API_URL}/api/room/${roomCode}/add-upload`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, title, artist, audioUrl }),
      });
      if (!response.ok) throw new Error('Failed to add to playlist');
    } catch (error) { console.error('Add to playlist error:', error); throw error; }
  },

  refreshPlaylist: async () => {
    // FIX: Corrected the broken syntax from the previous version.
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
  },
}));