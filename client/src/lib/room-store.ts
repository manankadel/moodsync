import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

// Constants for sync logic
const NETWORK_JITTER_THRESHOLD = 0.08;
const HARD_SYNC_THRESHOLD = 0.3;
const SOFT_SYNC_PAUSE_DURATION = 70;
const SYNC_HEARTBEAT_INTERVAL = 1000;

// Interfaces...
interface Song { name: string; artist: string; albumArt: string | null; youtubeId?: string; isUpload?: boolean; audioUrl?: string; }
interface User { name: string; isAdmin: boolean; }
declare global { interface Window { onYouTubeIframeAPIReady: () => void; YT: any; } }
interface EqualizerSettings { bass: number; mids: number; treble: number; }
interface SyncState { isPlaying?: boolean; trackIndex?: number; volume?: number; isCollaborative?: boolean; equalizer?: EqualizerSettings; currentTime?: number; timestamp?: number; serverTimestamp?: number; }
interface AudioNodes { context: AudioContext | null; source: MediaElementAudioSourceNode | null; bass: BiquadFilterNode | null; mids: BiquadFilterNode | null; treble: BiquadFilterNode | null; }
interface LyricLine { time: number; text: string; }

interface RoomState {
  roomCode: string; playlistTitle: string; playlist: Song[]; users: User[]; currentTrackIndex: number; isPlaying: boolean; volume: number; isCollaborative: boolean; isLoading: boolean; error: string | null; player: any; socket: Socket | null; isAdmin: boolean; username: string; equalizer: EqualizerSettings; audioNodes: AudioNodes; currentTime: number; lyrics: { lines: LyricLine[]; isLoading: boolean; }; audioElement: HTMLAudioElement | null; syncInterval: NodeJS.Timeout | null; isSeeking: boolean; manualLatencyOffset: number;
  setIsSeeking: (isSeeking: boolean) => void; setManualLatencyOffset: (offset: number) => void; connect: (roomCode: string, username: string) => void; disconnect: () => void; initializePlayer: (domId: string) => void; setPlaylistData: (title: string, playlist: Song[]) => void; playPause: () => void; nextTrack: () => void; prevTrack: () => void; selectTrack: (index: number) => void; setVolume: (volume: number) => void; setEqualizer: (settings: EqualizerSettings, emit?: boolean) => void; toggleCollaborative: () => void; setLoading: (loading: boolean) => void; setError: (error: string | null) => void; syncPlayerState: (state: SyncState) => void; _changeTrack: (index: number, newState: Partial<SyncState>) => void; _canControl: () => boolean; _emitStateUpdate: (overrideState?: Partial<SyncState>) => void; _startSyncLoop: () => void; _stopSyncLoop: () => void; primePlayer: () => void;
  uploadFile: (file: File, title?: string, artist?: string) => Promise<any>;
  refreshPlaylist: () => void; fetchLyrics: (youtubeId: string) => void;
}

export const useRoomStore = create<RoomState>((set, get) => ({
  roomCode: '', playlistTitle: '', playlist: [], users: [], currentTrackIndex: 0, isPlaying: false, volume: 80, isCollaborative: false, isLoading: true, error: null, player: null, socket: null, isAdmin: false, username: '', equalizer: { bass: 0, mids: 0, treble: 0 }, audioNodes: { context: null, source: null, bass: null, mids: null, treble: null }, currentTime: 0, lyrics: { lines: [], isLoading: false }, audioElement: null, syncInterval: null, isSeeking: false, manualLatencyOffset: 0,

  setIsSeeking: (isSeeking) => set({ isSeeking }),
  setManualLatencyOffset: (offset) => set({ manualLatencyOffset: offset }),

  connect: (roomCode, username) => {
    if (get().socket) return;
    const socket = io(API_URL, { transports: ['websocket'], upgrade: false });
    set({ socket, username, roomCode });
    socket.on('connect', () => { console.log('✅ Connected with High-Performance Sync'); socket.emit('join_room', { room_code: roomCode, username }); });
    socket.on('disconnect', () => set({ users: [], isAdmin: false }));
    socket.on('error', (data) => get().setError(data.message));
    socket.on('update_user_list', (users: User[]) => { const self = users.find((u: User) => u.name === get().username); set({ users, isAdmin: self?.isAdmin || false }); });
    socket.on('load_current_state', (state) => get().syncPlayerState(state));
    socket.on('sync_player_state', (state) => get().syncPlayerState(state));
    socket.on('refresh_playlist', () => get().refreshPlaylist());
  },

  disconnect: () => { get()._stopSyncLoop(); get().socket?.disconnect(); get().audioElement?.pause(); set({ socket: null }); },

  _emitStateUpdate: (overrideState) => {
    const { socket, roomCode, isPlaying, currentTrackIndex, _canControl, playlist, audioElement, player } = get();
    if (!_canControl() || !socket) return;
    const currentTrack = playlist[currentTrackIndex];
    let currentTime = 0;
    try { currentTime = currentTrack?.isUpload && audioElement ? audioElement.currentTime : player?.getCurrentTime() || 0; } catch(e) {}
    const stateToSend = { isPlaying, trackIndex: currentTrackIndex, currentTime, timestamp: Date.now() / 1000, ...overrideState };
    socket.emit('update_player_state', { room_code: roomCode, state: stateToSend });
  },
  
  _startSyncLoop: () => { get()._stopSyncLoop(); set({ syncInterval: setInterval(() => get()._emitStateUpdate({}), SYNC_HEARTBEAT_INTERVAL) }); },
  _stopSyncLoop: () => { const { syncInterval } = get(); if (syncInterval) { clearInterval(syncInterval); set({ syncInterval: null }); } },

  initializePlayer: (domId) => {
    const audioEl = new Audio();
    audioEl.crossOrigin = 'anonymous';
    audioEl.addEventListener('timeupdate', () => { if (!get().isSeeking) set({ currentTime: audioEl.currentTime }); });
    audioEl.addEventListener('play', () => { if (get()._canControl()) { get()._emitStateUpdate({ isPlaying: true }); get()._startSyncLoop(); }});
    audioEl.addEventListener('pause', () => { if (get()._canControl()) { get()._emitStateUpdate({ isPlaying: false }); get()._stopSyncLoop(); }});
    audioEl.addEventListener('ended', () => { if (get()._canControl()) get().nextTrack(); });
    set({ audioElement: audioEl });

    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const bass = audioContext.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 250;
      const mids = audioContext.createBiquadFilter(); mids.type = 'peaking'; mids.frequency.value = 1000; mids.Q.value = 1;
      const treble = audioContext.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 4000;
      
      const source = audioContext.createMediaElementSource(audioEl);
      source.connect(bass);
      bass.connect(mids);
      mids.connect(treble);
      treble.connect(audioContext.destination);
      
      set({ audioNodes: { context: audioContext, source, bass, mids, treble } });
    } catch (e) { console.error("Could not create Web Audio Context or graph:", e); }

    const onPlayerReady = (event: any) => { set({ player: event.target }); };
    const onPlayerStateChange = (event: any) => {
      const state = get();
      if (!state._canControl() || state.isSeeking) return;
      let newIsPlaying = event.data === window.YT.PlayerState.PLAYING;
      if (event.data === window.YT.PlayerState.ENDED) { state.nextTrack(); return; }
      if (newIsPlaying !== state.isPlaying) {
        set({ isPlaying: newIsPlaying });
        state._emitStateUpdate({ isPlaying: newIsPlaying });
        if (newIsPlaying) state._startSyncLoop(); else state._stopSyncLoop();
      }
    };

    window.onYouTubeIframeAPIReady = () => {
      new window.YT.Player(domId, {
        height: '0', width: '0',
        playerVars: { origin: window.location.origin, controls: 0, disablekb: 1 },
        events: { onReady: onPlayerReady, onStateChange: onPlayerStateChange },
      });
    };
    if (window.YT?.Player) window.onYouTubeIframeAPIReady();
  },

  setPlaylistData: (title, playlist) => { set({ playlistTitle: title, playlist, isLoading: false, error: null }); if (playlist.length > 0 && playlist[0].youtubeId) get().fetchLyrics(playlist[0].youtubeId); },
  _canControl: () => get().isAdmin || get().isCollaborative,

  _changeTrack: (index, newState) => {
    const { player, audioElement, playlist, _canControl } = get();
    if (!_canControl() || index < 0 || index >= playlist.length) return;
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
      audioElement.play().catch(e => console.error('Play error:', e));
    } else if (newTrack.youtubeId && player) {
      get().fetchLyrics(newTrack.youtubeId);
      player.loadVideoById(newTrack.youtubeId, newState.currentTime || 0);
    }
  },

  playPause: () => { if (!get()._canControl()) return; const { player, audioElement, isPlaying, playlist, currentTrackIndex } = get(); const target = playlist[currentTrackIndex]?.isUpload ? audioElement : player; if (isPlaying) target.pause(); else target.play()?.catch((e:any) => {}); },
  nextTrack: () => get()._changeTrack((get().currentTrackIndex + 1) % get().playlist.length, {}),
  prevTrack: () => get()._changeTrack((get().currentTrackIndex - 1 + get().playlist.length) % get().playlist.length, {}),
  selectTrack: (index) => { if (index !== get().currentTrackIndex) get()._changeTrack(index, { isPlaying: true }); else get().playPause(); },

  setVolume: (volume) => { const { player, audioElement } = get(); if (audioElement) audioElement.volume = volume / 100; if (player?.setVolume) player.setVolume(volume); set({ volume }); if (get()._canControl()) get()._emitStateUpdate({ volume }); },
  setEqualizer: (settings, emit = true) => { const { audioNodes, _canControl } = get(); if (audioNodes.bass) audioNodes.bass.gain.value = settings.bass; if (audioNodes.mids) audioNodes.mids.gain.value = settings.mids; if (audioNodes.treble) audioNodes.treble.gain.value = settings.treble; set({ equalizer: settings }); if (emit && _canControl()) get()._emitStateUpdate({ equalizer: settings }); },
  toggleCollaborative: () => { if (get().isAdmin) { const newState = !get().isCollaborative; set({ isCollaborative: newState }); get()._emitStateUpdate({ isCollaborative: newState }); } },
  
  syncPlayerState: (state) => {
    const { player, audioElement, playlist, currentTrackIndex, isPlaying, isSeeking, manualLatencyOffset } = get();
    if (isSeeking) return;

    if (state.equalizer) get().setEqualizer(state.equalizer, false);
    if (state.isCollaborative !== undefined) set({ isCollaborative: state.isCollaborative });
    if (state.volume !== undefined) get().setVolume(state.volume);

    if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
        set({ currentTrackIndex: state.trackIndex });
        const track = playlist[state.trackIndex];
        if (track?.isUpload && track.audioUrl && audioElement) { audioElement.src = track.audioUrl; audioElement.load(); }
        else if (track?.youtubeId && player) { player.cueVideoById(track.youtubeId, state.currentTime); get().fetchLyrics(track.youtubeId); }
    }
    
    const target = playlist[get().currentTrackIndex]?.isUpload ? audioElement : player;
    if (!target) return;

    if (state.currentTime !== undefined && state.serverTimestamp !== undefined) {
        const latency = (Date.now() / 1000) - state.serverTimestamp;
        if (latency < 0 || latency > 3.0) return;
        const projectedTime = state.currentTime + (state.isPlaying ? latency : 0) + manualLatencyOffset;
        let playerTime = 0;
        try { playerTime = playlist[get().currentTrackIndex]?.isUpload && audioElement ? audioElement.currentTime : player?.getCurrentTime() || 0; } catch (e) {}
        const drift = projectedTime - playerTime;

        if (Math.abs(drift) > NETWORK_JITTER_THRESHOLD) {
            if (Math.abs(drift) > HARD_SYNC_THRESHOLD) {
                if (playlist[get().currentTrackIndex]?.isUpload && audioElement) audioElement.currentTime = projectedTime; else player?.seekTo(projectedTime, true);
            } else if (drift < -NETWORK_JITTER_THRESHOLD) {
                target.pause();
                setTimeout(() => { if (get().isPlaying) target.play()?.catch(()=>{}); }, SOFT_SYNC_PAUSE_DURATION);
            }
        }
    }
    
    if (state.isPlaying !== undefined && state.isPlaying !== isPlaying) {
        state.isPlaying ? target.play()?.catch(()=>{}) : target.pause();
        set({ isPlaying: state.isPlaying });
    }
  },

  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error, isLoading: false }),
  primePlayer: () => { const { player, audioElement, volume, audioNodes } = get(); if (audioNodes.context?.state === 'suspended') audioNodes.context.resume(); if (audioElement) audioElement.volume = 0; if (player?.playVideo) { player.mute(); player.playVideo(); setTimeout(() => { player.pauseVideo(); player.unMute(); player.setVolume(volume); }, 250); } },
  fetchLyrics: async (youtubeId) => { try { const res = await fetch(`${API_URL}/api/lyrics/${youtubeId}`); const lines = await res.json(); set({ lyrics: { lines, isLoading: false } }); } catch (e) { set({ lyrics: { lines: [], isLoading: false } }); } },
  uploadFile: async (file, title, artist) => { const formData = new FormData(); formData.append('file', file); const res = await fetch(`${API_URL}/api/upload`, { method: 'POST', body: formData }); if (!res.ok) throw new Error('Upload failed'); const data = await res.json(); await fetch(`${API_URL}/api/room/${get().roomCode}/add-upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: data.filename, title: title || file.name.replace(/\.[^/.]+$/, ''), artist: artist || 'Unknown Artist', audioUrl: data.audioUrl }) }); return data; },
  refreshPlaylist: async () => { const { roomCode, playlist } = get(); if (!roomCode) return; try { const res = await fetch(`${API_URL}/api/room/${roomCode}`); if (res.ok) { const data = await res.json(); if (JSON.stringify(data.playlist) !== JSON.stringify(playlist)) set({ playlist: data.playlist }); } } catch (e) {} },
}));