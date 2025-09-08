"use client";

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Image from 'next/image';
import Script from 'next/script';
import Player from '@/components/player';
import { useRoomStore } from '@/lib/room-store';
import { Users, Crown, Copy, Link as LinkIcon, Share2 } from 'lucide-react';
import WaveButton from '@/components/ui/WaveButton';

// DEFINE THE API URL AT THE TOP
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

// ... (rest of the file is the same until fetchRoomData) ...
const UsernameModal = ({ onSubmit }: { onSubmit: (name: string) => void }) => {
  const [name, setName] = useState('');
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.2, ease: "circOut" }} className="bg-black/50 border border-white/10 rounded-xl p-8 shadow-2xl w-full max-w-sm">
        <h2 className="text-2xl font-semibold text-white mb-6 text-center">Enter Your Name</h2>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(name.trim()); }}>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your display name..." className="w-full rounded-md border border-white/10 bg-white/5 px-4 py-3 text-white text-center outline-none focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-400/30 transition-all" autoFocus />
          <WaveButton text="Enter Sonic Space" type="submit" disabled={!name.trim()} />
        </form>
      </motion.div>
    </motion.div>
  );
};
const RoomSidebar = ({ roomCode, users, isAdmin, isCollaborative, onToggleCollaborative }: { roomCode: string, users: {name: string, isAdmin: boolean}[], isAdmin: boolean, isCollaborative: boolean, onToggleCollaborative: () => void }) => {
    const [copied, setCopied] = useState(false);
    const copyToClipboard = () => {
        navigator.clipboard.writeText(window.location.href);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <aside className="hidden lg:flex flex-col gap-8 sticky top-8">
            <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}} transition={{delay: 0.5}}>
                <h2 className="text-sm font-light text-gray-400 mb-2">Share This Space</h2>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-white/5 border border-white/10">
                    <LinkIcon size={16} className="text-gray-500 flex-shrink-0" />
                    <span className="font-mono text-sm font-semibold tracking-wide text-gray-400 truncate">{`moodsync.app/${roomCode}`}</span>
                    <button onClick={copyToClipboard} className="ml-auto p-2 rounded-md hover:bg-white/10 transition-colors" title="Copy link">
                        <Copy size={16} className={copied ? "text-cyan-400" : "text-gray-400"} />
                    </button>
                </div>
                {copied && <p className="text-xs text-cyan-400 mt-2 animate-pulse">Link copied!</p>}
            </motion.div>
            <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}} transition={{delay: 0.6}}>
                <h2 className="text-sm font-light text-gray-400 mb-3">In The Room ({users.length})</h2>
                <div className="space-y-2 max-h-64 overflow-y-auto pr-2">
                    {users.map((user) => (
                        <div key={user.name} className="flex items-center gap-3 p-2 rounded-md bg-white/5">
                            <span className="text-sm text-white truncate">{user.name}</span>
                            {user.isAdmin && <Crown size={14} className="ml-auto text-amber-400 flex-shrink-0" aria-label="Room Admin" />}
                        </div>
                    ))}
                </div>
            </motion.div>
            {isAdmin && (
                <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}} transition={{delay: 0.7}}>
                    <h2 className="text-sm font-light text-gray-400 mb-3">Admin Controls</h2>
                    <div className="p-4 rounded-lg bg-white/5 border border-white/10">
                        <label htmlFor="collaborative-toggle" className="flex items-center justify-between cursor-pointer">
                            <div className="flex items-center gap-3">
                                <Share2 size={16} className="text-cyan-400"/>
                                <span className="text-white font-medium">Collaborative Playback</span>
                            </div>
                            <div className="relative">
                                <input id="collaborative-toggle" type="checkbox" className="sr-only" checked={isCollaborative} onChange={onToggleCollaborative} />
                                <div className="block bg-gray-600 w-10 h-6 rounded-full"></div>
                                <div className={`dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${isCollaborative ? 'translate-x-4 bg-cyan-400' : ''}`}></div>
                            </div>
                        </label>
                        <p className="text-xs text-gray-500 mt-2">Allow anyone in the room to control the music.</p>
                    </div>
                </motion.div>
            )}
        </aside>
    );
};

export default function RoomPage() {
  const params = useParams();
  const roomCode = params.room_code as string;
  const [showNameModal, setShowNameModal] = useState(true);
  const { playlistTitle, playlist, currentTrackIndex, isLoading, error, users, isAdmin, volume, isCollaborative } = useRoomStore();
  const { player, isPlaying } = useRoomStore();
  const { initializePlayer, setPlaylistData, setLoading, setError, playPause, nextTrack, prevTrack, selectTrack, setVolume, connect, disconnect, toggleCollaborative, setCurrentTime } = useRoomStore.getState();
  const currentTrack = playlist[currentTrackIndex];
  const animationFrameId = useRef<number | null>(null);

  useEffect(() => {
    initializePlayer('youtube-player-container');
    return () => { disconnect(); }
  }, [initializePlayer, disconnect]);

  useEffect(() => {
    if (!roomCode || showNameModal) return;
    const fetchRoomData = async () => {
      setLoading(true);
      try {
        // USE THE API_URL VARIABLE HERE
        const response = await fetch(`${API_URL}/api/room/${roomCode}`);
        if (!response.ok) throw new Error('Room not found or an error occurred.');
        const data = await response.json();
        setPlaylistData(data.playlist_title, data.playlist);
      } catch (err) { setError(err instanceof Error ? err.message : 'An unknown error occurred.'); }
    };
    fetchRoomData();
  }, [roomCode, showNameModal, setPlaylistData, setLoading, setError]);
  
  useEffect(() => {
    const update = () => {
      if (player && typeof player.getCurrentTime === 'function') {
        setCurrentTime(player.getCurrentTime());
      }
      animationFrameId.current = requestAnimationFrame(update);
    };
    if (isPlaying) {
      animationFrameId.current = requestAnimationFrame(update);
    } else {
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
    }
    return () => {
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
    };
  }, [isPlaying, player, setCurrentTime]);

  const handleNameSubmit = (name: string) => {
    if (roomCode) { connect(roomCode, name); setShowNameModal(false); }
  };

  // ... (rest of the file is the same) ...
  if (showNameModal) {
    return <AnimatePresence>{showNameModal && <UsernameModal onSubmit={handleNameSubmit} />}</AnimatePresence>;
  }
  if (isLoading) return <main className="flex min-h-screen items-center justify-center bg-black"><p className="text-gray-400">Crafting Sonic Space...</p></main>;
  if (error) return <main className="flex min-h-screen flex-col items-center justify-center bg-black p-8 text-center"><h1 className="text-3xl font-semibold text-red-500">Error</h1><p className="mt-2 text-gray-400">{error}</p><Link href="/" className="mt-8 text-cyan-400 hover:text-cyan-300">&larr; Go back home</Link></main>;
  return (
    <div className="min-h-screen bg-black text-white overflow-hidden">
      <Script src="https://www.youtube.com/iframe_api" />
      <div id="youtube-player-container" className="fixed -z-10 top-0 left-0"></div>
      <div className="absolute inset-0 z-0 opacity-50"><AnimatePresence>{currentTrack?.albumArt && (<motion.div key={currentTrack.youtubeId} initial={{ opacity: 0, scale: 1.1 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.1 }} transition={{ duration: 1.5, ease: "easeInOut" }} className="absolute inset-0"><Image src={currentTrack.albumArt} alt="background" layout="fill" objectFit="cover" className="blur-3xl saturate-50" /></motion.div>)}</AnimatePresence><div className="absolute inset-0 bg-black/70" /></div>
      <main className="relative z-10 grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-8 xl:gap-16 max-w-7xl mx-auto p-4 sm:p-8 h-screen">
        <div className="flex flex-col h-full pt-8 pb-32">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white">{playlistTitle}</h1>
          </motion.div>
          <motion.ul initial="hidden" animate="visible" className="mt-8 space-y-2 pr-4 -mr-4 flex-1 overflow-y-auto">
            {playlist.map((song, index) => (
              <motion.li key={song.youtubeId || index} onClick={() => selectTrack(index)} className={`relative flex items-center gap-4 p-3 rounded-lg border transition-all duration-300 ${(isAdmin || isCollaborative) ? 'cursor-pointer' : 'cursor-default'} ${currentTrackIndex === index ? 'bg-white/10 border-white/20' : 'bg-transparent border-transparent hover:bg-white/5'}`}>
                <AnimatePresence>{currentTrackIndex === index && (<motion.div layoutId="playing-indicator" className="absolute inset-0 rounded-lg border-2 border-cyan-400"/>)}</AnimatePresence>
                <div className="relative h-12 w-12 rounded-md overflow-hidden bg-gray-800 flex-shrink-0">{song.albumArt ? <Image src={song.albumArt} alt={song.name} layout="fill" objectFit="cover" /> : null}</div>
                <div className="relative flex-grow min-w-0"><p className="font-semibold text-white truncate">{song.name}</p><p className="text-sm text-gray-400 truncate">{song.artist}</p></div>
              </motion.li>
            ))}
          </motion.ul>
        </div>
        <div className="h-full flex flex-col justify-start pt-8">
            <RoomSidebar roomCode={roomCode} users={users} isAdmin={isAdmin} isCollaborative={isCollaborative} onToggleCollaborative={toggleCollaborative} />
        </div>
      </main>
      <AnimatePresence>{currentTrack && (<Player albumArt={currentTrack.albumArt} title={currentTrack.name} artist={currentTrack.artist} isPlaying={isPlaying} onPlayPause={playPause} onNext={nextTrack} onPrev={prevTrack} volume={volume} onVolumeChange={setVolume} />)}</AnimatePresence>
    </div>
  );
}