"use client";
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Plus, X, Loader2, Music, AlertCircle } from 'lucide-react';
import { useRoomStore } from '@/lib/room-store';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

interface SearchResult { 
  id: string; 
  title: string; 
  artist: string; 
  thumbnail: string; 
}

export default function SearchModal({ isOpen, onClose, roomCode }: { isOpen: boolean; onClose: () => void; roomCode: string }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { isAdmin, isCollaborative, userId } = useRoomStore();

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    
    setError(null);
    setIsSearching(true);
    
    try {
      const res = await fetch(`${API_URL}/api/yt-search`, {
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      
      if (!res.ok) {
        setError('Search failed. Please try again.');
        setResults([]);
        return;
      }
      
      const data = await res.json();
      setResults(data.results || []);
      
      if (!data.results || data.results.length === 0) {
        setError('No results found. Try a different search.');
      }
    } catch (error) {
      console.error('Search error:', error);
      setError('Network error. Please check your connection.');
      setResults([]);
    } finally { 
      setIsSearching(false); 
    }
  };

  const addTrack = async (track: SearchResult) => {
    if (!isAdmin && !isCollaborative) {
      setError('Only the host or collaborative mode can add songs.');
      return;
    }

    setAddingId(track.id);
    setError(null);
    
    try {
      const response = await fetch(`${API_URL}/api/room/${roomCode}/add-yt`, {
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: track.id,
          title: track.title,
          artist: track.artist,
          thumbnail: track.thumbnail,
          uuid: userId
        })
      });

      if (response.status === 403) {
        setError('Permission denied. You need to be the host or enable collaborative mode.');
        setAddingId(null);
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.error || 'Failed to add song. Server might be busy.');
        setAddingId(null);
        return;
      }

      // Success
      onClose();
      setResults([]);
      setQuery('');
      setError(null);
    } catch (error) {
      console.error('Add track error:', error);
      setError('Failed to add song. Please try again.');
      setAddingId(null);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div 
          initial={{ opacity: 0 }} 
          animate={{ opacity: 1 }} 
          exit={{ opacity: 0 }} 
          className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-start justify-center p-4 pt-20" 
          onClick={onClose}
        >
          <motion.div 
            initial={{ scale: 0.95, opacity: 0 }} 
            animate={{ scale: 1, opacity: 1 }} 
            exit={{ scale: 0.95, opacity: 0 }} 
            className="bg-zinc-900 border border-white/10 rounded-xl w-full max-w-lg flex flex-col shadow-2xl overflow-hidden" 
            onClick={e => e.stopPropagation()}
          >
            
            {/* Header */}
            <div className="p-4 border-b border-white/10 flex gap-3 items-center bg-black/40">
              <Search className="text-gray-400" size={20} />
              <form onSubmit={handleSearch} className="flex-1">
                <input 
                  autoFocus 
                  value={query} 
                  onChange={e => setQuery(e.target.value)} 
                  placeholder="Search YouTube..." 
                  className="w-full bg-transparent text-white outline-none placeholder:text-gray-500 text-lg" 
                />
              </form>
              <button onClick={onClose}><X className="text-gray-400 hover:text-white" /></button>
            </div>

            {/* Error Message */}
            <AnimatePresence>
              {error && (
                <motion.div 
                  initial={{ opacity: 0, y: -10 }} 
                  animate={{ opacity: 1, y: 0 }} 
                  exit={{ opacity: 0, y: -10 }}
                  className="mx-2 mt-2 p-3 rounded-lg bg-red-500/20 border border-red-500/50 flex items-start gap-2"
                >
                  <AlertCircle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-red-200 text-sm">{error}</p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Results */}
            <div className="max-h-[60vh] overflow-y-auto p-2">
              {isSearching ? (
                <div className="flex flex-col items-center justify-center p-8 gap-3">
                  <Loader2 className="animate-spin text-cyan-400" size={32} />
                  <p className="text-gray-400 text-sm">Searching...</p>
                </div>
              ) : results.length === 0 ? (
                <div className="text-center p-8 text-gray-500">
                  <Music size={48} className="mx-auto mb-2 opacity-20" />
                  <p className="text-sm">
                    {query.trim() ? 'No results found' : 'Search for your favorite tracks'}
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  {results.map(r => (
                    <div 
                      key={r.id} 
                      className="flex items-center gap-3 p-3 hover:bg-white/5 rounded-lg group transition-colors"
                    >
                      <img 
                        src={r.thumbnail} 
                        className="h-12 w-12 rounded object-cover bg-gray-800" 
                        alt={r.title}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate text-white text-sm">{r.title}</p>
                        <p className="text-xs text-gray-400 truncate">{r.artist}</p>
                      </div>
                      <button 
                        onClick={() => addTrack(r)} 
                        disabled={!!addingId} 
                        className="p-2 bg-white/5 text-cyan-400 rounded-full hover:bg-cyan-500 hover:text-white transition-all disabled:opacity-50 flex-shrink-0"
                      >
                        {addingId === r.id ? (
                          <Loader2 size={20} className="animate-spin" />
                        ) : (
                          <Plus size={20} />
                        )}
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