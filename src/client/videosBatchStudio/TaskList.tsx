import type { Session } from "../../shared/types";
import { deriveCurrentProductStep, productStepById } from "./stageModel";

export function taskStatus(session: Session) {
  const workflow = session.videosBatchWorkflow;
  if (!workflow) return "教案草稿";
  if (workflow.completed) return "已完成";
  const stage = workflow.stages[workflow.currentStage];
  const label = productStepById(deriveCurrentProductStep(workflow)).label;
  const status = stage?.status === "running" ? "生成中" : stage?.status === "failed" ? "需要处理"
    : ["COURSE_INTRO_SELECTION", "ASSET_CONFIRMATION"].includes(workflow.currentStage) ? "待确认" : "待继续";
  return `${label} · ${status}`;
}

export function TaskList({ sessions, busy, onSelect, onCreate, onGallery }: {
  sessions: Session[]; busy?: boolean; onSelect: (id: string) => void; onCreate: () => void; onGallery: () => void;
}) {
  return <section className="gallery-page" aria-label="任务列表">
    <div className="gallery-hero"><div><h1>任务列表</h1><p>继续未完成的课程视频，或开始新任务。</p></div>
      <button type="button" disabled={busy} onClick={onCreate}>新建任务</button>
      <button type="button" onClick={onGallery}>作品广场</button>
    </div>
    {!sessions.length ? <p>还没有任务。新建任务后即可上传或粘贴教案。</p> : <div className="gallery-grid">
      {sessions.map((session) => <article className="gallery-card" key={session.id}>
        <div className="gallery-card-body"><h2>{session.title}</h2><p>{taskStatus(session)}</p>
          <button type="button" onClick={() => onSelect(session.id)} aria-label={`继续任务：${session.title}`}>继续任务</button>
        </div>
      </article>)}
    </div>}
  </section>;
}
