const CATEGORY_LABELS: Record<string, string> = {
  CHARACTER: "人物 / 拟人动物",
  SCENE: "场景 / 空间环境",
  PROP: "兵器 / 法宝 / 道具",
  CREATURE: "神兽 / 灵宠 / 非拟人生物"
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
    <section className="vbs-stage-page">
      <div className="vbs-stage-kicker">04 · 资产计划</div>
      <h2>{String(artifact?.title || "资产计划与生成提示词")}</h2>
      <p className="vbs-stage-lead">在生成图片前检查角色、场景和道具是否完整。稳定公开编号由服务端分配，模型只负责资产语义和 Prompt。</p>
      {!items.length ? <div className="vbs-empty-card">资产计划尚未生成。</div> : (
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
                    {item.sourceEvidence && <div className="vbs-source-evidence"><strong>来源情节</strong><span>{String(item.sourceEvidence)}</span></div>}
                    {item.continuityNotes && <div className="vbs-source-evidence"><strong>连续性</strong><span>{String(item.continuityNotes)}</span></div>}
                    <details><summary>查看图片 Prompt</summary><p className="vbs-prompt-copy">{String(item.prompt || "")}</p></details>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
