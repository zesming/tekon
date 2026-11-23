import { useEffect, useRef, useState } from 'react';
import { WbIcons } from './AgentIcon.js';

export type ContentWidthPreset = 'normal' | 'wide' | 'full';

const WIDTH_LABELS: Record<ContentWidthPreset, string> = {
  normal: '正常',
  wide: '宽',
  full: '全宽',
};

export function WidthMenu({
  value,
  onChange,
}: {
  value: ContentWidthPreset;
  onChange: (next: ContentWidthPreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const label = `内容宽度：${WIDTH_LABELS[value]}`;

  return (
    <div className="wb-width-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`wb-icon-btn ${open ? 'active' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {WbIcons.width}
      </button>
      {open ? (
        <div className="wb-width-menu" role="menu" aria-label="内容宽度设置">
          {(
            [
              ['normal', '正常', '适中阅读'],
              ['wide', '宽', '宽屏展开'],
              ['full', '全宽', '100%'],
            ] as const
          ).map(([preset, title, sub]) => (
            <button
              key={preset}
              type="button"
              className={`wb-width-opt ${value === preset ? 'active' : ''}`}
              role="menuitemradio"
              aria-checked={value === preset}
              onClick={() => {
                onChange(preset);
                setOpen(false);
              }}
            >
              <span>{title}</span>
              <span className="wb-width-opt-sub">{sub}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
