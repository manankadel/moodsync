"use client";
import { motion } from "framer-motion";

export default function Navigation() {
  return (
    <motion.nav 
      initial={{ y: -100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.8, ease: "circOut", delay: 0.5 }}
      className="fixed top-0 left-0 right-0 z-50"
    >
      <div className="flex items-center justify-between max-w-7xl mx-auto px-8 py-6">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <svg width="28" height="28" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <motion.path 
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: 1, delay: 1 }}
              d="M25 75V25L75 25V75L25 25L75 75" 
              stroke="white" 
              strokeWidth="8"
            />
          </svg>
          <span className="text-xl font-semibold text-white tracking-wide">MoodSync</span>
        </div>
        
        {/* Nav Links (future use) */}
        <div className="hidden md:flex items-center gap-8 text-sm text-gray-400">
          <a href="#" className="hover:text-white transition-colors">Features</a>
          <a href="#" className="hover:text-white transition-colors">How It Works</a>
        </div>
      </div>
    </motion.nav>
  );
}