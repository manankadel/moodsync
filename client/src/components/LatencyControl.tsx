
import { motion } from "framer-motion";
import { useRoomStore } from "@/lib/room-store";

const LatencyControl = () => {
  const { manualLatencyOffset, setManualLatencyOffset } = useRoomStore(
    (state) => ({
      manualLatencyOffset: state.manualLatencyOffset,
      setManualLatencyOffset: state.setManualLatencyOffset,
    })
  );

  const handleChange = (value: string) => {
    const numericValue = Number(value);
    setManualLatencyOffset(numericValue);
  };
  
  const offsetMs = Math.round(manualLatencyOffset * 1000);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10, transition: { duration: 0.2 } }}
      className="absolute bottom-24 right-0 flex flex-col items-center gap-3 bg-black/50 border border-white/10 backdrop-blur-md rounded-lg p-4 shadow-2xl w-64"
    >
      <div className="text-xs font-bold text-white tracking-widest">
        LATENCY OFFSET
      </div>
      <input
        id="latency-slider"
        type="range"
        min="-0.25"
        max="0.25"
        step="0.01"
        value={manualLatencyOffset}
        onChange={(e) => handleChange(e.target.value)}
        className="w-full h-1 bg-gray-700 rounded-full appearance-none cursor-pointer accent-purple-400"
        title={`Latency Offset: ${offsetMs} ms`}
      />
      <div className="text-sm font-mono text-purple-300 w-20 text-center border border-purple-400/30 bg-purple-500/10 rounded px-2 py-1">
        {offsetMs > 0 ? `+${offsetMs}`: offsetMs} ms
      </div>
       <p className="text-xs text-gray-500 text-center mt-1">Adjust if your audio is ahead or behind others.</p>
    </motion.div>
  );
};

export default LatencyControl;