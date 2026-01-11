"use client";

import { useEffect, useState } from "react";

export default function AudioUnlocker() {
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    const unlock = async () => {
      try {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        if (ctx.state === "suspended") {
          await ctx.resume();
        }
        setUnlocked(true);
        window.removeEventListener("keydown", unlock);
        window.removeEventListener("touchstart", unlock);
        window.removeEventListener("click", unlock);
      } catch (e) {}
    };

    window.addEventListener("keydown", unlock);
    window.addEventListener("touchstart", unlock);
    window.addEventListener("click", unlock);
  }, []);

  if (unlocked) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black text-white text-lg z-50">
      Tap to enable audio
    </div>
  );
}
