// Isolated browser acceptance fixture: actual TaskList/view memory, synthetic data/API.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { TaskList } from "../../src/client/videosBatchStudio/TaskList";
import { useViewPosition, useViewState } from "../../src/client/productionCenter/viewMemory";
import { api } from "../../src/client/api";
import type { Session } from "../../src/shared/types";
import "../../src/client/videosBatchStudio/tokens.css";
import "../../src/client/videosBatchStudio/experience.css";
const sessions = Array.from({ length: 1000 }, (_, i) => ({ id: `project-${i}`, title: `合成项目 ${String(i).padStart(4,"0")}`, createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" } as Session));
api.previewBatch = async (_action, ids) => { await new Promise(resolve => setTimeout(resolve, 1500)); return ids.map(sessionId => ({sessionId, expectedVersion: "fixture", eligible: true})); };
api.executeBatch = async (_action, items) => items.map(item => ({ sessionId: item.sessionId, ok: true, reason: "合成接收" }));
function Editor({ id, back }: { id:string; back:()=>void }) {
  const ref = useViewPosition(id); const [value, setValue] = useViewState(`${id}:draft`, "合成长文".repeat(5000));
  return <section ref={ref}><button onClick={back}>返回合成列表</button><h1>{id}</h1><textarea aria-label="合成编辑器" style={{width:"95%",height:400}} value={value} onChange={event=>setValue(event.target.value)}/></section>;
}
function App() {
  const [id,setId]=useState("");
  return id ? <Editor key={id} id={id} back={()=>setId("")} /> : <TaskList sessions={sessions} onSelect={setId} onCreate={()=>{}} onGallery={()=>{}}/>;
}
createRoot(document.getElementById("root")!).render(<App/>);
