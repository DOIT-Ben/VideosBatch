import { Clamp } from "../components/Clamp";
import { StageEmpty, StageFact, StagePage } from "../components/StagePage";

const CATEGORY_LABELS: Record<string, string> = {
  CHARACTER: "人物",
  SCENE: "场景",
  PROP: "道具",
  CREATURE: "生物"
};

const CATEGORY_ALIASES: Array<{ key: string; needles: string[] }> = [
  { key: "CHARACTER", needles: ["CHARACTER", "人物", "角色"] },
  { key: "SCENE", needles: ["SCENE", "场景"] },
  { key: "PROP", needles: ["PROP", "道具"] },
  { key: "CREATURE", needles: ["CREATURE", "生物"] }
];

const CANONICAL_KEYS = new Set(CATEGORY_ALIASES.map(({ key }) => key));

/**
 * Resolve an asset item's canonical category.
 *
 * Never compare the model's category text with `===`: real output carries a
 * sub-direction alongside the canonical name, and an exact key splits one
 * category into several groups whose titles fall back to raw English. Match the
 * canonical name anywhere in the string and fall back to the raw value so every
 * item still has a home (same failure mode as IntroCandidatesStage).
 *
 * Note the server already constrains this: `llmTextStages` validates `category`
 * against the exact enum and requires `assetKey` to start with `category-`, so
 * the tolerant paths below only serve hand-edited (advanced drawer) or legacy
 * artifacts. When several canonical names do appear, the *earliest* mention wins
 * — canonical output is `<canonical>：<sub-direction>`, so the category precedes
 * its qualifier — with the longest needle breaking ties and declaration order
 * after that. Declaration order alone silently mis-filed anything whose
 * qualifier happened to contain another canonical name ("生物：场景中的小鸟"
 * landed under 场景).
 */
function categoryKey(category: unknown, assetKey?: unknown) {
  const raw = String(category || "").trim();
  const upper = raw.toUpperCase();
  if (CANONICAL_KEYS.has(upper)) return upper;
  let best: { key: string; at: number; length: number } | undefined;
  for (const { key, needles } of CATEGORY_ALIASES) {
    for (const needle of needles) {
      const at = upper.indexOf(needle.toUpperCase());
      if (at < 0) continue;
      if (!best || at < best.at || (at === best.at && needle.length > best.length)) {
        best = { key, at, length: needle.length };
      }
    }
  }
  if (best) return best.key;
  // Last resort: a validated `assetKey` prefix (`CHARACTER-HERO`) still names the
  // category even when the free-text field is unusable.
  const keyPrefix = String(assetKey || "").trim().toUpperCase().split("-")[0];
  if (CANONICAL_KEYS.has(keyPrefix)) return keyPrefix;
  return raw || "OTHER";
}

export function AssetPlanStage({ artifact }: { artifact: any }) {
  const items: any[] = Array.isArray(artifact?.items) ? artifact.items : [];
  const grouped = items.reduce((acc: Record<string, any[]>, item: any) => {
    const key = categoryKey(item?.category, item?.assetKey);
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
                    {item.aspectRatio ? <div className="vbs-card-topline"><span>{String(item.aspectRatio)}</span></div> : null}
                    <h4>{String(item.name || "未命名资产")}</h4>
                    <Clamp lines={3}><p>{String(item.description || "")}</p></Clamp>
                    {(item.sourceEvidence || item.continuityNotes || item.prompt) && (
                      <details className="vbs-plan-reference">
                        <summary>查看出处、连贯性与提示词</summary>
                        {item.sourceEvidence && <div className="vbs-source-evidence"><strong>出处</strong><span>{String(item.sourceEvidence)}</span></div>}
                        {item.continuityNotes && <div className="vbs-source-evidence"><strong>连贯性</strong><span>{String(item.continuityNotes)}</span></div>}
                        {item.prompt && <p className="vbs-prompt-copy">{String(item.prompt || "")}</p>}
                      </details>
                    )}
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
