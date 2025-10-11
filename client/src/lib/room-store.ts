import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

const HARD_SYNC_THRESHOLD = 0.25; 
const ADAPTIVE_RATE_THRESHOLD = 0.05; 
const PLAYBACK_RATE_ADJUST = 0.015; 
const SYNC_HEARTBEAT_INTERVAL = 500;
const CLOCK_SYNC_INTERVAL = 10000;

interface Song { name: string; artist: string; albumArt: string | null; youtubeId?: string; isUpload?: boolean; audioUrl?: string; }
interface User { name: string; isAdmin: boolean; }
declare global { interface Window { onYouTubeIframeAPIReady: () => void; YT: any; } }
interface EqualizerSettings { bass: number; mids: number; treble: number; }
interface SyncState { isPlaying?: boolean; trackIndex?: number; volume?: number; isCollaborative?: boolean; equalizer?: EqualizerSettings; currentTime?: number; serverTimestamp?: number; }
interface AudioNodes { context: AudioContext | null; source: MediaElementAudioSourceNode | null; bass: BiquadFilterNode | null; mids: BiquadFilterNode | null; treble: BiquadFilterNode | null; }
interface LyricLine { time: number; text: string; }

interface RoomState {
  socket: Socket | null; player: any; audioElement: HTMLAudioElement | null;
  playlist: Song[]; currentTrackIndex: number; isPlaying: boolean;
  isSeeking: boolean; manualLatencyOffset: number; serverClockOffset: number; isAudioGraphConnected: boolean;
  syncInterval: NodeJS.Timeout | null; clockSyncInterval: NodeJS.Timeout | null;
  roomCode: string; playlistTitle: string; users: User[]; volume: number; isCollaborative: boolean; isLoading: boolean; error: string | null; isAdmin: boolean; username: string; equalizer: EqualizerSettings; audioNodes: AudioNodes; currentTime: number; lyrics: { lines: LyricLine[]; isLoading: boolean; };
  playerReady: boolean; contextUnlocked: boolean;
  connect: (roomCode: string, username: string) => void; disconnect: () => void; initializePlayer: (domId: string) => void;
  setPlaylistData: (title: string, playlist: Song[]) => void; playPause: () => void; nextTrack: () => void; prevTrack: () => void; selectTrack: (index: number) => void; setVolume: (volume: number) => void; setEqualizer: (settings: EqualizerSettings) => void; toggleCollaborative: () => void; setIsSeeking: (isSeeking: boolean) => void; setManualLatencyOffset: (offset: number) => void;
  _emitStateUpdate: (overrideState?: Partial<Omit<SyncState, 'serverTimestamp'>>) => void;
  syncPlayerState: (state: SyncState) => void; _syncClock: () => Promise<void>; primePlayer: () => void; fetchLyrics: (youtubeId: string) => void; refreshPlaylist: () => void;
  uploadFile: (file: File, title?: string, artist?: string) => Promise<any>;
  setLoading: (loading: boolean) => void; setError: (error: string | null) => void;
}

let globalAudioContext: AudioContext | null = null;
let globalAudioSource: MediaElementAudioSourceNode | null = null;

export const useRoomStore = create<RoomState>((set, get) => ({
  socket: null, player: null, audioElement: null,
  playlist: [], currentTrackIndex: 0, isPlaying: false,
  isSeeking: false, manualLatencyOffset: 0, serverClockOffset: 0, isAudioGraphConnected: false,
  syncInterval: null, clockSyncInterval: null,
  roomCode: '', playlistTitle: '', users: [], volume: 80, isCollaborative: false, isLoading: true, error: null, isAdmin: false, username: '', equalizer: { bass: 0, mids: 0, treble: 0 }, audioNodes: { context: null, source: null, bass: null, mids: null, treble: null }, currentTime: 0, lyrics: { lines: [], isLoading: false },
  playerReady: false, contextUnlocked: false,
  
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error, isLoading: false }),
  setIsSeeking: (isSeeking) => set({ isSeeking }),
  setManualLatencyOffset: (offset) => set({ manualLatencyOffset: offset }),

  connect: (roomCode, username) => {
    if (get().socket) return;
    const socket = io(API_URL, { transports: ['websocket'], reconnection: true, reconnectionAttempts: 5 });
    set({ socket, username, roomCode });
    
    socket.on('connect', () => {
      console.log('✅ Connected to server');
      socket.emit('join_room', { room_code: roomCode, username });
      get()._syncClock();
      const clockInterval = setInterval(() => get()._syncClock(), CLOCK_SYNC_INTERVAL);
      set({ clockSyncInterval: clockInterval });
      
      const syncInt = setInterval(() => {
        if (get().isAdmin && get().playerReady) {
          get()._emitStateUpdate();
        }
      }, SYNC_HEARTBEAT_INTERVAL);
      set({ syncInterval: syncInt });
    });
    
    socket.on('disconnect', () => console.log('⚠️ Disconnected from server'));
    socket.on('error', (data) => get().setError(data.message));
    socket.on('update_user_list', (users: User[]) => { 
      const self = users.find(u => u.name === get().username); 
      set({ users, isAdmin: self?.isAdmin || false }); 
      if (self?.isAdmin) console.log('🎯 You are now admin');
    });
    socket.on('load_current_state', (state) => get().syncPlayerState(state));
    socket.on('sync_player_state', (state) => get().syncPlayerState(state));
    socket.on('refresh_playlist', () => get().refreshPlaylist());
  },
  
  disconnect: () => {
    const { socket, syncInterval, clockSyncInterval, player, audioElement } = get();
    if (syncInterval) clearInterval(syncInterval);
    if (clockSyncInterval) clearInterval(clockSyncInterval);
    if (player?.destroy) player.destroy();
    if (audioElement) { audioElement.pause(); audioElement.src = ''; }
    socket?.disconnect();
    set({ socket: null, syncInterval: null, clockSyncInterval: null, player: null, playerReady: false });
  },

  _emitStateUpdate: (overrideState) => {
    const { socket, roomCode, isPlaying, currentTrackIndex, isAdmin, isCollaborative, playlist, audioElement, player, playerReady } = get();
    if (!isAdmin && !isCollaborative || !playerReady) return;
    
    let currentTime = 0;
    try { 
      const track = playlist[currentTrackIndex];
      if (track?.isUpload && audioElement) {
        currentTime = audioElement.currentTime || 0;
      } else if (player?.getCurrentTime) {
        currentTime = player.getCurrentTime() || 0;
      }
    } catch(e) {}
    
    socket?.emit('update_player_state', { 
      room_code: roomCode, 
      state: { 
        isPlaying, trackIndex: currentTrackIndex, currentTime, 
        timestamp: Date.now() / 1000, ...overrideState 
      }
    });
  },
  
  syncPlayerState: (state) => {
    const { player, audioElement, playlist, currentTrackIndex, isPlaying, isSeeking, manualLatencyOffset, serverClockOffset, playerReady, volume, isAdmin, nextTrack } = get();
    if (isSeeking || !playerReady) return;

    if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
        set({ currentTrackIndex: state.trackIndex });
        const track = playlist[state.trackIndex];

        if (!track || (!track.youtubeId && !track.audioUrl)) {
            console.error(`Track at index ${state.trackIndex} is invalid or has no source. Skipping.`);
            if (isAdmin) setTimeout(() => nextTrack(), 500);
            return;
        }

        if (track.isUpload) {
            if (player?.stopVideo) player.stopVideo();
            if (audioElement && track.audioUrl) {
                audioElement.src = track.audioUrl;
                audioElement.volume = volume / 100;
                audioElement.load();
            }
        } else {
            if (audioElement) {
                audioElement.pause();
                audioElement.src = '';
            }
            if (player && track.youtubeId) {
                player.loadVideoById(track.youtubeId);
                player.setVolume(volume);
                get().fetchLyrics(track.youtubeId);
            }
        }
    }
    
    const targetTrack = playlist[get().currentTrackIndex];
    if (!targetTrack) return;

    if (state.currentTime !== undefined && state.serverTimestamp !== undefined) {
        const serverTimeNow = Date.now() / 1000 - serverClockOffset;
        const timeSinceUpdate = serverTimeNow - state.serverTimestamp;

        if (timeSinceUpdate >= 0 && timeSinceUpdate < 5) {
            const projectedTime = state.currentTime + (state.isPlaying ? timeSinceUpdate : 0);
            let playerTime = 0;
            try {
                if (targetTrack.isUpload && audioElement) playerTime = (audioElement.currentTime || 0) - manualLatencyOffset;
                else if (player?.getCurrentTime) playerTime = (player.getCurrentTime() || 0) - manualLatencyOffset;
            } catch(e) {}
            
            const drift = projectedTime - playerTime;
            
            if (!targetTrack.isUpload && player?.setPlaybackRate && state.isPlaying) {
                if (Math.abs(drift) > ADAPTIVE_RATE_THRESHOLD && Math.abs(drift) < HARD_SYNC_THRESHOLD) {
                    const newRate = 1.0 + Math.min(Math.max(drift * 0.5, -PLAYBACK_RATE_ADJUST * 2), PLAYBACK_RATE_ADJUST * 2);
                    if (Math.abs(player.getPlaybackRate() - newRate) > 0.001) player.setPlaybackRate(newRate);
                } else if (Math.abs(drift) < ADAPTIVE_RATE_THRESHOLD) {
                    if (Math.abs(player.getPlaybackRate() - 1.0) > 0.001) player.setPlaybackRate(1.0);
                }
            }
            
            if (Math.abs(drift) > HARD_SYNC_THRESHOLD) {
                const seekTime = projectedTime + manualLatencyOffset;
                if (isFinite(seekTime) && seekTime >= 0) {
                    console.log(`🔄 Hard sync: drift=${drift.toFixed(3)}s, seeking to ${seekTime.toFixed(2)}s`);
                    try {
                      if (targetTrack.isUpload && audioElement) audioElement.currentTime = seekTime;
                      else if (player?.seekTo) player.seekTo(seekTime, true);
                    } catch(e) { console.warn('Seek error:', e); }
                }
            }
        }
    }
    
    if (state.isPlaying !== undefined && state.isPlaying !== isPlaying) {
        set({ isPlaying: state.isPlaying });
        try {
          if (targetTrack.isUpload && audioElement) { 
            state.isPlaying ? audioElement.play().catch(e => console.warn("Play failed:", e)) : audioElement.pause();
          } else if (player) { 
            state.isPlaying ? player.playVideo() : player.pauseVideo();
          }
        } catch(e) { console.warn('Play/pause sync error:', e); }
    }
    
    if (state.volume !== undefined && state.volume !== volume) {
      set({ volume: state.volume });
      if (audioElement) audioElement.volume = state.volume / 100;
      if (player?.setVolume) player.setVolume(state.volume);
    }
    if (state.equalizer) {
      const { audioNodes } = get();
      if (audioNodes.bass) audioNodes.bass.gain.value = state.equalizer.bass;
      if (audioNodes.mids) audioNodes.mids.gain.value = state.equalizer.mids;
      if (audioNodes.treble) audioNodes.treble.gain.value = state.equalizer.treble;
      set({ equalizer: state.equalizer });
    }
    if (state.isCollaborative !== undefined) set({ isCollaborative: state.isCollaborative });
  },

  _syncClock: async () => {
    try {
        const res = await fetch(`${API_URL}/ping`);
        if (!res.ok) throw new Error(`Ping failed: ${res.status}`);
        const clientReceiveTime = Date.now() / 1000;
        const data = await res.json();
        const serverTime = data.serverTime;
        const offset = clientReceiveTime - serverTime;
        set({ serverClockOffset: offset });
    } catch (e) { console.warn("Clock sync failed:", e); }
  },

  initializePlayer: (domId) => {
    if (get().isAudioGraphConnected) return;

    const audioEl = new Audio();
    audioEl.crossOrigin = 'anonymous';
    audioEl.addEventListener('timeupdate', () => { if (!get().isSeeking) set({ currentTime: audioEl.currentTime }); });
    audioEl.addEventListener('play', () => { if (get().isAdmin) set({ isPlaying: true }); });
    audioEl.addEventListener('pause', () => { if (get().isAdmin) set({ isPlaying: false }); });
    audioEl.addEventListener('ended', () => { if (get().isAdmin) get().nextTrack(); });
    audioEl.addEventListener('error', (e) => {
        console.error('Audio element error:', e);
        if(get().isAdmin) {
            console.log("Audio error, admin skipping to next track.");
            setTimeout(() => get().nextTrack(), 500);
        }
    });
    set({ audioElement: audioEl });

    try {
        if (!globalAudioContext) {
            globalAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            globalAudioSource = globalAudioContext.createMediaElementSource(audioEl);
            const bass = globalAudioContext.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 200; bass.gain.value = 0;
            const mids = globalAudioContext.createBiquadFilter(); mids.type = 'peaking'; mids.frequency.value = 2000; mids.Q.value = 1; mids.gain.value = 0;
            const treble = globalAudioContext.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 5000; treble.gain.value = 0;
            globalAudioSource.connect(bass); bass.connect(mids); mids.connect(treble); treble.connect(globalAudioContext.destination);
            set({ audioNodes: { context: globalAudioContext, source: globalAudioSource, bass, mids, treble }, isAudioGraphConnected: true });
            console.log("✅ AudioContext initialized");
        }
    } catch (e) { console.error("AudioContext error:", e); }
    
    const onPlayerReady = (e: any) => {
      console.log('✅ YouTube player ready');
      set({ player: e.target, playerReady: true });
      if (e.target?.setVolume) e.target.setVolume(get().volume);
    };

    const onPlayerStateChange = (e: any) => {
        const { isAdmin, nextTrack, _emitStateUpdate, playerReady, isPlaying } = get();
        if (!playerReady) return;
        const newIsPlaying = e.data === window.YT.PlayerState.PLAYING;
        if (e.data === window.YT.PlayerState.ENDED && isAdmin) { nextTrack(); return; }
        if (isAdmin && isPlaying !== newIsPlaying) {
          set({ isPlaying: newIsPlaying });
          setTimeout(() => _emitStateUpdate({ isPlaying: newIsPlaying }), 100);
        }
    };

    const onPlayerError = (e: any) => {
      console.error('YouTube player error:', e.data);
      if (get().isAdmin) {
        console.log("YouTube error, admin skipping to next track.");
        setTimeout(() => get().nextTrack(), 1000);
      }
    };

    window.onYouTubeIframeAPIReady = () => { 
      new window.YT.Player(domId, { 
        height: '0', width: '0', 
        playerVars: { controls: 0, disablekb: 1, enablejsapi: 1, playsinline: 1, origin: window.location.origin }, 
        events: { onReady: onPlayerReady, onStateChange: onPlayerStateChange, onError: onPlayerError }, 
      }); 
    };
    if (window.YT?.Player) window.onYouTubeIframeAPIReady();
  },

  setPlaylistData: (title, playlist) => { 
    set({ playlistTitle: title, playlist, isLoading: false, error: null }); 
    if (playlist.length > 0 && playlist[0]?.youtubeId) get().fetchLyrics(playlist[0].youtubeId); 
  },
  
  playPause: () => {
    const { isAdmin, isCollaborative, isPlaying, player, audioElement, playlist, currentTrackIndex, playerReady, contextUnlocked, audioNodes } = get();
    if (!isAdmin && !isCollaborative || !playerReady) return;
    
    if (!contextUnlocked && audioNodes.context) {
      if (audioNodes.context.state === 'suspended') audioNodes.context.resume().then(() => set({ contextUnlocked: true }));
      else set({ contextUnlocked: true });
    }
    
    const track = playlist[currentTrackIndex];
    if (!track) return;
    
    try {
      if (track.isUpload) {
          if (audioElement) isPlaying ? audioElement.pause() : audioElement.play().catch(e => console.error("Audio play failed", e));
      } else {
          if (player) isPlaying ? player.pauseVideo() : player.playVideo();
      }
      
      const newState = !isPlaying;
      set({ isPlaying: newState });
      get()._emitStateUpdate({ isPlaying: newState });
    } catch(e) {
      console.error('Play/pause error:', e);
    }
  },

  nextTrack: () => {
    const { isAdmin, isCollaborative, currentTrackIndex, playlist, player, audioElement } = get();
    if (!isAdmin && !isCollaborative) return;
    const newIndex = (currentTrackIndex + 1) % playlist.length;
    if (player?.stopVideo) player.stopVideo();
    if (audioElement) { audioElement.pause(); audioElement.src = ''; }
    set({ isPlaying: false });
    get()._emitStateUpdate({ trackIndex: newIndex, currentTime: 0, isPlaying: false });
  },

  prevTrack: () => {
    const { isAdmin, isCollaborative, currentTrackIndex, playlist, player, audioElement } = get();
    if (!isAdmin && !isCollaborative) return;
    const newIndex = (currentTrackIndex - 1 + playlist.length) % playlist.length;
    if (player?.stopVideo) player.stopVideo();
    if (audioElement) { audioElement.pause(); audioElement.src = ''; }
    set({ isPlaying: false });
    get()._emitStateUpdate({ trackIndex: newIndex, currentTime: 0, isPlaying: false });
  },

  selectTrack: (index) => {
    const { isAdmin, isCollaborative, currentTrackIndex, player, audioElement, playlist } = get();
    if (!isAdmin && !isCollaborative) return;
    
    const track = playlist[index];
    if (!track || (!track.youtubeId && !track.audioUrl)) {
        console.warn(`Attempted to select an invalid track at index ${index}. Skipping.`);
        if(isAdmin) get().nextTrack();
        return;
    }
    
    if (index !== currentTrackIndex) {
        if (player?.stopVideo) player.stopVideo();
        if (audioElement) { audioElement.pause(); audioElement.src = ''; }
        set({ isPlaying: false });
        get()._emitStateUpdate({ trackIndex: index, currentTime: 0, isPlaying: false });
    } else {
        get().playPause();
    }
  },

  setVolume: (volume) => { 
    const { player, audioElement, isAdmin } = get(); 
    if (audioElement) audioElement.volume = volume / 100; 
    if (player?.setVolume) player.setVolume(volume); 
    set({ volume }); 
    if (isAdmin) get()._emitStateUpdate({ volume }); 
  },
  
  setEqualizer: (settings) => { 
    const { audioNodes, isAdmin } = get(); 
    if (audioNodes.bass) audioNodes.bass.gain.value = settings.bass; 
    if (audioNodes.mids) audioNodes.mids.gain.value = settings.mids; 
    if (audioNodes.treble) audioNodes.treble.gain.value = settings.treble; 
    set({ equalizer: settings }); 
    if (isAdmin) get()._emitStateUpdate({ equalizer: settings }); 
  },
  
  toggleCollaborative: () => { 
    const { isAdmin, isCollaborative } = get(); 
    if (isAdmin) { 
      const newState = !isCollaborative; 
      set({ isCollaborative: newState }); 
      get()._emitStateUpdate({ isCollaborative: newState }); 
    } 
  },
  
  primePlayer: () => { 
    const { audioNodes } = get(); 
    if (audioNodes.context?.state === 'suspended') {
      audioNodes.context.resume().then(() => set({ contextUnlocked: true })).catch(e => console.warn('Context unlock failed:', e));
    } else { set({ contextUnlocked: true }); }
  },
  
  fetchLyrics: async (youtubeId) => { 
    if (!youtubeId) return;
    set({ lyrics: { lines: [], isLoading: true } });
    try { 
      const res = await fetch(`${API_URL}/api/lyrics/${youtubeId}`); 
      const lines = res.ok ? await res.json() : [];
      set({ lyrics: { lines, isLoading: false } }); 
    } catch (e) { 
      set({ lyrics: { lines: [], isLoading: false } }); 
    } 
  },
  
  refreshPlaylist: async () => { 
    const { roomCode, playlist } = get(); 
    if (!roomCode) return; 
    try { 
      const res = await fetch(`${API_URL}/api/room/${roomCode}`); 
      if (res.ok) { 
        const data = await res.json(); 
        if (JSON.stringify(data.playlist) !== JSON.stringify(playlist)) {
          set({ playlist: data.playlist });
        }
      } 
    } catch (e) { console.warn('Refresh playlist error:', e); } 
  },
  
  uploadFile: async (file, title, artist) => { 
    const { roomCode } = get(); 
    const formData = new FormData(); 
    formData.append('file', file); 
    const res = await fetch(`${API_URL}/api/upload`, { method: 'POST', body: formData }); 
    if (!res.ok) throw new Error('Upload failed'); 
    const data = await res.json(); 
    await fetch(`${API_URL}/api/room/${roomCode}/add-upload`, { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ 
        filename: data.filename, 
        title: title || file.name.replace(/\.[^/.]+$/, ''), 
        artist: artist || 'Unknown Artist', 
        audioUrl: data.audioUrl 
      }) 
    }); 
    return data; 
  },
}));