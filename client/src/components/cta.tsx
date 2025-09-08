"use client";
import UIPanel from "./ui-panel";
import { motion } from "framer-motion";

export default function Cta() {
  return (
    <section className="relative py-24 px-4 overflow-hidden bg-black">
      {/* We reuse the Ethereal Grid background for consistency */}
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-gradient-to-t from-gray-900 via-black to-black" />
        <div className="absolute -bottom-72 -right-72 h-[40rem] w-[40rem] rounded-full bg-purple-500/10 blur-3xl" />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `
              repeating-linear-gradient(0deg, transparent, transparent 1px, rgba(255, 255, 255, 0.03) 1px, rgba(255, 255, 255, 0.03) 2px),
              repeating-linear-gradient(90deg, transparent, transparent 1px, rgba(255, 255, 255, 0.03) 1px, rgba(255, 255, 255, 0.03) 2px)
            `,
            backgroundSize: "60px 60px",
            maskImage: "radial-gradient(ellipse 80% 50% at 50% 50%, black, transparent)",
          }}
        />
      </div>

      {/* Foreground content */}
      <div className="relative z-10 flex flex-col items-center">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.8 }}
          className="text-center mb-12"
        >
          <h2 className="text-4xl md:text-5xl font-semibold tracking-tight text-white">
            Enter Your Space
          </h2>
          <p className="mt-4 max-w-xl mx-auto text-lg text-gray-400">
            Your journey into sound begins now. Create a new room or join an existing one.
          </p>
        </motion.div>
        
        <UIPanel />
      </div>
    </section>
  );
}