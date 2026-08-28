import { useEffect, useMemo, useState } from "react";

export function ArtifactDebugDrawer({
  open,
  title,
  artifact,
  onClose,
  onSave
}: {
  open: boolean;
  title: string;
  artifact: unknown;
  onClose: () => void;
  onSave?: (artifact: unknown) => Promise<void> | void;
}) {
  const formatted = useMemo(() => JSON.stringify(artifact ?? {}, null, 2), [artifact]);
  const [draft, setDraft] = useState(formatted);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(formatted);
    setEditing(false);
    setError("");
  }, [formatted, open]);

  if (!open) return null;

  const save = async () => {
    try {
      const next = JSON.parse(draft || "{}");
      await onSave?.(next);
      setEditing(false);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "JSON 格式错误");
    }
  };

  return (
    <div className="vbs-debug-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <aside className="vbs-debug-drawer" role="dialog" aria-modal="true" aria-label={`${title}原始数据`}>
        <header>
          <div>
            <small>高级 · 原始数据</small>
            <strong>{title}</strong>
          </div>
          <button type="button" onClick={onClose}>关闭</button>
        </header>
        {editing ? (
          <>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={24} aria-label={`${title} JSON`} />
            {error && <div className="vbs-inline-error">{error}</div>}
            <div className="vbs-debug-actions">
              <button type="button" className="vbs-primary" onClick={save}>保存原始数据</button>
              <button type="button" className="vbs-secondary" onClick={() => { setDraft(formatted); setEditing(false); setError(""); }}>取消</button>
            </div>
          </>
        ) : (
          <>
            <pre>{formatted}</pre>
            {onSave && <button type="button" className="vbs-secondary" onClick={() => setEditing(true)}>编辑 JSON</button>}
          </>
        )}
      </aside>
    </div>
  );
}
