"use client";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Play, Pause, SkipBack, SkipForward, Volume1, Volume2, VolumeX, SlidersHorizontal } from "lucide-react";
import BeatVisualizer from "./visualizer";
import Equalizer from "./Equalizer";
import { useRoomStore } from "@/lib/room-store";

interface PlayerProps {
  title: string; artist: string; isPlaying: boolean;
  volume: number; duration: number;
  onPlayPause: () => void; onNext: () => void; onPrev: () => void; onVolumeChange: (v: number) => void;
}

export default function Player({ title, artist, isPlaying, volume, duration, onPlayPause, onNext, onPrev, onVolumeChange }: PlayerProps) {
  const VolumeIcon = volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;
  const [showEqualizer, setShowEqualizer] = useState(false);
  const { currentTime, isAdmin, isSeeking, setIsSeeking, _emitStateUpdate, audioElement } = useRoomStore();
  const [seekValue, setSeekValue] = useState(0);

  useEffect(() => { if (!isSeeking) setSeekValue(duration > 0 ? (currentTime / duration) * 100 : 0) }, [currentTime, duration, isSeeking]);

  const handleSeekEnd = (e: React.MouseEvent<HTMLInputElement>) => {
    if (!isAdmin || !audioElement) return;
    const seekTime = (Number(e.currentTarget.value) / 100) * duration;
    audioElement.currentTime = seekTime;
    setIsSeeking(false);
    setTimeout(() => _emitStateUpdate({ currentTime: seekTime }), 150);
  };
  
  const formatTime = (s: number) => isNaN(s) || s < 0 ? '0:00' : `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;

  return (
    <motion.footer initial={{ y: 100 }} animate={{ y: 0 }} className="fixed bottom-0 left-0 right-0 z-50 h-auto sm:h-28 bg-black/70 backdrop-blur-xl border-t border-white/10 p-2">
      <div className="mx-auto max-w-screen-lg h-full flex flex-col sm:flex-row items-center justify-center relative">
        <BeatVisualizer />
        <div className="grid grid-cols-[1fr_auto_1fr] sm:grid-cols-[1fr_2fr_1fr] items-center gap-2 sm:gap-4 w-full">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <div className="h-12 w-12 sm:h-14 sm:w-14 rounded-lg bg-gray-800 flex-shrink-0 flex items-center justify-center text-xl sm:text-2xl">🎵</div>
            <div className="min-w-0"><p className="font-semibold truncate text-sm sm:text-base">{title}</p><p className="font-light text-xs sm:text-sm text-gray-400 truncate">{artist}</p></div>
          </div>
          
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-2 sm:gap-4">
              <button onClick={onPrev} disabled={!isAdmin} className="disabled:opacity-50 text-gray-300 hover:text-white p-2"><SkipBack /></button>
              <button onClick={onPlayPause} disabled={!isAdmin} className="h-12 w-12 sm:h-14 sm:w-14 flex items-center justify-center rounded-full bg-white text-black disabled:opacity-50">{isPlaying ? <Pause /> : <Play className="translate-x-0.5"/>}</button>
              <button onClick={onNext} disabled={!isAdmin} className="disabled:opacity-50 text-gray-300 hover:text-white p-2"><SkipForward /></button>
            </div>
            <div className="w-full flex items-center gap-2 text-xs text-gray-400 max-w-xs sm:max-w-sm lg:max-w-md">
              <span className='hidden sm:inline'>{formatTime(currentTime)}</span>
              <input type="range" min="0" max="100" value={seekValue} disabled={!isAdmin || duration === 0} onMouseDown={() => isAdmin && setIsSeeking(true)} onMouseUp={handleSeekEnd} onChange={e=>setSeekValue(Number(e.target.value))} className="w-full h-1 bg-gray-700 rounded-full appearance-none cursor-pointer accent-cyan-400"/>
              <span className='hidden sm:inline'>{formatTime(duration)}</span>
            </div>
          </div>

          <div className="relative flex items-center justify-end gap-1">
            <AnimatePresence>{showEqualizer && <Equalizer />}</AnimatePresence>
            <button onClick={() => setShowEqualizer(!showEqualizer)} className={`p-2 rounded-full ${showEqualizer ? 'text-cyan-300' : 'text-gray-400'}`}><SlidersHorizontal size={18} /></button>
            <div className="items-center gap-2 hidden sm:flex">
              <VolumeIcon size={20} />
              <input type="range" min="0" max="100" value={volume} onChange={(e) => onVolumeChange(Number(e.target.value))} className="w-24 h-1 bg-gray-700 rounded-full appearance-none accent-cyan-400" />
            </div>
          </div>
        </div>
      </div>
    </motion.footer>
  );
}