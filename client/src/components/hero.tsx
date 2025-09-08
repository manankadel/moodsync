"use client";
import { motion } from "framer-motion";
import { ArrowDown } from "lucide-react";

export default function Hero() {
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.2, delayChildren: 1 }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.8, ease: "circOut" } }
  };

  return (
    <section className="relative flex items-center justify-center h-screen">
      {/* We keep our Ethereal Grid background from HeroScene */}
      <div className="absolute inset-0 z-0 overflow-hidden bg-black">
        <div className="absolute inset-0 bg-gradient-to-br from-gray-900 via-black to-gray-900" />
        <div className="absolute -left-64 -top-64 h-[40rem] w-[40rem] rounded-full bg-purple-500/20 blur-3xl" />
        <div className="absolute -bottom-72 -right-72 h-[40rem] w-[40rem] rounded-full bg-sky-500/20 blur-3xl" />
        <div
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
      
      {/* Foreground content */}
      <motion.div 
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        className="relative z-10 text-center px-4"
      >
        <motion.h1 variants={itemVariants} className="text-5xl md:text-7xl font-semibold tracking-tight text-white">
          Where Music Becomes <br /> Atmosphere
        </motion.h1>
        <motion.p variants={itemVariants} className="mt-6 max-w-2xl mx-auto text-lg text-gray-400">
          Create and experience perfectly synchronized listening rooms, generated from the essence of a mood.
        </motion.p>
        <motion.div variants={itemVariants} className="mt-12">
          <button className="group inline-flex items-center gap-3 px-8 py-4 rounded-full bg-white/10 border border-white/20 text-white transition-all duration-300 hover:bg-white/20 hover:border-white/30">
            <span>Begin the Experience</span>
            <ArrowDown className="h-5 w-5 transition-transform duration-300 group-hover:translate-y-1" />
          </button>
        </motion.div>
      </motion.div>
    </section>
  );
}