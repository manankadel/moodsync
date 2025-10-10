import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

const HARD_SYNC_THRESHOLD = 0.35;
const ADAPTIVE_RATE_THRESHOLD = 0.05;
const PLAYBACK_RATE_ADJUST = 0.02;
const SYNC_HEARTBEAT_INTERVAL = 1000;
const CLOCK_SYNC_INTERVAL = 5000;

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
  connect: (roomCode: string, username: string) => void; disconnect: () => void; initializePlayer: (domId: string) => void;
  setPlaylistData: (title: string, playlist: Song[]) => void; playPause: () => void; nextTrack: () => void; prevTrack: () => void; selectTrack: (index: number) => void; setVolume: (volume: number) => void; setEqualizer: (settings: EqualizerSettings) => void; toggleCollaborative: () => void; setIsSeeking: (isSeeking: boolean) => void; setManualLatencyOffset: (offset: number) => void;
  _emitStateUpdate: (overrideState?: Partial<Omit<SyncState, 'serverTimestamp'>>) => void;
  syncPlayerState: (state: SyncState) => void; _syncClock: () => Promise<void>; primePlayer: () => void; fetchLyrics: (youtubeId: string) => void; refreshPlaylist: () => void;
  uploadFile: (file: File, title?: string, artist?: string) => Promise<any>;
  setLoading: (loading: boolean) => void; setError: (error: string | null) => void;
}

export const useRoomStore = create<RoomState>((set, get) => ({
  socket: null, player: null, audioElement: null,
  playlist: [], currentTrackIndex: 0, isPlaying: false,
  isSeeking: false, manualLatencyOffset: 0, serverClockOffset: 0, isAudioGraphConnected: false,
  syncInterval: null, clockSyncInterval: null,
  roomCode: '', playlistTitle: '', users: [], volume: 80, isCollaborative: false, isLoading: true, error: null, isAdmin: false, username: '', equalizer: { bass: 0, mids: 0, treble: 0 }, audioNodes: { context: null, source: null, bass: null, mids: null, treble: null }, currentTime: 0, lyrics: { lines: [], isLoading: false },
  
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
    socket.on('update_user_list', (users: User[]) => { const self = users.find(u => u.name === get().username); set({ users, isAdmin: self?.isAdmin || false }); });
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
  },

  _emitStateUpdate: (overrideState) => {
    const { socket, roomCode, isPlaying, currentTrackIndex, isAdmin, isCollaborative, playlist, audioElement, player } = get();
    if (!isAdmin && !isCollaborative) return;
    let currentTime = 0;
    try { currentTime = playlist[currentTrackIndex]?.isUpload && audioElement ? audioElement.currentTime : player?.getCurrentTime() || 0; } catch(e) {}
    const stateToSend = { isPlaying, trackIndex: currentTrackIndex, currentTime, timestamp: Date.now() / 1000, ...overrideState };
    socket?.emit('update_player_state', { room_code: roomCode, state: stateToSend });
  },
  
  syncPlayerState: (state) => {
    const { player, audioElement, playlist, currentTrackIndex, isPlaying, isSeeking, manualLatencyOffset, serverClockOffset } = get();
    if (isSeeking) return;

    if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
        set({ currentTrackIndex: state.trackIndex, isPlaying: state.isPlaying }); // Sync isPlaying state on track change
        const track = playlist[state.trackIndex];
        if (track?.isUpload && track.audioUrl && audioElement) { audioElement.src = track.audioUrl; audioElement.load(); }
        else if (track?.youtubeId && player) { player.cueVideoById(track.youtubeId); get().fetchLyrics(track.youtubeId); }
    }
    
    const targetTrack = playlist[get().currentTrackIndex];
    const isUpload = targetTrack?.isUpload;
    const target = isUpload ? audioElement : player;
    if (!target) return;

    if (state.currentTime !== undefined && state.serverTimestamp !== undefined) {
        const serverTimeNow = Date.now() / 1000 - serverClockOffset;
        const timeSinceUpdate = serverTimeNow - state.serverTimestamp;
        if (timeSinceUpdate < 0 || timeSinceUpdate > 5) return;

        const projectedTime = state.currentTime + (state.isPlaying ? timeSinceUpdate : 0);
        let playerTime = 0;
        try {
            const rawPlayerTime = isUpload && audioElement ? audioElement.currentTime : player?.getCurrentTime() || 0;
            playerTime = rawPlayerTime - manualLatencyOffset;
        } catch(e) {}
        const drift = projectedTime - playerTime;

        if (player && typeof player.setPlaybackRate === 'function') {
            if (Math.abs(drift) > ADAPTIVE_RATE_THRESHOLD && Math.abs(drift) < HARD_SYNC_THRESHOLD) {
                const newRate = 1.0 + (drift > 0 ? PLAYBACK_RATE_ADJUST : -PLAYBACK_RATE_ADJUST);
                if (player.getPlaybackRate() !== newRate) player.setPlaybackRate(newRate);
            } else {
                if (player.getPlaybackRate() !== 1.0) player.setPlaybackRate(1.0);
            }
        }
        
        if (Math.abs(drift) > HARD_SYNC_THRESHOLD) {
            const seekTime = projectedTime + manualLatencyOffset;
            if (isFinite(seekTime)) {
                if (isUpload) target.currentTime = seekTime;
                else target.seekTo(seekTime, true);
            }
        }
    }
    
    if (state.isPlaying !== undefined && state.isPlaying !== isPlaying) {
        if (isUpload && audioElement) { state.isPlaying ? audioElement.play().catch(()=>{}) : audioElement.pause(); }
        else if (player) { state.isPlaying ? player.playVideo() : player.pauseVideo(); }
        set({ isPlaying: state.isPlaying });
    }
  },

  _syncClock: async () => {
    try {
        const clientSendTime = Date.now() / 1000;
        const response = await fetch(`${API_URL}/ping`);
        const data = await response.json();
        const clientReceiveTime = Date.now() / 1000;
        const serverTime = data.serverTime;
        const rtt = clientReceiveTime - clientSendTime;
        const offset = clientReceiveTime - (serverTime + rtt / 2);
        set({ serverClockOffset: offset });
    } catch (e) { console.warn("Clock sync failed:", e); }
  },

  initializePlayer: (domId) => {
    const audioEl = new Audio();
    audioEl.crossOrigin = 'anonymous';
    audioEl.addEventListener('timeupdate', () => { if (!get().isSeeking) set({ currentTime: audioEl.currentTime }); });
    audioEl.addEventListener('play', () => { set({ isPlaying: true }); });
    audioEl.addEventListener('pause', () => { set({ isPlaying: false }); });
    audioEl.addEventListener('ended', () => { if (get().isAdmin) get().nextTrack(); });
    set({ audioElement: audioEl });

    try {
        if (!get().isAudioGraphConnected) {
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            const source = audioContext.createMediaElementSource(audioEl);
            const bass = audioContext.createBiquadFilter(); bass.type = 'lowshelf';
            const mids = audioContext.createBiquadFilter(); mids.type = 'peaking';
            const treble = audioContext.createBiquadFilter(); treble.type = 'highshelf';
            source.connect(bass).connect(mids).connect(treble).connect(audioContext.destination);
            set({ audioNodes: { context: audioContext, source, bass, mids, treble }, isAudioGraphConnected: true });
        }
    } catch (e) { console.error("Error setting up AudioContext:", e); }
    
    const onPlayerStateChange = (e: any) => {
        const { isAdmin, isPlaying, nextTrack, _emitStateUpdate } = get();
        const newIsPlaying = e.data === window.YT.PlayerState.PLAYING;
        set({ isPlaying: newIsPlaying }); // Update local state immediately for UI responsiveness
        if (isAdmin) {
            if (e.data === window.YT.PlayerState.ENDED) { nextTrack(); return; }
            if (newIsPlaying !== isPlaying) { _emitStateUpdate({ isPlaying: newIsPlaying }); }
        }
    };

    window.onYouTubeIframeAPIReady = () => { new window.YT.Player(domId, { height: '0', width: '0', playerVars: { origin: window.location.origin, controls: 0, disablekb: 1 }, events: { onReady: (e: any) => set({ player: e.target }), onStateChange: onPlayerStateChange }, }); };
    if (window.YT?.Player) window.onYouTubeIframeAPIReady();
  },

  setPlaylistData: (title, playlist) => { set({ playlistTitle: title, playlist, isLoading: false, error: null }); if (playlist.length > 0 && playlist[0].youtubeId) get().fetchLyrics(playlist[0].youtubeId); },
  
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
    get()._emitStateUpdate({ trackIndex: newIndex, currentTime: 0 });
  },

  prevTrack: () => {
    const { isAdmin, isCollaborative, currentTrackIndex, playlist, player, audioElement } = get();
    if (!isAdmin && !isCollaborative) return;
    const newIndex = (currentTrackIndex - 1 + playlist.length) % playlist.length;
    player?.stopVideo();
    if (audioElement) { audioElement.pause(); audioElement.src = ''; }
    get()._emitStateUpdate({ trackIndex: newIndex, currentTime: 0 });
  },

  selectTrack: (index) => {
    const { isAdmin, isCollaborative, currentTrackIndex, player, audioElement } = get();
    if (!isAdmin && !isCollaborative) return;
    if (index !== currentTrackIndex) {
        player?.stopVideo();
        if (audioElement) { audioElement.pause(); audioElement.src = ''; }
        get()._emitStateUpdate({ trackIndex: index, currentTime: 0 });
    } else {
        get().playPause();
    }
  },

  setVolume: (volume) => { const { player, audioElement, isAdmin } = get(); if (audioElement) audioElement.volume = volume / 100; if (player?.setVolume) player.setVolume(volume); set({ volume }); if (isAdmin) get()._emitStateUpdate({ volume }); },
  setEqualizer: (settings) => { const { audioNodes, isAdmin } = get(); if (audioNodes.bass) audioNodes.bass.gain.value = settings.bass; if (audioNodes.mids) audioNodes.mids.gain.value = settings.mids; if (audioNodes.treble) audioNodes.treble.gain.value = settings.treble; set({ equalizer: settings }); if (isAdmin) get()._emitStateUpdate({ equalizer: settings }); },
  toggleCollaborative: () => { const { isAdmin, isCollaborative } = get(); if (isAdmin) { const newState = !isCollaborative; set({ isCollaborative: newState }); get()._emitStateUpdate({ isCollaborative: newState }); } },
  
  primePlayer: () => { const { player, audioElement, audioNodes } = get(); if (audioNodes.context?.state === 'suspended') audioNodes.context.resume(); if (audioElement) { audioElement.volume = 0; audioElement.play().then(() => audioElement.pause()); } if (player?.playVideo) { player.mute(); player.playVideo(); setTimeout(() => { player.pauseVideo(); player.unMute(); }, 250); } },
  fetchLyrics: async (youtubeId) => { try { const res = await fetch(`${API_URL}/api/lyrics/${youtubeId}`); if(res.ok) { const lines = await res.json(); set({ lyrics: { lines, isLoading: false } }); } } catch (e) { set({ lyrics: { lines: [], isLoading: false } }); } },
  refreshPlaylist: async () => { const { roomCode, playlist } = get(); if (!roomCode) return; try { const res = await fetch(`${API_URL}/api/room/${roomCode}`); if (res.ok) { const data = await res.json(); if (JSON.stringify(data.playlist) !== JSON.stringify(playlist)) set({ playlist: data.playlist }); } } catch (e) {} },
  uploadFile: async (file, title, artist) => { const { roomCode } = get(); const formData = new FormData(); formData.append('file', file); const res = await fetch(`${API_URL}/api/upload`, { method: 'POST', body: formData }); if (!res.ok) throw new Error('Upload failed'); const data = await res.json(); await fetch(`${API_URL}/api/room/${roomCode}/add-upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: data.filename, title: title || file.name.replace(/\.[^/.]+$/, ''), artist: artist || 'Unknown Artist', audioUrl: data.audioUrl }) }); return data; },
}));