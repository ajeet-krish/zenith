import { useCallback, useRef, useEffect } from 'react';

interface ResizeHandleProps {
  onResize: (delta: number) => void;
  direction?: 'left' | 'right';
}

/**
 * Vertical drag handle for resizing panels.
 * Renders a thin 4px strip that highlights on hover and drags to resize.
 */
export function ResizeHandle({ onResize, direction = 'right' }: ResizeHandleProps) {
  const dragging = useRef(false);
  const startX = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = direction === 'right'
        ? e.clientX - startX.current
        : startX.current - e.clientX;
      startX.current = e.clientX;
      onResize(delta);
    };

    const handleMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [onResize, direction]);

  return (
    <div
      onMouseDown={handleMouseDown}
      className="w-1 shrink-0 cursor-col-resize bg-dust/0 hover:bg-neon-purple/40 active:bg-neon-purple/60 transition-colors"
    />
  );
}
