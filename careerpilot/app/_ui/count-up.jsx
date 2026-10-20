'use client';
import { useLayoutEffect, useRef, useState } from 'react';

const fmt = (n) => n.toLocaleString('en-IN');

// tristenobrien.ai's figures: count up from 0 over 1.4 s (ease-out-expo) once a fifth is in view.
// The server renders the final number, which CSS (.count) hides for its first second, so the reset to
// 0 happens before anyone sees it; a number already showing (slow script) stays put. It counts once:
// a later change of value (a refresh after an action) just shows the new number.
export function CountUp({ value }) {
  const ref = useRef(null);
  const hidden = useRef(null);
  const done = useRef(false);
  const [n, setN] = useState(value);
  useLayoutEffect(() => {
    const el = ref.current;
    hidden.current ??= getComputedStyle(el).opacity === '0';
    el.dataset.run = '';
    if (done.current || !hidden.current || !value || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      done.current = true;
      setN(value);
      return;
    }
    setN(0);
    let frame;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const tick = (now) => {
        const p = Math.min(1, (now - start) / 1400);
        setN(Math.round(value * (p === 1 ? 1 : 1 - 2 ** (-10 * p))));
        if (p < 1) frame = requestAnimationFrame(tick);
        else done.current = true;
      };
      frame = requestAnimationFrame(tick);
    }, { threshold: 0.2 });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(frame); };
  }, [value]);
  return <span ref={ref} className="count">{fmt(n)}</span>;
}
