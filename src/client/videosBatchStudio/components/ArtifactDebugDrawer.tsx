import { useEffect, useMemo, useState } from "react";
import { Dialog, ScrollArea } from "radix-ui";
import { X } from "lucide-react";

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
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="vbs-radix-overlay" />
        <Dialog.Content className="vbs-debug-drawer" aria-describedby={undefined}>
          <header>
            <div>
              <small>高级 · 原始数据</small>
              <Dialog.Title>{title}</Dialog.Title>
            </div>
            <Dialog.Close className="vbs-icon-button" aria-label="关闭原始数据"><X size={18} /></Dialog.Close>
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
              <ScrollArea.Root className="vbs-debug-scroll" type="auto">
                <ScrollArea.Viewport className="vbs-debug-scroll-viewport">
                  <pre>{formatted}</pre>
                </ScrollArea.Viewport>
                <ScrollArea.Scrollbar className="vbs-scrollbar" orientation="vertical">
                  <ScrollArea.Thumb className="vbs-scrollbar-thumb" />
                </ScrollArea.Scrollbar>
              </ScrollArea.Root>
              {onSave && <button type="button" className="vbs-secondary" onClick={() => setEditing(true)}>编辑 JSON</button>}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
