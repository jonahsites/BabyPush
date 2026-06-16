import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";

interface SlingshotGameProps {
  side: "blue" | "red";
  userTokens: number;
  isDevMode: boolean;
  onLaunch: (pullX: number, pullY: number, maxPull: number) => Promise<boolean>;
  onCancel: () => void;
}

export default function SlingshotGame({
  side,
  userTokens,
  isDevMode,
  onLaunch,
  onCancel,
}: SlingshotGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  
  // Drag offsets relative to center (140, 110)
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [isLaunching, setIsLaunching] = useState(false);
  const [recoilOffset, setRecoilOffset] = useState({ x: 0, y: 0 });

  const maxPull = 100; // max dragging pixels
  const center = { x: 140, y: 110 };
  const leftProng = { x: 105, y: 80 };
  const rightProng = { x: 175, y: 80 };

  const babyImg =
    side === "blue"
      ? "https://lh3.googleusercontent.com/d/1SNCMihirT-5iX9Fp_AZTclJTJ0P5kae4"
      : "https://lh3.googleusercontent.com/d/1MBQVettULlTDGfz3HDLUojv_4kj7dlkx";

  // Calculate stats based on current pull
  const dx = drag.x;
  const dy = drag.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const ratio = Math.min(1, distance / maxPull);
  const estimatedSteps = Math.ceil(ratio * 25);
  
  // Direction label
  let dirLabel = "Neutral";
  if (distance > 10) {
    // Launch angle is opposite of pull angle!
    const angle = Math.atan2(-dy, -dx) * (180 / Math.PI);
    if (angle >= -45 && angle < 45) dirLabel = "East (Right)";
    else if (angle >= 45 && angle < 135) dirLabel = "North (Up)";
    else if (angle < -45 && angle >= -135) dirLabel = "South (Down)";
    else dirLabel = "West (Left)";
  }

  // Handle move events anywhere in the window during dragging
  useEffect(() => {
    if (!isDragging || isLaunching) return;

    const handlePointerMove = (e: PointerEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const clientX = e.clientX;
      const clientY = e.clientY;

      // Extract coordinates relative to the center of the arena (140, 110)
      const relativeX = clientX - (rect.left + center.x);
      const relativeY = clientY - (rect.top + center.y);

      // Clamp distance to maxPull
      const dist = Math.sqrt(relativeX * relativeX + relativeY * relativeY);
      if (dist <= maxPull) {
        setDrag({ x: relativeX, y: relativeY });
      } else {
        const angle = Math.atan2(relativeY, relativeX);
        setDrag({
          x: Math.cos(angle) * maxPull,
          y: Math.sin(angle) * maxPull,
        });
      }
    };

    const handlePointerUp = async () => {
      setIsDragging(false);
      
      const pullDist = Math.sqrt(drag.x * drag.x + drag.y * drag.y);
      if (pullDist < 10) {
        // Reset drag if pull is too low
        setDrag({ x: 0, y: 0 });
        return;
      }

      // Play recoil animation: let the baby whip across the other side and fade
      setIsLaunching(true);
      
      // Opposite direction of pull, flying out!
      const angle = Math.atan2(drag.y, drag.x);
      const targetFlightDist = 180; // Fly out far
      const targetX = -Math.cos(angle) * targetFlightDist;
      const targetY = -Math.sin(angle) * targetFlightDist;

      // Begin quick flying animation sequence
      setRecoilOffset({ x: drag.x, y: drag.y });
      
      // Animate flight quickly
      let start: number | null = null;
      const duration = 250; // ms

      const animate = async (timestamp: number) => {
        if (!start) start = timestamp;
        const progress = Math.min(1, (timestamp - start) / duration);
        
        // Linear path from current pull coordinates to opposite target launch coordinates
        const currentPullX = drag.x;
        const currentPullY = drag.y;
        
        const currentX = currentPullX + (targetX - currentPullX) * progress;
        const currentY = currentPullY + (targetY - currentPullY) * progress;
        
        setRecoilOffset({ x: currentX, y: currentY });

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          // Trigger the state update in Firebase and grid movement
          const success = await onLaunch(drag.x, drag.y, maxPull);
          if (!success) {
            // If failed (e.g. not enough tokens), restore
            setIsLaunching(false);
            setDrag({ x: 0, y: 0 });
            setRecoilOffset({ x: 0, y: 0 });
          }
        }
      };

      requestAnimationFrame(animate);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isDragging, drag, isLaunching, onLaunch]);

  const canAfford = isDevMode || userTokens >= 100;

  return (
    <div className="text-center">
      <div className="mb-2 relative text-center">
        <p className="text-[11px] text-black/70 font-black uppercase tracking-wider font-mono">
          🚀 launch payload up to 25 steps (100 pixels) on grid!
        </p>
        <div className="flex gap-1.5 justify-center items-center mt-1">
          <span className="text-[9px] px-2 py-0.5 rounded-full font-black uppercase tracking-wider bg-rose-100 text-rose-700 border border-rose-400">
            Cost: 100 Tokens
          </span>
          <span className="text-[9px] px-2 py-0.5 rounded-full font-black uppercase tracking-wider bg-yellow-100 text-yellow-800 border border-yellow-400">
            Humanitarian Tier Action
          </span>
        </div>
      </div>

      {/* Dragging Arena */}
      <div 
        ref={containerRef}
        onPointerDown={(e) => {
          if (isLaunching) return;
          e.preventDefault();
          setIsDragging(true);
        }}
        className="w-[280px] h-[240px] bg-[#fdfcfa] border-4 border-black rounded-3xl relative overflow-hidden shadow-[inset_0_4px_10px_rgba(0,0,0,0.06)] mx-auto cursor-grab active:cursor-grabbing select-none"
      >
        {/* Dynamic Launch Indicator Arc/Details */}
        <div className="absolute top-2 left-3 text-left font-mono text-[9px] text-[#4b5563] pointer-events-none">
          <div>Estimated Steps: <span className="font-black text-black">{estimatedSteps} blocks</span></div>
          <div>Direction: <span className="font-black text-rose-600 uppercase">{dirLabel}</span></div>
        </div>

        {/* Slingshot Visual Elements */}
        <svg className="absolute inset-0 pointer-events-none z-10 w-full h-full">
          {/* Wooden Slingshot Handle Stem */}
          <line
            x1={center.x}
            y1={center.y}
            x2={center.x}
            y2={210}
            stroke="#78350f"
            strokeWidth={14}
            strokeLinecap="round"
          />
          {/* Golden Grip details */}
          <line
            x1={center.x}
            y1={140}
            x2={center.x}
            y2={190}
            stroke="#d97706"
            strokeWidth={15}
            strokeLinecap="round"
          />
          {/* Y-Forks */}
          <path
            d={`M ${leftProng.x} ${leftProng.y} Q ${center.x} ${center.y + 10} ${rightProng.x} ${rightProng.y}`}
            fill="none"
            stroke="#78350f"
            strokeWidth={12}
            strokeLinecap="round"
          />

          {/* Elastic Rubber Bands */}
          {!isLaunching ? (
            <>
              {/* Stretchy Band Right */}
              <line
                x1={rightProng.x}
                y1={rightProng.y}
                x2={center.x + drag.x}
                y2={center.y + drag.y}
                stroke="#f59e0b"
                strokeWidth={7 - 4 * ratio} // rubber bands get thinner as they stretch
                strokeLinecap="round"
                opacity={0.85}
              />
              {/* Stretchy Band Left */}
              <line
                x1={leftProng.x}
                y1={leftProng.y}
                x2={center.x + drag.x}
                y2={center.y + drag.y}
                stroke="#f59e0b"
                strokeWidth={7 - 4 * ratio}
                strokeLinecap="round"
                opacity={0.85}
              />
            </>
          ) : (
            <>
              {/* Snapped band left/right recoil visualization */}
              <line
                x1={leftProng.x}
                y1={leftProng.y}
                x2={center.x}
                y2={center.y - 10}
                stroke="#f59e0b"
                strokeWidth={5}
                strokeLinecap="round"
                opacity={0.3}
              />
              <line
                x1={rightProng.x}
                y1={rightProng.y}
                x2={center.x}
                y2={center.y - 10}
                stroke="#f59e0b"
                strokeWidth={5}
                strokeLinecap="round"
                opacity={0.3}
              />
            </>
          )}

          {/* Wooden Fork Caps (Pegs) */}
          <circle cx={leftProng.x} cy={leftProng.y} r={7} fill="#451a03" />
          <circle cx={rightProng.x} cy={rightProng.y} r={7} fill="#451a03" />
        </svg>

        {/* Draggable Launcher Character Element */}
        <div
          className={`absolute rounded-full pointer-events-none transition-transform z-20`}
          style={{
            left: `${center.x - 20 + (!isLaunching ? drag.x : recoilOffset.x)}px`,
            top: `${center.y - 20 + (!isLaunching ? drag.y : recoilOffset.y)}px`,
            width: "40px",
            height: "40px",
            transform: isDragging ? "scale(1.15)" : "scale(1)",
          }}
        >
          {/* Sling Cradle Pocket pouch */}
          {!isLaunching && (
            <div className="absolute inset-x-[-4px] inset-y-[2px] bg-[#543d2b] border border-black rounded-lg transform rotate-[45deg] opacity-70 scale-x-50 z-[-1]" />
          )}

          {/* Baby Figurine Avatar */}
          <img
            src={babyImg}
            className={`w-full h-full object-contain ${isDragging ? "animate-wiggle" : ""}`}
            alt="Slingshot Object"
            referrerPolicy="no-referrer"
          />
        </div>

        {/* Ring Guidance Backdrop */}
        <div 
          className="absolute border-2 border-dashed border-gray-200 rounded-full pointer-events-none"
          style={{
            left: `${center.x - maxPull}px`,
            top: `${center.y - maxPull}px`,
            width: `${maxPull * 2}px`,
            height: `${maxPull * 2}px`,
          }}
        />

        {/* Pull Instructions Mask Override */}
        {distance === 0 && !isLaunching && (
          <div className="absolute bottom-5 inset-x-0 text-center pointer-events-none font-black uppercase text-[10px] tracking-widest text-[#9ca3af] animate-pulse">
            👆 CLICK & drag baby backward!
          </div>
        )}
      </div>

      {/* Pricing / Affordability Hint */}
      <div className="mt-4 flex flex-col items-center gap-2">
        <div className="text-[11px] font-mono font-black uppercase">
          {isDevMode ? (
            <span className="text-amber-500">⚡ DEV MODE ACCREDITED (FREE LAUNCH)</span>
          ) : !canAfford ? (
            <span className="text-red-600">❌ INSUFFICIENT TOKENS ({userTokens}/100)</span>
          ) : (
            <span className="text-green-600">✓ SUFFICIENT TOKENS ({userTokens}/100)</span>
          )}
        </div>

        <div className="flex gap-2.5 w-full mt-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl bg-gray-100 hover:bg-gray-200 text-black border-2 border-black text-xs font-black uppercase transition-colors cursor-pointer"
          >
            Cancel
          </button>
          
          {!isDevMode && !canAfford && (
            <button
              type="button"
              onClick={() => {
                onCancel();
                // We'll trigger the Purchase Modal open directly in parent via the button clicked
                (window as any)._openPurchaseModal?.();
              }}
              className="flex-1 py-2.5 rounded-xl bg-yellow-300 hover:bg-yellow-400 text-black border-2 border-black text-xs font-black uppercase shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] transition-all cursor-pointer"
            >
              🛒 Refill Tokens
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
