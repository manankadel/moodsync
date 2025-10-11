import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

// --- ENTERPRISE SYNC CONSTANTS ---
const HARD_SYNC_THRESHOLD = 0.35;
const ADAPTIVE_RATE_THRESHOLD = 0.05;
const PLAYBACK_RATE_ADJUST = 0.02;
const SYNC_HEARTBEAT_INTERVAL = 1000;
const CLOCK_SYNC_INTERVAL = 5000;

// --- INTERFACES ---
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

// --- SINGLETON AUDIO ENGINE ---
let singletonAudioElement: HTMLAudioElement | null = null;
let singletonAudioNodes: AudioNodes = { context: null, source: null, bass: null, mids: null, treble: null };
let isAudioEngineInitialized = false;

if (typeof window !== 'undefined') {
  singletonAudioElement = new Audio();
  singletonAudioElement.crossOrigin = 'anonymous';
}

export const useRoomStore = create<RoomState>((set, get) => ({
  socket: null, player: null, 
  audioElement: singletonAudioElement,
  audioNodes: singletonAudioNodes,
  playlist: [], currentTrackIndex: 0, isPlaying: false,
  isSeeking: false, manualLatencyOffset: 0, serverClockOffset: 0, isAudioGraphConnected: false,
  syncInterval: null, clockSyncInterval: null,
  roomCode: '', playlistTitle: '', users: [], volume: 80, isCollaborative: false, isLoading: true, error: null, isAdmin: false, username: '', equalizer: { bass: 0, mids: 0, treble: 0 }, currentTime: 0, lyrics: { lines: [], isLoading: false },
  playerReady: false, contextUnlocked: false,
  
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error, isLoading: false }),
  setIsSeeking: (isSeeking) => set({ isSeeking }),
  setManualLatencyOffset: (offset) => set({ manualLatencyOffset: offset }),

  connect: (roomCode, username) => {
    if (get().socket) return;
    const socket = io(API_URL, { transports: ['websocket'] });
    set({ socket, username, roomCode });
    socket.on('connect', () => {
      console.log('✅ Connected with Enterprise Sync Engine');
      socket.emit('join_room', { room_code: roomCode, username });
      get()._syncClock();
      const clockInterval = setInterval(() => get()._syncClock(), CLOCK_SYNC_INTERVAL);
      set({ clockSyncInterval: clockInterval });
    });
    socket.on('disconnect', () => get().disconnect());
    socket.on('error', (data) => get().setError(data.message));
    socket.on('update_user_list', (users: User[]) => { const self = users.find(u => u.name === get().username); set({ users, isAdmin: self?.isAdmin || false }); if (self?.isAdmin) console.log('🎯 You are now admin'); });
    socket.on('load_current_state', (state) => get().syncPlayerState(state));
    socket.on('sync_player_state', (state) => get().syncPlayerState(state));
    socket.on('refresh_playlist', () => get().refreshPlaylist());
  },
  
  disconnect: () => {
    const { socket, syncInterval, clockSyncInterval, player, audioElement } = get();
    if (syncInterval) clearInterval(syncInterval);
    if (clockSyncInterval) clearInterval(clockSyncInterval);
    player?.destroy();
    audioElement?.pause();
    socket?.disconnect();
    set({ socket: null, syncInterval: null, clockSyncInterval: null, player: null, isAudioGraphConnected: false });
    isAudioEngineInitialized = false; // Allow re-initialization on next connect
  },

  _emitStateUpdate: (overrideState) => {
    const { socket, roomCode, isPlaying, currentTrackIndex, isAdmin, isCollaborative, playlist, audioElement, player, playerReady } = get();
    if ((!isAdmin && !isCollaborative) || !playerReady) return;
    let currentTime = 0;
    try { currentTime = playlist[currentTrackIndex]?.isUpload && audioElement ? audioElement.currentTime : player?.getCurrentTime() || 0; } catch(e) {}
    const stateToSend = { isPlaying, trackIndex: currentTrackIndex, currentTime, timestamp: Date.now() / 1000, ...overrideState };
    socket?.emit('update_player_state', { room_code: roomCode, state: stateToSend });
  },
  
  syncPlayerState: (state) => {
    const { player, audioElement, playlist, currentTrackIndex, isPlaying, isSeeking, manualLatencyOffset, serverClockOffset, playerReady, volume, isAdmin, nextTrack } = get();
    if (isSeeking || !playerReady) return;

    if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
        set({ currentTrackIndex: state.trackIndex, isPlaying: state.isPlaying ?? isPlaying });
        const track = playlist[state.trackIndex];
        if (!track || (!track.youtubeId && !track.audioUrl)) { if (isAdmin) setTimeout(() => nextTrack(), 500); return; }
        if (track.isUpload) {
            if (player?.stopVideo) player.stopVideo();
            if (audioElement && track.audioUrl) { audioElement.src = track.audioUrl; audioElement.volume = volume / 100; audioElement.load(); }
        } else {
            if (audioElement) { audioElement.pause(); audioElement.src = ''; }
            if (player && track.youtubeId) { player.loadVideoById({ videoId: track.youtubeId }); player.setVolume(volume); get().fetchLyrics(track.youtubeId); }
        }
    }
    
    const targetTrack = playlist[get().currentTrackIndex];
    if (!targetTrack) return;

    if (state.currentTime !== undefined && state.serverTimestamp !== undefined) {
        const serverTimeNow = Date.now() / 1000 - serverClockOffset;
        const timeSinceUpdate = serverTimeNow - state.serverTimestamp;
        if (timeSinceUpdate < 0 || timeSinceUpdate > 5) return;

        const projectedTime = state.currentTime + (state.isPlaying ? timeSinceUpdate : 0);
        let playerTime = 0;
        try {
            const rawPlayerTime = targetTrack.isUpload && audioElement ? audioElement.currentTime : player?.getCurrentTime() || 0;
            playerTime = rawPlayerTime - manualLatencyOffset;
        } catch(e) {}
        
        const drift = projectedTime - playerTime;
        
        if (!targetTrack.isUpload && player?.setPlaybackRate && state.isPlaying) {
            if (Math.abs(drift) > ADAPTIVE_RATE_THRESHOLD && Math.abs(drift) < HARD_SYNC_THRESHOLD) {
                const newRate = 1.0 + Math.min(Math.max(drift * 0.1, -PLAYBACK_RATE_ADJUST), PLAYBACK_RATE_ADJUST);
                if (Math.abs(player.getPlaybackRate() - newRate) > 0.001) player.setPlaybackRate(newRate);
            } else {
                if (Math.abs(player.getPlaybackRate() - 1.0) > 0.001) player.setPlaybackRate(1.0);
            }
        }
        
        if (Math.abs(drift) > HARD_SYNC_THRESHOLD) {
            const seekTime = projectedTime + manualLatencyOffset;
            if (isFinite(seekTime) && seekTime >= 0) {
                try {
                  if (targetTrack.isUpload && audioElement) audioElement.currentTime = seekTime;
                  else if (player?.seekTo) player.seekTo(seekTime, true);
                } catch(e) {}
            }
        }
    }
    
    if (state.isPlaying !== undefined && state.isPlaying !== isPlaying) {
        set({ isPlaying: state.isPlaying });
        try {
          if (targetTrack.isUpload && audioElement) { state.isPlaying ? audioElement.play().catch(()=>{}) : audioElement.pause(); }
          else if (player) { state.isPlaying ? player.playVideo() : player.pauseVideo(); }
        } catch(e) {}
    }
    if (state.volume !== undefined && state.volume !== volume) { set({ volume: state.volume }); if (audioElement) audioElement.volume = state.volume / 100; if (player?.setVolume) player.setVolume(state.volume); }
    if (state.equalizer) { const { audioNodes } = get(); if (audioNodes.bass) audioNodes.bass.gain.value = state.equalizer.bass; if (audioNodes.mids) audioNodes.mids.gain.value = state.equalizer.mids; if (audioNodes.treble) audioNodes.treble.gain.value = state.equalizer.treble; set({ equalizer: state.equalizer }); }
    if (state.isCollaborative !== undefined) set({ isCollaborative: state.isCollaborative });
  },

  _syncClock: async () => {
    try {
        const res = await fetch(`${API_URL}/ping`); if (!res.ok) throw new Error(`Ping failed: ${res.status}`);
        const data = await res.json();
        set({ serverClockOffset: (Date.now() / 1000) - data.serverTime });
    } catch (e) { console.warn("Clock sync failed:", e); }
  },

  initializePlayer: (domId) => {
    if (isAudioEngineInitialized) return;

    const { audioElement } = get();
    if (!audioElement) return;

    audioElement.ontimeupdate = () => { if (!get().isSeeking) set({ currentTime: audioElement.currentTime }); };
    audioElement.onplay = () => set({ isPlaying: true });
    audioElement.onpause = () => set({ isPlaying: false });
    audioElement.onended = () => { if (get().isAdmin) get().nextTrack(); };
    audioElement.onerror = (e) => { if(get().isAdmin) setTimeout(() => get().nextTrack(), 500); };
    
    const onPlayerStateChange = (e: any) => {
        const { isAdmin, nextTrack, _emitStateUpdate, playerReady, isPlaying } = get();
        if (!playerReady) return;
        const newIsPlaying = e.data === window.YT.PlayerState.PLAYING;
        if (e.data === window.YT.PlayerState.ENDED && isAdmin) { nextTrack(); return; }
        if (isAdmin && isPlaying !== newIsPlaying) {
          _emitStateUpdate({ isPlaying: newIsPlaying });
        }
        set({ isPlaying: newIsPlaying });
    };

    const onPlayerReady = (e: any) => { console.log('✅ YouTube player ready'); set({ player: e.target, playerReady: true }); if (e.target?.setVolume) e.target.setVolume(get().volume); };
    const onPlayerError = (e: any) => { if (get().isAdmin) setTimeout(() => get().nextTrack(), 1000); };

    window.onYouTubeIframeAPIReady = () => { new window.YT.Player(domId, { height: '0', width: '0', playerVars: { controls: 0, disablekb: 1, enablejsapi: 1, playsinline: 1, origin: 'https://www.moodsync.fun' }, events: { onReady: onPlayerReady, onStateChange: onPlayerStateChange, onError: onPlayerError }, }); };
    if (typeof window !== 'undefined' && window.YT?.Player) window.onYouTubeIframeAPIReady();
    isAudioEngineInitialized = true;
  },

  setPlaylistData: (title, playlist) => { set({ playlistTitle: title, playlist, isLoading: false, error: null }); if (playlist.length > 0 && playlist[0]?.youtubeId) get().fetchLyrics(playlist[0].youtubeId); },
  
  playPause: () => {
    const { isAdmin, isCollaborative, isPlaying, player, audioElement, playlist, currentTrackIndex } = get();
    if (!isAdmin && !isCollaborative) return;
    const isUpload = playlist[currentTrackIndex]?.isUpload;
    if (isUpload && audioElement) { !isPlaying ? audioElement.play().catch(()=>{}) : audioElement.pause(); }
    else if (player) { !isPlaying ? player.playVideo() : player.pauseVideo(); }
    get()._emitStateUpdate({ isPlaying: !isPlaying });
  },

  nextTrack: () => {
    const { isAdmin, isCollaborative, currentTrackIndex, playlist, player, audioElement } = get();
    if (!isAdmin && !isCollaborative) return;
    const newIndex = (currentTrackIndex + 1) % playlist.length;
    player?.stopVideo();
    if (audioElement) { audioElement.pause(); audioElement.src = ''; }
    get()._emitStateUpdate({ trackIndex: newIndex, currentTime: 0, isPlaying: true });
  },

  prevTrack: () => {
    const { isAdmin, isCollaborative, currentTrackIndex, playlist, player, audioElement } = get();
    if (!isAdmin && !isCollaborative) return;
    const newIndex = (currentTrackIndex - 1 + playlist.length) % playlist.length;
    player?.stopVideo();
    if (audioElement) { audioElement.pause(); audioElement.src = ''; }
    get()._emitStateUpdate({ trackIndex: newIndex, currentTime: 0, isPlaying: true });
  },

  selectTrack: (index) => {
    const { isAdmin, isCollaborative, currentTrackIndex, player, audioElement, playlist } = get();
    if (!isAdmin && !isCollaborative) return;
    if (index !== currentTrackIndex) {
        if (!playlist[index]) return; // Guard against invalid index
        player?.stopVideo();
        if (audioElement) { audioElement.pause(); audioElement.src = ''; }
        get()._emitStateUpdate({ trackIndex: index, currentTime: 0, isPlaying: true });
    } else {
        get().playPause();
    }
  },

  setVolume: (volume) => { const { isAdmin } = get(); set({ volume }); if (isAdmin) get()._emitStateUpdate({ volume }); },
  setEqualizer: (settings) => { const { isAdmin } = get(); set({ equalizer: settings }); if (isAdmin) get()._emitStateUpdate({ equalizer: settings }); },
  toggleCollaborative: () => { const { isAdmin, isCollaborative } = get(); if (isAdmin) { const newState = !isCollaborative; set({ isCollaborative: newState }); get()._emitStateUpdate({ isCollaborative: newState }); } },
  
  primePlayer: () => { 
    const { audioNodes } = get(); 
    if (audioNodes?.context?.state === 'suspended') {
      audioNodes.context.resume().then(() => set({ contextUnlocked: true })).catch(()=>{});
    } else { set({ contextUnlocked: true }); }
  },
  fetchLyrics: async (youtubeId) => { if (!youtubeId) return; set({ lyrics: { lines: [], isLoading: true } }); try { const res = await fetch(`${API_URL}/api/lyrics/${youtubeId}`); const lines = res.ok ? await res.json() : []; set({ lyrics: { lines, isLoading: false } }); } catch (e) { set({ lyrics: { lines: [], isLoading: false } }); } },
  refreshPlaylist: async () => { const { roomCode, playlist } = get(); if (!roomCode) return; try { const res = await fetch(`${API_URL}/api/room/${roomCode}`); if (res.ok) { const data = await res.json(); if (JSON.stringify(data.playlist) !== JSON.stringify(playlist)) set({ playlist: data.playlist }); } } catch (e) {} },
  uploadFile: async (file, title, artist) => { const { roomCode } = get(); const formData = new FormData(); formData.append('file', file); const res = await fetch(`${API_URL}/api/upload`, { method: 'POST', body: formData }); if (!res.ok) throw new Error('Upload failed'); const data = await res.json(); await fetch(`${API_URL}/api/room/${roomCode}/add-upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: data.filename, title: title || file.name.replace(/\.[^/.]+$/, ''), artist: artist || 'Unknown Artist', audioUrl: data.audioUrl }) }); return data; },
}));