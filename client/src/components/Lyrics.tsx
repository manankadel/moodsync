"use client";

import { useRoomStore } from "@/lib/room-store";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";

const Lyrics = () => {
  const { lines, isLoading } = useRoomStore((state) => state.lyrics);
  const currentTime = useRoomStore((state) => state.currentTime);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Find the index of the currently active lyric line
  const activeLineIndex = lines.findIndex((line, index) => {
    const nextLine = lines[index + 1];
    return currentTime >= line.time && (!nextLine || currentTime < nextLine.time);
  });

  // Automatically scroll the active line into view
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (container && activeLineIndex >= 0) {
      const activeElement = container.children[activeLineIndex] as HTMLElement;
      if (activeElement) {
        const containerHeight = container.offsetHeight;
        const elementTop = activeElement.offsetTop;
        const elementHeight = activeElement.offsetHeight;
        
        container.scrollTo({
          top: elementTop - containerHeight / 2 + elementHeight / 2,
          behavior: "smooth",
        });
      }
    }
  }, [activeLineIndex]);

  const renderContent = () => {
    if (isLoading) {
      return <div className="text-gray-400">Loading Lyrics...</div>;
    }
    if (lines.length === 0) {
      return <div className="text-gray-400">Synchronized lyrics not available for this track.</div>;
    }
    return lines.map((line, index) => (
      <motion.p
        key={`${line.time}-${index}`}
        animate={{
          opacity: index === activeLineIndex ? 1 : 0.4,
          scale: index === activeLineIndex ? 1.05 : 1,
          x: index === activeLineIndex ? 5 : 0,
        }}
        transition={{ duration: 0.5, ease: "circOut" }}
        className="font-semibold text-2xl text-white transition-colors duration-300"
      >
        {line.text}
      </motion.p>
    ));
  };
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 50 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 50 }}
      transition={{ duration: 0.5, ease: "circOut" }}
      className="absolute inset-x-0 bottom-full mb-4 h-[50vh] bg-black/60 backdrop-blur-xl border-t border-b border-white/10 rounded-t-2xl shadow-2xl"
    >
      <div
        ref={scrollContainerRef}
        className="h-full flex flex-col gap-8 justify-center items-start p-12 overflow-y-auto text-left"
      >
        {renderContent()}
      </div>
    </motion.div>
  );
};

export default Lyrics;