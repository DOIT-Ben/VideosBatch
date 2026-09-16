import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * Progressive disclosure for long content.
 *
 * The body clamps to `lines` with a fade at the cut; the toggle only renders
 * when the content actually overflows, so short entries stay clean and no
 * "展开" button ever points at nothing. Children pass through untouched, so
 * every existing paragraph/blockquote selector keeps applying.
 */
export function Clamp({
  lines = 4,
  className = "",
  children
}: {
  lines?: number;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // With the clamp active, scrollHeight still reports the full content.
    setOverflowing(el.scrollHeight > el.clientHeight + 2);
  });

  return (
    <div className={`vbs-clamp ${className}`}>
      <div
        ref={ref}
        className={`vbs-clamp-body ${open ? "open" : ""}`}
        style={{ "--vbs-clamp-lines": lines } as CSSProperties}
      >
        {children}
      </div>
      {overflowing && (
        <button type="button" className="vbs-clamp-toggle" onClick={() => setOpen((value) => !value)}>
          {open ? "收起" : "展开全文"}
        </button>
      )}
    </div>
  );
}
