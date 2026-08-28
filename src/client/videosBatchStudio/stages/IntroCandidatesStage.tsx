import { useMemo } from "react";

export function IntroCandidatesStage({
  artifact,
  selectedIntroId,
  busy,
  onSelect
}: {
  artifact: any;
  selectedIntroId?: string;
  busy?: boolean;
  onSelect: (candidate: any) => Promise<void> | void;
}) {
  const candidates = Array.isArray(artifact?.candidates) ? artifact.candidates : [];
  const recommendations = new Map(
    (Array.isArray(artifact?.recommendations) ? artifact.recommendations : [])
      .map((item: any) => [String(item?.id || ""), String(item?.reason || "")])
  );
  const groups = useMemo(() => {
    const ordered = ["数学史与知识由来", "历史需求与古今应用", "创意故事与现代情境"];
    return ordered.map((label) => ({
      label,
      items: candidates.filter((candidate: any) => candidate?.creativeType === label)
    })).filter((group) => group.items.length);
  }, [artifact]);

  return (
    <section className="vbs-stage-page">
      <div className="vbs-stage-kicker">02 · 课程导入</div>
      <h2>选择课程导入方案</h2>
      <p className="vbs-stage-lead">系统生成三类九套候选。选择并锁定一套后，后续故事、资产和视频都沿用这一方向。</p>
      {!candidates.length ? (
        <div className="vbs-empty-card">课程导入方案尚未生成。使用右侧“自动运行到确认点”生成候选。</div>
      ) : (
        <div className="vbs-intro-groups">
          {groups.map((group) => (
            <section className="vbs-intro-group" key={group.label}>
              <h3>{group.label}</h3>
              <div className="vbs-intro-grid">
                {group.items.map((candidate: any) => {
                  const recommended = recommendations.get(String(candidate.id || ""));
                  const selected = selectedIntroId === candidate.id;
                  return (
                    <article className={`vbs-intro-card ${selected ? "selected" : ""}`} key={candidate.id}>
                      <div className="vbs-card-topline">
                        <span className="vbs-code">{candidate.id}</span>
                        {recommended && <span className="vbs-recommend">推荐</span>}
                      </div>
                      <h4>{candidate.name || candidate.id}</h4>
                      <p>{candidate.body || ""}</p>
                      {candidate.endingQuestion && <blockquote>{candidate.endingQuestion}</blockquote>}
                      {candidate.truthfulnessCategory && <small>{candidate.truthfulnessCategory}</small>}
                      {recommended && <div className="vbs-reason">{recommended}</div>}
                      <button type="button" className={selected ? "vbs-confirmed" : "vbs-primary"} disabled={busy || selected} onClick={() => onSelect(candidate)}>
                        {selected ? "✓ 已锁定" : "选择此方案"}
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
