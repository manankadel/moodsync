"use client";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Play, Pause, SkipBack, SkipForward, Volume1, Volume2, VolumeX, SlidersHorizontal, Loader2 } from "lucide-react";
import BeatVisualizer from "./visualizer";
import Equalizer from "./Equalizer";
import { useRoomStore } from '@/lib/room-store';

interface PlayerProps {
  title: string; artist: string; isPlaying: boolean;
  volume: number; duration: number;
  onPlayPause: () => void; onNext: () => void; onPrev: () => void; onVolumeChange: (v: number) => void;
}

export default function Player({ title, artist, isPlaying, volume, duration, onPlayPause, onNext, onPrev, onVolumeChange }: PlayerProps) {
  const VolumeIcon = volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;
  const [showEqualizer, setShowEqualizer] = useState(false);
  
  // Explicitly destructure isSeeking from the store to fix TS error
  const { currentTime, isAdmin, isSeeking, setIsSeeking, _emitStateUpdate, audioElement, statusMessage } = useRoomStore();
  
  const [seekValue, setSeekValue] = useState(0);
  const [isBuffering, setIsBuffering] = useState(false);

  // Sync Buffering State
  useEffect(() => {
    if (!audioElement) return;
    const onWaiting = () => setIsBuffering(true);
    const onPlaying = () => setIsBuffering(false);
    audioElement.addEventListener('waiting', onWaiting);
    audioElement.addEventListener('playing', onPlaying);
    return () => {
        audioElement.removeEventListener('waiting', onWaiting);
        audioElement.removeEventListener('playing', onPlaying);
    };
  }, [audioElement]);

  // Update slider only if user isn't dragging it
  useEffect(() => { 
      if (!isSeeking) {
          setSeekValue(duration > 0 ? (currentTime / duration) * 100 : 0);
      }
  }, [currentTime, duration, isSeeking]);

  const handleSeekEnd = (e: React.MouseEvent<HTMLInputElement>) => {
    if (!isAdmin || !audioElement) return;
    const seekTime = (Number(e.currentTarget.value) / 100) * duration;
    
    // Optimistic update + Server emit
    audioElement.currentTime = seekTime;
    _emitStateUpdate({ currentTime: seekTime, isPlaying: true });
    setIsSeeking(false);
  };
  
  const formatTime = (s: number) => isNaN(s) || s < 0 ? '0:00' : `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;

  return (
    <motion.footer initial={{ y: 100 }} animate={{ y: 0 }} className="fixed bottom-0 left-0 right-0 z-50 h-auto sm:h-28 bg-black/80 backdrop-blur-xl border-t border-white/10 p-2 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
      <div className="mx-auto max-w-screen-lg h-full flex flex-col sm:flex-row items-center justify-center relative">
        <BeatVisualizer />
        
        {/* STATUS MESSAGE OVERLAY */}
        <AnimatePresence>
            {statusMessage && (
                <motion.div initial={{opacity:0, y: 10}} animate={{opacity:1, y:0}} exit={{opacity:0}} className="absolute -top-12 left-1/2 -translate-x-1/2 bg-cyan-600/90 text-white px-4 py-2 rounded-full text-xs font-bold shadow-lg flex items-center gap-2 z-50 whitespace-nowrap">
                    <Loader2 size={12} className="animate-spin" /> {statusMessage}
                </motion.div>
            )}
        </AnimatePresence>

        <div className="grid grid-cols-[1fr_auto_1fr] sm:grid-cols-[1fr_2fr_1fr] items-center gap-2 sm:gap-4 w-full relative z-10">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <div className="h-12 w-12 sm:h-14 sm:w-14 rounded-xl bg-gradient-to-br from-gray-800 to-gray-900 flex-shrink-0 flex items-center justify-center text-xl sm:text-2xl shadow-inner border border-white/5">
                🎵
            </div>
            <div className="min-w-0">
                <p className="font-bold truncate text-sm sm:text-base text-white">{title}</p>
                <p className="font-medium text-xs sm:text-sm text-gray-400 truncate">{artist}</p>
            </div>
          </div>
          
          <div className="flex flex-col items-center gap-2">
            {/* BUFFERING INDICATOR */}
            {isBuffering && isPlaying && !statusMessage && (
                <span className="absolute -top-3 text-[10px] text-cyan-400 flex items-center gap-1 font-bold tracking-widest bg-black/50 px-2 rounded-full border border-cyan-500/20">
                    <Loader2 size={10} className="animate-spin" /> SYNCING
                </span>
            )}

            <div className="flex items-center gap-4 sm:gap-6">
              <button onClick={onPrev} disabled={!isAdmin} className="disabled:opacity-30 text-gray-400 hover:text-white transition-colors p-2 active:scale-95"><SkipBack size={24} /></button>
              <button onClick={onPlayPause} disabled={!isAdmin} className="h-12 w-12 sm:h-14 sm:w-14 flex items-center justify-center rounded-full bg-white text-black disabled:opacity-50 hover:scale-105 active:scale-95 transition-all shadow-lg shadow-white/10">
                {isPlaying ? <Pause fill="black" /> : <Play fill="black" className="translate-x-0.5"/>}
              </button>
              <button onClick={onNext} disabled={!isAdmin} className="disabled:opacity-30 text-gray-400 hover:text-white transition-colors p-2 active:scale-95"><SkipForward size={24} /></button>
            </div>
            <div className="w-full flex items-center gap-3 text-xs text-gray-400 max-w-xs sm:max-w-sm lg:max-w-md font-mono">
              <span className='hidden sm:inline w-10 text-right'>{formatTime(currentTime)}</span>
              <input type="range" min="0" max="100" value={seekValue} disabled={!isAdmin || duration === 0} onMouseDown={() => isAdmin && setIsSeeking(true)} onMouseUp={handleSeekEnd} onChange={e=>setSeekValue(Number(e.target.value))} className="w-full h-1 bg-gray-700 rounded-full appearance-none cursor-pointer accent-cyan-400 hover:accent-cyan-300"/>
              <span className='hidden sm:inline w-10'>{formatTime(duration)}</span>
            </div>
          </div>

          <div className="relative flex items-center justify-end gap-2">
            <AnimatePresence>{showEqualizer && <Equalizer />}</AnimatePresence>
            <button onClick={() => setShowEqualizer(!showEqualizer)} className={`p-2 rounded-full transition-colors ${showEqualizer ? 'text-cyan-400 bg-white/10' : 'text-gray-400 hover:text-white'}`}><SlidersHorizontal size={20} /></button>
            <div className="items-center gap-2 hidden sm:flex group">
              <VolumeIcon size={20} className="text-gray-400 group-hover:text-white transition-colors" />
              <input type="range" min="0" max="100" value={volume} onChange={(e) => onVolumeChange(Number(e.target.value))} className="w-20 h-1 bg-gray-700 rounded-full appearance-none accent-white cursor-pointer" />
            </div>
          </div>
        </div>
      </div>
    </motion.footer>
  );
}