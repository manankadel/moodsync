"use client";

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Player from '@/components/player';
import { useRoomStore } from '@/lib/room-store';
import { shallow } from 'zustand/shallow';
import { Crown, Copy, Link as LinkIcon, Upload, WifiOff, Search, Music2, Loader2 } from 'lucide-react';
import FileUploadModal from '@/components/FileUploadModal';
import SearchModal from '@/components/SearchModal';
import WaveButton from '@/components/ui/WaveButton';
import Lyrics from '@/components/Lyrics';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

const MemoizedPlayer = memo(Player);

const UsernameModal = ({ onSubmit }: { onSubmit: (name: string) => void }) => {
    const [name, setName] = useState('');
    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4">
          <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} className="bg-zinc-900 border border-white/10 rounded-xl p-8 w-full max-w-sm">
            <h2 className="text-2xl font-semibold mb-6 text-center text-white">Enter Your Name</h2>
            <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(name.trim()); }} className="flex flex-col gap-4">
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your display name..." className="w-full rounded-md border-white/10 bg-white/5 p-3 text-center text-white outline-none focus:border-cyan-400" autoFocus />
              <WaveButton text="Enter Sonic Space" type="submit" disabled={!name.trim()} />
            </form>
          </motion.div>
        </motion.div>
    );
};

const DisconnectedOverlay = () => (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed bottom-28 left-0 right-0 z-20 flex items-center justify-center gap-2 bg-red-900/90 text-red-100 py-2 backdrop-blur-sm">
        <WifiOff size={16} /><span className="font-medium text-sm">Connection lost. Reconnecting...</span>
    </motion.div>
);

const RoomSidebar = memo(function RoomSidebar({ roomCode, onOpenUpload, onOpenSearch }: { roomCode: string, onOpenUpload: () => void, onOpenSearch: () => void }) {
    const { users, isAdmin } = useRoomStore(state => ({ users: state.users, isAdmin: state.isAdmin }), shallow);
    const [copied, setCopied] = useState(false);
    const copyToClipboard = () => {
        navigator.clipboard.writeText(`${window.location.protocol}//${window.location.host}/room/${roomCode}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <aside className="hidden lg:flex flex-col gap-8 sticky top-8 h-[calc(100vh-8rem)]">
            <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}}>
                <h2 className="text-sm font-light text-gray-400 mb-2">Share This Space</h2>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-white/5 border border-white/10">
                    <LinkIcon size={16} className="text-gray-500" />
                    <span className="font-mono text-sm font-semibold text-gray-400 truncate select-all">{roomCode}</span>
                    <button onClick={copyToClipboard} className="ml-auto p-2 rounded-md hover:bg-white/10"><Copy size={16} className={copied ? "text-cyan-400" : "text-gray-400"} /></button>
                </div>
            </motion.div>
            
            <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}} className="flex-1 flex flex-col min-h-0">
                <h2 className="text-sm font-light text-gray-400 mb-3">In The Room ({users.length})</h2>
                <div className="space-y-2 overflow-y-auto pr-2 custom-scrollbar">
                    {users.map((user, idx) => (
                        <div key={idx} className="flex items-center gap-3 p-2 rounded-md bg-white/5">
                            <span className="text-sm truncate text-white">{user.name}</span>
                            {user.isAdmin && <Crown size={14} className="ml-auto text-amber-400 flex-shrink-0" />}
                        </div>
                    ))}
                </div>
            </motion.div>
            
            {isAdmin && (
                <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}} className="space-y-3">
                    <button onClick={onOpenSearch} className="w-full p-4 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-bold flex items-center justify-center gap-2 transition-colors shadow-lg shadow-cyan-900/20">
                        <Search size={18} /> Add Song (YouTube)
                    </button>
                    <button onClick={onOpenUpload} className="w-full p-4 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-gray-300 font-medium flex items-center justify-center gap-2 transition-colors">
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
  const [viewMode, setViewMode] = useState<'playlist' | 'lyrics'>('playlist');

  const { setRoomData, setLoading, setError, connect, disconnect, primePlayer } = useRoomStore.getState();
  const state = useRoomStore(s => ({
    isLoading: s.isLoading, error: s.error,
    playlist: s.playlist, currentTrackIndex: s.currentTrackIndex, playlistTitle: s.playlistTitle,
    isAdmin: s.isAdmin, isDisconnected: s.isDisconnected,
  }), shallow);
  const playerControls = useRoomStore(s => ({ playPause: s.playPause, nextTrack: s.nextTrack, prevTrack: s.prevTrack, setVolume: s.setVolume, selectTrack: s.selectTrack }), shallow);
  const playerState = useRoomStore(s => ({ isPlaying: s.isPlaying, volume: s.volume, duration: s.duration }), shallow);

  const currentTrack = state.playlist[state.currentTrackIndex];

  useEffect(() => {
    if (!showNameModal) connect(roomCode, "Guest");
    return () => disconnect();
  }, [roomCode, showNameModal]);
  
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
  
  // FIX: Check Name Modal FIRST. This breaks the deadlock.
  if (showNameModal) return <UsernameModal onSubmit={handleNameSubmit} />;

  // Then check loading
  if (state.isLoading) return <main className="flex min-h-screen items-center justify-center bg-black text-white"><Loader2 className="animate-spin mr-2" /> Entering Space...</main>;
  
  // Then check error
  if (state.error) return <main className="flex min-h-screen flex-col gap-4 items-center justify-center bg-black p-4 text-center"><h1 className='text-2xl text-red-500 font-bold'>Error</h1><p className="text-gray-300">{state.error}</p><Link href="/" className="mt-4 p-2 bg-cyan-600 rounded-md text-white">Go Home</Link></main>;

  return (
    <div className="min-h-screen bg-black text-white overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-black to-black z-[-1]" />
      
      {/* Mobile Header */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 p-4 bg-black/80 backdrop-blur-md border-b border-white/10 flex justify-between items-center">
          <h1 className="font-bold truncate max-w-[50%]">{state.playlistTitle}</h1>
          <div className="flex gap-2">
            <button onClick={() => setViewMode(viewMode === 'playlist' ? 'lyrics' : 'playlist')} className="p-2 rounded-full bg-white/10">
                {viewMode === 'playlist' ? <Music2 size={20} className="text-purple-400"/> : <LinkIcon size={20}/>}
            </button>
            {state.isAdmin && <button onClick={() => setShowSearchModal(true)} className="p-2 rounded-full bg-cyan-600"><Search size={20}/></button>}
          </div>
      </div>

      <main className="grid grid-cols-1 lg:grid-cols-[1fr_350px] gap-8 max-w-7xl mx-auto p-4 sm:p-8 h-screen pt-20 lg:pt-8 pb-32">
        
        {/* Main Content Area (Lyrics or Playlist) */}
        <div className="relative h-full rounded-2xl bg-white/5 border border-white/10 overflow-hidden flex flex-col">
            {/* Desktop Toggle */}
            <div className="absolute top-4 right-4 z-20 hidden lg:flex bg-black/50 rounded-lg p-1">
                <button onClick={() => setViewMode('playlist')} className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${viewMode === 'playlist' ? 'bg-white/20 text-white' : 'text-gray-400 hover:text-white'}`}>Playlist</button>
                <button onClick={() => setViewMode('lyrics')} className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${viewMode === 'lyrics' ? 'bg-white/20 text-white' : 'text-gray-400 hover:text-white'}`}>Lyrics</button>
            </div>

            {viewMode === 'playlist' ? (
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                     <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-6 px-2">
                        <h1 className="text-3xl md:text-5xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-gray-500">{state.playlistTitle}</h1>
                        <p className="text-gray-400 mt-2">Currently playing: <span className="text-cyan-400">{currentTrack?.name || 'Nothing'}</span></p>
                    </motion.div>
                    {state.playlist.map((song, index) => (
                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} key={index} onClick={() => state.isAdmin && playerControls.selectTrack(index)} 
                            className={`group flex items-center gap-4 p-3 rounded-xl transition-all border ${state.currentTrackIndex === index ? 'bg-white/10 border-cyan-500/50' : 'border-transparent hover:bg-white/5'} ${state.isAdmin ? 'cursor-pointer' : ''}`}>
                            <div className="relative h-12 w-12 rounded-lg overflow-hidden bg-gray-800 flex-shrink-0">
                                {song.albumArt ? <img src={song.albumArt} alt="art" className="object-cover h-full w-full" /> : <div className="h-full w-full flex items-center justify-center text-xl">🎵</div>}
                                {state.currentTrackIndex === index && playerState.isPlaying && (
                                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center"><div className="w-1 h-3 bg-cyan-400 animate-bounce mx-[1px]"/></div>
                                )}
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className={`font-semibold truncate ${state.currentTrackIndex === index ? 'text-cyan-400' : 'text-white'}`}>{song.name}</p>
                                <p className="text-sm text-gray-400 truncate">{song.artist}</p>
                            </div>
                        </motion.div>
                    ))}
                </div>
            ) : (
                <Lyrics />
            )}
        </div>

        {/* Sidebar (Desktop) */}
        <RoomSidebar roomCode={roomCode} onOpenUpload={() => setShowUploadModal(true)} onOpenSearch={() => setShowSearchModal(true)} />
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
      <AnimatePresence>{state.isDisconnected && <DisconnectedOverlay />}</AnimatePresence>
      <FileUploadModal isOpen={showUploadModal} onClose={() => setShowUploadModal(false)} />
      <SearchModal isOpen={showSearchModal} onClose={() => setShowSearchModal(false)} roomCode={roomCode} />
    </div>
  );
}