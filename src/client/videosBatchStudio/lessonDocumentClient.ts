import type { VideosBatchParsedLessonDocument } from "../../shared/videosBatchWorkflow";

const ACCESS_TOKEN_STORAGE_KEY = "seereel_access_token";
const LEGACY_ACCESS_TOKEN_STORAGE_KEY = "reelyai_access_token";

function accessHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const token = window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)
      || window.localStorage.getItem(LEGACY_ACCESS_TOKEN_STORAGE_KEY)
      || "";
    return token ? { "x-seereel-access": token, "x-reelyai-access": token } : {};
  } catch {
    return {};
  }
}

export async function parseLessonDocumentFile(sessionId: string, file: File): Promise<VideosBatchParsedLessonDocument> {
  const params = new URLSearchParams({ filename: file.name });
  let response: Response;
  try {
    response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/videosbatch/lesson/parse?${params.toString()}`, {
      method: "POST",
      headers: {
        ...accessHeaders(),
        "Content-Type": file.type || "application/octet-stream"
      },
      body: file
    });
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("api-network-up"));
  } catch (error) {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("api-network-down"));
    throw error instanceof Error ? error : new Error("教案文件上传失败");
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error || `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<VideosBatchParsedLessonDocument>;
}
