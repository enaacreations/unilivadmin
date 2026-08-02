// Celebration confetti — a fixed, pointer-transparent overlay of falling
// brand-coloured pieces. Fired on gamified wins (order sent, mismatch-free
// delivery, audit submitted). Ported from the Claude Design prototype.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const COLORS = ["#FF9A3D", "#F2603C", "#C2459A", "#7C5CFF", "#157F5B"];
const PIECES = 28;
const BURST_MS = 3200;

export function Confetti({ burst }: { burst: number }) {
  if (!burst) return null;
  return (
    <div
      key={`confetti-${burst}`}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[100] overflow-hidden"
    >
      {Array.from({ length: PIECES }).map((_, i) => (
        <span
          key={i}
          className="absolute"
          style={{
            top: "-4vh",
            left: `${3 + ((i * 37) % 94)}%`,
            width: i % 3 === 0 ? 12 : 8,
            height: i % 2 === 0 ? 8 : 14,
            background: COLORS[i % COLORS.length],
            borderRadius: i % 4 === 0 ? 999 : 2,
            animation: `confetti-fall ${2 + (i % 5) * 0.25}s ${(i % 7) * 0.12}s ease-in both`,
          }}
        />
      ))}
    </div>
  );
}

/** `const { confetti, fire } = useConfetti()` — render `{confetti}` once in the
 *  page, call `fire()` on a success moment. Auto-clears after the burst. */
export function useConfetti(): { confetti: ReactNode; fire: () => void } {
  const [burst, setBurst] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fire = useCallback(() => {
    setBurst((b) => b + 1);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setBurst(0), BURST_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { confetti: <Confetti burst={burst} />, fire };
}
