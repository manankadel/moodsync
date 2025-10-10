import { motion } from "framer-motion";
import { useRoomStore } from "@/lib/room-store";

const Equalizer = () => {
  const { equalizer, setEqualizer, isAdmin, isCollaborative } = useRoomStore(
    (state) => ({
      equalizer: state.equalizer,
      setEqualizer: state.setEqualizer,
      isAdmin: state.isAdmin,
      isCollaborative: state.isCollaborative,
    })
  );

  const canControl = isAdmin || isCollaborative;

  const handleChange = (band: "bass" | "mids" | "treble", value: string) => {
    const numericValue = Number(value);
    setEqualizer({ ...equalizer, [band]: numericValue });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10, transition: { duration: 0.2 } }}
      className="absolute bottom-24 right-0 flex items-center gap-4 bg-black/50 border border-white/10 backdrop-blur-md rounded-lg p-4 shadow-2xl"
    >
      <div className="flex flex-col items-center gap-2">
        <label htmlFor="bass-slider" className="text-xs font-bold text-white tracking-widest">
          BASS
        </label>
        <input
          id="bass-slider"
          type="range"
          min="-10"
          max="10"
          step="0.5"
          value={equalizer.bass}
          onChange={(e) => handleChange("bass", e.target.value)}
          disabled={!canControl}
          className="w-20 h-1 bg-gray-700 rounded-full appearance-none cursor-pointer accent-cyan-400 disabled:opacity-50"
          title={`Bass: ${equalizer.bass} dB`}
        />
      </div>
      <div className="flex flex-col items-center gap-2">
        <label htmlFor="mids-slider" className="text-xs font-bold text-white tracking-widest">
          MIDS
        </label>
        <input
          id="mids-slider"
          type="range"
          min="-10"
          max="10"
          step="0.5"
          value={equalizer.mids}
          onChange={(e) => handleChange("mids", e.target.value)}
          disabled={!canControl}
          className="w-20 h-1 bg-gray-700 rounded-full appearance-none cursor-pointer accent-pink-400 disabled:opacity-50"
          title={`Mids: ${equalizer.mids} dB`}
        />
      </div>
      <div className="flex flex-col items-center gap-2">
        <label htmlFor="treble-slider" className="text-xs font-bold text-white tracking-widest">
          TREBLE
        </label>
        <input
          id="treble-slider"
          type="range"
          min="-10"
          max="10"
          step="0.5"
          value={equalizer.treble}
          onChange={(e) => handleChange("treble", e.target.value)}
          disabled={!canControl}
          className="w-20 h-1 bg-gray-700 rounded-full appearance-none cursor-pointer accent-amber-400 disabled:opacity-50"
          title={`Treble: ${equalizer.treble} dB`}
        />
      </div>
    </motion.div>
  );
};

export default Equalizer;