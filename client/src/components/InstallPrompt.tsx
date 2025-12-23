/* client/src/components/InstallPrompt.tsx */
"use client";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Share, PlusSquare, X } from "lucide-react";

export default function InstallPrompt() {
  const [isIOS, setIsIOS] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    const userAgent = window.navigator.userAgent.toLowerCase();
    const isIphone = /iphone|ipad|ipod/.test(userAgent);
    setIsIOS(isIphone);
    setIsStandalone(window.matchMedia('(display-mode: standalone)').matches);
    
    // Show prompt if on iOS and not yet installed
    if (isIphone && !window.matchMedia('(display-mode: standalone)').matches) {
        // Wait a bit before showing
        const timer = setTimeout(() => setShowPrompt(true), 2000);
        return () => clearTimeout(timer);
    }
  }, []);

  if (!showPrompt) return null;

  return (
    <AnimatePresence>
      <motion.div 
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 100, opacity: 0 }}
        className="fixed bottom-0 left-0 right-0 z-[60] p-4 pb-8 bg-zinc-900 border-t border-white/10 shadow-2xl"
      >
        <div className="max-w-md mx-auto flex flex-col gap-4">
            <div className="flex justify-between items-start">
                <h3 className="text-white font-bold text-lg">Install for Best Experience</h3>
                <button onClick={() => setShowPrompt(false)}><X className="text-gray-400" /></button>
            </div>
            <p className="text-gray-300 text-sm">
                To keep music playing in the background on iPhone, you must add this app to your home screen.
            </p>
            <div className="flex items-center gap-4 text-sm font-medium text-cyan-400">
                <span className="flex items-center gap-2">1. Tap Share <Share size={16} /></span>
                <span className="flex items-center gap-2">2. Add to Home Screen <PlusSquare size={16} /></span>
            </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}