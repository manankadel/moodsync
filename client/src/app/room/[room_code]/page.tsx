"use client";

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Player from '@/components/player';
import { useRoomStore } from '@/lib/room-store';
import { shallow } from 'zustand/shallow';
import { Crown, Copy, Link as LinkIcon, Upload, WifiOff } from 'lucide-react';
import FileUploadModal from '@/components/FileUploadModal';
import WaveButton from '@/components/ui/WaveButton';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

const MemoizedPlayer = memo(Player);

const UsernameModal = ( { onSubmit }: { onSubmit: (name: string) => void }) => {
    const [name, setName] = useState('');
    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} className="bg-black/50 border border-white/10 rounded-xl p-8 w-full max-w-sm">
            <h2 className="text-2xl font-semibold mb-6 text-center">Enter Your Name</h2>
            <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(name.trim()); }} className="flex flex-col gap-4">
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your display name..." className="w-full rounded-md border-white/10 bg-white/5 p-3 text-center" autoFocus />
              <WaveButton text="Enter Sonic Space" type="submit" disabled={!name.trim()} />
            </form>
          </motion.div>
        </motion.div>
    );
};

const DisconnectedOverlay = () => {
    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed bottom-28 z-20 w-full flex items-center justify-center gap-2 bg-yellow-900/80 text-yellow-200 py-2 border-t border-b border-yellow-400/30 backdrop-blur-sm">
            <WifiOff size={16} /><span className="font-medium text-sm">Connection lost. Reconnecting...</span>
        </motion.div>
    );
};

const RoomSidebar = memo(function RoomSidebar({ roomCode, onOpenUpload }: { roomCode: string, onOpenUpload: () => void }) {
    const { users, isAdmin } = useRoomStore(state => ({ users: state.users, isAdmin: state.isAdmin }), shallow);
    const [copied, setCopied] = useState(false);
    const copyToClipboard = () => {
        navigator.clipboard.writeText(`${window.location.protocol}//${window.location.host}/room/${roomCode}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <aside className="hidden lg:flex flex-col gap-8 sticky top-8">
            <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}}>
                <h2 className="text-sm font-light text-gray-400 mb-2">Share This Space</h2>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-white/5 border border-white/10">
                    <LinkIcon size={16} className="text-gray-500" />
                    <span className="font-mono text-sm font-semibold text-gray-400 truncate">{`${window.location.host}/room/${roomCode}`}</span>
                    <button onClick={copyToClipboard} className="ml-auto p-2 rounded-md hover:bg-white/10" title="Copy link"><Copy size={16} className={copied ? "text-cyan-400" : "text-gray-400"} /></button>
                </div>
                {copied && <p className="text-xs text-cyan-400 mt-2 animate-pulse">Link copied!</p>}
            </motion.div>
            <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}}>
                <h2 className="text-sm font-light text-gray-400 mb-3">In The Room ({users.length})</h2>
                <div className="space-y-2 max-h-64 overflow-y-auto pr-2">
                    {users.map((user, idx) => (
                        <div key={idx} className="flex items-center gap-3 p-2 rounded-md bg-white/5">
                            <span className="text-sm truncate">{user.name}</span>
                            {user.isAdmin && <Crown size={14} className="ml-auto text-amber-400 flex-shrink-0" />}
                        </div>
                    ))}
                </div>
            </motion.div>
            {isAdmin && (
                <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}}>
                    <h2 className="text-sm font-light text-gray-400 mb-3">Admin Controls</h2>
                    <button onClick={onOpenUpload} className="w-full p-4 rounded-lg bg-gradient-to-r from-purple-500/20 to-pink-500/20 border border-purple-400/30 hover:border-purple-400/50 flex items-center justify-center gap-2 text-white font-medium"><Upload size={18} />Upload Music</button>
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

  // State selectors
  const { connect, disconnect, primePlayer, setRoomData, setLoading, setError } = useRoomStore.getState();
  const state = useRoomStore(s => ({
    isLoading: s.isLoading, error: s.error,
    playlist: s.playlist, currentTrackIndex: s.currentTrackIndex, playlistTitle: s.playlistTitle,
    isAdmin: s.isAdmin, isDisconnected: s.isDisconnected,
  }), shallow);
  const playerControls = useRoomStore(s => ({
      playPause: s.playPause, nextTrack: s.nextTrack, prevTrack: s.prevTrack, setVolume: s.setVolume, selectTrack: s.selectTrack 
  }), shallow);
  const playerState = useRoomStore(s => ({ 
      isPlaying: s.isPlaying, volume: s.volume, duration: s.duration 
  }), shallow);

  const currentTrack = state.playlist[state.currentTrackIndex];

  // Connection Management Effect
  useEffect(() => {
    // Only auto-connect if user has entered their name
    if (!showNameModal && roomCode) {
      connect(roomCode, "Guest"); // Default username if needed
    }
    // Cleanup on component unmount
    return () => disconnect();
  }, [roomCode, showNameModal, connect, disconnect]);
  
  // Initial Room Data Fetching Effect
  useEffect(() => {
    if (showNameModal || !roomCode) return;
    setLoading(true);
    fetch(`${API_URL}/api/room/${roomCode}`)
      .then(res => res.ok ? res.json() : Promise.reject(new Error('Room not found or server is busy.')))
      .then(data => setRoomData(data))
      .catch(err => setError(err.message || 'An unknown error occurred.'))
      .finally(() => setLoading(false));
  }, [roomCode, showNameModal, setRoomData, setLoading, setError]);

  const handleNameSubmit = (name: string) => {
    setShowNameModal(false);
    // primePlayer MUST be called from a direct user interaction
    primePlayer(); 
    connect(roomCode, name);
  };
  
  if (state.isLoading) return <main className="flex min-h-screen items-center justify-center bg-black"><p>Loading Room...</p></main>;
  if (state.error) return <main className="flex min-h-screen flex-col gap-4 items-center justify-center bg-black p-4 text-center"><h1 className='text-2xl text-red-500 font-bold'>Connection Error</h1><p className="text-gray-300">{state.error}</p><Link href="/" className="mt-4 p-2 bg-cyan-600 rounded-md">Go Home</Link></main>;
  if (showNameModal) return <UsernameModal onSubmit={handleNameSubmit} />;

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="absolute inset-0 bg-gradient-to-b from-gray-900 via-black to-black z-[-1]" />
      <main className="grid grid-cols-1 lg:grid-cols-[1fr_350px] gap-4 md:gap-8 max-w-7xl mx-auto p-4 sm:p-8 min-h-screen">
        <div className="flex flex-col pt-4 md:pt-8 lg:pb-32 pb-48">
          <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-4 md:mb-8">
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold truncate">{state.playlistTitle}</h1>
            {state.isAdmin && (
                <div className='lg:hidden mt-4'>
                    <button onClick={() => setShowUploadModal(true)} className="p-2 bg-purple-600/50 border border-purple-500/50 rounded-lg text-sm flex items-center gap-2 hover:bg-purple-600/80"><Upload size={16} /> Upload Music</button>
                </div>
            )}
          </motion.div>
          <motion.ul initial="hidden" animate="visible" variants={{visible: { transition: {staggerChildren: 0.05} }}} className="space-y-2 overflow-y-auto -mr-4 pr-4">
            {state.playlist.map((song, index) => (
              <motion.li variants={{hidden: {opacity: 0, x: -20}, visible: {opacity: 1, x: 0}}} key={index} onClick={() => playerControls.selectTrack(index)} className={`flex items-center gap-4 p-3 rounded-lg border transition-colors ${state.currentTrackIndex === index ? 'bg-white/10 border-cyan-500' : 'border-transparent hover:bg-white/5'} ${state.isAdmin ? 'cursor-pointer' : ''}`}>
                <div className="h-12 w-12 bg-gray-800 rounded-md flex-shrink-0 flex items-center justify-center text-2xl">🎵</div>
                <div><p className="font-semibold truncate text-sm md:text-base">{song.name}</p><p className="text-xs md:text-sm text-gray-400 truncate">{song.artist}</p></div>
              </motion.li>
            ))}
          </motion.ul>
        </div>
        <div className="h-full hidden lg:flex flex-col justify-start pt-8"><RoomSidebar roomCode={roomCode} onOpenUpload={() => setShowUploadModal(true)} /></div>
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
    </div>
  );
}