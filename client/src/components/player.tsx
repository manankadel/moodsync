"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { Play, Pause, SkipBack, SkipForward, Volume1, Volume2, VolumeX, SlidersHorizontal, Mic } from "lucide-react";
import BeatVisualizer from "./visualizer";
import Equalizer from "./Equalizer";
import Lyrics from "./Lyrics";

interface PlayerProps {
  albumArt: string | null;
  title: string;
  artist: string;
  isPlaying: boolean;
  volume: number;
  onPlayPause: () => void;
  onNext: () => void;
  onPrev: () => void;
  onVolumeChange: (volume: number) => void;
}

export default function Player({ albumArt, title, artist, isPlaying, volume, onPlayPause, onNext, onPrev, onVolumeChange }: PlayerProps) {
  const VolumeIcon = volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;
  const [showEqualizer, setShowEqualizer] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);

  return (
    <motion.footer initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1, ease: "easeOut", delay: 0.5 }} className="fixed bottom-0 left-0 right-0 z-50 h-28 bg-gradient-to-t from-black via-black/80 to-transparent">
      <div className="mx-auto max-w-screen-lg h-full px-4 sm:px-8 flex items-center justify-center relative">
        <AnimatePresence>
            {showLyrics && <Lyrics />}
        </AnimatePresence>
        
        <BeatVisualizer />
        <div className="relative z-10 grid grid-cols-[1fr_auto_1fr] items-center gap-4 sm:gap-8 w-full">
          <div className="flex items-center gap-4 min-w-0">
            <div className="relative h-14 w-14 sm:h-16 sm:w-16 flex-shrink-0 rounded-lg bg-gray-800 shadow-lg">{albumArt && <Image src={albumArt} alt={title} layout="fill" objectFit="cover" className="rounded-lg"/>}</div>
            <div className="min-w-0 hidden sm:block"><p className="font-semibold text-lg text-white truncate">{title}</p><p className="text-sm font-light text-gray-400 truncate">{artist}</p></div>
          </div>
          <div className="flex items-center gap-4 sm:gap-6">
            <button onClick={onPrev} className="text-gray-400 hover:text-white transition-colors"><SkipBack className="w-6 h-6 sm:w-7 sm:h-7" /></button>
            <button onClick={onPlayPause} className="flex h-14 w-14 sm:h-16 sm:w-16 items-center justify-center rounded-full bg-white text-black transition-transform hover:scale-105 shadow-2xl">{isPlaying ? <Pause className="w-7 h-7 sm:w-8 sm:h-8" /> : <Play className="w-7 h-7 sm:w-8 sm:h-8 translate-x-0.5"/>}</button>
            <button onClick={onNext} className="text-gray-400 hover:text-white transition-colors"><SkipForward className="w-6 h-6 sm:w-7 sm:h-7" /></button>
          </div>
          <div className="relative flex items-center justify-end gap-2 sm:gap-3">
            <AnimatePresence>
                {showEqualizer && <Equalizer />}
            </AnimatePresence>
            
            <button onClick={() => setShowLyrics(!showLyrics)} className={`p-2 rounded-full transition-colors ${showLyrics ? 'bg-purple-400/20 text-purple-300' : 'text-gray-400 hover:text-white'}`}>
                <Mic size={20} />
            </button>
            
            <button onClick={() => setShowEqualizer(!showEqualizer)} className={`p-2 rounded-full transition-colors ${showEqualizer ? 'bg-cyan-400/20 text-cyan-300' : 'text-gray-400 hover:text-white'}`}>
                <SlidersHorizontal size={20} />
            </button>
            <VolumeIcon size={20} className="text-gray-400" />
            <input type="range" min="0" max="100" value={volume} onChange={(e) => onVolumeChange(Number(e.target.value))} className="w-20 sm:w-24 h-1 bg-gray-700 rounded-full appearance-none cursor-pointer accent-cyan-400" />
          </div>
        </div>
      </div>
    </motion.footer>
  );
}