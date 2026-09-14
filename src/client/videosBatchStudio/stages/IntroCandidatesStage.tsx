import { useMemo } from "react";
import { StageEmpty, StageFact, StagePage } from "../components/StagePage";

const CREATIVE_GROUPS = ["数学史与知识由来", "历史需求与古今应用", "创意故事与现代情境"] as const;

/**
 * Models write creativeType in loose shapes: "数学史与知识由来：原始问题",
 * "数学史与知识由来·原始问题", "A1历史需求与古今应用", or just the sub-direction.
 * Match the canonical category anywhere, then fall back to the leading segment, so
 * a candidate can never fall out of the grid and leave the step looking empty.
 */
function creativeGroup(value: unknown) {
  const raw = String(value ?? "").trim();
  const canonical = CREATIVE_GROUPS.find((name) => raw.includes(name));
  if (canonical) return { group: canonical, sub: raw.slice(raw.indexOf(canonical) + canonical.length).replace(/^[：:·/\s]+/, "").trim() };
  const [group = ""] = raw.split(/[：:·/]/);
  return { group: group.trim() || "其他方案", sub: "" };
}

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
  const candidates: any[] = Array.isArray(artifact?.candidates) ? artifact.candidates : [];
  const recommendations = new Map<string, string>(
    (Array.isArray(artifact?.recommendations) ? artifact.recommendations : [])
      .map((item: any): [string, string] => [String(item?.id || ""), String(item?.reason || "")])
  );
  const groups = useMemo(() => {
    const known = new Set<string>(CREATIVE_GROUPS);
    const buckets = new Map<string, any[]>();
    for (const candidate of candidates) {
      const key = creativeGroup(candidate?.creativeType).group || "其他方案";
      const bucket = buckets.get(key);
      if (bucket) bucket.push(candidate);
      else buckets.set(key, [candidate]);
    }
    // Canonical order first; anything the model invented stays visible at the end.
    const order = [...CREATIVE_GROUPS, ...[...buckets.keys()].filter((key) => !known.has(key)).sort()];
    return order
      .filter((key) => buckets.has(key))
      .map((key) => ({ label: key, items: buckets.get(key) as any[] }));
  }, [candidates]);

  return (
    <StagePage
      stepId="intro"
      title="选择课程导入方案"
      lead="挑一套课程导入方案，后续内容都按这个方向展开。"
      facts={<StageFact value={candidates.length} label="候选方案" />}
    >
      {!candidates.length ? (
        <StageEmpty>方案尚未生成。点击底部「自动运行」即可开始。</StageEmpty>
      ) : (
        <div className="vbs-intro-groups">
          {groups.map((group) => (
            <section className="vbs-intro-group" key={group.label}>
              <h3>{group.label}</h3>
              <div className="vbs-intro-grid">
                {group.items.map((candidate: any) => {
                  const { sub } = creativeGroup(candidate.creativeType);
                  const recommended = recommendations.get(String(candidate.id || ""));
                  const selected = selectedIntroId === candidate.id;
                  return (
                    <article className={`vbs-intro-card ${selected ? "selected" : ""}`} key={String(candidate.id)}>
                      <div className="vbs-card-topline">
                        <span className="vbs-code">{String(candidate.id || "")}</span>
                        {sub && <span className="vbs-card-sub">{sub}</span>}
                        {recommended && <span className="vbs-recommend">组内推荐</span>}
                      </div>
                      <h4>{String(candidate.name || candidate.id || "未命名方案")}</h4>
                      <p>{String(candidate.body || "")}</p>
                      {candidate.endingQuestion && <blockquote>{String(candidate.endingQuestion)}</blockquote>}
                      {candidate.truthfulnessCategory && <small>{String(candidate.truthfulnessCategory)}</small>}
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
    </StagePage>
  );
}
