import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

interface Song { name: string; artist: string; albumArt: string | null; youtubeId: string; }
interface User { name: string; isAdmin: boolean; }
declare global { interface Window { onYouTubeIframeAPIReady: () => void; YT: any; }}

interface EqualizerSettings { bass: number; mids: number; treble: number; }

interface SyncState {
  isPlaying?: boolean;
  trackIndex?: number;
  volume?: number;
  isCollaborative?: boolean;
  equalizer?: EqualizerSettings;
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
  roomCode: string; playlistTitle: string; playlist: Song[]; users: User[];
  currentTrackIndex: number; isPlaying: boolean; volume: number; isCollaborative: boolean;
  isLoading: boolean; error: string | null; player: any; socket: Socket | null; isAdmin: boolean; username: string;
  equalizer: EqualizerSettings;
  audioNodes: AudioNodes;
  currentTime: number;
  lyrics: {
    lines: LyricLine[];
    isLoading: boolean;
  };

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
  fetchLyrics: (youtubeId: string) => void;
  setCurrentTime: (time: number) => void;
  primePlayer: () => void;
}

export const useRoomStore = create<RoomState>((set, get) => ({
  roomCode: '', playlistTitle: '', playlist: [], users: [],
  currentTrackIndex: 0, isPlaying: false, volume: 80, isCollaborative: false, isLoading: true, error: null, player: null,
  socket: null, isAdmin: false, username: '',
  equalizer: { bass: 0, mids: 0, treble: 0 },
  audioNodes: { context: null, source: null, bass: null, mids: null, treble: null },
  currentTime: 0,
  lyrics: { lines: [], isLoading: false },

  connect: (roomCode, username) => {
    if (get().socket) return;
    const socket = io(API_URL);
    set({ socket, username, roomCode });
    socket.on('connect', () => socket.emit('join_room', { room_code: roomCode, username }));
    socket.on('disconnect', () => set({ users: [], isAdmin: false }));
    socket.on('error', (data) => get().setError(data.message));
    socket.on('update_user_list', (users: User[]) => {
      const self = users.find(u => u.name === get().username);
      set({ users, isAdmin: self?.isAdmin || false });
    });
    socket.on('load_current_state', (state) => get().syncPlayerState(state));
    socket.on('sync_player_state', (state) => get().syncPlayerState(state));
  },

  disconnect: () => { get().socket?.disconnect(); set({ socket: null }); },

  _connectAudioGraph: () => {
    const { player, audioNodes } = get();
    if (!player || !audioNodes.context || !audioNodes.bass || !audioNodes.mids || !audioNodes.treble) {
      return;
    }
    
    try {
      const iframe = player.getIframe();
      if (!iframe) return;
      const videoElement = iframe.contentWindow.document.querySelector('video');

      if (videoElement && !audioNodes.source) {
        videoElement.crossOrigin = "anonymous";
        const source = audioNodes.context.createMediaElementSource(videoElement);
        set(state => ({ audioNodes: { ...state.audioNodes, source }}));

        source.connect(audioNodes.bass);
        get().setEqualizer(get().equalizer, false);
        console.log("MoodSync: Audio Equalizer successfully connected.");
      }
    } catch (e) {
      console.error("MoodSync: Failed to connect audio graph. Equalizer will not work.", e);
    }
  },

  initializePlayer: (domId) => {
    const onPlayerStateChange = (event: any) => {
      const state = get();
      
      if (event.data === window.YT.PlayerState.PLAYING) {
        state.audioNodes.source?.disconnect();
        set(s => ({ audioNodes: { ...s.audioNodes, source: null } }));
        state._connectAudioGraph();
      }

      if (!state._canControl()) return;
      let newIsPlaying = state.isPlaying;
      if (event.data === window.YT.PlayerState.PLAYING) newIsPlaying = true;
      else if (event.data === window.YT.PlayerState.PAUSED) newIsPlaying = false;
      else if (event.data === window.YT.PlayerState.ENDED) { state.nextTrack(); return; }

      if (newIsPlaying !== state.isPlaying) {
        set({ isPlaying: newIsPlaying });
        state.socket?.emit('update_player_state', { room_code: state.roomCode, state: { isPlaying: newIsPlaying }});
      }
    };

    const onPlayerReady = (event: any) => {
      const player = event.target;
      player.setVolume(get().volume);
      set({ player });
      
      if (!get().audioNodes.context) {
          try {
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            
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

            bass.connect(mids);
            mids.connect(treble);
            treble.connect(audioContext.destination);

            set({ audioNodes: { context: audioContext, source: null, bass, mids, treble } });

          } catch (e) {
             console.error("MoodSync: Could not create Web Audio Context. Equalizer will not work.", e);
          }
      }
      
      const { playlist, currentTrackIndex } = get();
      if (playlist.length > 0) {
        player.cueVideoById(playlist[currentTrackIndex].youtubeId);
      }
    };
    
    window.onYouTubeIframeAPIReady = () => {
      new window.YT.Player(domId, {
        height: '0',
        width: '0',
        playerVars: {
          origin: window.location.origin
        },
        events: {
          'onReady': onPlayerReady,
          'onStateChange': onPlayerStateChange
        }
      });
    };
    if (window.YT && window.YT.Player) {
      window.onYouTubeIframeAPIReady();
    }
  },

  setPlaylistData: (title, playlist) => {
    set({ playlistTitle: title, playlist, isLoading: false, error: null, currentTrackIndex: 0, isPlaying: false });
    const { player } = get();
    if (playlist.length > 0) {
      get().fetchLyrics(playlist[0].youtubeId);
      if (player) player.cueVideoById(playlist[0].youtubeId);
    }
  },
  
  _canControl: () => get().isAdmin || get().isCollaborative,

  _changeTrack: (index: number) => {
    const { player, socket, roomCode, playlist } = get();
    if (player && get()._canControl() && playlist.length > 0) {
      const newTrack = playlist[index];
      get().fetchLyrics(newTrack.youtubeId);
      player.loadVideoById(newTrack.youtubeId);
      set({ currentTrackIndex: index, isPlaying: true });
      socket?.emit('update_player_state', { room_code: roomCode, state: { isPlaying: true, trackIndex: index }});
    }
  },

  playPause: () => {
    if (!get()._canControl()) return;
    const { player, isPlaying, audioNodes } = get();
    if (isPlaying) {
      player?.pauseVideo();
    } else {
      if (audioNodes.context?.state === 'suspended') {
        audioNodes.context.resume();
      }
      player?.playVideo();
    }
  },
  
  nextTrack: () => get()._changeTrack((get().currentTrackIndex + 1) % get().playlist.length),
  prevTrack: () => get()._changeTrack((get().currentTrackIndex - 1 + get().playlist.length) % get().playlist.length),
  selectTrack: (index) => {
    if (index !== get().currentTrackIndex) get()._changeTrack(index);
    else get().playPause();
  },
  
  setVolume: (volume: number) => {
    get().player?.setVolume(volume);
    set({ volume });
  },

  setEqualizer: (settings, emit = true) => {
    const { audioNodes, socket, roomCode, _canControl } = get();
    
    if(audioNodes.bass) audioNodes.bass.gain.value = settings.bass;
    if(audioNodes.mids) audioNodes.mids.gain.value = settings.mids;
    if(audioNodes.treble) audioNodes.treble.gain.value = settings.treble;

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
      if(isAdmin) {
          const newState = !isCollaborative;
          set({ isCollaborative: newState });
          socket?.emit('update_player_state', { room_code: roomCode, state: { isCollaborative: newState }});
      }
  },

  syncPlayerState: (state) => {
    const { player, playlist, currentTrackIndex, isPlaying, volume, isCollaborative, equalizer } = get();
    if (!player || !playlist || playlist.length === 0) return;

    if (state.equalizer && JSON.stringify(state.equalizer) !== JSON.stringify(equalizer)) {
        get().setEqualizer(state.equalizer, false);
    }
    
    if (state.isCollaborative !== undefined && state.isCollaborative !== isCollaborative) {
        set({ isCollaborative: state.isCollaborative });
    }
    
    if (state.trackIndex !== undefined && state.trackIndex !== currentTrackIndex) {
      if(state.trackIndex >= 0 && state.trackIndex < playlist.length) {
        player.loadVideoById(playlist[state.trackIndex].youtubeId);
        set({ currentTrackIndex: state.trackIndex });
        get().fetchLyrics(playlist[state.trackIndex].youtubeId);
      }
    }
    
    if (state.volume !== undefined && state.volume !== volume) {
        player.setVolume(state.volume);
        set({ volume: state.volume });
    }

    if (state.isPlaying !== undefined && state.isPlaying !== isPlaying) {
      setTimeout(() => {
        if (state.isPlaying) {
          player.playVideo();
        } else {
          player.pauseVideo();
        }
      }, 150);
      set({ isPlaying: state.isPlaying });
    }
  },

  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error, isLoading: false }),

  setCurrentTime: (time) => {
    set({ currentTime: time });
  },

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
    const { player, volume } = get();
    if (player && typeof player.playVideo === 'function') {
        console.log("Priming player for autoplay...");
        player.mute();
        player.playVideo();
        setTimeout(() => {
            player.pauseVideo();
            player.unMute();
            player.setVolume(volume);
            console.log("Player primed and ready for synchronized playback.");
        }, 250);
    }
  },
}));