"use client";

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Player from '@/components/player';
import { useRoomStore } from '@/lib/room-store';
import { shallow } from 'zustand/shallow';
import { Crown, Copy, Link as LinkIcon, Upload, WifiOff, Search, Music2, Loader2, PlusCircle, Sparkles, User, Settings, ToggleLeft, ToggleRight, PlayCircle } from 'lucide-react';
import FileUploadModal from '@/components/FileUploadModal';
import SearchModal from '@/components/SearchModal';
import Lyrics from '@/components/Lyrics';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

const MemoizedPlayer = memo(Player);

const UsernameModal = ({ onSubmit }: { onSubmit: (name: string) => void }) => {
    const [name, setName] = useState('');
    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4 backdrop-blur-md">
          <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-zinc-900/90 border border-white/10 rounded-2xl p-8 w-full max-w-sm shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-cyan-500 via-purple-500 to-pink-500" />
            <h2 className="text-3xl font-bold mb-2 text-center text-white">Identity</h2>
            <p className="text-gray-400 text-center mb-6 text-sm">Who is joining the session?</p>
            <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(name.trim()); }} className="flex flex-col gap-4">
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Display Name" className="w-full rounded-xl border-white/10 bg-black/20 p-4 text-center text-white text-lg outline-none focus:border-cyan-400 focus:bg-black/40 transition-all placeholder:text-gray-600" autoFocus />
              <button type="submit" disabled={!name.trim()} className="w-full py-4 rounded-xl bg-white text-black font-bold text-lg hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  Enter Space
              </button>
            </form>
          </motion.div>
        </motion.div>
    );
};

const SettingsModal = ({ onClose }: { onClose: () => void }) => {
    const { isCollaborative, toggleCollaborative } = useRoomStore();
    return (
        <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-zinc-900 border border-white/10 rounded-2xl p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
                <h3 className="text-xl font-bold mb-6 flex items-center gap-2"><Settings size={20} /> Room Settings</h3>
                <div className="flex items-center justify-between p-4 bg-white/5 rounded-xl">
                    <div>
                        <p className="font-semibold">Collaborative Queue</p>
                        <p className="text-xs text-gray-400">Allow guests to add songs</p>
                    </div>
                    <button onClick={() => toggleCollaborative(!isCollaborative)} className={`transition-colors ${isCollaborative ? 'text-cyan-400' : 'text-gray-500'}`}>
                        {isCollaborative ? <ToggleRight size={32} /> : <ToggleLeft size={32} />}
                    </button>
                </div>
            </div>
        </div>
    );
};

// CRITICAL FOR SYNC: This overlay appears if browser blocks audio
const InteractionOverlay = () => {
    const { needsInteraction, setNeedsInteraction, audioElement } = useRoomStore();
    if (!needsInteraction) return null;
    
    const handleUnlock = () => {
        audioElement?.play().then(() => setNeedsInteraction(false)).catch(() => {});
    };

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center p-4 text-center">
            <motion.button whileTap={{ scale: 0.95 }} onClick={handleUnlock} className="flex flex-col items-center gap-4">
                <PlayCircle size={80} className="text-cyan-400 animate-pulse" />
                <h2 className="text-2xl font-bold text-white">Tap to Join Session</h2>
                <p className="text-gray-400">Audio playback needs your permission</p>
            </motion.button>
        </motion.div>
    );
};

const DisconnectedOverlay = () => (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="fixed bottom-32 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-red-500/10 border border-red-500/20 text-red-200 px-6 py-3 rounded-full backdrop-blur-md shadow-xl">
        <WifiOff size={18} className="animate-pulse" /><span className="font-medium text-sm">Reconnecting...</span>
    </motion.div>
);

const RoomSidebar = memo(function RoomSidebar({ roomCode, onOpenUpload, onOpenSearch, onOpenSettings }: { roomCode: string, onOpenUpload: () => void, onOpenSearch: () => void, onOpenSettings: () => void }) {
    const { users, isAdmin, isCollaborative } = useRoomStore(state => ({ users: state.users, isAdmin: state.isAdmin, isCollaborative: state.isCollaborative }), shallow);
    const [copied, setCopied] = useState(false);
    
    const copyToClipboard = () => {
        navigator.clipboard.writeText(`${window.location.protocol}//${window.location.host}/room/${roomCode}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const canAdd = isAdmin || isCollaborative;

    return (
        <aside className="hidden lg:flex flex-col gap-8 sticky top-8 h-[calc(100vh-8rem)]">
            <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}}>
                <div className="flex justify-between items-center mb-3">
                    <h2 className="text-xs font-bold tracking-widest text-gray-500 uppercase">Session</h2>
                    {isAdmin && <button onClick={onOpenSettings} className="p-1 hover:bg-white/10 rounded"><Settings size={14} className="text-gray-400" /></button>}
                </div>
                <div className="flex items-center gap-2 p-1 rounded-xl bg-white/5 border border-white/10 pr-2 group hover:border-white/20 transition-colors">
                    <div className="p-3 rounded-lg bg-black/40 text-gray-400 group-hover:text-white"><LinkIcon size={16} /></div>
                    <span className="font-mono text-sm font-semibold text-gray-300 truncate select-all tracking-wider flex-1">{roomCode}</span>
                    <button onClick={copyToClipboard} className="p-2 rounded-lg hover:bg-white/10 transition-colors"><Copy size={16} className={copied ? "text-cyan-400" : "text-gray-500"} /></button>
                </div>
            </motion.div>
            
            <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}} className="flex-1 flex flex-col min-h-0">
                <h2 className="text-xs font-bold tracking-widest text-gray-500 mb-3 uppercase flex justify-between">
                    <span>Listeners</span><span className="bg-white/10 px-2 rounded-full text-white">{users.length}</span>
                </h2>
                <div className="space-y-2 overflow-y-auto pr-2 custom-scrollbar">
                    {users.map((user, idx) => (
                        <div key={idx} className="flex items-center gap-3 p-2 rounded-lg bg-white/5 border border-transparent hover:border-white/10 transition-colors">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${user.isAdmin ? 'bg-amber-500/20 text-amber-400' : 'bg-gray-800 text-gray-400'}`}>
                                {user.isAdmin ? <Crown size={14} /> : <User size={14} />}
                            </div>
                            <span className="text-sm truncate text-gray-200 font-medium">{user.name}</span>
                        </div>
                    ))}
                </div>
            </motion.div>
            
            {canAdd && (
                <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}} className="space-y-3">
                    <button onClick={onOpenSearch} className="group w-full p-4 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold flex items-center justify-center gap-3 transition-all shadow-lg shadow-cyan-900/20 hover:scale-[1.02] active:scale-[0.98]">
                        <Search size={20} className="group-hover:scale-110 transition-transform" /> <span>Add Song</span>
                    </button>
                    <button onClick={onOpenUpload} className="w-full p-4 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-gray-300 font-medium flex items-center justify-center gap-2 transition-colors hover:text-white">
                        <Upload size={18} /> Upload File
                    </button>
                </motion.div>
            )}
        </aside>
    );
});

export default function RoomPage() {
  const params = useParams();
  const roomCode = params.room_code as string;
  const [showNameModal, setShowNameModal] = useState(true);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [viewMode, setViewMode] = useState<'playlist' | 'lyrics'>('playlist');

  const { setRoomData, setLoading, setError, connect, disconnect, primePlayer } = useRoomStore.getState();
  const state = useRoomStore(s => ({
    isLoading: s.isLoading, error: s.error,
    playlist: s.playlist, currentTrackIndex: s.currentTrackIndex, playlistTitle: s.playlistTitle,
    isAdmin: s.isAdmin, isDisconnected: s.isDisconnected, isCollaborative: s.isCollaborative
  }), shallow);
  const playerControls = useRoomStore(s => ({ playPause: s.playPause, nextTrack: s.nextTrack, prevTrack: s.prevTrack, setVolume: s.setVolume, selectTrack: s.selectTrack }), shallow);
  const playerState = useRoomStore(s => ({ isPlaying: s.isPlaying, volume: s.volume, duration: s.duration }), shallow);

  const currentTrack = state.playlist[state.currentTrackIndex];
  const canAdd = state.isAdmin || state.isCollaborative;

  useEffect(() => {
    if (showNameModal || !roomCode) return;
    setLoading(true);
    fetch(`${API_URL}/api/room/${roomCode}`)
      .then(res => res.ok ? res.json() : Promise.reject(new Error('Room not found.')))
      .then(data => setRoomData(data))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [roomCode, showNameModal]);

  const handleNameSubmit = (name: string) => {
    setShowNameModal(false);
    primePlayer(); 
    connect(roomCode, name);
  };
  
  if (showNameModal) return <UsernameModal onSubmit={handleNameSubmit} />;
  if (state.isLoading) return <main className="flex min-h-screen items-center justify-center bg-black text-white"><Loader2 className="animate-spin mr-2" /> Entering Space...</main>;
  if (state.error) return <main className="flex min-h-screen flex-col gap-4 items-center justify-center bg-black p-4 text-center"><h1 className='text-2xl text-red-500 font-bold'>Error</h1><p className="text-gray-300">{state.error}</p><Link href="/" className="mt-4 p-2 bg-cyan-600 rounded-md text-white">Go Home</Link></main>;

  return (
    <div className="min-h-screen bg-black text-white overflow-hidden font-sans selection:bg-cyan-500/30">
      <div className="fixed inset-0 z-[-1]">
          <div className="absolute inset-0 bg-gradient-to-br from-gray-900 via-black to-black" />
          <div className="absolute top-[-20%] right-[-10%] w-[600px] h-[600px] rounded-full bg-purple-600/10 blur-[100px]" />
          <div className="absolute bottom-[-20%] left-[-10%] w-[500px] h-[500px] rounded-full bg-cyan-600/10 blur-[100px]" />
      </div>
      
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 p-4 bg-black/80 backdrop-blur-xl border-b border-white/10 flex justify-between items-center">
          <h1 className="font-bold truncate max-w-[50%] text-sm tracking-wider uppercase text-gray-400">{state.playlistTitle}</h1>
          <div className="flex gap-2">
            <button onClick={() => setViewMode(viewMode === 'playlist' ? 'lyrics' : 'playlist')} className="p-2 rounded-full bg-white/10 active:scale-95 transition-transform">
                {viewMode === 'playlist' ? <Music2 size={20} className="text-purple-400"/> : <LinkIcon size={20}/>}
            </button>
            {state.isAdmin && <button onClick={() => setShowSettingsModal(true)} className="p-2 rounded-full bg-white/10 active:scale-95"><Settings size={20} /></button>}
            {canAdd && <button onClick={() => setShowSearchModal(true)} className="p-2 rounded-full bg-cyan-600 text-white shadow-lg shadow-cyan-900/50 active:scale-95 transition-transform"><PlusCircle size={20}/></button>}
          </div>
      </div>

      <main className="grid grid-cols-1 lg:grid-cols-[1fr_350px] gap-8 max-w-7xl mx-auto p-4 sm:p-8 h-screen pt-24 lg:pt-8 pb-32">
        <div className="relative h-full rounded-3xl bg-white/5 border border-white/10 overflow-hidden flex flex-col shadow-2xl">
            <div className="absolute top-6 right-6 z-20 hidden lg:flex bg-black/40 backdrop-blur-md rounded-full p-1 border border-white/5">
                <button onClick={() => setViewMode('playlist')} className={`px-6 py-2 rounded-full text-sm font-bold transition-all ${viewMode === 'playlist' ? 'bg-white text-black shadow-lg' : 'text-gray-400 hover:text-white'}`}>Playlist</button>
                <button onClick={() => setViewMode('lyrics')} className={`px-6 py-2 rounded-full text-sm font-bold transition-all ${viewMode === 'lyrics' ? 'bg-white text-black shadow-lg' : 'text-gray-400 hover:text-white'}`}>Lyrics</button>
            </div>

            {viewMode === 'playlist' ? (
                <div className="flex-1 overflow-y-auto p-6 lg:p-10 space-y-2 custom-scrollbar">
                     <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
                        <h1 className="text-4xl md:text-6xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-white via-gray-200 to-gray-600">{state.playlistTitle}</h1>
                        <p className="text-gray-500 mt-2 font-medium flex items-center gap-2">
                            {state.playlist.length} Tracks <span className="w-1 h-1 rounded-full bg-gray-600" /> 
                            {currentTrack ? <span className="text-cyan-400">Playing {currentTrack.name}</span> : 'Waiting for music'}
                        </p>
                    </motion.div>

                    {state.playlist.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-20 text-center opacity-80">
                            <div className="w-24 h-24 rounded-full bg-white/5 flex items-center justify-center mb-6 animate-pulse">
                                <Sparkles size={40} className="text-cyan-400" />
                            </div>
                            <h3 className="text-2xl font-bold text-white mb-2">It's quiet... too quiet.</h3>
                            {canAdd ? (
                                <>
                                    <p className="text-gray-400 max-w-xs mx-auto mb-8">Add a song from YouTube or upload a file to start the session.</p>
                                    <button onClick={() => setShowSearchModal(true)} className="px-8 py-4 rounded-full bg-cyan-600 text-white font-bold hover:scale-105 transition-transform shadow-lg shadow-cyan-600/20">Add First Song</button>
                                </>
                            ) : (
                                <p className="text-gray-400 max-w-xs mx-auto mb-8">Waiting for the Host to add music...</p>
                            )}
                        </div>
                    ) : (
                        <div className="space-y-2">
                             {state.playlist.map((song, index) => (
                                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05 }} key={index} onClick={() => state.isAdmin && playerControls.selectTrack(index)} 
                                    className={`group flex items-center gap-5 p-4 rounded-2xl transition-all border ${state.isAdmin ? 'cursor-pointer' : ''} ${state.currentTrackIndex === index ? 'bg-white/10 border-cyan-500/30 shadow-lg shadow-black/20' : 'bg-transparent border-transparent hover:bg-white/5'}`}>
                                    <div className="relative h-14 w-14 rounded-xl overflow-hidden bg-gray-800 flex-shrink-0 shadow-lg">
                                        {song.albumArt ? <img src={song.albumArt} alt="art" className="object-cover h-full w-full group-hover:scale-110 transition-transform duration-500" /> : <div className="h-full w-full flex items-center justify-center text-2xl text-gray-600">🎵</div>}
                                        {state.currentTrackIndex === index && playerState.isPlaying && (
                                            <div className="absolute inset-0 bg-black/40 flex items-center justify-center gap-1">
                                                <div className="w-1 h-4 bg-cyan-400 animate-[bounce_1s_infinite]" />
                                                <div className="w-1 h-6 bg-cyan-400 animate-[bounce_1.2s_infinite]" />
                                                <div className="w-1 h-3 bg-cyan-400 animate-[bounce_0.8s_infinite]" />
                                            </div>
                                        )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className={`font-bold text-lg truncate ${state.currentTrackIndex === index ? 'text-cyan-400' : 'text-gray-100 group-hover:text-white'}`}>{song.name}</p>
                                        <p className="text-sm text-gray-500 truncate font-medium">{song.artist}</p>
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    )}
                </div>
            ) : (
                <Lyrics />
            )}
        </div>

        <RoomSidebar roomCode={roomCode} onOpenUpload={() => setShowUploadModal(true)} onOpenSearch={() => setShowSearchModal(true)} onOpenSettings={() => setShowSettingsModal(true)} />
      </main>
      
      <AnimatePresence>
        {currentTrack && (
            <MemoizedPlayer 
                title={currentTrack.name} artist={currentTrack.artist} 
                isPlaying={playerState.isPlaying} volume={playerState.volume} duration={playerState.duration}
                onPlayPause={playerControls.playPause} onNext={playerControls.nextTrack} onPrev={playerControls.prevTrack} onVolumeChange={playerControls.setVolume}
            />
        )}
      </AnimatePresence>
      <InteractionOverlay />
      <AnimatePresence>{state.isDisconnected && <DisconnectedOverlay />}</AnimatePresence>
      <FileUploadModal isOpen={showUploadModal} onClose={() => setShowUploadModal(false)} />
      <SearchModal isOpen={showSearchModal} onClose={() => setShowSearchModal(false)} roomCode={roomCode} />
      {showSettingsModal && <SettingsModal onClose={() => setShowSettingsModal(false)} />}
    </div>
  );
}