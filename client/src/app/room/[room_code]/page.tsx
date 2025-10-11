"use client";

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Player from '@/components/player';
import { useRoomStore } from '@/lib/room-store';
import { shallow } from 'zustand/shallow';
import { Crown, Copy, Link as LinkIcon, Upload, WifiOff } from 'lucide-react';
import WaveButton from '@/components/ui/WaveButton';
import FileUploadModal from '@/components/FileUploadModal';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

const MemoizedPlayer = memo(Player);

const UsernameModal = ({ onSubmit }: { onSubmit: (name: string) => void }) => {
  const [name, setName] = useState('');
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.2, ease: "circOut" }} className="bg-black/50 border border-white/10 rounded-xl p-8 shadow-2xl w-full max-w-sm">
        <h2 className="text-2xl font-semibold text-white mb-6 text-center">Enter Your Name</h2>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(name.trim()); }}>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your display name..." className="w-full rounded-md border border-white/10 bg-white/5 px-4 py-3 text-white text-center outline-none focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-400/30" autoFocus />
          <WaveButton text="Enter Sonic Space" type="submit" disabled={!name.trim()} />
        </form>
      </motion.div>
    </motion.div>
  );
};

const DisconnectedOverlay = () => (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-x-0 bottom-full mb-4 z-20 flex items-center justify-center gap-2 bg-yellow-900/50 text-yellow-200 py-2 border-t border-b border-yellow-400/30">
        <WifiOff size={16} /><span className="font-medium text-sm">Connection lost. Reconnecting...</span>
    </motion.div>
);

const RoomSidebar = memo(function RoomSidebar({ roomCode, onOpenUpload }: { roomCode: string, onOpenUpload: () => void }) {
    const { users, isAdmin } = useRoomStore(state => ({ users: state.users, isAdmin: state.isAdmin }), shallow);
    const [copied, setCopied] = useState(false);
    const copyToClipboard = () => {
        navigator.clipboard.writeText(`${window.location.protocol}//${window.location.host}/room/${roomCode}`);
        setCopied(true); setTimeout(() => setCopied(false), 2000);
    };

    return (
        <aside className="hidden lg:flex flex-col gap-8 sticky top-8">
            <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}} transition={{delay: 0.5}}>
                <h2 className="text-sm font-light text-gray-400 mb-2">Share This Space</h2>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-white/5 border border-white/10">
                    <LinkIcon size={16} className="text-gray-500" />
                    <span className="font-mono text-sm font-semibold tracking-wide text-gray-400 truncate">{`${window.location.host}/room/${roomCode}`}</span>
                    <button onClick={copyToClipboard} className="ml-auto p-2 rounded-md hover:bg-white/10" title="Copy link"><Copy size={16} className={copied ? "text-cyan-400" : "text-gray-400"} /></button>
                </div>
                {copied && <p className="text-xs text-cyan-400 mt-2 animate-pulse">Link copied!</p>}
            </motion.div>
            <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}} transition={{delay: 0.6}}>
                <h2 className="text-sm font-light text-gray-400 mb-3">In The Room ({users.length})</h2>
                <div className="space-y-2 max-h-64 overflow-y-auto pr-2">
                    {users.map((user, idx) => (
                        <div key={`${user.name}-${idx}`} className="flex items-center gap-3 p-2 rounded-md bg-white/5">
                            <span className="text-sm text-white truncate">{user.name}</span>
                            {user.isAdmin && <Crown size={14} className="ml-auto text-amber-400 flex-shrink-0" />}
                        </div>
                    ))}
                </div>
            </motion.div>
            {isAdmin && (
                <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}} transition={{delay: 0.7}}>
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

  const roomState = useRoomStore(s => ({
      isLoading: s.isLoading, error: s.error, isDisconnected: s.isDisconnected,
      playlist: s.playlist, currentTrackIndex: s.currentTrackIndex, playlistTitle: s.playlistTitle,
      isAdmin: s.isAdmin, isCollaborative: s.isCollaborative,
  }), shallow);
  
  const playerState = useRoomStore(s => ({ isPlaying: s.isPlaying, volume: s.volume, duration: s.duration }), shallow);
  const { setPlaylistData, setLoading, setError, selectTrack, connect, disconnect, primePlayer, playPause, nextTrack, prevTrack, setVolume } = useRoomStore.getState();
  const currentTrack = roomState.playlist[roomState.currentTrackIndex];

  useEffect(() => { return () => disconnect(); }, [disconnect]);

  useEffect(() => {
    if (!roomCode || showNameModal) return;
    const fetchRoomData = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${API_URL}/api/room/${roomCode}`);
        if (!res.ok) throw new Error('Room not found.');
        const data = await res.json();
        setPlaylistData(data.playlist_title, data.playlist);
      } catch (err) { setError(err instanceof Error ? err.message : 'An unknown error occurred.'); }
    };
    fetchRoomData();
  }, [roomCode, showNameModal, setPlaylistData, setLoading, setError]);

  const handleNameSubmit = (name: string) => {
    if (roomCode) { primePlayer(); connect(roomCode, name); setShowNameModal(false); }
  };
  
  if (showNameModal) return <AnimatePresence><UsernameModal onSubmit={handleNameSubmit} /></AnimatePresence>;
  if (roomState.isLoading) return <main className="flex min-h-screen items-center justify-center bg-black"><p className="text-gray-400">Crafting Sonic Space...</p></main>;
  if (roomState.error) return <main className="flex min-h-screen flex-col items-center justify-center bg-black p-8 text-center"><h1 className="text-3xl font-semibold text-red-500">Error</h1><p className="mt-2 text-gray-400">{roomState.error}</p><Link href="/" className="mt-8 text-cyan-400">&larr; Go back home</Link></main>;

  return (
    <div className="min-h-screen bg-black text-white overflow-hidden">
      <div className="absolute inset-0 bg-black/70" />
      <main className="relative z-10 grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-8 xl:gap-16 max-w-7xl mx-auto p-4 sm:p-8 h-screen">
        <div className="flex flex-col h-full pt-8 pb-32">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}><h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white">{roomState.playlistTitle}</h1></motion.div>
          <motion.ul initial="hidden" animate="visible" className="mt-8 space-y-2 pr-4 -mr-4 flex-1 overflow-y-auto">
            {roomState.playlist.map((song, index) => (
              <motion.li key={`${song.audioUrl || index}`} onClick={() => selectTrack(index)} className={`relative flex items-center gap-4 p-3 rounded-lg border ${(roomState.isAdmin || roomState.isCollaborative) ? 'cursor-pointer' : 'cursor-default'} ${roomState.currentTrackIndex === index ? 'bg-white/10 border-white/20' : 'bg-transparent border-transparent hover:bg-white/5'}`}>
                <AnimatePresence>{roomState.currentTrackIndex === index && (<motion.div layoutId="playing-indicator" className="absolute inset-0 rounded-lg border-2 border-cyan-400"/>)}</AnimatePresence>
                <div className="relative h-12 w-12 rounded-md overflow-hidden bg-gray-800 flex-shrink-0">
                  <div className="flex items-center justify-center h-full text-gray-500 text-2xl">🎵</div>
                </div>
                <div className="relative flex-grow min-w-0"><p className="font-semibold text-white truncate">{song.name}</p><p className="text-sm text-gray-400 truncate">{song.artist}</p></div>
              </motion.li>
            ))}
          </motion.ul>
        </div>
        <div className="h-full flex flex-col justify-start pt-8"><RoomSidebar roomCode={roomCode} onOpenUpload={() => setShowUploadModal(true)} /></div>
      </main>
      
      <AnimatePresence>
        {currentTrack && (
            <MemoizedPlayer 
                title={currentTrack.name} 
                artist={currentTrack.artist} 
                isPlaying={playerState.isPlaying}
                volume={playerState.volume}
                duration={playerState.duration}
                onPlayPause={playPause} 
                onNext={nextTrack} 
                onPrev={prevTrack} 
                onVolumeChange={setVolume}
            />
        )}
      </AnimatePresence>
      <AnimatePresence>{roomState.isDisconnected && <DisconnectedOverlay />}</AnimatePresence>
      <FileUploadModal isOpen={showUploadModal} onClose={() => setShowUploadModal(false)} />
    </div>
  );
}