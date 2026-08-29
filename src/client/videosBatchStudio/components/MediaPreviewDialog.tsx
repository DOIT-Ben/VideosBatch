import { Dialog } from "radix-ui";
import { Maximize2, X } from "lucide-react";

export function MediaPreviewDialog({
  open,
  title,
  imageUrl,
  onOpenChange
}: {
  open: boolean;
  title: string;
  imageUrl: string;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="vbs-radix-overlay" />
        <Dialog.Content className="vbs-media-dialog" aria-describedby={undefined}>
          <div className="vbs-media-dialog-header">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="vbs-icon-button" aria-label="关闭预览"><X size={18} /></Dialog.Close>
          </div>
          <div className="vbs-media-dialog-stage">
            {imageUrl ? <img src={imageUrl} alt={title} /> : <div className="vbs-media-empty">暂无可预览图片</div>}
          </div>
          {imageUrl && (
            <a className="vbs-secondary vbs-media-open-link" href={imageUrl} target="_blank" rel="noreferrer">
              <Maximize2 size={15} /> 打开原图
            </a>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
