import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

const HARD_SYNC_THRESHOLD = 0.3;
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
  playerReady: boolean; audioPrimed: boolean;
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
  playerReady: false, audioPrimed: false,
  
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error, isLoading: false }),
  setIsSeeking: (isSeeking) => set({ isSeeking }),
  setManualLatencyOffset: (offset) => set({ manualLatencyOffset: offset }),

  connect: (roomCode, username) => {
    if (get().socket) return;
    const socket = io(API_URL, { transports: ['websocket'], reconnection: true });
    set({ socket, username, roomCode });
    
    socket.on('connect', () => {
      console.log('✅ Connected to server');
      socket.emit('join_room', { room_code: roomCode, username });
      get()._syncClock();
      const clockInterval = setInterval(() => get()._syncClock(), CLOCK_SYNC_INTERVAL);
      set({ clockSyncInterval: clockInterval });
    });
    
    socket.on('disconnect', () => console.log('Disconnected from server'));
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
    const { socket, syncInterval, clockSyncInterval, player, audioElement } = get();
    if (syncInterval) clearInterval(syncInterval);
    if (clockSyncInterval) clearInterval(clockSyncInterval);
    if (player?.destroy) player.destroy();
    if (audioElement) { audioElement.pause(); audioElement.src = ''; }
    socket?.disconnect();
    set({ socket: null, syncInterval: null, clockSyncInterval: null, player: null });
  },

  _emitStateUpdate: (overrideState) => {
    const { socket, roomCode, isPlaying, currentTrackIndex, isAdmin, isCollaborative, playlist, audioElement, player, playerReady } = get();
    if (!isAdmin && !isCollaborative) return;
    if (!playerReady) return;
    
    let currentTime = 0;
    try { 
      const track = playlist[currentTrackIndex];
      if (track?.isUpload && audioElement) {
        currentTime = audioElement.currentTime || 0;
      } else if (player?.getCurrentTime) {
        currentTime = player.getCurrentTime() || 0;
      }
    } catch(e) { console.warn('Error getting current time:', e); }
    
    const stateToSend = { 
      isPlaying, 
      trackIndex: currentTrackIndex, 
      currentTime, 
      timestamp: Date.now() / 1000, 
      ...overrideState 
    };
    socket?.emit('update_player_state', { room_code: roomCode, state: stateToSend });
  },
  
  syncPlayerState: (state) => {
    const { player, audioElement, playlist, currentTrackIndex, isPlaying, isSeeking, manualLatencyOffset, serverClockOffset, playerReady } = get();
    if (isSeeking || !playerReady) return;

    if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
        set({ currentTrackIndex: state.trackIndex });
        const track = playlist[state.trackIndex];
        
        if (track?.isUpload && track.audioUrl && audioElement) { 
          audioElement.src = track.audioUrl;
          audioElement.load();
        } else if (track?.youtubeId && player?.loadVideoById) { 
          player.loadVideoById(track.youtubeId);
          get().fetchLyrics(track.youtubeId);
        }
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
            if (isUpload && audioElement) {
              playerTime = (audioElement.currentTime || 0) - manualLatencyOffset;
            } else if (player?.getCurrentTime) {
              playerTime = (player.getCurrentTime() || 0) - manualLatencyOffset;
            }
        } catch(e) {}
        
        const drift = projectedTime - playerTime;

        if (player?.setPlaybackRate && !isUpload) {
            if (Math.abs(drift) > ADAPTIVE_RATE_THRESHOLD && Math.abs(drift) < HARD_SYNC_THRESHOLD) {
                const newRate = 1.0 + (drift > 0 ? PLAYBACK_RATE_ADJUST : -PLAYBACK_RATE_ADJUST);
                if (Math.abs(player.getPlaybackRate() - newRate) > 0.001) {
                  player.setPlaybackRate(newRate);
                }
            } else if (Math.abs(drift) < ADAPTIVE_RATE_THRESHOLD) {
                if (Math.abs(player.getPlaybackRate() - 1.0) > 0.001) {
                  player.setPlaybackRate(1.0);
                }
            }
        }
        
        if (Math.abs(drift) > HARD_SYNC_THRESHOLD) {
            const seekTime = projectedTime + manualLatencyOffset;
            if (isFinite(seekTime) && seekTime >= 0) {
                try {
                  if (isUpload && audioElement) {
                    audioElement.currentTime = seekTime;
                  } else if (player?.seekTo) {
                    player.seekTo(seekTime, true);
                  }
                } catch(e) { console.warn('Seek error:', e); }
            }
        }
    }
    
    if (state.isPlaying !== undefined && state.isPlaying !== isPlaying) {
        const newPlayState = state.isPlaying;
        set({ isPlaying: newPlayState });
        
        try {
          if (isUpload && audioElement) { 
            if (newPlayState) {
              audioElement.play().catch(e => console.warn("Play failed:", e));
            } else {
              audioElement.pause();
            }
          } else if (player) { 
            if (newPlayState) {
              player.playVideo();
            } else {
              player.pauseVideo();
            }
          }
        } catch(e) { console.warn('Play/pause error:', e); }
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
    if (get().isAudioGraphConnected) {
      console.log("Player already initialized");
      return;
    }

    const audioEl = new Audio();
    audioEl.crossOrigin = 'anonymous';
    audioEl.addEventListener('timeupdate', () => { if (!get().isSeeking) set({ currentTime: audioEl.currentTime }); });
    audioEl.addEventListener('play', () => { set({ isPlaying: true }); });
    audioEl.addEventListener('pause', () => { set({ isPlaying: false }); });
    audioEl.addEventListener('ended', () => { if (get().isAdmin) get().nextTrack(); });
    set({ audioElement: audioEl });

    try {
        if (!globalAudioContext) {
            globalAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            globalAudioSource = globalAudioContext.createMediaElementSource(audioEl);
            
            const bass = globalAudioContext.createBiquadFilter(); 
            bass.type = 'lowshelf';
            bass.frequency.value = 200;
            bass.gain.value = 0;
            
            const mids = globalAudioContext.createBiquadFilter(); 
            mids.type = 'peaking';
            mids.frequency.value = 2000;
            mids.Q.value = 1;
            mids.gain.value = 0;
            
            const treble = globalAudioContext.createBiquadFilter(); 
            treble.type = 'highshelf';
            treble.frequency.value = 5000;
            treble.gain.value = 0;
            
            globalAudioSource.connect(bass);
            bass.connect(mids);
            mids.connect(treble);
            treble.connect(globalAudioContext.destination);
            
            set({ 
              audioNodes: { 
                context: globalAudioContext, 
                source: globalAudioSource, 
                bass, 
                mids, 
                treble 
              }, 
              isAudioGraphConnected: true 
            });
            
            console.log("✅ AudioContext initialized");
        }
    } catch (e) { 
      console.error("AudioContext error:", e); 
    }
    
    const onPlayerReady = (e: any) => {
      console.log('✅ YouTube player ready');
      set({ player: e.target, playerReady: true });
      const vol = get().volume;
      if (e.target?.setVolume) e.target.setVolume(vol);
    };

    const onPlayerStateChange = (e: any) => {
        const { isAdmin, nextTrack, _emitStateUpdate, playerReady } = get();
        if (!playerReady) return;
        
        const newIsPlaying = e.data === window.YT.PlayerState.PLAYING;
        
        if (e.data === window.YT.PlayerState.ENDED && isAdmin) { 
          nextTrack(); 
          return; 
        }
        
        if (isAdmin && get().isPlaying !== newIsPlaying) {
          set({ isPlaying: newIsPlaying });
          _emitStateUpdate({ isPlaying: newIsPlaying });
        }
    };

    window.onYouTubeIframeAPIReady = () => { 
      const ytPlayer = new window.YT.Player(domId, { 
        height: '0', 
        width: '0', 
        playerVars: { 
          controls: 0, 
          disablekb: 1,
          enablejsapi: 1,
          playsinline: 1
        }, 
        events: { 
          onReady: onPlayerReady, 
          onStateChange: onPlayerStateChange 
        }, 
      }); 
    };
    
    if (window.YT?.Player) window.onYouTubeIframeAPIReady();
  },

  setPlaylistData: (title, playlist) => { 
    set({ playlistTitle: title, playlist, isLoading: false, error: null }); 
    if (playlist.length > 0 && playlist[0].youtubeId) get().fetchLyrics(playlist[0].youtubeId); 
  },
  
  playPause: () => {
    const { isAdmin, isCollaborative, isPlaying, player, audioElement, playlist, currentTrackIndex, playerReady, audioPrimed } = get();
    if (!isAdmin && !isCollaborative) return;
    if (!playerReady) return;
    
    const track = playlist[currentTrackIndex];
    const isUpload = track?.isUpload;
    
    if (!audioPrimed) {
      get().primePlayer();
      set({ audioPrimed: true });
      setTimeout(() => get().playPause(), 300);
      return;
    }
    
    try {
      if (isUpload && audioElement) { 
        if (!isPlaying) {
          audioElement.play().catch(e => console.warn("Play failed:", e)); 
        } else {
          audioElement.pause();
        }
      } else if (player) { 
        if (!isPlaying) {
          player.playVideo();
        } else {
          player.pauseVideo();
        }
      }
      get()._emitStateUpdate({ isPlaying: !isPlaying });
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
    get()._emitStateUpdate({ trackIndex: newIndex, currentTime: 0, isPlaying: false });
  },

  prevTrack: () => {
    const { isAdmin, isCollaborative, currentTrackIndex, playlist, player, audioElement } = get();
    if (!isAdmin && !isCollaborative) return;
    const newIndex = (currentTrackIndex - 1 + playlist.length) % playlist.length;
    if (player?.stopVideo) player.stopVideo();
    if (audioElement) { audioElement.pause(); audioElement.src = ''; }
    get()._emitStateUpdate({ trackIndex: newIndex, currentTime: 0, isPlaying: false });
  },

  selectTrack: (index) => {
    const { isAdmin, isCollaborative, currentTrackIndex, player, audioElement } = get();
    if (!isAdmin && !isCollaborative) return;
    if (index !== currentTrackIndex) {
        if (player?.stopVideo) player.stopVideo();
        if (audioElement) { audioElement.pause(); audioElement.src = ''; }
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
    const { player, audioElement, audioNodes } = get(); 
    
    if (audioNodes.context?.state === 'suspended') {
      audioNodes.context.resume().catch(e => console.warn('Resume failed:', e)); 
    }
    
    if (audioElement) { 
      const originalVolume = audioElement.volume;
      audioElement.volume = 0.01; 
      const playPromise = audioElement.play();
      if (playPromise) {
        playPromise
          .then(() => {
            setTimeout(() => {
              audioElement.pause();
              audioElement.currentTime = 0;
              audioElement.volume = originalVolume;
            }, 100);
          })
          .catch(e => console.warn("Audio prime failed:", e));
      }
    } 
    
    if (player?.playVideo) { 
      const originalVol = player.getVolume?.() || 80;
      player.setVolume(1);
      player.playVideo(); 
      setTimeout(() => { 
        player.pauseVideo(); 
        player.setVolume(originalVol);
      }, 100); 
    } 
  },
  
  fetchLyrics: async (youtubeId) => { 
    set({ lyrics: { lines: [], isLoading: true } });
    try { 
      const res = await fetch(`${API_URL}/api/lyrics/${youtubeId}`); 
      if(res.ok) { 
        const lines = await res.json(); 
        set({ lyrics: { lines, isLoading: false } }); 
      } else {
        set({ lyrics: { lines: [], isLoading: false } });
      }
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