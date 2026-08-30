import { useMemo, useState } from "react";
import type { Asset } from "../../../shared/types";
import { buildAssetCandidateGroups, isAssetConfirmationComplete } from "../contentModel";
import { MediaPreviewDialog } from "../components/MediaPreviewDialog";
import { Check, ImageIcon, Maximize2 } from "lucide-react";

export function AssetGalleryStage({
  planArtifact,
  candidatesArtifact,
  confirmationArtifact,
  nativeAssets = [],
  selectedAssetIds = {},
  onSelectAsset = () => undefined,
  busy,
  onConfirmAll
}: {
  planArtifact: any;
  candidatesArtifact: any;
  confirmationArtifact: any;
  nativeAssets?: Asset[];
  selectedAssetIds?: Record<string, string>;
  onSelectAsset?: (assetKey: string, assetId: string) => Promise<void> | void;
  busy?: boolean;
  onConfirmAll: () => Promise<void> | void;
}) {
  const groups = useMemo(
    () => buildAssetCandidateGroups(planArtifact, candidatesArtifact, confirmationArtifact, nativeAssets),
    [planArtifact, candidatesArtifact, confirmationArtifact, nativeAssets]
  );
  const [preview, setPreview] = useState<{ title: string; url: string } | null>(null);
  const readyToConfirm = groups.length > 0 && groups.every((group) => {
    const selected = selectedAssetIds[group.assetKey] || group.selectedAssetId;
    return Boolean(selected && group.candidateAssetIds.includes(selected));
  });

  return (
    <section className="vbs-stage-page">
      <div className="vbs-stage-kicker">05 · 资产图片</div>
      <div className="vbs-section-title">
        <div>
          <h2>确认资产图片</h2>
          <p className="vbs-stage-lead">逐个查看真实生成结果，为每个角色、场景和道具选定一张最终参考图。</p>
        </div>
        <span>{groups.length} 个资产</span>
      </div>
      {!groups.length ? <div className="vbs-empty-card">资产计划或候选图尚未生成。</div> : (
        <>
          <div className="vbs-asset-gallery vbs-asset-gallery-detailed">
            {groups.map((group) => {
              const selectedId = selectedAssetIds[group.assetKey] || group.selectedAssetId;
              const confirmed = Boolean(confirmationArtifact?.confirmed && selectedId);
              return (
                <article className={`vbs-asset-card ${confirmed ? "confirmed" : ""}`} key={group.assetKey}>
                  <div className="vbs-asset-card-copy">
                    <div className="vbs-card-topline">
                      <span className="vbs-code">{group.publicAssetId || group.assetKey}</span>
                      <span>{group.candidates.length} 张候选</span>
                    </div>
                    <h4>{group.name}</h4>
                    <p>{group.description}</p>
                  </div>
                  <div className="vbs-candidate-grid" role="radiogroup" aria-label={`${group.name}候选图片`}>
                    {group.candidates.map((candidate, index) => {
                      const selected = selectedId === candidate.id;
                      return (
                        <div className={`vbs-candidate-tile ${selected ? "selected" : ""}`} key={candidate.id}>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className="vbs-candidate-select"
                            disabled={busy}
                            onClick={() => onSelectAsset(group.assetKey, candidate.id)}
                          >
                            <div className="vbs-candidate-image">
                              {candidate.previewUrl ? (
                                <img src={candidate.previewUrl} alt={`${group.name} 候选 ${index + 1}`} loading="lazy" />
                              ) : (
                                <div className="vbs-candidate-placeholder"><ImageIcon size={22} /><span>等待图片</span></div>
                              )}
                              {selected && candidate.previewUrl && <span className="vbs-selected-badge"><Check size={13} /> 已选择</span>}
                            </div>
                            <span>候选 {index + 1}</span>
                          </button>
                          {candidate.previewUrl && (
                            <button
                              type="button"
                              className="vbs-candidate-preview"
                              onClick={() => setPreview({ title: `${group.name} · 候选 ${index + 1}`, url: candidate.previewUrl })}
                            >
                              <Maximize2 size={14} /> 预览
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="vbs-asset-selection-state">
                    <span>{selectedId ? `已选择 ${selectedId}` : "请选择一张候选图"}</span>
                    {confirmed && <strong><Check size={14} /> 已确认</strong>}
                  </div>
                </article>
              );
            })}
          </div>
          {!isAssetConfirmationComplete(planArtifact, candidatesArtifact, confirmationArtifact) && (
            <div className="vbs-stage-confirm-bar">
              <div><strong>确认最终资产</strong><span>确认后，后续剧本和分镜只引用这里选定的图片；仍可从本步骤重新生成。</span></div>
              <button type="button" className="vbs-primary" disabled={busy || !readyToConfirm} onClick={onConfirmAll}>确认全部资产 →</button>
            </div>
          )}
        </>
      )}
      <MediaPreviewDialog
        open={Boolean(preview)}
        title={preview?.title || "资产预览"}
        imageUrl={preview?.url || ""}
        onOpenChange={(open) => { if (!open) setPreview(null); }}
      />
    </section>
  );
}
