"use client";
import { motion } from "framer-motion";

// This is our new "Ethereal Grid" background
export default function HeroScene() {
  return (
    <div className="absolute inset-0 z-0 overflow-hidden bg-black">
      {/* Layer 1: Base Gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-gray-900 via-black to-gray-900" />

      {/* Layer 2: Glowing Auras (Subtle colored light sources) */}
      <div className="absolute -left-64 -top-64 h-[40rem] w-[40rem] rounded-full bg-purple-500/20 blur-3xl" />
      <div className="absolute -bottom-72 -right-72 h-[40rem] w-[40rem] rounded-full bg-sky-500/20 blur-3xl" />
      
      {/* Layer 3: The Animated Grid */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 2, delay: 0.5 }}
        className="absolute inset-0"
        style={{
          backgroundImage: `
            repeating-linear-gradient(0deg, transparent, transparent 1px, rgba(255, 255, 255, 0.05) 1px, rgba(255, 255, 255, 0.05) 2px),
            repeating-linear-gradient(90deg, transparent, transparent 1px, rgba(255, 255, 255, 0.05) 1px, rgba(255, 255, 255, 0.05) 2px)
          `,
          backgroundSize: "40px 40px",
        }}
      />
    </div>
  );
}