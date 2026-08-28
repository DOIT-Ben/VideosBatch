export function ScreenplayStage({ artifact }: { artifact: any }) {
  const scenes = Array.isArray(artifact?.scenes) ? artifact.scenes : [];
  const duration = Number(artifact?.targetDurationSeconds || 0);
  return (
    <section className="vbs-stage-page vbs-document-stage">
      <div className="vbs-stage-kicker">06 · 视频剧本</div>
      <div className="vbs-document-header">
        <div><h2>{artifact?.title || "正式视频剧本"}</h2><p>把故事转换成可执行的视频表达结构。</p></div>
        <div className="vbs-document-facts">
          <span><strong>{duration || "—"}s</strong><small>目标时长</small></span>
          <span><strong>{duration ? duration / 10 : "—"}</strong><small>预计主分镜</small></span>
        </div>
      </div>
      {!scenes.length ? <div className="vbs-empty-card">正式视频剧本尚未生成。</div> : (
        <div className="vbs-screenplay-list">
          {scenes.map((scene: any) => (
            <article className="vbs-screenplay-scene" key={scene.sequence}>
              <div className="vbs-scene-number">{String(scene.sequence).padStart(2, "0")}</div>
              <div>
                <h3>{scene.title || `场景 ${scene.sequence}`}</h3>
                {scene.knowledgeFocus && <p><strong>知识重点：</strong>{scene.knowledgeFocus}</p>}
                {scene.visualAction && <p><strong>画面 / 动作：</strong>{scene.visualAction}</p>}
                {scene.dialogue && <blockquote>{scene.dialogue}</blockquote>}
                <div className="vbs-scene-meta">
                  {scene.visualPresentation && <span>呈现：{scene.visualPresentation}</span>}
                  {scene.ambientSound && <span>环境声：{scene.ambientSound}</span>}
                  {scene.effectSound && <span>音效：{scene.effectSound}</span>}
                  {scene.emotionalPurpose && <span>情绪目的：{scene.emotionalPurpose}</span>}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
