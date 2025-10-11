"use client";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Play, Pause, SkipBack, SkipForward, Volume1, Volume2, VolumeX, SlidersHorizontal } from "lucide-react";
import BeatVisualizer from "./visualizer";
import Equalizer from "./Equalizer";
import { useRoomStore } from "@/lib/room-store";

// This is the clean, final interface.
interface PlayerProps {
  title: string;
  artist: string;
  isPlaying: boolean;
  volume: number;
  duration: number;
  onPlayPause: () => void;
  onNext: () => void;
  onPrev: () => void;
  onVolumeChange: (volume: number) => void;
}

export default function Player({ title, artist, isPlaying, volume, duration, onPlayPause, onNext, onPrev, onVolumeChange }: PlayerProps) {
  const VolumeIcon = volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;
  const [showEqualizer, setShowEqualizer] = useState(false);

  // All state is correctly pulled from the central store.
  const { currentTime, isAdmin, isCollaborative, isSeeking, setIsSeeking, _emitStateUpdate, audioElement } = useRoomStore();
  const [seekValue, setSeekValue] = useState(0);
  const canControl = isAdmin || isCollaborative;

  useEffect(() => {
    if (!isSeeking) {
      setSeekValue(duration > 0 ? (currentTime / duration) * 100 : 0);
    }
  }, [currentTime, duration, isSeeking]);

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canControl) return;
    setSeekValue(Number(e.target.value));
  };

  const handleSeekEnd = (e: React.MouseEvent<HTMLInputElement>) => {
    if (!canControl || !audioElement) return;
    const seekTime = (Number(e.currentTarget.value) / 100) * duration;
    audioElement.currentTime = seekTime;
    setTimeout(() => {
      _emitStateUpdate({ currentTime: seekTime });
      setIsSeeking(false);
    }, 150);
  };

  const formatTime = (seconds: number) => {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${min}:${sec}`;
  };

  return (
    <motion.footer initial={{ y: 100 }} animate={{ y: 0 }} transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }} className="fixed bottom-0 left-0 right-0 z-50 h-28 bg-black/70 backdrop-blur-xl border-t border-white/10">
      <div className="mx-auto max-w-screen-lg h-full px-4 sm:px-8 flex items-center justify-center relative">
        <BeatVisualizer />
        <div className="relative z-10 grid grid-cols-[1fr_2fr_1fr] items-center gap-4 sm:gap-8 w-full">
          {/* Left Side */}
          <div className="flex items-center gap-4 min-w-0">
            <div className="relative h-14 w-14 sm:h-16 sm:w-16 flex-shrink-0 rounded-lg bg-gray-800 shadow-lg overflow-hidden">
                <div className="flex items-center justify-center h-full text-gray-500 text-2xl">🎵</div>
            </div>
            <div className="min-w-0 hidden sm:block"><p className="font-semibold text-lg text-white truncate">{title}</p><p className="font-light text-sm text-gray-400 truncate">{artist}</p></div>
          </div>
          
          {/* Center Controls */}
          <div className="flex flex-col items-center gap-2 w-full">
            <div className="flex items-center gap-4 sm:gap-6">
              <button onClick={onPrev} disabled={!canControl} className="text-gray-400 hover:text-white disabled:opacity-50"><SkipBack className="w-6 h-6 sm:w-7 sm:h-7" /></button>
              <button onClick={onPlayPause} disabled={!canControl} className="flex h-14 w-14 sm:h-16 sm:w-16 items-center justify-center rounded-full bg-white text-black transition-transform hover:scale-105 shadow-2xl disabled:opacity-50">{isPlaying ? <Pause className="w-7 h-7 sm:w-8 sm:h-8" /> : <Play className="w-7 h-7 sm:w-8 sm:h-8 translate-x-0.5"/>}</button>
              <button onClick={onNext} disabled={!canControl} className="text-gray-400 hover:text-white disabled:opacity-50"><SkipForward className="w-6 h-6 sm:w-7 sm:h-7" /></button>
            </div>
            <div className="w-full flex items-center gap-2 text-xs text-gray-400">
                <span>{formatTime(currentTime)}</span>
                <input type="range" min="0" max="100" value={seekValue} disabled={!canControl || duration === 0} onMouseDown={() => canControl && setIsSeeking(true)} onMouseUp={handleSeekEnd} onChange={handleSeekChange} className="w-full h-1 bg-gray-700 rounded-full appearance-none cursor-pointer accent-cyan-400 disabled:opacity-50"/>
                <span>{formatTime(duration)}</span>
            </div>
          </div>
          
          {/* Right Side: Cleaned with no dead buttons */}
          <div className="relative flex items-center justify-end gap-1 sm:gap-2">
            <AnimatePresence>{showEqualizer && <Equalizer />}</AnimatePresence>
            <button onClick={() => setShowEqualizer(!showEqualizer)} className={`p-2 rounded-full ${showEqualizer ? 'bg-cyan-400/20 text-cyan-300' : 'text-gray-400 hover:text-white'}`}><SlidersHorizontal size={18} /></button>
            <VolumeIcon size={20} className="text-gray-400 ml-2" />
            <input type="range" min="0" max="100" value={volume} onChange={(e) => onVolumeChange(Number(e.target.value))} className="w-20 sm:w-24 h-1 bg-gray-700 rounded-full appearance-none accent-cyan-400" />
          </div>
        </div>
      </div>
    </motion.footer>
  );
}