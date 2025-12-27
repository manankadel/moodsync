// FILE 4: page.tsx
// Location: /path/to/moodsync/client/src/app/room/[room_code]/page.tsx
// Copy ALL of this and replace your current page.tsx

"use client";

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Player from '@/components/player';
import { useRoomStore } from '@/lib/room-store';
import { shallow } from 'zustand/shallow';
import { Crown, Copy, Link as LinkIcon, Upload, WifiOff, Search, Music2, Loader2, PlusCircle, Sparkles, User, Settings, ToggleLeft, ToggleRight, PlayCircle } from 'lucide-react';
import FileUploadModal from '@/components/FileUploadModal';
import SearchModal from '@/components/SearchModal';
import Lyrics from '@/components/Lyrics';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

const MemoizedPlayer = memo(Player);

const UsernameModal = ({ onSubmit }: { onSubmit: (name: string) => void }) => {
    const [name, setName] = useState('');
    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4 backdrop-blur-md">
          <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-zinc-900/90 border border-white/10 rounded-2xl p-8 w-full max-w-sm shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-cyan-500 via-purple-500 to-pink-500" />
            <h2 className="text-3xl font-bold mb-2 text-center text-white">Identity</h2>
            <p className="text-gray-400 text-center mb-6 text-sm">Who is joining the session?</p>
            <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(name.trim()); }} className="flex flex-col gap-4">
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Display Name" className="w-full rounded-xl border-white/10 bg-black/20 p-4 text-center text-white text-lg outline-none focus:border-cyan-400 focus:bg-black/40 transition-all placeholder:text-gray-600" autoFocus />
              <button type="submit" disabled={!name.trim()} className="w-full py-4 rounded-xl bg-white text-black font-bold text-lg hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  Enter Space
              </button>
            </form>
          </motion.div>
        </motion.div>
    );
};

const SettingsModal = ({ onClose }: { onClose: () => void }) => {
    const { isCollaborative, toggleCollaborative } = useRoomStore();
    return (
        <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-zinc-900 border border-white/10 rounded-2xl p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
                <h3 className="text-xl font-bold mb-6 flex items-center gap-2"><Settings size={20} /> Room Settings</h3>
                <div className="flex items-center justify-between p-4 bg-white/5 rounded-xl">
                    <div>
                        <p className="font-semibold">Collaborative Queue</p>
                        <p className="text-xs text-gray-400">Allow guests to add songs</p>
                    </div>
                    <button onClick={() => toggleCollaborative(!isCollaborative)} className={`transition-colors ${isCollaborative ? 'text-cyan-400' : 'text-gray-500'}`}>
                        {isCollaborative ? <ToggleRight size={32} /> : <ToggleLeft size={32} />}
                    </button>
                </div>
            </div>
        </div>
    );
};

const InteractionOverlay = () => {
    const { needsInteraction, setNeedsInteraction, audioElement } = useRoomStore();
    const [isAttempting, setIsAttempting] = useState(false);
    
    if (!needsInteraction) return null;
    
    const handleUnlock = async () => {
        if (isAttempting || !audioElement) return;
        
        setIsAttempting(true);
        
        try {
            const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
            
            if (audioCtx.state === 'suspended') {
                await audioCtx.resume();
            }
            
            if (audioElement && audioElement.src) {
                try {
                    const playPromise = audioElement.play();
                    if (playPromise instanceof Promise) {
                        await playPromise;
                        setTimeout(() => {
                            audioElement.pause();
                        }, 100);
                    }
                } catch (e: any) {
                    if (e.name !== 'AbortError') {
                        console.error('[TAP] Play error:', e);
                    }
                }
            } else {
                console.log('[TAP] No audio source, unlocking context only');
            }
            
            setNeedsInteraction(false);
        } catch (error) {
            console.error('[TAP] Unlock error:', error);
            setNeedsInteraction(false);
        } finally {
            setIsAttempting(false);
        }
    };

    return (
        <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center p-4 text-center"
        >
            <motion.button 
                onClick={handleUnlock}
                disabled={isAttempting}
                className="flex flex-col items-center gap-4 cursor-pointer active:scale-95 transition-transform disabled:opacity-50"
            >
                <PlayCircle size={80} className="text-cyan-400 animate-pulse" />
                <h2 className="text-2xl font-bold text-white">Tap to Join Session</h2>
                <p className="text-gray-400">Audio playback needs your permission</p>
                {isAttempting && <Loader2 size={24} className="text-cyan-400 animate-spin" />}
            </motion.button>
        </motion.div>
    );
};

const DisconnectedOverlay = () => (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="fixed bottom-32 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-red-500/10 border border-red-500/20 text-red-200 px-6 py-3 rounded-full backdrop-blur-md shadow-xl">
        <WifiOff size={18} className="animate-pulse" /><span className="font-medium text-sm">Reconnecting...</span>
    </motion.div>
);

const RoomSidebar = memo(function RoomSidebar({ roomCode, onOpenUpload, onOpenSearch, onOpenSettings }: { roomCode: string, onOpenUpload: () => void, onOpenSearch: () => void, onOpenSettings: () => void }) {
    const { users, isAdmin, isCollaborative } = useRoomStore(state => ({ users: state.users, isAdmin: state.isAdmin, isCollaborative: state.isCollaborative }), shallow);
    const [copied, setCopied] = useState(false);
    
    const copyToClipboard = () => {
        navigator.clipboard.writeText(`${window.location.protocol}//${window.location.host}/room/${roomCode}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const canAdd = isAdmin || isCollaborative;

    return (
        <aside className="hidden lg:flex flex-col gap-8 sticky top-8 h-[calc(100vh-8rem)]">
            <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}}>
                    <div className="flex justify-between items-center mb-3">
                        <h2 className="text-xs font-bold tracking-widest text-gray-500 uppercase">Session</h2>
                        {isAdmin && <button onClick={onOpenSettings} className="p-1 hover:bg-white/10 rounded"><Settings size={14} className="text-gray-400" /></button>}
                    </div>
        <div className="flex items-center gap-2 p-1 rounded-xl bg-white/5 border border-white/10 pr-2 group hover:border-white/20 transition-colors">
            <div className="p-3 rounded-lg bg-black/40 text-gray-400 group-hover:text-white"><LinkIcon size={16} /></div>
            <span className="font-mono text-sm font-semibold text-gray-300 truncate select-all tracking-wider flex-1">{roomCode}</span>
            <button onClick={copyToClipboard} className="p-2 rounded-lg hover:bg-white/10 transition-colors"><Copy size={16} className={copied ? "text-cyan-400" : "text-gray-500"} /></button>
        </div>
        </motion.div>
        
        <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}} className="flex-1 flex flex-col min-h-0">
            <h2 className="text-xs font-bold tracking-widest text-gray-500 mb-3 uppercase flex justify-between">
                <span>Listeners</span><span className="bg-white/10 px-2 rounded-full text-white">{users.length}</span>
            </h2>
            <div className="space-y-2 overflow-y-auto pr-2 custom-scrollbar">
                {users.map((user, idx) => (
                    <div key={idx} className="flex items-center gap-3 p-2 rounded-lg bg-white/5 border border-transparent hover:border-white/10 transition-colors">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${user.isAdmin ? 'bg-amber-500/20 text-amber-400' : 'bg-gray-800 text-gray-400'}`}>
                            {user.isAdmin ? <Crown size={14} /> : <User size={14} />}
                        </div>
                        <span className="text-sm truncate text-gray-200 font-medium">{user.name}</span>
                    </div>
                ))}
            </div>
        </motion.div>
        
        {canAdd && (
            <motion.div initial={{opacity: 0, x: 20}} animate={{opacity: 1, x: 0}} className="space-y-3">
                <button onClick={onOpenSearch} className="group w-full p-4 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold flex items-center justify-center gap-3 transition-all shadow-lg shadow-cyan-900/20 hover:scale-[1.02] active:scale-[0.98]">
                    <Search size={20} className="group-hover:scale-110 transition-transform" /> <span>Add Song</span>
                </button>
                <button onClick={onOpenUpload} className="w-full p-4 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-gray-300 font-medium flex items-center justify-center gap-2 transition-colors hover:text-white">
                    <Upload size={18} /> Upload File
                </button>
            </motion.div>
        )}
        </aside>
    );
});