export function StoryboardStage({ artifact }: { artifact: any }) {
  const segments = Array.isArray(artifact?.segments) ? artifact.segments : [];
  return (
    <section className="vbs-stage-page">
      <div className="vbs-stage-kicker">07 · 视频分镜</div>
      <div className="vbs-document-header">
        <div><h2>{artifact?.title || "最终 10 秒分镜"}</h2><p>正式分镜是事实源；垫图副本只用于执行，不在这里改写正文。</p></div>
        <div className="vbs-document-facts">
          <span><strong>{artifact?.targetDuration || "—"}s</strong><small>总时长</small></span>
          <span><strong>{segments.length}</strong><small>主分镜</small></span>
        </div>
      </div>
      {!segments.length ? <div className="vbs-empty-card">最终分镜尚未生成。</div> : (
        <div className="vbs-shot-list">
          {segments.map((segment: any) => {
            const start = (Number(segment.sequence || 1) - 1) * 10;
            const references = Array.isArray(segment.references) ? segment.references : [];
            const subshots = Array.isArray(segment.subshots) ? segment.subshots : [];
            return (
              <article className="vbs-shot-card" key={segment.sequence}>
                <header>
                  <div><span className="vbs-code">镜头 {String(segment.sequence).padStart(2, "0")}</span><strong>{String(start).padStart(2, "0")}–{String(start + Number(segment.duration || 10)).padStart(2, "0")}s · {segment.duration || 10}s</strong></div>
                  {segment.nativeShotId && <span className="vbs-native-pill">已同步制作画布</span>}
                </header>
                <p className="vbs-visual-prompt">{segment.visualPrompt}</p>
                {segment.teachingPurpose && <div className="vbs-teaching-purpose"><strong>教学目的</strong><span>{segment.teachingPurpose}</span></div>}
                <div className="vbs-subshot-list">
                  {subshots.map((subshot: any) => (
                    <div className="vbs-subshot" key={subshot.sequence}>
                      <span>{subshot.duration}s</span>
                      <div><strong>{subshot.visual}</strong><p>{subshot.action}</p><small>{subshot.camera} · {subshot.sound}{subshot.voice ? ` · ${subshot.voice}` : ""}</small></div>
                    </div>
                  ))}
                </div>
                {references.length > 0 && <div className="vbs-reference-chips">{references.map((reference: any) => <span key={reference.publicAssetId || reference.assetId}>{reference.label || reference.publicAssetId || reference.assetId}</span>)}</div>}
                {(segment.narration || segment.subtitles) && <div className="vbs-dialogue-block">{segment.narration && <p><strong>旁白：</strong>{segment.narration}</p>}{segment.subtitles && <p><strong>字幕：</strong>{segment.subtitles}</p>}</div>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
