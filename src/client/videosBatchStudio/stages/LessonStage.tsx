import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, FileText, LoaderCircle, RotateCcw, UploadCloud } from "lucide-react";
import { Tabs } from "radix-ui";
import { useDropzone } from "react-dropzone";
import type {
  VideosBatchLessonSource,
  VideosBatchParsedLessonDocument
} from "../../../shared/videosBatchWorkflow";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

const LESSON_ACCEPT = {
  "application/pdf": [".pdf"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/octet-stream": [".doc", ".docx", ".pdf"]
};

type ParseState =
  | { kind: "idle" }
  | { kind: "parsing"; fileName: string }
  | { kind: "ready"; document: VideosBatchParsedLessonDocument; draftText: string }
  | { kind: "error"; message: string };

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function LessonStage({
  sessionTitle,
  lessonText,
  source,
  busy,
  started,
  onParseFile,
  onStart
}: {
  sessionTitle: string;
  lessonText?: string;
  source?: VideosBatchLessonSource;
  busy?: boolean;
  started: boolean;
  onParseFile?: (file: File) => Promise<VideosBatchParsedLessonDocument>;
  onStart: (lessonText: string, source?: VideosBatchLessonSource) => Promise<void> | void;
}) {
  const [pasteDraft, setPasteDraft] = useState(lessonText || "");
  const [parseState, setParseState] = useState<ParseState>({ kind: "idle" });

  useEffect(() => {
    setPasteDraft(lessonText || "");
  }, [lessonText]);

  const parseFile = async (file: File) => {
    if (!onParseFile) {
      setParseState({ kind: "error", message: "教案解析服务尚未连接。" });
      return;
    }
    setParseState({ kind: "parsing", fileName: file.name });
    try {
      const document = await onParseFile(file);
      setParseState({ kind: "ready", document, draftText: document.text });
    } catch (error) {
      setParseState({ kind: "error", message: error instanceof Error ? error.message : "教案解析失败，请重新上传。" });
    }
  };

  const dropzone = useDropzone({
    accept: LESSON_ACCEPT,
    maxFiles: 1,
    maxSize: MAX_FILE_BYTES,
    multiple: false,
    disabled: started || busy || parseState.kind === "parsing",
    onDropAccepted(files) {
      const file = files[0];
      if (file) void parseFile(file);
    },
    onDropRejected(rejections) {
      const first = rejections[0];
      const code = first?.errors?.[0]?.code;
      const message = code === "file-too-large"
        ? "教案文件不能超过 25 MB。"
        : "仅支持 DOC、DOCX、PDF 教案文件。";
      setParseState({ kind: "error", message });
    }
  });

  if (started) {
    return (
      <section className="vbs-stage-page vbs-lesson-stage vbs-v2-lesson-readonly">
        <div className="vbs-stage-kicker">01 · 教案</div>
        <div className="vbs-document-header">
          <div>
            <h2>课程教案</h2>
            <p>这是后续课程导入、故事、资产和视频分镜的教学事实源。</p>
          </div>
          <div className="vbs-v2-source-chip">
            <FileText size={16} />
            <span>{source?.kind === "file" ? source.fileName || "已上传教案" : "粘贴文本"}</span>
          </div>
        </div>
        <article className="vbs-v2-lesson-document">
          <header>
            <div><small>项目</small><strong>{sessionTitle || "课程视频"}</strong></div>
            <span>{lessonText?.length || 0} 字</span>
          </header>
          <pre>{lessonText || "暂无教案内容"}</pre>
        </article>
      </section>
    );
  }

  const parsed = parseState.kind === "ready" ? parseState : undefined;

  return (
    <section className="vbs-stage-page vbs-lesson-stage vbs-v2-lesson-onboarding">
      <div className="vbs-v2-lesson-hero">
        <span className="vbs-stage-kicker">01 · 教案</span>
        <h1>从一份教案，开始制作课程视频</h1>
        <p>上传完整课程教案。系统先解析并让你确认内容，再生成三类九套课程导入方案。</p>
      </div>

      <Tabs.Root className="vbs-v2-lesson-tabs" defaultValue="upload">
        <Tabs.List className="vbs-v2-tab-list" aria-label="教案输入方式">
          <Tabs.Trigger className="vbs-v2-tab-trigger" value="upload"><UploadCloud size={15} /> 上传文件</Tabs.Trigger>
          <Tabs.Trigger className="vbs-v2-tab-trigger" value="paste"><FileText size={15} /> 粘贴文本</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content className="vbs-v2-tab-panel" value="upload">
          {!parsed ? (
            <>
              <div
                {...dropzone.getRootProps({
                  className: `vbs-v2-dropzone ${dropzone.isDragActive ? "dragging" : ""} ${parseState.kind === "error" ? "error" : ""}`
                })}
              >
                <input {...dropzone.getInputProps()} />
                <div className="vbs-v2-dropzone-icon">
                  {parseState.kind === "parsing" ? <LoaderCircle size={30} className="spin" /> : <UploadCloud size={30} />}
                </div>
                {parseState.kind === "parsing" ? (
                  <>
                    <strong>正在解析 {parseState.fileName}</strong>
                    <span>正在提取教案正文，请稍候…</span>
                  </>
                ) : (
                  <>
                    <strong>{dropzone.isDragActive ? "松开即可上传" : "拖入教案，或点击选择文件"}</strong>
                    <span>支持 DOC · DOCX · PDF，单个文件最大 25 MB</span>
                  </>
                )}
              </div>
              {parseState.kind === "error" && (
                <div className="vbs-v2-upload-error" role="alert"><AlertCircle size={16} /><span>{parseState.message}</span></div>
              )}
              <div className="vbs-v2-upload-note">
                <CheckCircle2 size={15} />
                <span>文件只用于提取教案文字；确认前不会启动生成流程。</span>
              </div>
            </>
          ) : (
            <div className="vbs-v2-parse-result">
              <header className="vbs-v2-file-summary">
                <div className="vbs-v2-file-icon"><FileText size={24} /></div>
                <div className="vbs-v2-file-copy">
                  <strong>{parsed.document.fileName}</strong>
                  <span>{parsed.document.fileType.toUpperCase()} · {formatBytes(parsed.document.sizeBytes)}</span>
                </div>
                <span className="vbs-v2-parse-success"><CheckCircle2 size={14} /> 解析完成</span>
              </header>

              <div className="vbs-v2-parse-metrics">
                <span><strong>{parsed.document.characterCount.toLocaleString()}</strong><small>字符</small></span>
                <span><strong>{parsed.document.paragraphCount.toLocaleString()}</strong><small>段落</small></span>
                {parsed.document.pageCount ? <span><strong>{parsed.document.pageCount}</strong><small>页</small></span> : null}
              </div>

              {parsed.document.warnings.length > 0 && (
                <div className="vbs-v2-parse-warning"><AlertCircle size={15} /><span>{parsed.document.warnings.join("；")}</span></div>
              )}

              <label className="vbs-v2-parse-editor">
                <span>确认教案内容 <small>可在开始前直接修正解析结果</small></span>
                <textarea
                  rows={16}
                  value={parsed.draftText}
                  onChange={(event) => setParseState({ ...parsed, draftText: event.target.value })}
                  aria-label="解析后的教案内容"
                />
              </label>

              <div className="vbs-v2-parse-actions">
                <button type="button" className="vbs-secondary" disabled={busy} onClick={() => setParseState({ kind: "idle" })}>
                  <RotateCcw size={15} /> 重新上传
                </button>
                <button
                  type="button"
                  className="vbs-primary vbs-v2-start-button"
                  disabled={busy || !parsed.draftText.trim()}
                  onClick={() => onStart(parsed.draftText.trim(), {
                    kind: "file",
                    fileName: parsed.document.fileName,
                    fileType: parsed.document.fileType,
                    sizeBytes: parsed.document.sizeBytes
                  })}
                >
                  {busy ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}
                  {busy ? "正在启动…" : "确认教案并开始制作"}
                </button>
              </div>
            </div>
          )}
        </Tabs.Content>

        <Tabs.Content className="vbs-v2-tab-panel" value="paste">
          <div className="vbs-v2-paste-panel">
            <label>
              <span>完整教案文本</span>
              <textarea
                value={pasteDraft}
                onChange={(event) => setPasteDraft(event.target.value)}
                rows={18}
                placeholder="粘贴教学目标、教学重难点、教学过程、课堂活动等完整教案内容……"
                aria-label="完整教案文本"
              />
            </label>
            <div className="vbs-v2-paste-footer">
              <span>{pasteDraft.trim().length.toLocaleString()} 字</span>
              <button
                type="button"
                className="vbs-primary vbs-v2-start-button"
                disabled={busy || !pasteDraft.trim()}
                onClick={() => onStart(pasteDraft.trim(), { kind: "pasted_text" })}
              >
                {busy ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}
                {busy ? "正在启动…" : "确认文本并开始制作"}
              </button>
            </div>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}
