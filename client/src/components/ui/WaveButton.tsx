"use client";
import React, { useRef, useEffect } from 'react';

type WaveButtonProps = {
  text?: string;
  onClick?: () => void;
  type?: 'button' | 'submit';
  disabled?: boolean;
};

// This component is now correctly typed and structured for Next.js/React
const WaveButton: React.FC<WaveButtonProps> = ({ text = "Get In Touch", onClick, type = "button", disabled = false }) => {
  const wave1Ref = useRef<HTMLDivElement>(null);
  const wave2Ref = useRef<HTMLDivElement>(null);
  const wave3Ref = useRef<HTMLDivElement>(null);
  const animationRefs = useRef<Animation[]>([]);
  const durations = [12000, 10000, 8000];
  const waveRefs = [wave1Ref, wave2Ref, wave3Ref];

  useEffect(() => {
    animationRefs.current = waveRefs.map((ref, i) => {
      if (!ref.current) return null;
      return ref.current.animate(
        [{ transform: 'translateX(0px)' }, { transform: 'translateX(-400px)' }],
        { duration: durations[i], iterations: Infinity, easing: 'linear' }
      );
    }).filter((anim): anim is Animation => anim !== null); // Type guard to filter out nulls
    return () => animationRefs.current.forEach(anim => anim?.cancel());
  }, []);

  const setSpeed = (rate: number) => animationRefs.current.forEach(anim => { if(anim) anim.playbackRate = rate });
  const handleMouseEnter = () => setSpeed(6);
  const handleMouseLeave = () => setSpeed(1);

  const getWave = (color: string, width = 6) => {
    const svg = `<svg viewBox="0 0 400 100" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none"><path d="M0 50 Q100 10 200 50 Q300 90 400 50" stroke="${color}" stroke-width="${width}" fill="none" vector-effect="non-scaling-stroke"/></svg>`;
    return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="relative group inline-block w-full px-8 py-4 text-lg font-bold text-white rounded-full bg-black/20 border border-white/20 backdrop-blur-md overflow-hidden transition-all duration-300 hover:border-white/30 hover:shadow-cyan-400/20 disabled:opacity-50 disabled:cursor-not-allowed"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <span className="relative z-10">{text}</span>
      <div className="absolute inset-0 z-0 blur-sm opacity-70 group-hover:opacity-100 transition-opacity duration-500">
        <div ref={wave1Ref} className="absolute inset-0 h-full" style={{ width: '800px', backgroundImage: getWave('#f472b6', 12), backgroundSize: '400px 100%', backgroundRepeat: 'repeat-x' }} />
        <div ref={wave2Ref} className="absolute inset-0 h-full" style={{ width: '800px', backgroundImage: getWave('#22d3ee', 10), backgroundSize: '400px 100%', backgroundRepeat: 'repeat-x' }} />
        <div ref={wave3Ref} className="absolute inset-0 h-full" style={{ width: '800px', backgroundImage: getWave('#ffffff', 8), backgroundSize: '400px 100%', backgroundRepeat: 'repeat-x' }} />
      </div>
    </button>
  );
}

export default WaveButton;