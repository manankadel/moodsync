"use client";
import { useEffect, useState, useRef } from 'react';
import { useRoomStore } from '@/lib/room-store';
import { motion } from 'framer-motion';

// Helper to parse LRC format: [00:12.50] Hello World -> { time: 12.5, text: "Hello World" }
const parseLRC = (lrc: string) => {
    const regex = /^\[(\d{2}):(\d{2}(?:\.\d+)?)\](.*)/;
    const lines = lrc.split('\n');
    const result = [];
    for (const line of lines) {
        const match = line.match(regex);
        if (match) {
            const min = parseInt(match[1]);
            const sec = parseFloat(match[2]);
            const text = match[3].trim();
            if (text) result.push({ time: min * 60 + sec, text });
        }
    }
    return result;
};

export default function Lyrics() {
    const { playlist, currentTrackIndex, currentTime } = useRoomStore();
    const currentTrack = playlist[currentTrackIndex];
    const [lines, setLines] = useState<{time: number, text: string}[]>([]);
    const [activeLine, setActiveLine] = useState(0);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (currentTrack?.lyrics) {
            setLines(parseLRC(currentTrack.lyrics));
        } else {
            setLines([]);
        }
    }, [currentTrack]);

    useEffect(() => {
        // Find current active line
        const index = lines.findIndex((line, i) => {
            const nextLine = lines[i + 1];
            return currentTime >= line.time && (!nextLine || currentTime < nextLine.time);
        });
        if (index !== -1) {
            setActiveLine(index);
            // Auto scroll
            if (scrollRef.current) {
                const el = scrollRef.current.children[index] as HTMLElement;
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }
    }, [currentTime, lines]);

    if (!currentTrack?.lyrics || lines.length === 0) return (
        <div className="h-full flex items-center justify-center text-gray-500/50 text-2xl font-bold tracking-widest uppercase select-none">
            No Lyrics
        </div>
    );

    return (
        <div className="h-full w-full overflow-hidden relative mask-image-gradient">
            <div className="absolute inset-0 pointer-events-none bg-gradient-to-b from-black/80 via-transparent to-black/80 z-10" />
            <div ref={scrollRef} className="h-full overflow-y-auto px-4 py-[50vh] no-scrollbar space-y-6 text-center">
                {lines.map((line, i) => (
                    <motion.p 
                        key={i}
                        animate={{ 
                            scale: i === activeLine ? 1.1 : 0.95,
                            opacity: i === activeLine ? 1 : 0.3,
                            filter: i === activeLine ? 'blur(0px)' : 'blur(1px)',
                            color: i === activeLine ? '#ffffff' : '#9ca3af'
                        }}
                        className="text-xl md:text-3xl font-bold transition-all duration-300"
                    >
                        {line.text}
                    </motion.p>
                ))}
            </div>
        </div>
    );
}