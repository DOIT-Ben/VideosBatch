export function StoryStage({ artifact }: { artifact: any }) {
  const content = String(artifact?.content || "");
  return (
    <section className="vbs-stage-page vbs-document-stage">
      <div className="vbs-stage-kicker">03 · 故事文稿</div>
      <div className="vbs-document-header">
        <div>
          <h2>{artifact?.title || "故事文稿"}</h2>
          <p>{artifact?.storyType || "课程导入故事"}</p>
        </div>
        <div className="vbs-document-facts">
          <span><strong>{content.length}</strong><small>当前字数</small></span>
          <span><strong>{artifact?.storyType || "—"}</strong><small>故事类型</small></span>
        </div>
      </div>
      {artifact?.truthfulnessNote && <div className="vbs-note-card"><strong>真实性说明</strong><p>{artifact.truthfulnessNote}</p></div>}
      {content ? <article className="vbs-longform">{content}</article> : <div className="vbs-empty-card">故事文稿尚未生成。</div>}
    </section>
  );
}
