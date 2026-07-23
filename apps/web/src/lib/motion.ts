// Shared motion vocabulary — every framer-motion usage in this app should
// import from here rather than hand-tuning its own easing/duration, so
// motion reads as one coordinated system instead of per-component taste.
//
// Every animated component must also call useReducedMotion() (from
// "framer-motion") and either skip the animated wrapper entirely or render
// the end state immediately — see page-transition.tsx for the reference
// pattern.

export const ease = {
  /** Default for enters/reveals — fast start, gentle settle. */
  out: [0.16, 1, 0.3, 1] as const,
  /** Symmetric — looping or state-cycling motion (e.g. pipeline stages). */
  inOut: [0.65, 0, 0.35, 1] as const,
  /** Larger/hero-scale motion — display text, big panel reveals. */
  emphasized: [0.2, 0, 0, 1] as const,
};

export const duration = {
  instant: 0.1,
  /** Matches --animate-in / --animate-out in globals.css — keep in sync. */
  fast: 0.15,
  base: 0.2,
  moderate: 0.35,
  slow: 0.5,
};

export function transition(d: number = duration.base, e: readonly number[] = ease.out) {
  return { duration: d, ease: e };
}

export const fadeUp = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: transition(duration.moderate) },
};

export function staggerContainer(stagger = 0.05) {
  return { hidden: {}, show: { transition: { staggerChildren: stagger } } };
}
