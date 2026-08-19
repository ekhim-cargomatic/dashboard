import { useEffect, useRef, useState } from 'react';

/**
 * Track a container's width so SVG charts can be laid out in real pixels.
 *
 * The charts compute tick counts, label density and bar widths from the measured
 * width rather than relying on `viewBox` scaling, which would stretch text and
 * stroke weights along with the geometry.
 */
export function useElementWidth<T extends HTMLElement>(fallback = 720) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      if (measured > 0) setWidth(measured);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}
