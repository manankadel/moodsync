"use client";
import { useEffect, useRef } from 'react';
import { useRoomStore } from '@/lib/room-store';

export default function BeatVisualizer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  
  let player, isPlaying, audioElement;
  try {
    player = useRoomStore(state => state.player);
    isPlaying = useRoomStore(state => state.isPlaying);
    audioElement = useRoomStore(state => state.audioElement); // Access the dedicated HTML5 audio element
  } catch (error) {
    console.error('Error accessing room store:', error);
    return null; 
  }

  // Effect for setting up the one-time AudioContext and connecting the dedicated Audio Element
  useEffect(() => {
    // This effect runs only when the dedicated audioElement becomes available
    if (!audioElement || sourceRef.current) return;
    
    try {
      if (!audioContextRef.current) {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioContextRef.current = audioContext;
        
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyserRef.current = analyser;
        
        // CRITICAL FIX: ONLY connect to the dedicated HTML5 Audio Element
        // The YouTube iframe is cross-origin and will throw a SecurityError (as seen in log)
        const source = audioContext.createMediaElementSource(audioElement);
        sourceRef.current = source;
        source.connect(analyser);
        analyser.connect(audioContext.destination);
      }
    } catch (e) {
      console.error("Error setting up AudioContext for Uploaded Audio:", e);
    }
    // Cleanup function to disconnect the audio graph
    return () => {
        if (sourceRef.current) {
            sourceRef.current.disconnect();
            sourceRef.current = null;
        }
    };
  }, [audioElement]); // Dependency on audioElement ensures it runs once when the element is set

  // Effect for handling the animation loop
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
      analyserRef.current.getByteFrequencyData(dataArray);
      
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barWidth = 4;
      const numBars = canvas.width / (barWidth + 1);
      let x = 0;

      for (let i = 0; i < numBars; i++) {
        // Simple visualization for uploaded audio
        const barHeight = Math.pow(dataArray[i] / 255, 2.5) * canvas.height;
        const r = 50 + (dataArray[i] * 0.5);
        const g = 150 + (dataArray[i] * 0.2);
        const b = 220;
        
        ctx.fillStyle = `rgba(${r},${g},${b}, 0.8)`;
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 2;
      }
    };

    if (isPlaying) {
      audioContextRef.current?.resume();
      renderFrame();
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [isPlaying]);

  return <canvas ref={canvasRef} width="300" height="60" className="absolute bottom-0 left-1/2 -translate-x-1/2 opacity-25 blur-[1px]" />;
}