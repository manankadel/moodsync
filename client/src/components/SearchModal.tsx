"use client";
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Plus, X, Loader2, Music } from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

interface SearchResult { id: string; title: string; artist: string; thumbnail: string; }

export default function SearchModal({ isOpen, onClose, roomCode }: { isOpen: boolean; onClose: () => void; roomCode: string }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setIsSearching(true);
    try {
      const res = await fetch(`${API_URL}/api/yt-search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      const data = await res.json();
      setResults(data.results || []);
    } catch (error) {
      console.error(error);
    } finally { setIsSearching(false); }
  };

  const addTrack = async (track: SearchResult) => {
    setAddingId(track.id);
    try {
      // Use the specific YT endpoint
      await fetch(`${API_URL}/api/room/${roomCode}/add-yt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(track)
      });
      onClose();
      setResults([]);
      setQuery('');
    } catch (error) {
      alert("Failed to add track. Server might be busy downloading.");
    } finally { setAddingId(null); }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-start justify-center p-4 pt-20" onClick={onClose}>
          <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }} className="bg-zinc-900 border border-white/10 rounded-xl w-full max-w-lg flex flex-col shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            
            <div className="p-4 border-b border-white/10 flex gap-3 items-center bg-black/40">
              <Search className="text-gray-400" size={20} />
              <form onSubmit={handleSearch} className="flex-1">
                <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search YouTube..." className="w-full bg-transparent text-white outline-none placeholder:text-gray-500 text-lg" />
              </form>
              <button onClick={onClose}><X className="text-gray-400 hover:text-white" /></button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto p-2">
              {isSearching ? (
                  <div className="flex justify-center p-8"><Loader2 className="animate-spin text-cyan-400" size={32} /></div>
              ) : results.length === 0 ? (
                  <div className="text-center p-8 text-gray-500">
                      <Music size={48} className="mx-auto mb-2 opacity-20" />
                      <p>Search for your favorite tracks</p>
                  </div>
              ) : (
                  <div className="space-y-1">
                      {results.map(r => (
                        <div key={r.id} className="flex items-center gap-3 p-3 hover:bg-white/5 rounded-lg group transition-colors">
                          <img src={r.thumbnail} className="h-12 w-12 rounded object-cover bg-gray-800" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate text-white">{r.title}</p>
                            <p className="text-sm text-gray-400 truncate">{r.artist}</p>
                          </div>
                          <button onClick={() => addTrack(r)} disabled={!!addingId} className="p-2 bg-white/5 text-cyan-400 rounded-full hover:bg-cyan-500 hover:text-white transition-all disabled:opacity-50">
                            {addingId === r.id ? <Loader2 size={20} className="animate-spin" /> : <Plus size={20} />}
                          </button>
                        </div>
                      ))}
                  </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}