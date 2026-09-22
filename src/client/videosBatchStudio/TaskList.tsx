import { useMemo, useState } from "react";
import { ArrowRight, Check, FileText, Plus, Search, X } from "lucide-react";
import type { Session } from "../../shared/types";
import { deriveCurrentProductStep, deriveProductStepStatus, productStepById, VIDEOS_BATCH_PRODUCT_STEPS } from "./stageModel";

export type TaskFilter = "all" | "active" | "attention" | "done";
export function taskCategory(session: Session): Exclude<TaskFilter, "all"> {
  const workflow = session.videosBatchWorkflow;
  if (!workflow) return "active";
  if (workflow.completed) return "done";
  const status = deriveProductStepStatus(workflow, productStepById(deriveCurrentProductStep(workflow)));
  return status === "failed" || status === "confirm" ? "attention" : "active";
}
export function taskStatus(session: Session) {
  const workflow = session.videosBatchWorkflow;
  if (!workflow) return "教案草稿";
  if (workflow.completed) return "已完成";
  const step = productStepById(deriveCurrentProductStep(workflow));
  const status = deriveProductStepStatus(workflow, step);
  return `${step.label} · ${status === "running" ? "生成中" : status === "failed" ? "需要处理" : status === "confirm" ? "待确认" : "待继续"}`;
}
export function selectTasks(sessions: Session[], query: string, filter: TaskFilter, sort: string) {
  const text = query.trim().toLocaleLowerCase();
  return sessions.filter(s => (!text || (s.title || "未命名课程视频").toLocaleLowerCase().includes(text)) && (filter === "all" || taskCategory(s) === filter))
    .sort((a, b) => sort === "title" ? (a.title || "").localeCompare(b.title || "", "zh-CN")
      : (sort === "oldest" ? 1 : -1) * ((Date.parse(a.updatedAt || a.createdAt) || 0) - (Date.parse(b.updatedAt || b.createdAt) || 0)));
}
function updatedLabel(session: Session) {
  const date = new Date(session.updatedAt || session.createdAt);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function TaskList({ sessions, busy, onSelect, onCreate, onGallery }: {
  sessions: Session[]; busy?: boolean; onSelect: (id: string) => void; onCreate: () => void; onGallery: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [sort, setSort] = useState("recent");
  const visible = useMemo(() => selectTasks(sessions, query, filter, sort), [sessions, query, filter, sort]);
  const filters: { id: TaskFilter; label: string }[] = [{ id: "all", label: "全部" }, { id: "active", label: "制作中" }, { id: "attention", label: "待处理" }, { id: "done", label: "已完成" }];
  return <section className="gallery-page vb-task-page" aria-label="任务列表">
    <header className="vb-task-heading"><div><p className="vb-eyebrow">课程视频工作室</p><h1>我的任务</h1><p>从教案到成片，把每一堂课讲得更生动。</p></div>
      <button type="button" className="vb-task-create" disabled={busy} onClick={onCreate}><Plus size={18} />{busy ? "请稍候…" : "新建任务"}</button>
    </header>
    {sessions.length > 0 && <div className="vb-task-tools">
      <div className="vb-task-filters" role="group" aria-label="按任务状态筛选">{filters.map(item => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
      <label className="vb-task-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="搜索任务名称" placeholder="搜索任务名称" value={query} onChange={e => setQuery(e.target.value)} />{query && <button type="button" aria-label="清空搜索" onClick={() => setQuery("")}><X size={15} /></button>}</label>
      <select aria-label="任务排序" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">最近更新</option><option value="oldest">最早更新</option><option value="title">按名称</option></select>
    </div>}
    <p className="vb-task-result" role="status">{sessions.length > 0 ? `${visible.length} 个任务` : "准备好你的第一份教案"}</p>
    {visible.length ? <ul className="vb-task-list">{visible.map(session => {
      const workflow = session.videosBatchWorkflow;
      const category = taskCategory(session);
      const title = session.title || "未命名课程视频";
      const updated = updatedLabel(session);
      const steps = VIDEOS_BATCH_PRODUCT_STEPS.map(step => workflow ? deriveProductStepStatus(workflow, step) : "pending");
      const completed = steps.filter(s => s === "ready").length;
      return <li key={session.id} className="vb-task-row">
        <span className={`vb-task-icon ${category}`} aria-hidden="true">{category === "done" ? <Check size={22} /> : <FileText size={22} />}</span>
        <div className="vb-task-copy"><h2 title={title}>{title}</h2><p className={`vb-task-status ${category}`}>{taskStatus(session)}</p></div>
        <div className="vb-task-progress" aria-label={`已完成 ${completed} / 9 步`}><div aria-hidden="true">{steps.map((status, i) => <span key={i} className={status} />)}</div><small>{workflow ? `${completed} / 9 步` : "上传或粘贴教案开始"}</small></div>
        {updated && <time className="vb-task-time" dateTime={session.updatedAt || session.createdAt}>{updated}<small>更新</small></time>}
        <button className="vb-task-open" type="button" onClick={() => onSelect(session.id)} aria-label={`继续任务：${title}`}>{category === "done" ? "查看成片" : category === "attention" ? "去处理" : "继续任务"}<ArrowRight size={16} /></button>
      </li>;
    })}</ul> : <div className="vb-task-empty"><FileText size={32} aria-hidden="true" /><h2>{sessions.length ? "没有找到匹配的任务" : "让一份教案，成为一段好视频"}</h2><p>{sessions.length ? "试试其他名称，或查看全部任务。" : "上传 Word、PDF，或直接粘贴教案。你可以逐步审阅故事、画面与最终成片。"}</p>{sessions.length > 0 && <button type="button" onClick={() => { setQuery(""); setFilter("all"); }}>清除筛选</button>}</div>}
    <footer className="vb-task-bottom"><span>想看看已经发布的作品？</span><button type="button" onClick={onGallery}>浏览作品广场 <ArrowRight size={14} /></button></footer>
  </section>;
}
