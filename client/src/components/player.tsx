"use client";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { Play, Pause, SkipBack, SkipForward, Volume1, Volume2, VolumeX, SlidersHorizontal, Mic, Timer } from "lucide-react";
import BeatVisualizer from "./visualizer";
import Equalizer from "./Equalizer";
import Lyrics from "./Lyrics";
import LatencyControl from "./LatencyControl";
import { useRoomStore } from "@/lib/room-store";

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
  const [showLatencyControl, setShowLatencyControl] = useState(false);

  const { player, audioElement, playlist, currentTrackIndex, currentTime, isAdmin, isCollaborative, isSeeking, setIsSeeking } = useRoomStore();
  const [duration, setDuration] = useState(0);
  const [seekValue, setSeekValue] = useState(0);

  const currentTrack = playlist[currentTrackIndex];
  const canControl = isAdmin || isCollaborative;

  useEffect(() => {
    let interval: NodeJS.Timeout | undefined;
    const updateDuration = () => {
      try {
        let d = 0;
        if (currentTrack?.isUpload && audioElement) {
          d = audioElement.duration;
        } else if (player && typeof player.getDuration === 'function') {
          d = player.getDuration();
        }
        if (!isNaN(d) && d > 0) {
          setDuration(d);
          if (interval) clearInterval(interval);
        }
      } catch (e) { /* Player might not be ready */ }
    };
    
    updateDuration();
    if(duration === 0) {
        interval = setInterval(updateDuration, 1000);
    }

    return () => {
        if(interval) clearInterval(interval)
    };
  }, [isPlaying, player, audioElement, currentTrack, currentTrackIndex, duration]);

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
    if (!canControl) return;
    const newSeekValue = Number((e.target as HTMLInputElement).value);
    const seekTime = (newSeekValue / 100) * duration;
    
    if (currentTrack?.isUpload && audioElement) {
      audioElement.currentTime = seekTime;
    } else if (player) {
      player.seekTo(seekTime, true);
    }
    
    setTimeout(() => {
      useRoomStore.getState()._emitStateUpdate({ currentTime: seekTime });
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
    <motion.footer initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1, ease: "easeOut", delay: 0.5 }} className="fixed bottom-0 left-0 right-0 z-50 h-28 bg-gradient-to-t from-black via-black/80 to-transparent">
      <div className="mx-auto max-w-screen-lg h-full px-4 sm:px-8 flex items-center justify-center relative">
        <AnimatePresence>{showLyrics && <Lyrics />}</AnimatePresence>
        <BeatVisualizer />
        <div className="relative z-10 grid grid-cols-[1fr_2fr_1fr] items-center gap-4 sm:gap-8 w-full">
          <div className="flex items-center gap-4 min-w-0">
            <div className="relative h-14 w-14 sm:h-16 sm:w-16 flex-shrink-0 rounded-lg bg-gray-800 shadow-lg overflow-hidden">
              {albumArt ? (
                <Image 
                  src={albumArt} 
                  alt={title} 
                  fill 
                  className="object-cover rounded-lg"
                  unoptimized
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                    const parent = e.currentTarget.parentElement;
                    if (parent) {
                      parent.innerHTML = '<div class="flex items-center justify-center h-full text-gray-500 text-2xl">🎵</div>';
                    }
                  }}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-gray-500 text-2xl">🎵</div>
              )}
            </div>
            <div className="min-w-0 hidden sm:block"><p className="font-semibold text-lg text-white truncate">{title}</p><p className="font-light text-sm text-gray-400 truncate">{artist}</p></div>
          </div>
          
          <div className="flex flex-col items-center gap-2 w-full">
            <div className="flex items-center gap-4 sm:gap-6">
              <button onClick={onPrev} disabled={!canControl} className="text-gray-400 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"><SkipBack className="w-6 h-6 sm:w-7 sm:h-7" /></button>
              <button onClick={onPlayPause} disabled={!canControl} className="flex h-14 w-14 sm:h-16 sm:w-16 items-center justify-center rounded-full bg-white text-black transition-transform hover:scale-105 shadow-2xl disabled:opacity-50 disabled:cursor-not-allowed disabled:scale-100">{isPlaying ? <Pause className="w-7 h-7 sm:w-8 sm:h-8" /> : <Play className="w-7 h-7 sm:w-8 sm:h-8 translate-x-0.5"/>}</button>
              <button onClick={onNext} disabled={!canControl} className="text-gray-400 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"><SkipForward className="w-6 h-6 sm:w-7 sm:h-7" /></button>
            </div>
            <div className="w-full flex items-center gap-2 text-xs text-gray-400">
                <span>{formatTime(currentTime)}</span>
                <input
                    type="range"
                    min="0"
                    max="100"
                    value={seekValue}
                    disabled={!canControl || duration === 0}
                    onMouseDown={() => canControl && setIsSeeking(true)}
                    onMouseUp={handleSeekEnd}
                    onChange={handleSeekChange}
                    className="w-full h-1 bg-gray-700 rounded-full appearance-none cursor-pointer accent-cyan-400 disabled:opacity-50"
                />
                <span>{formatTime(duration)}</span>
            </div>
          </div>

          <div className="relative flex items-center justify-end gap-2 sm:gap-3">
            <AnimatePresence>{showEqualizer && <Equalizer />}</AnimatePresence>
            <AnimatePresence>{showLatencyControl && <LatencyControl />}</AnimatePresence>
            
            <button onClick={() => setShowLyrics(!showLyrics)} className={`p-2 rounded-full transition-colors ${showLyrics ? 'bg-purple-400/20 text-purple-300' : 'text-gray-400 hover:text-white'}`}><Mic size={20} /></button>
            <button onClick={() => setShowEqualizer(!showEqualizer)} className={`p-2 rounded-full transition-colors ${showEqualizer ? 'bg-cyan-400/20 text-cyan-300' : 'text-gray-400 hover:text-white'}`}><SlidersHorizontal size={20} /></button>
            <button onClick={() => setShowLatencyControl(!showLatencyControl)} className={`p-2 rounded-full transition-colors ${showLatencyControl ? 'bg-purple-400/20 text-purple-300' : 'text-gray-400 hover:text-white'}`}><Timer size={20} /></button>
            
            <VolumeIcon size={20} className="text-gray-400" />
            <input type="range" min="0" max="100" value={volume} onChange={(e) => onVolumeChange(Number(e.target.value))} className="w-20 sm:w-24 h-1 bg-gray-700 rounded-full appearance-none cursor-pointer accent-cyan-400" />
          </div>
        </div>
      </div>
    </motion.footer>
  );
}