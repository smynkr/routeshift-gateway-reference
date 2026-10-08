'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';

type RevealProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
};

/**
 * Scroll-triggered entrance that stays out of the way: a short opacity +
 * vertical drift, rendered exactly once. Reduced-motion users get the final
 * content with no animation. Wraps whole sections so inner DOM contracts
 * (and their tests) never change.
 */
export function Reveal({ children, className, delay = 0 }: RevealProps) {
  const reduceMotion = useReducedMotion();
  const [canAnimate, setCanAnimate] = useState(false);
  useEffect(() => {
    setCanAnimate(typeof IntersectionObserver !== 'undefined');
  }, []);
  // Hydration starts with the same visible markup as the server.
  if (reduceMotion || !canAnimate) {
    return <div className={className}>{children}</div>;
  }
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-64px' }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
