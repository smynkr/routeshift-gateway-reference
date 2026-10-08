'use client';

import { useEffect, useRef, useState } from 'react';

type CountUpProps = {
  target: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  durationMs?: number;
  className?: string;
};

function formatValue(value: number, decimals: number, prefix: string, suffix: string): string {
  const body = decimals > 0 ? value.toFixed(decimals) : Math.round(value).toLocaleString('en-US');
  return `${prefix}${body}${suffix}`;
}

/**
 * Number transition for proof stats: counts from 0 to the final sample value
 * the first time it scrolls into view. Reduced-motion (or no
 * IntersectionObserver) renders the final value immediately. The accessible
 * name stays the final formatted value so screen readers never hear the
 * intermediate ticks.
 */
export function CountUp({
  target,
  decimals = 0,
  prefix = '',
  suffix = '',
  durationMs = 900,
  className,
}: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const finalText = formatValue(target, decimals, prefix, suffix);
  // The first client render must match the server; animate only after mount.
  const [display, setDisplay] = useState(finalText);
  const startedRef = useRef(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || startedRef.current) return;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(finalText);
      return;
    }
    if (typeof IntersectionObserver === 'undefined' || typeof requestAnimationFrame === 'undefined') {
      setDisplay(finalText);
      return;
    }
    setDisplay(formatValue(0, decimals, prefix, suffix));
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting) || startedRef.current) return;
        startedRef.current = true;
        observer.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const progress = Math.min(1, (now - start) / durationMs);
          const eased = 1 - Math.pow(1 - progress, 3);
          setDisplay(formatValue(target * eased, decimals, prefix, suffix));
          if (progress < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // finalText is derived from stable props; re-running on every render would restart the count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, decimals, prefix, suffix, durationMs]);

  return (
    <span ref={ref} className={className} aria-label={finalText}>
      {display}
    </span>
  );
}
