export function AssetGalleryStage({
  planArtifact,
  candidatesArtifact,
  confirmationArtifact,
  busy,
  onConfirmAll
}: {
  planArtifact: any;
  candidatesArtifact: any;
  confirmationArtifact: any;
  busy?: boolean;
  onConfirmAll: () => Promise<void> | void;
}) {
  const planItems = Array.isArray(planArtifact?.items) ? planArtifact.items : [];
  const candidates = Array.isArray(candidatesArtifact?.items) ? candidatesArtifact.items : [];
  const byKey = new Map(candidates.map((item: any) => [String(item?.assetKey || ""), item]));
  const confirmedByKey = new Map((Array.isArray(confirmationArtifact?.items) ? confirmationArtifact.items : []).map((item: any) => [String(item?.assetKey || ""), item]));
  const readyToConfirm = planItems.length > 0 && planItems.every((item: any) => {
    const candidate = byKey.get(String(item.assetKey)) as any;
    return Array.isArray(candidate?.candidateAssetIds) && candidate.candidateAssetIds.length > 0;
  });

  return (
    <section className="vbs-stage-page">
      <div className="vbs-stage-kicker">05 · 资产图片</div>
      <div className="vbs-section-title"><div><h2>确认资产图片</h2><p className="vbs-stage-lead">每个资产都必须有一张确认图片，确认后才能进入正式视频剧本。</p></div><span>{planItems.length} 个资产</span></div>
      {!planItems.length ? <div className="vbs-empty-card">资产计划或候选图尚未生成。</div> : (
        <>
          <div className="vbs-asset-gallery">
            {planItems.map((item: any) => {
              const candidate = byKey.get(String(item.assetKey)) as any;
              const confirmation = confirmedByKey.get(String(item.assetKey)) as any;
              const candidateIds = Array.isArray(candidate?.candidateAssetIds) ? candidate.candidateAssetIds : [];
              const confirmed = Boolean(confirmation?.selectedAssetId);
              return (
                <article className={`vbs-asset-card ${confirmed ? "confirmed" : ""}`} key={item.assetKey}>
                  <div className="vbs-asset-preview" aria-label={`${item.name}候选图`}>
                    <span>{candidateIds.length ? "候选图已生成" : "等待生成"}</span>
                    <small>{candidate?.publicAssetId || item.assetId || item.assetKey}</small>
                  </div>
                  <div className="vbs-asset-card-copy">
                    <h4>{item.name}</h4>
                    <p>{item.description}</p>
                    <div className="vbs-card-topline">
                      <span>{candidateIds.length} 张候选</span>
                      <span>{confirmed ? "✓ 已确认" : candidateIds.length ? "待确认" : "待生成"}</span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
          {!confirmationArtifact?.confirmed && (
            <div className="vbs-stage-confirm-bar">
              <div><strong>确认当前候选</strong><span>Foundation 会默认选择每个资产的第一张候选图；Phase 2 将提供逐资产可视化选择。</span></div>
              <button type="button" className="vbs-primary" disabled={busy || !readyToConfirm} onClick={onConfirmAll}>确认全部资产 →</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
