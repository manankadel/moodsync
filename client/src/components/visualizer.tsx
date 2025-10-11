"use client";
import { useEffect, useRef } from 'react';
import { useRoomStore } from '@/lib/room-store';

export default function BeatVisualizer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  
  const isPlaying = useRoomStore(state => state.isPlaying);
  const audioNodes = useRoomStore(state => state.audioNodes);

  useEffect(() => {
    if (!audioNodes.context || analyserRef.current) return;
    
    try {
      const analyser = audioNodes.context.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      
      if (audioNodes.source && audioNodes.bass) {
        audioNodes.source.connect(analyser);
        console.log("✅ Analyser connected");
      }
    } catch (e) {
      console.error("Analyser error:", e);
    }

    return () => {
      if (analyserRef.current) {
        try {
          analyserRef.current.disconnect();
        } catch (e) {}
      }
    };
  }, [audioNodes.context, audioNodes.source, audioNodes.bass]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx || !analyserRef.current) return;

    const bufferLength = analyserRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    let animationFrameId: number;

    const renderFrame = () => {
      if (!analyserRef.current || !ctx || !canvas) return;
      
      animationFrameId = requestAnimationFrame(renderFrame);
      
      try {
        analyserRef.current.getByteFrequencyData(dataArray);
      } catch (e) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barWidth = 4;
      const numBars = Math.floor(canvas.width / (barWidth + 1));
      let x = 0;

      for (let i = 0; i < numBars && i < dataArray.length; i++) {
        const barHeight = Math.pow(dataArray[i] / 255, 2.5) * canvas.height;
        const r = 50 + (dataArray[i] * 0.5);
        const g = 150 + (dataArray[i] * 0.2);
        const b = 220;
        
        ctx.fillStyle = `rgba(${r},${g},${b}, 0.8)`;
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 2;
      }
    };

    if (isPlaying && audioNodes.context) {
      if (audioNodes.context.state === 'suspended') {
        audioNodes.context.resume().catch(() => {});
      }
      renderFrame();
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [isPlaying, audioNodes.context]);

  return <canvas ref={canvasRef} width="300" height="60" className="absolute bottom-0 left-1/2 -translate-x-1/2 opacity-25 blur-[1px]" />;
}