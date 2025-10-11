"use client";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import WaveButton from "./ui/WaveButton";
import { ArrowLeft } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

export default function UIPanel() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [step, setStep] = useState<number>(0);
  const [joinCode, setJoinCode] = useState('');

  const handleCreateRoom = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`${API_URL}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}), // No mood needed anymore
      });
      if (!response.ok) throw new Error('Failed to create room');
      const data = await response.json();
      router.push(`/room/${data.room_code}`);
    } catch (error) {
      console.error("Error creating room:", error);
      alert("Could not create a room. Please try again.");
      setIsLoading(false);
    }
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (joinCode.trim()) router.push(`/room/${joinCode.trim().toUpperCase()}`);
  };
  
  const resetState = () => setStep(0);

  return (
    <motion.div layout transition={{ duration: 0.5, type: "spring", bounce: 0.2 }} className="w-full max-w-md">
      <div className="relative rounded-2xl bg-black/40 p-8 shadow-2xl backdrop-blur-xl border border-white/10">
        <AnimatePresence mode="wait">
          {step === 0 && (
            <motion.div key="step0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col gap-4">
                <WaveButton text={isLoading ? "Architecting..." : "Create a Sonic Space"} onClick={handleCreateRoom} disabled={isLoading} />
                <button onClick={() => setStep(2)} className="w-full px-8 py-4 text-lg font-bold text-gray-400 hover:text-white transition-colors">Join a Space</button>
            </motion.div>
          )}
          {step === 2 && (
            <motion.div key="step2" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <button onClick={resetState} className="absolute top-4 left-4 flex items-center gap-2 text-gray-400 hover:text-white transition-colors text-sm"><ArrowLeft size={16}/> Back</button>
              <h2 className="text-2xl font-semibold text-center text-white mb-6 pt-4">Join an Existing Space</h2>
              <form className="flex flex-col gap-3" onSubmit={handleJoinRoom}>
                <input type="text" placeholder="ENTER ROOM CODE" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} className="w-full rounded-md border border-white/10 bg-white/5 px-5 py-4 text-center tracking-widest font-mono text-white outline-none focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-400/30 transition-all"/>
                <WaveButton text="Enter Space" type="submit" disabled={!joinCode.trim()} />
              </form>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}