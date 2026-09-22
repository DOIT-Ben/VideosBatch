import { useMemo, useState, useSyncExternalStore, useRef } from "react";
import { api } from "../api";
import { productionRuns } from "../productionCenter/runStore";
import { useViewState, useViewPosition } from "../productionCenter/viewMemory";
import type { ProductionRun } from "../../shared/productionRuns";
import { runStatusLabel } from "../../shared/productionRuns";
import type { BatchAction, BatchItem, BatchResult } from "../../shared/batchControls";
import { ArrowRight, Check, FileText, Plus, Search, X } from "lucide-react";
import type { Session } from "../../shared/types";
import { deriveCurrentProductStep, deriveProductStepStatus, productStepById, VIDEOS_BATCH_PRODUCT_STEPS } from "./stageModel";

export type TaskFilter = "all" | "active" | "waiting" | "attention" | "done";
export function taskCategory(session: Session, run?: ProductionRun, live = false): Exclude<TaskFilter, "all"> {
  const workflow = session.videosBatchWorkflow;
  if (run && ["reconciling", "failed", "waiting_input"].includes(run.status)) return "attention";
  if (run && ["queued", "paused", "pause_requested"].includes(run.status)) return "waiting";
  if (run?.status === "running") return "active";
  if (!workflow) return live ? "waiting" : "active";
  if (workflow.completed) return "done";
  const status = deriveProductStepStatus(workflow, productStepById(deriveCurrentProductStep(workflow)));
  return status === "failed" || status === "confirm" ? "attention" : live && status !== "running" ? "waiting" : "active";
}
export function taskStatus(session: Session) {
  const workflow = session.videosBatchWorkflow;
  if (!workflow) return "教案草稿";
  if (workflow.completed) return "已完成";
  const step = productStepById(deriveCurrentProductStep(workflow));
  const status = deriveProductStepStatus(workflow, step);
  return `${step.label} · ${status === "running" ? "生成中" : status === "failed" ? "需要处理" : status === "confirm" ? "待确认" : "待继续"}`;
}
export function selectTasks(sessions: Session[], query: string, filter: TaskFilter, sort: string, runs?: Map<string, ProductionRun>) {
  const text = query.trim().toLocaleLowerCase();
  return sessions.filter(s => (!text || (s.title || "未命名课程视频").toLocaleLowerCase().includes(text)) && (filter === "all" || taskCategory(s, runs?.get(s.id), Boolean(runs)) === filter))
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
  const [query, setQuery] = useViewState("tasks:query", "");
  const [filter, setFilter] = useViewState<TaskFilter>("tasks:filter", "all");
  const [sort, setSort] = useViewState("tasks:sort", "recent");
  const revision = useSyncExternalStore(productionRuns.subscribe, () => productionRuns.revision, () => 0);
  const visible = useMemo(() => selectTasks(sessions, query, filter, sort, productionRuns.latestBySession), [sessions, query, filter, sort, revision]);
  const [page, setPage] = useViewState("tasks:page", 0);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(visible.length / 50) - 1));
  const shown = visible.slice(currentPage * 50, currentPage * 50 + 50);
  const root = useViewPosition("tasks");
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<BatchAction>("start");
  const [priority, setPriority] = useState(1);
  const [preview, setPreview] = useState<BatchItem[]>();
  const [results, setResults] = useState<BatchResult[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const request = useRef("");
  const previewOperation = async () => {
    setPending(true); setError(""); setResults(undefined);
    try { setPreview(await api.previewBatch(action, selected)); request.current = crypto.randomUUID(); }
    catch (error) { setError(error instanceof Error ? error.message : "预览失败"); }
    finally { setPending(false); }
  };
  const execute = async () => {
    if (!preview || pending) return;
    setPending(true); setError("");
    try { setResults(await api.executeBatch(action, preview, request.current, priority)); }
    catch (error) { setError(error instanceof Error ? error.message : "结果尚未确认；可重试同一操作"); }
    finally { setPending(false); }
  };
  const actions: [BatchAction, string][] = [["start", "开始自动执行"], ["pause", "暂停后续"], ["resume", "继续执行"], ["stop", "停止后续"], ["retry", "重试失败项"], ["priority", "调整排队优先级"]];
  const filters: { id: TaskFilter; label: string }[] = [{ id: "all", label: "全部" }, { id: "active", label: "执行中" }, { id: "waiting", label: "等待" }, { id: "attention", label: "待处理" }, { id: "done", label: "已完成" }];
  return <section ref={root} className="gallery-page vb-task-page" aria-label="任务列表">
    <header className="vb-task-heading"><div><p className="vb-eyebrow">课程视频工作室</p><h1>我的任务</h1><p>从教案到成片，把每一堂课讲得更生动。</p></div>
      <button type="button" className="vb-task-create" disabled={busy} onClick={onCreate}><Plus size={18} />{busy ? "请稍候…" : "新建任务"}</button>
    </header>
    {sessions.length > 0 && <div className="vb-task-tools">
      <div className="vb-task-filters" role="group" aria-label="按任务状态筛选">{filters.map(item => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setPage(0); }}>{item.label}</button>)}</div>
      <label className="vb-task-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="搜索任务名称" placeholder="搜索任务名称" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} />{query && <button type="button" aria-label="清空搜索" onClick={() => setQuery("")}><X size={15} /></button>}</label>
      <select aria-label="任务排序" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">最近更新</option><option value="oldest">最早更新</option><option value="title">按名称</option></select>
    </div>}
    {sessions.length > 0 && <section className="vb-batch-bar" aria-label="批量任务管理">
      <label><input type="checkbox" disabled={pending} aria-label="选择当前页任务" checked={shown.length > 0 && shown.every(item => selected.includes(item.id))} onChange={event => { setSelected(event.target.checked ? [...new Set([...selected, ...shown.map(item => item.id)])].slice(0, 100) : selected.filter(id => !shown.some(item => item.id === id))); setPreview(undefined); setResults(undefined); }} /> 本页</label>
      <span>已选 {selected.length} / 100</span><select aria-label="批量操作" value={action} disabled={pending} onChange={event => { setAction(event.target.value as BatchAction); setPreview(undefined); setResults(undefined); }}>{actions.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>
      {action === "priority" && <label>仅影响等待任务<select aria-label="排队优先级" value={priority} disabled={pending} onChange={event => { setPriority(Number(event.target.value)); setPreview(undefined); }}><option value={0}>普通</option><option value={1}>优先</option><option value={2}>最优先</option></select></label>}
      <button type="button" disabled={pending || !selected.length} onClick={() => void previewOperation()}>预览操作</button><button type="button" disabled={pending || !selected.length} onClick={() => { setSelected([]); setPreview(undefined); setResults(undefined); }}>清空选择</button>
      {preview && <div className="vb-batch-preview"><h2>操作预览：{actions.find(([id]) => id === action)?.[1]}</h2><ul>{preview.map(item => <li key={item.sessionId}>{sessions.find(session => session.id === item.sessionId)?.title || "项目不可访问"} — {item.eligible ? "可执行" : item.reason}</li>)}</ul><button type="button" disabled={pending || Boolean(results) || !preview.some(item => item.eligible)} onClick={() => void execute()}>{pending ? "正在处理…" : "执行适用项"}</button></div>}
      {results && <ul className="vb-batch-results" aria-label="逐项操作结果">{results.map((item, index) => <li key={`${item.sessionId}:${index}`}>{sessions.find(session => session.id === item.sessionId)?.title || "项目"}：{item.ok ? "已接收" : "未执行"}，{item.reason}</li>)}</ul>}
      {error && <p role="alert">{error}</p>}
    </section>}
    <p className="vb-task-result" role="status">{sessions.length > 0 ? `${visible.length} 个任务` : "准备好你的第一份教案"}</p>
    {visible.length ? <ul className="vb-task-list">{shown.map(session => {
      const workflow = session.videosBatchWorkflow;
      const run = productionRuns.latest(session.id);
      const category = taskCategory(session, run, true);
      const title = session.title || "未命名课程视频";
      const updated = updatedLabel(session);
      const steps = VIDEOS_BATCH_PRODUCT_STEPS.map(step => workflow ? deriveProductStepStatus(workflow, step) : "pending");
      const completed = steps.filter(s => s === "ready").length;
      return <li key={session.id} className="vb-task-row">
        <label className="vb-task-check"><input type="checkbox" disabled={pending} aria-label={`选择任务：${title}`} checked={selected.includes(session.id)} onChange={event => { setSelected(ids => event.target.checked ? [...ids, session.id].slice(0,100) : ids.filter(id => id !== session.id)); setPreview(undefined); setResults(undefined); }} /></label>
        <div className="vb-task-copy"><h2 title={title}>{title}</h2><p className={`vb-task-status ${category}`}>{taskStatus(session)}{run ? ` · ${runStatusLabel[run.status]}` : ""}</p></div>
        <div className="vb-task-progress" aria-label={`已完成 ${completed} / 9 步`}><div aria-hidden="true">{steps.map((status, i) => <span key={i} className={status} />)}</div><small>{workflow ? `${completed} / 9 步` : "上传或粘贴教案开始"}</small></div>
        {updated && <time className="vb-task-time" dateTime={session.updatedAt || session.createdAt}>{updated}<small>更新</small></time>}
        <button className="vb-task-open" type="button" onClick={() => onSelect(session.id)} aria-label={`继续任务：${title}`}>{category === "done" ? "查看成片" : category === "attention" ? "去处理" : "继续任务"}<ArrowRight size={16} /></button>
      </li>;
    })}</ul> : <div className="vb-task-empty"><FileText size={32} aria-hidden="true" /><h2>{sessions.length ? "没有找到匹配的任务" : "让一份教案，成为一段好视频"}</h2><p>{sessions.length ? "试试其他名称，或查看全部任务。" : "上传 Word、PDF，或直接粘贴教案。你可以逐步审阅故事、画面与最终成片。"}</p>{sessions.length > 0 && <button type="button" onClick={() => { setQuery(""); setFilter("all"); }}>清除筛选</button>}</div>}
    {visible.length > 50 && <nav className="vb-task-pagination" aria-label="任务分页"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {Math.ceil(visible.length / 50)}</span><button type="button" disabled={(currentPage + 1) * 50 >= visible.length} onClick={() => setPage(currentPage + 1)}>下一页</button></nav>}
    <footer className="vb-task-bottom"><span>想看看已经发布的作品？</span><button type="button" onClick={onGallery}>浏览作品广场 <ArrowRight size={14} /></button></footer>
  </section>;
}
