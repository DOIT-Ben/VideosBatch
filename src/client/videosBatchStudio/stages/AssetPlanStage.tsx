import { StageEmpty, StageFact, StagePage } from "../components/StagePage";

const CATEGORY_LABELS: Record<string, string> = {
  CHARACTER: "人物",
  SCENE: "场景",
  PROP: "道具",
  CREATURE: "生物"
};

export function AssetPlanStage({ artifact }: { artifact: any }) {
  const items: any[] = Array.isArray(artifact?.items) ? artifact.items : [];
  const grouped = items.reduce((acc: Record<string, any[]>, item: any) => {
    const key = String(item?.category || "OTHER");
    (acc[key] ||= []).push(item);
    return acc;
  }, {});
  const groups = Object.entries(grouped) as Array<[string, any[]]>;

  return (
    <StagePage
      stepId="asset-plan"
      title={String(artifact?.title || "资产计划")}
      lead="检查角色、场景和道具是否齐全，再进入图片生成。"
      facts={<StageFact value={items.length} label="资产项" />}
    >
      {!items.length ? <StageEmpty>资产计划尚未生成。</StageEmpty> : (
        <div className="vbs-asset-plan-groups">
          {groups.map(([category, group]) => (
            <section key={category} className="vbs-asset-plan-group">
              <div className="vbs-section-title"><h3>{CATEGORY_LABELS[category] || category}</h3><span>{group.length} 项</span></div>
              <div className="vbs-asset-plan-list">
                {group.map((item: any) => (
                  <article className="vbs-asset-plan-card" key={String(item.assetKey)}>
                    <div className="vbs-card-topline"><span className="vbs-code">{String(item.assetId || item.assetKey || "")}</span><span>{String(item.aspectRatio || "")}</span></div>
                    <h4>{String(item.name || "未命名资产")}</h4>
                    <p>{String(item.description || "")}</p>
                    {item.sourceEvidence && <div className="vbs-source-evidence"><strong>出处</strong><span>{String(item.sourceEvidence)}</span></div>}
                    {item.continuityNotes && <div className="vbs-source-evidence"><strong>连贯性</strong><span>{String(item.continuityNotes)}</span></div>}
                    <details><summary>查看生成提示词</summary><p className="vbs-prompt-copy">{String(item.prompt || "")}</p></details>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </StagePage>
  );
}
