"use client";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import WaveButton from "./ui/WaveButton"; // CORRECT IMPORT
import { ArrowLeft, Check } from "lucide-react";

const genres = {
  'House': ['deep-house', 'house', 'progressive-house', 'tech-house'],
  'Techno': ['techno', 'minimal-techno', 'detroit-techno'],
  'Electronic': ['electronica', 'edm', 'electro', 'dubstep'],
  'Sets': ['boiler-room', 'live-techno-set', 'deep-house-mix'],
  'Indie': ['indie', 'indie-pop', 'alternative'],
};
type GenreCategory = keyof typeof genres;

// Helper components are defined correctly
const CategoryButton = ({ text, onClick, isSelected }: { text: string; onClick: () => void; isSelected: boolean; }) => (
  <button onClick={onClick} className={`p-4 rounded-lg transition-all duration-300 text-center text-white w-full ${isSelected ? 'bg-cyan-400/20 border border-cyan-400' : 'bg-white/5 border border-transparent hover:bg-white/10'}`}>
    {text}
  </button>
);

const GenreTag = ({ text, onClick, isSelected }: { text: string; onClick: () => void; isSelected: boolean; }) => (
  <button onClick={onClick} className={`px-4 py-2 text-sm rounded-full flex items-center gap-2 transition-all duration-300 ${isSelected ? 'bg-cyan-400 text-black font-semibold' : 'bg-white/10 text-gray-300 hover:bg-white/20'}`}>
    {isSelected && <Check size={16} />}
    {text.replace(/-/g, ' ')}
  </button>
);

export default function UIPanel() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [step, setStep] = useState<number>(0);
  const [selectedCategory, setSelectedCategory] = useState<GenreCategory | null>(null);
  const [selectedGenre, setSelectedGenre] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');

  const handleCreateRoom = async () => {
    if (!selectedGenre) return;
    setIsLoading(true);
    try {
      const response = await fetch('http://localhost:5001/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mood: selectedGenre }),
      });
      if (!response.ok) throw new Error('Failed to create room');
      const data = await response.json();
      router.push(`/room/${data.room_code}`);
    } catch (error) {
      console.error("Error creating room:", error);
      alert("Could not create a room.");
      setIsLoading(false);
    }
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (joinCode.trim()) router.push(`/room/${joinCode.trim().toUpperCase()}`);
  };
  
  const resetState = () => {
      setStep(0);
      setSelectedCategory(null);
      setSelectedGenre(null);
  };

  return (
    <motion.div layout transition={{ duration: 0.5, type: "spring", bounce: 0.2 }} className="w-full max-w-md">
      <div className="relative rounded-2xl bg-black/40 p-8 shadow-2xl backdrop-blur-xl border border-white/10">
        <AnimatePresence mode="wait">
          {/* STEP 0: Main Menu */}
          {step === 0 && (
            <motion.div key="step0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col gap-4">
                <WaveButton text="Create a Sonic Space" onClick={() => setStep(1)} />
                <button onClick={() => setStep(2)} className="w-full px-8 py-4 text-lg font-bold text-gray-400 hover:text-white transition-colors">Join a Space</button>
            </motion.div>
          )}

          {/* STEP 1: Create Room Flow */}
          {step === 1 && (
            <motion.div key="step1" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <button onClick={resetState} className="absolute top-4 left-4 flex items-center gap-2 text-gray-400 hover:text-white transition-colors text-sm"><ArrowLeft size={16}/> Back</button>
              <h2 className="text-2xl font-semibold text-center text-white mb-6 pt-4">Select a Category</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
                {(Object.keys(genres) as GenreCategory[]).map((cat) => (
                  <CategoryButton key={cat} text={cat} onClick={() => setSelectedCategory(cat)} isSelected={selectedCategory === cat} />
                ))}
              </div>
              <AnimatePresence>
                {selectedCategory && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} className="overflow-hidden">
                    <h3 className="text-lg font-medium text-center text-gray-300 my-4">Specify the Vibe</h3>
                    <div className="flex flex-wrap justify-center gap-2 mb-6">
                      {genres[selectedCategory].map(genre => (
                        <GenreTag key={genre} text={genre} onClick={() => setSelectedGenre(genre)} isSelected={selectedGenre === genre} />
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              <WaveButton text={isLoading ? "Architecting..." : "Launch Space"} onClick={handleCreateRoom} disabled={!selectedGenre || isLoading} />
            </motion.div>
          )}

          {/* STEP 2: Join Room Flow */}
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