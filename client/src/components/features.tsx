"use client";
import { motion } from "framer-motion";
import { BrainCircuit, Users, Globe } from "lucide-react";

const features = [
  {
    icon: <BrainCircuit className="h-8 w-8 text-purple-400" />,
    title: "Intelligent Curation",
    description: "Our algorithm analyzes mood and context to generate playlists that feel uniquely personal and deeply resonant.",
  },
  {
    icon: <Users className="h-8 w-8 text-sky-400" />,
    title: "Synchronized Spaces",
    description: "Experience music together. Our technology ensures flawless, real-time audio sync across unlimited devices, anywhere.",
  },
  {
    icon: <Globe className="h-8 w-8 text-amber-400" />,
    title: "Seamless Access",
    description: "No installations. No barriers. MoodSync is a pure web experience, accessible on any device with a modern browser.",
  },
];

export default function Features() {
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.2, delayChildren: 0.2 }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 50 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.7, ease: "circOut" } }
  };

  return (
    <section className="py-24 px-4 bg-black">
      <div className="max-w-7xl mx-auto">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.8 }}
          className="text-center mb-16"
        >
          <h2 className="text-4xl md:text-5xl font-semibold tracking-tight text-white">
            A New Era of Listening
          </h2>
          <p className="mt-4 max-w-2xl mx-auto text-lg text-gray-400">
            MoodSync isn't just about playlists. It's about creating shared sonic environments.
          </p>
        </motion.div>

        <motion.div 
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.2 }}
          className="grid grid-cols-1 md:grid-cols-3 gap-8"
        >
          {features.map((feature, index) => (
            <motion.div 
              key={index}
              variants={itemVariants}
              className="group relative p-8 rounded-2xl bg-white/5 border border-white/10 overflow-hidden"
            >
              <div className="absolute top-0 left-0 h-full w-full bg-gradient-to-br from-purple-500/10 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"/>
              <div className="relative z-10">
                <div className="mb-4">{feature.icon}</div>
                <h3 className="text-xl font-semibold text-white mb-2">{feature.title}</h3>
                <p className="text-gray-400 font-light">{feature.description}</p>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}