import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import type { Asset, AssetImageModel, AssetImageSize, AssetPromptAdaptation, SessionWithShots, Shot, StoryBeat, StoryPlan } from "../shared/types";
import { composeSeedanceVideoText, composeSeedreamAssetPrompt, type Lang } from "./promptCompose";
import { fetchWithRetry } from "./fetchWithRetry";
import { arkMissingKeyMessage, BYTEPLUS_ARK_BASE, resolveArkCredential, VOLCENGINE_CN_ARK_BASE, type ArkCredential, type StandardCredentialRouteConfig } from "./arkCredentials";
import { seedreamWebSearchPayload } from "./seedreamOptions";
import { loadPromptTemplate } from "./prompts/promptTemplates";
import { generateShotVideoViaNewApiH3 } from "./videosBatchWorkflow/newApiH3Video";
import type { VideosBatchAudioTimeline } from "../shared/videosBatchWorkflow";
import type { VideosBatchReferenceBinding } from "../shared/videosBatchNativeProjection";

export interface BuildSeedancePayloadOpts {
  /** Override the assembled text content. Used when the user audited & edited the dryRun preview. */
  prebuiltText?: string;
  /** Session spoken language for the submitted text. Default `"zh"`; still enforced when `prebuiltText` is set. */
  lang?: Lang;
  /**
   * Per-shot override for Seedance's `generate_audio` flag. `true` forces audio on, `false`
   * forces audio off, `undefined` falls through to env `SEEDANCE_GENERATE_AUDIO` (default true
   * unless that env equals "false"). Used when the caller wants a clean silent video — Seedance's
   * auto-generated dialogue is often gibberish and cleaner to suppress than to direct via prompt.
   */
  generateAudio?: boolean;
  /** Request-scoped credential captured before handing work to background tasks. */
  credential?: ArkCredential;
  /** VideosBatch NewAPI H3 hook: persist the upstream task id before polling starts. */
  onProviderTaskSubmitted?(taskId: string): Promise<void> | void;
  /** VideosBatch NewAPI H3 hook: persist ordered references before the paid POST. */
  onProviderReferenceBindingsPrepared?(bindings: VideosBatchReferenceBinding[]): Promise<void> | void;
  /** VideosBatch NewAPI H3 hook: capture the exact compiled prompt before the paid POST. */
  onProviderPromptPrepared?(prompt: string): Promise<void> | void;
  /** Resume an already-submitted NewAPI H3 task without issuing another POST. */
  taskId?: string | null;
}

export const MEDIA_DIR = path.resolve(process.cwd(), "data", "media");

/**
 * 集中提示词段落区：与媒体生成相关的系统/风格提示词骨架一律存放在
 * src/server/prompts/*.md（loadPromptTemplate 启动加载、缺失即抛错），
 * 组装函数只做段落注入与变量插值，不再内嵌整句提示词。
 */
const SHORT_FILM_OUTLINE_SYSTEM_PROMPT = loadPromptTemplate("short-film-outline");

const BYTEPLUS_SEEDANCE_BASE = BYTEPLUS_ARK_BASE;
const BYTEPLUS_SEEDANCE_MODEL = "dreamina-seedance-2-0-260128";
const BYTEPLUS_SEEDANCE_FAST_MODEL = "dreamina-seedance-2-0-fast-260128";
const VOLCENGINE_CN_SEEDANCE_BASE = VOLCENGINE_CN_ARK_BASE;
const VOLCENGINE_CN_SEEDANCE_MODEL = "doubao-seedance-2-0";
const VOLCENGINE_CN_SEEDANCE_FAST_MODEL = "doubao-seedance-2-0-fast";
const AGENT_PLAN_SEEDANCE_MODEL = "doubao-seedance-2-0-260128";
const AGENT_PLAN_SEEDANCE_FAST_MODEL = "doubao-seedance-2-0-fast-260128";
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "canceled"]);
const STITCH_SIGNATURE_VERSION = "stitch-v5-exact-10s-normalized-crf18-high";
const openAIKey = () => process.env.OAI_KEY || process.env.OPENAI_API_KEY;
export const seedanceTimeoutMs = () => Number(process.env.SEEDANCE_TIMEOUT_MS || 45 * 60 * 1000);
const stitchDownloadConcurrency = () => Math.max(1, Number(process.env.STITCH_DOWNLOAD_CONCURRENCY || 2));
const ffmpegLogBytes = () => Math.max(1024, Number(process.env.STITCH_FFMPEG_LOG_BYTES || 4096));

const jsonHeaders = (apiKey?: string) => ({
  "Content-Type": "application/json",
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
});
const SEEDREAM_KEY_ENVS = [
  "BP_ARK_API_KEY",
  "BP_SEEDREAM_API_KEY",
  "CN_ARK_API_KEY",
  "CN_SEEDREAM_API_KEY",
  "ARK_AGENT_PLAN_KEY"
];
const SEEDANCE_KEY_ENVS = [
  "BP_ARK_API_KEY",
  "BP_SEEDANCE_API_KEY",
  "CN_ARK_API_KEY",
  "CN_SEEDANCE_API_KEY",
  "ARK_AGENT_PLAN_KEY"
];
const SEEDREAM_STANDARD_ROUTES: StandardCredentialRouteConfig[] = [
  {
    route: "byteplus",
    keyEnvNames: ["BP_ARK_API_KEY", "BP_SEEDREAM_API_KEY"],
    baseEnvNames: ["BP_SEEDREAM_API_BASE"],
    defaultBase: BYTEPLUS_SEEDANCE_BASE
  },
  {
    route: "volcengine-cn",
    keyEnvNames: ["CN_ARK_API_KEY", "CN_SEEDREAM_API_KEY"],
    baseEnvNames: ["CN_SEEDREAM_API_BASE"],
    defaultBase: VOLCENGINE_CN_SEEDANCE_BASE
  }
];
const SEEDANCE_STANDARD_ROUTES: StandardCredentialRouteConfig[] = [
  {
    route: "byteplus",
    keyEnvNames: ["BP_ARK_API_KEY", "BP_SEEDANCE_API_KEY"],
    baseEnvNames: ["BP_SEEDANCE_API_BASE"],
    defaultBase: BYTEPLUS_SEEDANCE_BASE
  },
  {
    route: "volcengine-cn",
    keyEnvNames: ["CN_ARK_API_KEY", "CN_SEEDANCE_API_KEY"],
    baseEnvNames: ["CN_SEEDANCE_API_BASE"],
    defaultBase: VOLCENGINE_CN_SEEDANCE_BASE
  }
];

/**
 * Guard against "silent fake success": when a paid model key is missing the dev paths return a
 * placeholder image/video URL so the canvas still renders something. In production that would make a
 * misconfigured deployment look like it is generating real media. Refuse explicitly instead.
 */
function refuseFakeSuccessInProduction(label: string, keyEnvs: string[]): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(arkMissingKeyMessage(label, keyEnvs));
  }
}

function seedreamCredential() {
  return resolveArkCredential({
    keyEnvNames: SEEDREAM_KEY_ENVS,
    baseEnvNames: ["BP_SEEDREAM_API_BASE"],
    defaultBase: BYTEPLUS_SEEDANCE_BASE,
    standardRoutes: SEEDREAM_STANDARD_ROUTES
  });
}

export function seedreamCredentialSource() {
  return seedreamCredential().source;
}

export function resolveSeedreamCredential() {
  return seedreamCredential();
}

export function defaultSeedreamAssetImageModel(): AssetImageModel {
  return seedreamCredentialSource() === "agent-plan" ? "seedream-5-lite" : "seedream-4-5";
}

function seedanceCredential() {
  return resolveArkCredential({
    keyEnvNames: SEEDANCE_KEY_ENVS,
    baseEnvNames: ["SEEDANCE_API_BASE"],
    defaultBase: BYTEPLUS_SEEDANCE_BASE,
    standardRoutes: SEEDANCE_STANDARD_ROUTES
  });
}

export function resolveSeedanceCredential() {
  return seedanceCredential();
}

export interface StoryboardPlanResult {
  shots: Array<Partial<Shot> & { index?: number }>;
  model?: string;
  rawUsage?: unknown;
}

export interface StoryPlanResult {
  story: StoryPlan;
  model?: string;
  rawUsage?: unknown;
}

export async function generateStoryboard(session: SessionWithShots, assets: Asset[]): Promise<Array<Partial<Shot> & { index?: number }>> {
  return (await generateStoryboardDetailed(session, assets)).shots;
}

export async function generateStoryboardDetailed(session: SessionWithShots, assets: Asset[]): Promise<StoryboardPlanResult> {
  const planningAssets = sessionScopedPlanningAssets(session, assets);
  if (session.story?.beats?.length) {
    const shots = session.shots.map((shot, index) => {
      const beat = session.story?.beats.find((item) => item.index === shot.index) || session.story?.beats[index % session.story.beats.length];
      return beat ? shotFromStoryBeat(session, beat, shot, planningAssets) : undefined;
    }).filter(Boolean) as Array<Partial<Shot>>;
    return { shots, model: session.story.model };
  }

  const apiKey = openAIKey();
  if (apiKey) {
    try {
      const model = process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini";
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: jsonHeaders(apiKey),
        body: JSON.stringify({
          model,
          input: [
            {
              role: "system",
              content:
                "You are a short-film storyboard director. Return strict JSON only. Create concise cinematic shot plans in Chinese."
            },
            {
              role: "user",
              content: JSON.stringify({
                title: session.title,
                logline: session.logline,
                style: session.style,
                targetDurationSec: session.targetDurationSec,
                shotCount: session.shots.length,
                assets: planningAssets.map((asset) => ({
                  name: asset.name,
                  type: asset.type,
                  description: asset.description
                })),
                schema: {
                  shots: [
                    {
                      index: 1,
                      title: "short title",
                      script: "what happens on screen",
                      camera: "camera, light, movement",
                      prompt: "video generation prompt"
                    }
                  ]
                }
              })
            }
          ],
          text: { format: { type: "json_object" } }
        })
      });

      if (response.ok) {
        const data = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }>; usage?: unknown };
        const text = data.output_text || data.output?.flatMap((item) => item.content ?? []).map((item) => item.text).join("");
        if (text) {
          const parsed = JSON.parse(text) as { shots?: Array<Partial<Shot>> };
          if (Array.isArray(parsed.shots) && parsed.shots.length) return { shots: parsed.shots, model, rawUsage: data.usage };
        }
      }
    } catch {
      // Fall through to the local planner so the product workflow remains usable offline.
    }
  }

  const beats = [
    "建立世界和主角当前状态",
    "出现扰动，主角被迫行动",
    "发现关键线索或异常规则",
    "第一次尝试失败，情绪压力上升",
    "资产或场景中的关键细节被重新理解",
    "主角做出不可逆选择",
    "高潮镜头，核心冲突被视觉化",
    "余韵收束，留下短片的最后情绪"
  ];

  const shots = session.shots.map((shot, index) => {
    const beat = beats[index % beats.length];
    const title = `${String(index + 1).padStart(2, "0")} ${beat}`;
    const script = `${session.logline}\n本分镜承担“${beat}”：让画面清晰推进一个叙事动作，并保持人物、场景和道具连续。`;
    const camera =
      index % 3 === 0
        ? "wide establishing shot, slow dolly movement, practical motivated light"
        : index % 3 === 1
          ? "medium close shot, handheld tension, shallow depth of field"
          : "detail insert and reaction shot, precise focus pull, restrained movement";
    const prompt = [
      `Short film: ${session.title}`,
      `Style: ${session.style}`,
      `Shot ${index + 1}: ${title}`,
      `Script: ${script}`,
      `Camera: ${camera}`,
      "Generate a coherent cinematic video shot for Seedance 2.0. Preserve continuity across shots."
    ].join("\n");

    return { index: index + 1, title, script, camera, prompt };
  });
  return { shots, model: "local-template" };
}

export async function generateStoryPlan(session: SessionWithShots, assets: Asset[]): Promise<StoryPlan> {
  return (await generateStoryPlanDetailed(session, assets)).story;
}

export async function generateStoryPlanDetailed(session: SessionWithShots, assets: Asset[]): Promise<StoryPlanResult> {
  const planningAssets = sessionScopedPlanningAssets(session, assets);
  if (session.story?.locked) return { story: normalizeStoryPlan(session.story, session, planningAssets, session.story.model || "locked"), model: session.story.model || "locked" };

  const fallback = buildLocalStoryPlan(session, planningAssets);
  const apiKey = openAIKey();
  if (!apiKey) return { story: fallback, model: "local-template" };

  try {
    const model = process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini";
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: jsonHeaders(apiKey),
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: SHORT_FILM_OUTLINE_SYSTEM_PROMPT
          },
          {
            role: "user",
            content: JSON.stringify({
              title: session.title,
              logline: session.logline,
              style: session.style,
              targetDurationSec: session.targetDurationSec,
              shotCount: session.shots.length,
              assets: planningAssets.map((asset) => ({
                id: asset.id,
                name: asset.name,
                type: asset.type,
                description: asset.description,
                tags: asset.tags
              })),
              requirements: [
                "synopsis 使用 300-800 中文字",
                "beats 数量必须等于 shotCount",
                "每个 beat 的 durationSec 必须在 1-15 秒之间",
                "assetMentions 使用 @资产名 格式，例如 @男主角/顾沉",
                "不要新增不可拍摄的大段内心独白"
              ],
              schema: {
                premise: "一句话故事",
                synopsis: "300-800字短片大纲",
                theme: "主题",
                tone: "风格/情绪",
                characters: [
                  {
                    name: "角色名",
                    role: "故事功能",
                    arc: "角色变化",
                    assetId: "可选资产id",
                    assetMention: "@资产名"
                  }
                ],
                beats: [
                  {
                    index: 1,
                    title: "节拍标题",
                    purpose: "戏剧功能",
                    plot: "发生什么",
                    emotion: "情绪变化",
                    visual: "画面执行",
                    assetMentions: ["@资产名"],
                    durationSec: 15
                  }
                ],
                locked: false
              }
            })
          }
        ],
        text: { format: { type: "json_object" } }
      })
    });

    if (!response.ok) return { story: fallback, model: "local-template" };
    const data = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }>; usage?: unknown };
    const text = data.output_text || data.output?.flatMap((item) => item.content ?? []).map((item) => item.text).join("");
    if (!text) return { story: fallback, model: "local-template" };
    return { story: normalizeStoryPlan(JSON.parse(text), session, planningAssets, model), model, rawUsage: data.usage };
  } catch {
    return { story: fallback, model: "local-template" };
  }
}

function shotFromStoryBeat(session: SessionWithShots, beat: StoryBeat, shot: Shot, assets: Asset[]): Partial<Shot> {
  const assetMentions = normalizeAssetMentions(beat.assetMentions);
  const assetText = assetMentions.length ? `\n资产引用：${assetMentions.join(" ")}` : "";
  const script = [`节拍目的：${beat.purpose}`, `剧情动作：${beat.plot}`, `情绪变化：${beat.emotion}`].join("\n");
  const camera = `画面执行：${beat.visual}\n风格基调：${session.story?.tone || session.style}`;
  const prompt = [
    `${assetMentions.join(" ")} ${beat.plot}`.trim(),
    `短片：${session.title}`,
    `剧本节拍 ${beat.index}：${beat.title}`,
    script,
    camera,
    assetText,
    "严格按照本节拍推进，不新增节拍外的反转、人物或对白。"
  ]
    .filter(Boolean)
    .join("\n");

  return {
    index: shot.index,
    storyBeatIndex: beat.index,
    title: beat.title || shot.title,
    script,
    camera,
    rawPrompt: prompt,
    prompt,
    durationSec: Math.min(Math.max(Number(beat.durationSec) || shot.durationSec || 1, 1), 15)
  };
}

export function buildLocalStoryPlan(session: SessionWithShots, assets: Asset[]): StoryPlan {
  const planningAssets = sessionScopedPlanningAssets(session, assets);
  const beatTitles = [
    "建立处境",
    "扰动出现",
    "发现线索",
    "压力升级",
    "重新理解",
    "不可逆选择",
    "冲突高潮",
    "余韵收束"
  ];
  const perBeat = Math.min(15, Math.max(1, Math.round(session.targetDurationSec / Math.max(session.shots.length, 1))));
  const mentions = planningAssets.slice(0, 4).map((asset) => `@${formatAssetMention(asset.name)}`);
  return normalizeStoryPlan(
    {
      premise: session.logline || `${session.title} 的短片故事`,
      synopsis:
        session.logline ||
        `${session.title} 围绕一个清晰的视觉冲突展开：主角在有限时间内被迫面对一个改变关系和命运的选择。故事以具体动作推进，强调人物状态、场景压力和结尾余韵。`,
      theme: "人在压力下选择诚实面对自己",
      tone: session.style || "电影感、克制、真实、情绪逐步升高",
      characters: planningAssets
        .filter((asset) => asset.type === "character")
        .slice(0, 4)
        .map((asset) => ({
          name: asset.name,
          role: "推动故事的关键人物",
          arc: "从被动反应走向主动选择",
          assetId: asset.id,
          assetMention: `@${formatAssetMention(asset.name)}`
        })),
      beats: session.shots.map((shot, index) => ({
        index: shot.index,
        title: `${String(shot.index).padStart(2, "0")} ${beatTitles[index % beatTitles.length]}`,
        purpose: beatTitles[index % beatTitles.length],
        plot: `${session.logline || session.title}。本节拍让人物通过一个可见动作推进故事。`,
        emotion: index === 0 ? "压抑、观察" : index === session.shots.length - 1 ? "释放、余韵" : "紧张升级",
        visual:
          index % 2 === 0
            ? "用环境建立空间关系，角色动作清晰，光线和道具保持连续。"
            : "用中近景和细节反应推进情绪，保留前一镜的运动和节奏。",
        assetMentions: mentions,
        durationSec: perBeat
      })),
      locked: false
    },
    session,
    planningAssets,
    "local-template"
  );
}

function sessionScopedPlanningAssets(session: SessionWithShots, assets: Asset[]) {
  const shotIds = new Set(session.shots.map((shot) => shot.id));
  const explicitAssetIds = new Set<string>();
  session.shots.forEach((shot) => {
    (shot.assetIds || []).forEach((id) => explicitAssetIds.add(id));
    addDefinedAssetId(explicitAssetIds, shot.firstFrameAssetId);
    addDefinedAssetId(explicitAssetIds, shot.lastFrameAssetId);
    addDefinedAssetId(explicitAssetIds, shot.subShotStoryboardAssetId);
    (shot.subShotStoryboardAssetIds || []).forEach((id) => explicitAssetIds.add(id));
    addDefinedAssetId(explicitAssetIds, shot.referenceVideoAssetId);
  });

  return assets.filter((asset) => {
    if (asset.ownerSessionId === session.id) return true;
    if (asset.ownerShotId && shotIds.has(asset.ownerShotId)) return true;
    return explicitAssetIds.has(asset.id);
  });
}

function addDefinedAssetId(ids: Set<string>, value: string | undefined | null) {
  if (value) ids.add(value);
}

function normalizeStoryPlan(value: unknown, session: SessionWithShots, assets: Asset[], model?: string): StoryPlan {
  const body = isRecord(value) ? value : {};
  const beatsValue = Array.isArray(body.beats) ? body.beats : [];
  const perBeat = Math.min(15, Math.max(1, Math.round(session.targetDurationSec / Math.max(session.shots.length, 1))));
  const beats = session.shots.map((shot, index) => {
    const source = beatsValue.find((item) => isRecord(item) && Number(item.index) === shot.index) || beatsValue[index];
    const beat = isRecord(source) ? source : {};
    return {
      index: shot.index,
      title: String(beat.title || `Shot ${shot.index}`),
      purpose: String(beat.purpose || "推进剧情"),
      plot: String(beat.plot || session.logline || session.title),
      emotion: String(beat.emotion || "情绪递进"),
      visual: String(beat.visual || "电影感画面，动作清晰，保持连续性"),
      assetMentions: normalizeAssetMentions(Array.isArray(beat.assetMentions) ? beat.assetMentions.map(String) : inferAssetMentions(String(beat.plot || ""), assets)),
      durationSec: Math.min(Math.max(Number(beat.durationSec) || shot.durationSec || perBeat, 1), 15)
    };
  });
  const charactersValue = Array.isArray(body.characters) ? body.characters : [];
  const characters = charactersValue
    .map((item) => (isRecord(item) ? item : {}))
    .map((item) => ({
      name: String(item.name || ""),
      role: String(item.role || ""),
      arc: String(item.arc || ""),
      assetId: typeof item.assetId === "string" ? item.assetId : undefined,
      assetMention: typeof item.assetMention === "string" ? item.assetMention : undefined
    }))
    .filter((item) => item.name || item.assetMention);

  return {
    premise: String(body.premise || session.logline || session.title),
    synopsis: String(body.synopsis || session.logline || ""),
    theme: String(body.theme || "选择与自我面对"),
    tone: String(body.tone || session.style || "cinematic, emotionally grounded"),
    characters,
    beats,
    locked: Boolean(body.locked),
    updatedAt: new Date().toISOString(),
    model
  };
}

function inferAssetMentions(text: string, assets: Asset[]) {
  const normalized = normalizeMentionText(text);
  return assets
    .filter((asset) => [asset.name, ...(asset.tags || [])].some((name) => normalized.includes(normalizeMentionText(name))))
    .map((asset) => `@${formatAssetMention(asset.name)}`);
}

function normalizeAssetMentions(values: string[] = []) {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => (value.startsWith("@") ? value : `@${value}`))
        .map((value) => value.replace(/\s*\/\s*/g, "/").replace(/\s+/g, ""))
    )
  );
}

function normalizeMentionText(value: string) {
  return value.toLowerCase().replace(/\s+/g, "").replace(/／/g, "/").trim();
}

function formatAssetMention(name: string) {
  return name.replace(/\s*\/\s*/g, "/").replace(/\s+/g, "");
}

export interface SeedreamGenerateOpts {
  /** Override the assembled Seedream prompt verbatim (post user-edit from dryRun preview). */
  promptOverride?: string;
  /** Assets matching `referenceImageUrls` order, used only to bind @ names to attached images. */
  referenceAssets?: Array<Pick<Asset, "id" | "prompt" | "description" | "name" | "type" | "mediaKind">>;
  /** Output language for reference-binding metadata. Default `"zh"`. */
  lang?: Lang;
  /** Seedream output size. Defaults to 2K when neither caller nor env overrides it. */
  size?: AssetImageSize;
}

export interface AssetImageResult {
  url: string;
  /** The provider prompt actually submitted (audit trail). */
  composedPrompt: string;
  /** The model variant that actually produced the image. Can differ from the request after fallback. */
  model: AssetImageModel;
  /** The concrete provider model id sent to the image API. */
  actualModelId?: string;
  /** Which credential route was used for the generation. */
  credentialSource?: ArkCredential["source"];
  /** Set only when a provider-safe retry was required after a policy rejection. */
  promptAdaptation?: AssetPromptAdaptation;
  rawUsage?: unknown;
}

export async function generateAssetImage(
  asset: Asset,
  model: AssetImageModel = "seedream-4-5",
  referenceImageUrls: string[] = [],
  opts: SeedreamGenerateOpts = {}
): Promise<AssetImageResult> {
  if (model === "seedream-4-5") {
    try {
      return await generateAssetImageViaSeedream(asset, referenceImageUrls, "seedream-4-5", opts);
    } catch (error) {
      // Some Ark / BytePlus accounts or regions have Seedream 4.0 enabled but not the newer 4.5
      // model. The canvas picker defaults to 4.5, so without this fallback "出图" hard-fails with
      // InvalidEndpointOrModel.NotFound even though a working Seedream model is configured.
      if (!isMissingSeedreamModelError(error)) throw error;
      console.warn(`[seedream] ${asset.id} requested seedream-4-5 but model is unavailable; falling back to seedream-4`);
      return await generateAssetImageViaSeedream(asset, referenceImageUrls, "seedream-4", opts);
    }
  }
  if (model === "seedream-4") return generateAssetImageViaSeedream(asset, referenceImageUrls, "seedream-4", opts);
  if (model === "seedream-5-lite") return generateAssetImageViaSeedream(asset, referenceImageUrls, "seedream-5-lite", opts);
  if (model === "gpt-image-2-1k") {
    const generated = await generateAssetImageViaLyaiapp(asset, referenceImageUrls);
    return {
      url: generated.url,
      composedPrompt: generated.submittedPrompt,
      model: "gpt-image-2-1k",
      promptAdaptation: generated.promptAdaptation
    };
  }
  const url = await generateAssetImageViaOpenAI(asset, referenceImageUrls);
  return { url, composedPrompt: assetUserPrompt(asset), model: "gpt-image-2" };
}

/**
 * Remove only provider-sensitive identity/age wording after an explicit
 * content-policy rejection. The canonical asset prompt remains untouched in
 * storage; this text is a temporary submission variant for the provider.
 */
export function buildProviderSafeImagePrompt(prompt: string) {
  const original = prompt.trim();
  if (!original) return original;
  let safe = original
    .replace(/(?:中国)?小学(?:女生|男生)(?:[\u4e00-\u9fff]{1,4}(?=[，,、。；;：:]))?/gu, "虚构的教育类非写实动画学生角色")
    .replace(/中国小学普通同学基础角色/gu, "虚构的教育类非写实动画学生角色")
    .replace(/小学普通同学/gu, "虚构的教育类非写实动画学生角色")
    .replace(/(?:小学生|未成年人|女孩|男孩)/gu, "虚构的教育类非写实动画学生角色")
    .replace(/纤细匀称的儿童体型/gu, "纤细匀称的角色体型")
    .replace(/儿童体型/gu, "自然匀称的角色体型")
    .replace(/儿童/gu, "动画角色")
    .replace(/(?:约|大约|年龄(?:为|是)?|年约)?\s*\d{1,3}\s*岁/gu, "")
    .replace(/虚构的教育类非写实动画学生角色(?:[，,、]\s*){2,}/gu, "虚构的教育类非写实动画学生角色，")
    .replace(/[，,]\s*[，,]/gu, "，")
    .replace(/[，,]\s*[。；;]/gu, "。")
    .replace(/[。]\s*[。]/gu, "。")
    .replace(/\s{2,}/gu, " ")
    .trim();
  const safetyClause = "明确为虚构的非写实教育动画角色，不涉及真人、不涉及性化、伤害或危险情节";
  if (!safe.includes("不涉及性化")) {
    safe = `${safe.replace(/[。；;]+$/u, "")}；${safetyClause}。`;
  }
  return safe;
}

type LyaiappImageGenerationResult = {
  url: string;
  submittedPrompt: string;
  promptAdaptation?: AssetPromptAdaptation;
};

function imageContentPolicyError(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "IMAGE_CONTENT_POLICY");
}

async function generateAssetImageViaLyaiapp(asset: Asset, referenceImageUrls: string[] = []): Promise<LyaiappImageGenerationResult> {
  const apiKey = process.env.VIDEOSBATCH_IMAGE_API_KEY?.trim();
  if (!apiKey) throw new Error("Lyaiapp 图片生成需要配置 VIDEOSBATCH_IMAGE_API_KEY");
  const baseUrl = (process.env.VIDEOSBATCH_IMAGE_BASE_URL?.trim() || "https://api.lyaiapp.com/v1").replace(/\/+$/, "");
  const refs = await prepareOpenAIReferenceImages(referenceImageUrls);
  const canonicalPrompt = assetUserPrompt(asset);
  const requestImage = async (prompt: string) => {
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: { ...jsonHeaders(apiKey), "User-Agent": "curl/8.5.0" },
      body: JSON.stringify({
        model: process.env.VIDEOSBATCH_IMAGE_MODEL?.trim() || "gpt-image-2-1k",
        prompt,
        size: process.env.VIDEOSBATCH_IMAGE_SIZE?.trim() || "16:9",
        ...(refs.length ? { image_urls: refs } : {})
      })
    });
    const responseText = await response.text();
    if (!response.ok) {
      let providerCode = "";
      try {
        const parsed = responseText ? JSON.parse(responseText) as { error?: { code?: unknown } } : {};
        providerCode = typeof parsed.error?.code === "string" ? parsed.error.code : "";
      } catch {
        // Keep the bounded raw detail below; classification does not depend on JSON shape.
      }
      const error = new Error(`Lyaiapp image API failed: ${response.status} ${responseText.slice(0, 1000)}`);
      Object.assign(error, {
        code: providerCode === "content_policy_violation" ? "IMAGE_CONTENT_POLICY" : `IMAGE_HTTP_${response.status}`,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500
      });
      throw error;
    }
    const body = responseText ? JSON.parse(responseText) as { data?: Array<{ url?: string; b64_json?: string }> } : {};
    const first = body.data?.[0];
    if (first?.url) return first.url;
    if (first?.b64_json) return `data:image/png;base64,${first.b64_json}`;
    throw new Error("Lyaiapp image API returned no image");
  };

  try {
    return { url: await requestImage(canonicalPrompt), submittedPrompt: canonicalPrompt };
  } catch (error) {
    if (!imageContentPolicyError(error)) throw error;
    const safePrompt = buildProviderSafeImagePrompt(canonicalPrompt);
    if (!safePrompt || safePrompt === canonicalPrompt) throw error;
    const adaptation: AssetPromptAdaptation = {
      strategy: "provider-safe-v1",
      trigger: "IMAGE_CONTENT_POLICY",
      originalPromptHash: createHash("sha256").update(canonicalPrompt).digest("hex"),
      submittedPromptHash: createHash("sha256").update(safePrompt).digest("hex")
    };
    return {
      url: await requestImage(safePrompt),
      submittedPrompt: safePrompt,
      promptAdaptation: adaptation
    };
  }
}

function isMissingSeedreamModelError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /InvalidEndpointOrModel\.NotFound|model or endpoint .* does not exist|does not have access/i.test(message);
}

export async function expandAssetPrompt(asset: Partial<Asset>) {
  return { prompt: assetUserPrompt(asset), model: "user-prompt", rawUsage: undefined };
}

function assetUserPrompt(asset: Partial<Pick<Asset, "prompt" | "description" | "name">>) {
  return (asset.prompt || asset.description || asset.name || "").trim();
}

async function generateAssetImageViaOpenAI(asset: Asset, referenceImageUrls: string[] = []) {
  const apiKey = openAIKey();
  if (!apiKey) {
    return `https://placehold.co/1024x1024/1f2937/f8fafc?text=${encodeURIComponent(asset.name)}`;
  }
  const usableRefs = await prepareOpenAIReferenceImages(referenceImageUrls);
  const prompt = assetUserPrompt(asset);
  const endpoint = usableRefs.length ? "edits" : "generations";
  const response = await fetch(`https://api.openai.com/v1/images/${endpoint}`, {
    method: "POST",
    headers: jsonHeaders(apiKey),
    body: JSON.stringify({
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
      prompt,
      ...(usableRefs.length ? { images: usableRefs.map((url) => ({ image_url: url })) } : {}),
      size: process.env.OPENAI_IMAGE_SIZE || "1536x1024"
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI image API failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
  const first = data.data?.[0];
  if (first?.url) return first.url;
  if (first?.b64_json) {
    await mkdir(MEDIA_DIR, { recursive: true });
    const fileName = `${asset.id}-asset.png`;
    await writeFile(path.join(MEDIA_DIR, fileName), Buffer.from(first.b64_json, "base64"));
    return `/media/${fileName}`;
  }
  throw new Error("OpenAI image API returned no image");
}

async function prepareOpenAIReferenceImages(urls: string[]) {
  const results: string[] = [];
  for (const url of urls) {
    if (!url) continue;
    if (url.startsWith("data:image/")) {
      results.push(url);
      continue;
    }
    if (url.startsWith("/media/")) {
      const dataUrl = await readLocalMediaAsDataUrl(url);
      if (dataUrl) results.push(dataUrl);
      continue;
    }
    if (/^https?:\/\//.test(url)) {
      results.push(await downloadImageAsDataUrl(url));
    }
  }
  return results;
}

async function downloadImageAsDataUrl(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const bytes = Buffer.from(await response.arrayBuffer());
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } finally {
    clearTimeout(timer);
  }
}

type SeedreamVariant = "seedream-4" | "seedream-4-5" | "seedream-5-lite";
const SEEDREAM_MAX_REFERENCE_IMAGES = 14;

const SEEDREAM_DEFAULT_MODEL: Record<Exclude<SeedreamVariant, "seedream-5-lite">, string> = {
  "seedream-4": "doubao-seedream-4-0-250828",
  "seedream-4-5": "doubao-seedream-4-5-251128"
};
const SEEDREAM_5_LITE_MODEL = "doubao-seedream-5.0-lite";

// The 4.5 model accepts the same OpenAI-compatible image-generation request shape as 4.0
// (model + prompt + size + optional image references). We keep a per-variant model id and a shared
// SEEDREAM_SIZE so callers can override either independently.
// Keep operator-provided model ids authoritative. BytePlus ModelArk commonly uses the short ids
// (`seedream-4-5-251128` / `seedream-4-0-250828`), while Volcengine Ark may expose the
// `doubao-...` ids. Do NOT normalize unconditionally; instead try alternates only after the first
// id returns InvalidEndpointOrModel.NotFound.
function seedreamModelAlternates(modelId: string, credential: ArkCredential) {
  const routePreferredModel = seedreamModelForRoute(modelId, credential.standardRoute);
  const ids = [routePreferredModel];
  if (routePreferredModel.startsWith("seedream-")) ids.push(`doubao-${routePreferredModel}`);
  if (routePreferredModel.startsWith("doubao-seedream-")) ids.push(routePreferredModel.replace(/^doubao-/, ""));
  return [...new Set(ids)];
}

function seedreamModelForRoute(modelId: string, route?: string) {
  if (route === "volcengine-cn" && modelId.startsWith("seedream-")) return `doubao-${modelId}`;
  if (route === "byteplus" && modelId.startsWith("doubao-seedream-")) return modelId.replace(/^doubao-/, "");
  return modelId;
}

export function resolveSeedreamModelIds(variant: SeedreamVariant, usesAgentPlan = false) {
  if (usesAgentPlan) {
    return [process.env.SEEDREAM_AGENT_PLAN_MODEL || process.env.SEEDREAM_50_LITE_MODEL || process.env.SEEDREAM_5_LITE_MODEL || SEEDREAM_5_LITE_MODEL];
  }
  if (variant === "seedream-5-lite") {
    return [process.env.SEEDREAM_50_LITE_MODEL || process.env.SEEDREAM_5_LITE_MODEL || process.env.SEEDREAM_AGENT_PLAN_MODEL || SEEDREAM_5_LITE_MODEL];
  }
  const model = variant === "seedream-4-5"
    ? process.env.SEEDREAM_45_MODEL || process.env.SEEDREAM_4_5_MODEL || SEEDREAM_DEFAULT_MODEL["seedream-4-5"]
    : process.env.SEEDREAM_MODEL || SEEDREAM_DEFAULT_MODEL["seedream-4"];
  return [model];
}

function normalizeSeedreamSize(value: unknown): AssetImageSize | undefined {
  return value === "4K" || value === "2K" ? value : undefined;
}

export interface SeedreamImageRequestBodyInput {
  model: string;
  prompt: string;
  image?: string[];
  size: AssetImageSize;
  supportsOutputFormat: boolean;
  webSearchPayload?: Record<string, unknown>;
}

export function buildSeedreamImageRequestBody(input: SeedreamImageRequestBodyInput) {
  const refs = (input.image || []).filter(Boolean).slice(0, SEEDREAM_MAX_REFERENCE_IMAGES);
  return {
    model: input.model,
    prompt: input.prompt,
    ...(refs.length ? { image: refs } : {}),
    response_format: "url",
    size: input.size,
    sequential_image_generation: "disabled",
    ...(input.supportsOutputFormat ? { output_format: "png" } : {}),
    stream: false,
    watermark: false,
    ...(input.webSearchPayload || {})
  };
}

async function generateAssetImageViaSeedream(
  asset: Asset,
  referenceImageUrls: string[] = [],
  variant: SeedreamVariant = "seedream-4-5",
  opts: SeedreamGenerateOpts = {}
) {
  const credential = seedreamCredential();
  const lang: Lang = opts.lang === "en" ? "en" : "zh";
  const preparedRefs = await prepareSeedreamReferenceInputs(referenceImageUrls, asset.id, opts.referenceAssets);
  const usableRefs = preparedRefs.map((ref) => ref.url);
  const referenceAssets = preparedRefs.map((ref) => ref.asset).filter((ref): ref is NonNullable<typeof ref> => Boolean(ref));
  const promptAsset = opts.promptOverride && opts.promptOverride.trim().length > 0
    ? { ...asset, prompt: opts.promptOverride }
    : asset;
  const composedPrompt = composeSeedreamAssetPrompt(promptAsset, usableRefs.length > 0, lang, {
    referenceAssets
  }).composedPrompt;
  if (!credential.apiKey) {
    refuseFakeSuccessInProduction("Seedream image generation", SEEDREAM_KEY_ENVS);
    return {
      url: `https://placehold.co/2048x2048/1f2937/f8fafc?text=${encodeURIComponent(asset.name)}`,
      composedPrompt,
      model: variant,
      credentialSource: credential.source
    };
  }

  // Default to 2K for faster image-node iteration. Env override remains available, while a
  // per-node Inspector choice wins over the env default.
  const size = normalizeSeedreamSize(opts.size) || normalizeSeedreamSize(process.env.SEEDREAM_SIZE) || "2K";
  // Seedream image generation: a POST that creates a result, not a side-effecting "create task"
  // — Seedream's API is request/response (the response body IS the image URL), so retry-on-
  // timeout is safe (no orphaned task to clean up). Wrap in fetchWithRetry so transient
  // "fetch failed" / 5xx don't kill the user's gen.
  const modelIds = resolveSeedreamModelIds(variant, credential.source === "agent-plan").flatMap((model) =>
    seedreamModelAlternates(model, credential)
  );
  let lastMissingModelError: unknown;
  for (const modelId of modelIds) {
    const response = await fetchWithRetry(`${credential.apiBase}/images/generations`, {
      method: "POST",
      timeoutMs: 240_000,
      idempotent: true,
      tag: `seedream:asset:${asset.id}`,
      headers: jsonHeaders(credential.apiKey),
      body: JSON.stringify(buildSeedreamImageRequestBody({
        model: modelId,
        prompt: composedPrompt,
        image: usableRefs,
        size,
        supportsOutputFormat: variant === "seedream-5-lite",
        webSearchPayload: seedreamWebSearchPayload()
      }))
    });

    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(`Seedream image API failed: ${response.status} ${text.slice(0, 1000)}`);
      if (isMissingSeedreamModelError(error) && modelId !== modelIds[modelIds.length - 1]) {
        lastMissingModelError = error;
        continue;
      }
      throw error;
    }

    const imageUrl = findUrl(body, ["url", "image_url"]);
    if (imageUrl) {
      return {
        url: imageUrl,
        composedPrompt,
        model: variant,
        actualModelId: modelId,
        credentialSource: credential.source,
        rawUsage: body.usage
      };
    }
    throw new Error(`Seedream image API returned no image url: ${JSON.stringify(body).slice(0, 1000)}`);
  }
  throw lastMissingModelError instanceof Error ? lastMissingModelError : new Error(`Seedream model unavailable: ${modelIds.join(" / ")}`);
}

async function prepareSeedreamReferenceInputs(
  urls: string[],
  assetId: string,
  assets: SeedreamGenerateOpts["referenceAssets"] = []
) {
  const results: Array<{ url: string; asset?: NonNullable<SeedreamGenerateOpts["referenceAssets"]>[number] }> = [];
  for (const [index, url] of urls.entries()) {
    if (results.length >= SEEDREAM_MAX_REFERENCE_IMAGES) break;
    if (!url) continue;
    const asset = assets[index];
    if (/^https?:\/\//.test(url)) {
      results.push({ url, asset });
      continue;
    }
    const dataUrl = url.startsWith("data:image/") ? url : url.startsWith("/media/") ? await readLocalMediaAsDataUrl(url) : undefined;
    if (!dataUrl) continue;
    results.push({ url: await upscaleReferenceImageDataUrl(dataUrl, assetId, index), asset });
  }
  return results;
}

async function upscaleReferenceImageDataUrl(dataUrl: string, assetId: string, index: number) {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
  if (!match) return dataUrl;

  await mkdir(MEDIA_DIR, { recursive: true });
  const ext = match[1].includes("png") ? ".png" : match[1].includes("webp") ? ".webp" : ".jpg";
  const safeId = sanitizeFilePart(assetId || "asset");
  const inputPath = path.join(MEDIA_DIR, `${safeId}-reference-input-${index}-${Date.now()}${ext}`);
  const outputName = `${safeId}-reference-enhanced-${index}-${Date.now()}.png`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  await writeFile(inputPath, Buffer.from(match[2], "base64"));

  try {
    await runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-vf",
      "scale='if(lt(iw,ih),768,-2)':'if(gte(iw,ih),768,-2)':flags=lanczos,unsharp=5:5:0.8:3:3:0.35",
      "-frames:v",
      "1",
      outputPath
    ]);
    return await readLocalMediaAsDataUrl(`/media/${outputName}`) || dataUrl;
  } finally {
    await unlink(inputPath).catch(() => undefined);
  }
}

export function canUseBytePlusSeedance(credential: ArkCredential = seedanceCredential()) {
  return Boolean(!process.env.SEEDANCE_API_URL && credential.apiKey);
}

export async function createSeedanceVideoTask(shot: Shot, assets: Asset[], opts: BuildSeedancePayloadOpts = {}) {
  const credential = opts.credential || seedanceCredential();
  if (!credential.apiKey) throw new Error(arkMissingKeyMessage("Seedance generation", SEEDANCE_KEY_ENVS));
  const payload = await buildBytePlusSeedancePayload(shot, assets, opts);
  const submittedReferenceImageUrls = payload.content
    .filter((item) => item.role === "reference_image")
    .map((item) => item.image_url?.url)
    .filter((url): url is string => Boolean(url));
  const createBody = await requestSeedanceJson(`${credential.apiBase}/contents/generations/tasks`, credential.apiKey, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  return {
    taskId: extractTaskId(createBody),
    model: payload.model,
    composedText: payload.composedText,
    submittedReferenceImageUrls,
    createResponse: createBody
  };
}

export async function pollSeedanceVideoTask(taskId: string) {
  const credential = seedanceCredential();
  if (!credential.apiKey) throw new Error(arkMissingKeyMessage("Seedance polling", SEEDANCE_KEY_ENVS));
  const body = await requestSeedanceJson(`${credential.apiBase}/contents/generations/tasks/${taskId}`, credential.apiKey);
  const status = extractStatus(body);
  return {
    taskId,
    status,
    videoUrl: findUrl(body, ["video_url", "output_url", "url"]),
    error: extractGenerationError(body),
    response: body
  };
}

export async function cancelSeedanceVideoTask(taskId: string) {
  const credential = seedanceCredential();
  if (!credential.apiKey) throw new Error(arkMissingKeyMessage("Seedance cancellation", SEEDANCE_KEY_ENVS));
  const body = await requestSeedanceJson(`${credential.apiBase}/contents/generations/tasks/${taskId}`, credential.apiKey, {
    method: "DELETE"
  });
  return {
    taskId,
    response: body
  };
}

export async function generateShotVideo(shot: Shot, assets: Asset[], opts: BuildSeedancePayloadOpts = {}) {
  if ((process.env.VIDEOSBATCH_VIDEO_PROVIDER || "").trim().toLowerCase() === "newapi-h3") {
    return generateShotVideoViaNewApiH3(shot, assets, {
      taskId: opts.taskId ?? shot.generationTaskId,
      onTaskSubmitted: opts.onProviderTaskSubmitted,
      onReferenceBindingsPrepared: opts.onProviderReferenceBindingsPrepared,
      onPromptPrepared: opts.onProviderPromptPrepared
    });
  }
  if (process.env.SEEDANCE_API_URL && process.env.SEEDANCE_API_KEY) {
    return generateShotVideoViaCustomEndpoint(shot, assets, opts);
  }

  const credential = opts.credential || seedanceCredential();
  if (!credential.apiKey) {
    refuseFakeSuccessInProduction("Seedance video generation", SEEDANCE_KEY_ENVS);
    return `https://placehold.co/1280x720/111827/f8fafc?text=${encodeURIComponent(`Video ${shot.index}`)}`;
  }
  return generateShotVideoViaBytePlusArk(shot, assets, credential, opts);
}

export async function extractTailVideoClip(videoUrl: string, shotId: string, sourceShotId: string, seconds?: number) {
  await mkdir(MEDIA_DIR, { recursive: true });
  const duration = Math.min(Math.max(Number(seconds) || 15, 1), 15);
  const inputPath = await materializeVideo(videoUrl, sourceShotId, 0);
  const outputName = `${shotId}-reference-tail-from-${sourceShotId}-${duration}s-${Date.now()}.mp4`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  await runFfmpeg([
    "-y",
    "-sseof",
    `-${duration}`,
    "-i",
    inputPath,
    "-t",
    String(duration),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outputPath
  ]);
  return `/media/${outputName}`;
}

export async function extractTailAudioClip(videoUrl: string, shotId: string, sourceShotId: string, seconds?: number) {
  await mkdir(MEDIA_DIR, { recursive: true });
  const duration = Math.min(Math.max(Number(seconds) || 15, 1), 15);
  const inputPath = await materializeVideo(videoUrl, sourceShotId, 0);
  const outputName = `${shotId}-reference-audio-from-${sourceShotId}-${duration}s-${Date.now()}.mp3`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  try {
    await runFfmpeg([
      "-y",
      "-sseof",
      `-${duration}`,
      "-i",
      inputPath,
      "-t",
      String(duration),
      "-vn",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      outputPath
    ]);
  } catch {
    return undefined;
  }
  return `/media/${outputName}`;
}

async function generateShotVideoViaCustomEndpoint(shot: Shot, assets: Asset[], opts: BuildSeedancePayloadOpts = {}) {
  const apiKey = process.env.SEEDANCE_API_KEY;
  if (!apiKey || !process.env.SEEDANCE_API_URL) throw new Error("Missing SEEDANCE_API_KEY or SEEDANCE_API_URL");
  // Mirror BytePlus behavior: first-frame mode is mutually exclusive with reference media.
  const firstFrameAsset = resolveFirstFrameAsset(shot, assets);
  const firstFrameUrl = firstFrameAsset ? getAssetMediaUrl(firstFrameAsset, "image") : undefined;
  const useFirstFrameMode = Boolean(firstFrameUrl && /^https?:\/\//.test(firstFrameUrl) && !firstFrameUrl.includes("placehold.co"));

  const referenceClipUrl = useFirstFrameMode ? undefined : getSeedanceWebUrl(shot.referenceClipUrl);
  const referenceAudioUrl = useFirstFrameMode ? undefined : getSeedanceWebUrl(shot.referenceAudioUrl);
  const prompt = opts.prebuiltText && opts.prebuiltText.trim().length > 0
    ? opts.prebuiltText.trim()
    : (shot.rawPrompt || shot.prompt || "").trim();

  // Custom Seedance HTTP endpoint — wrapped in fetchWithRetry with idempotent=false so we only
  // retry pre-flight network errors (not server-confirmed timeouts that may have created a task).
  const response = await fetchWithRetry(process.env.SEEDANCE_API_URL, {
    method: "POST",
    timeoutMs: 240_000,
    idempotent: false,
    tag: `seedance:custom-server:${shot.id}`,
    headers: jsonHeaders(apiKey),
    body: JSON.stringify({
      model: resolveSeedanceModel(shot),
      prompt,
      duration: getShotDurationSec(shot),
      ...(typeof opts.generateAudio === "boolean" ? { generate_audio: opts.generateAudio } : {}),
      references: [
        ...(useFirstFrameMode && firstFrameAsset && firstFrameUrl
          ? [
              {
                id: `first-frame-${firstFrameAsset.id}`,
                type: "first_frame",
                media_kind: "image",
                image_url: firstFrameUrl,
                description: `First frame image from asset "${firstFrameAsset.name}"`
              }
            ]
          : []),
        ...(referenceClipUrl
          ? [
              {
                id: "previous-shot-tail",
                type: "continuity",
                media_kind: "video",
                video_url: referenceClipUrl,
                description: "Tail clip from the previous shot for shot-to-shot continuity"
              }
            ]
          : []),
        ...(referenceAudioUrl
          ? [
              {
                id: "previous-shot-audio",
                type: "continuity",
                media_kind: "audio",
                audio_url: referenceAudioUrl,
                description: "Tail audio from the previous shot for music continuity"
              }
            ]
          : []),
        ...(useFirstFrameMode
          ? []
          : assets.map((asset) => ({
              id: asset.id,
              type: asset.type,
              media_kind: asset.mediaKind,
              image_url: getAssetMediaUrl(asset, "image"),
              video_url: getAssetMediaUrl(asset, "video"),
              audio_url: getAssetMediaUrl(asset, "audio"),
              description: asset.description
            })))
      ]
    })
  });

  if (!response.ok) {
    throw new Error(decorateSeedanceError(response.status, await response.text()));
  }

  const data = (await response.json()) as { video_url?: string; url?: string; data?: { url?: string } };
  const videoUrl = data.video_url || data.url || data.data?.url;
  if (!videoUrl) throw new Error("Seedance API returned no video_url/url");
  return videoUrl;
}

/**
 * Tag known recoverable Seedance error shapes with a sentinel prefix the client can detect.
 * Currently handles the r2v reference-video duration ceiling (15.2s) — the client surfaces this
 * with a one-click "派生 15s 剪裁版并切换" button instead of dumping the raw API error to the UI.
 *
 * The decoration is purely additive: the original message is preserved verbatim after the
 * sentinel so debugging / logs stay informative. Other 400s pass through unchanged.
 */
export const REFERENCE_VIDEO_TOO_LONG_PREFIX = "[REFERENCE_VIDEO_TOO_LONG]";
function decorateSeedanceError(status: number, text: string): string {
  const base = `Seedance API failed: ${status} ${text.slice(0, 1000)}`;
  if (status === 400 && /video duration[^]*?must be less than or equal to 15\.\d/i.test(text)) {
    return `${REFERENCE_VIDEO_TOO_LONG_PREFIX} ${base}`;
  }
  return base;
}

async function generateShotVideoViaBytePlusArk(shot: Shot, assets: Asset[], credential: ArkCredential, opts: BuildSeedancePayloadOpts = {}) {
  const payload = await buildBytePlusSeedancePayload(shot, assets, opts);
  if (!credential.apiKey) throw new Error(arkMissingKeyMessage("Seedance generation", SEEDANCE_KEY_ENVS));
  const createBody = await requestSeedanceJson(`${credential.apiBase}/contents/generations/tasks`, credential.apiKey, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const taskId = extractTaskId(createBody);
  const deadline = Date.now() + seedanceTimeoutMs();
  const pollMs = Number(process.env.SEEDANCE_POLL_MS || 5000);
  let lastBody: unknown = createBody;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    lastBody = await requestSeedanceJson(`${credential.apiBase}/contents/generations/tasks/${taskId}`, credential.apiKey);
    const status = extractStatus(lastBody);
    if (TERMINAL_STATUSES.has(status)) {
      const videoUrl = findUrl(lastBody, ["video_url", "output_url", "url"]);
      if (status === "succeeded" && videoUrl) return videoUrl;
      throw new Error(`Seedance task ${taskId} ${status}: ${JSON.stringify(extractGenerationError(lastBody)).slice(0, 500)}`);
    }
  }

  const videoUrl = findUrl(lastBody, ["video_url", "output_url", "url"]);
  if (videoUrl) return videoUrl;
  throw new Error(`Seedance task ${taskId} timed out before video_url was ready`);
}

export async function buildBytePlusSeedancePayload(shot: Shot, assets: Asset[], opts: BuildSeedancePayloadOpts = {}) {
  const model = resolveSeedanceModel(shot, opts.credential);
  const lang: Lang = opts.lang === "en" ? "en" : "zh";
  // The shot can drive Seedance in three mutually exclusive anchor modes (anchored from strongest
  // to weakest):
  //   1. SubShot mode (subShotPanelCount > 0)  — a single grid image acts as a TIMELINE of N
  //      sub-panels and Seedance is told to read panel positions as cuts. Disables first/last
  //      frame mode; the grid image is sent as a normal reference_image plus a magic sequencing
  //      instruction in the text. (EvoLink GPT-Image-2 / Seedance 2.0 community technique.)
  //   2. First-and-last frame I2V (firstFrameAssetId + lastFrameAssetId) — anchors the start and
  //      end frames; the model interpolates motion. Disables continuity reference media.
  //   3. First-frame I2V (firstFrameAssetId only) — anchors the start frame.
  // When none of the three are set the shot falls back to plain prompt + reference media.
  const useSubShotMode = Boolean(
    shot.subShotPanelCount && shot.subShotPanelCount > 1 && (
      shot.subShotStoryboardAssetId ||
      (shot.subShotStoryboardAssetIds && shot.subShotStoryboardAssetIds.length > 0)
    )
  );
  const subShotPanelCount = useSubShotMode ? Math.max(2, Math.min(16, Math.floor(shot.subShotPanelCount as number))) : 0;
  // Resolve the FULL list of storyboard assets feeding this shot. The plural field
  // `subShotStoryboardAssetIds` is the source of truth for N-to-1 wiring (set by canvas
  // drag-to-connect); the legacy singular `subShotStoryboardAssetId` is kept as a fallback for
  // older data. Order matters: the primary (own-shot) grid leads — its panel sequence drives the
  // "Follow the storyboard sequence of N reference frames in image1" magic instruction.
  const subShotAssetIds = (() => {
    const list = (shot.subShotStoryboardAssetIds && shot.subShotStoryboardAssetIds.length > 0)
      ? shot.subShotStoryboardAssetIds
      : (shot.subShotStoryboardAssetId ? [shot.subShotStoryboardAssetId] : []);
    return Array.from(new Set(list));
  })();
  const subShotAssets = useSubShotMode
    ? subShotAssetIds
        .map((id) => assets.find((asset) => asset.id === id))
        .filter((a): a is Asset => Boolean(a))
    : [];
  const subShotAsset = subShotAssets[0]; // primary grid (drives the sequencing instruction)
  const subShotUrl = subShotAsset ? getAssetMediaUrl(subShotAsset, "image") : undefined;
  const useSubShotResolved = Boolean(subShotUrl && /^https?:\/\//.test(subShotUrl) && !subShotUrl.includes("placehold.co"));
  // Extra (non-primary) storyboard URLs the user wired in via canvas. Passed to Seedance as
  // additional reference images alongside the primary grid; helpful for cross-shot continuity
  // (e.g. "follow the timeline of grid A but borrow the lighting from grid B").
  const subShotExtraReferences = useSubShotResolved
    ? subShotAssets
        .slice(1)
        .map((asset) => ({ asset, url: getAssetMediaUrl(asset, "image") }))
        .filter((item): item is { asset: Asset; url: string } => Boolean(item.url && /^https?:\/\//.test(item.url) && !item.url.includes("placehold.co")))
    : [];

  // Seedance 2.0 rejects payloads that mix `first_frame` / `last_frame` content with any
  // `reference_image` or `reference_video` content (`InvalidParameter: first/last frame content
  // cannot be mixed with reference media content`). So a shot can run sub-shot mode (grid as
  // reference_image) OR first/last-frame I2V — not both simultaneously.
  //
  // Priority is INVERTED from the previous default: when a user wires firstFrameAssetId onto
  // a shot that already has a sub-shot grid, first-frame wins. This is the cross-shot
  // continuity ergonomic — wiring `last-tail of shot N → first-frame of shot N+1` should "just
  // work" without forcing the caller to also clear sub-shot fields.
  const firstFrameAsset = resolveFirstFrameAsset(shot, assets);
  const firstFrameUrl = firstFrameAsset ? getAssetMediaUrl(firstFrameAsset, "image") : undefined;
  const useFirstFrameMode = Boolean(firstFrameUrl && /^https?:\/\//.test(firstFrameUrl) && !firstFrameUrl.includes("placehold.co"));

  const lastFrameAsset = useFirstFrameMode ? resolveLastFrameAsset(shot, assets) : undefined;
  const lastFrameUrl = lastFrameAsset ? getAssetMediaUrl(lastFrameAsset, "image") : undefined;
  const useLastFrameMode = Boolean(lastFrameUrl && /^https?:\/\//.test(lastFrameUrl) && !lastFrameUrl.includes("placehold.co"));

  // Demote sub-shot when first-frame is active. Field stays on the shot record (so re-clearing
  // first-frame restores the grid), but the payload sees first-frame mode only.
  const subShotActive = useSubShotResolved && !useFirstFrameMode;

  // Reference video is allowed in two cases:
  //   1) asset-backed reference_video: the wired refvideo asset is present in `assets` (normally
  //      because the prompt @-mentioned it / the caller explicitly included it);
  //   2) URL-backed continuity: previous-shot or shot-to-shot wiring resolved a remote clip URL
  //      without an asset id. In both cases first-frame and sub-shot modes still win the mutex.
  const resolvedContinuityVideoUrl = getSeedanceWebUrl(shot.referenceClipUrl);
  const resolvedContinuityAudioUrl = getSeedanceWebUrl(shot.referenceAudioUrl);
  const hasAssetBackedReferenceVideo = Boolean(
    shot.referenceVideoAssetId && assets.some((a) => a.id === shot.referenceVideoAssetId)
  );
  const hasUrlBackedContinuityVideo = Boolean(!shot.referenceVideoAssetId && resolvedContinuityVideoUrl);
  const useContinuityReference = hasAssetBackedReferenceVideo || hasUrlBackedContinuityVideo;
  const continuityVideoUrl = (useFirstFrameMode || subShotActive || !useContinuityReference)
    ? undefined
    : resolvedContinuityVideoUrl;
  const continuityAudioUrl = (useFirstFrameMode || subShotActive || !useContinuityReference)
    ? undefined
    : resolvedContinuityAudioUrl;
  // In sub-shot mode pass the primary grid first (Seedance's image1 — owns the sequencing) plus
  // any extra storyboards the user wired in. In first-frame mode we drop all other reference
  // imagery (Seedance API rejects mixing first_frame with reference_image). Otherwise keep
  // @-mentioned assets as references.
  const referenceImages = subShotActive
    ? (subShotAsset && subShotUrl
        ? [{ asset: subShotAsset, url: subShotUrl as string }, ...subShotExtraReferences]
        : [])
    : useFirstFrameMode
      ? []
      : assets
          .map((asset) => ({ asset, url: getAssetMediaUrl(asset, "image") }))
          .filter((item): item is { asset: Asset; url: string } => Boolean(item.url && /^https?:\/\//.test(item.url) && !item.url.includes("placehold.co")));
  const rawReferenceVideos = subShotActive || useFirstFrameMode
    ? []
    : assets
        .map((asset) => ({ asset, url: getAssetMediaUrl(asset, "video") }))
        .filter((item): item is { asset: Asset; url: string } => Boolean(item.url && /^https?:\/\//.test(item.url) && !item.url.includes("placehold.co")));
  const rawReferenceAudios = subShotActive || useFirstFrameMode
    ? []
    : assets
        .map((asset) => ({ asset, url: getAssetMediaUrl(asset, "audio") }))
        .filter((item): item is { asset: Asset; url: string } => Boolean(item.url && /^https?:\/\//.test(item.url) && !item.url.includes("placehold.co")));
  // Dedupe reference videos by URL (the user may have uploaded the same file twice and produced
  // two assets sharing one TOS URL) AND drop any that collide with continuityVideoUrl (the wired
  // refvideo doesn't need to be sent as both `continuity` and `@-mention` ref). Then cap at the
  // Seedance hard limit (3 video contents per request) so the upstream doesn't 400 us.
  const SEEDANCE_VIDEO_LIMIT = 3;
  const continuityUrlNorm = continuityVideoUrl;
  const seenVideoUrls = new Set<string>();
  if (continuityUrlNorm) seenVideoUrls.add(continuityUrlNorm);
  const dedupedReferenceVideos: typeof rawReferenceVideos = [];
  for (const item of rawReferenceVideos) {
    if (seenVideoUrls.has(item.url)) continue;
    seenVideoUrls.add(item.url);
    dedupedReferenceVideos.push(item);
  }
  // Reserve 1 slot for continuityVideoUrl when it's set, then take up to (LIMIT - reserved).
  const continuitySlots = continuityUrlNorm ? 1 : 0;
  const referenceVideos = dedupedReferenceVideos.slice(0, Math.max(0, SEEDANCE_VIDEO_LIMIT - continuitySlots));
  const SEEDANCE_AUDIO_LIMIT = 3;
  const continuityAudioUrlNorm = continuityAudioUrl;
  const seenAudioUrls = new Set<string>();
  if (continuityAudioUrlNorm) seenAudioUrls.add(continuityAudioUrlNorm);
  const dedupedReferenceAudios: typeof rawReferenceAudios = [];
  for (const item of rawReferenceAudios) {
    if (seenAudioUrls.has(item.url)) continue;
    seenAudioUrls.add(item.url);
    dedupedReferenceAudios.push(item);
  }
  const continuityAudioSlots = continuityAudioUrlNorm ? 1 : 0;
  const referenceAudios = dedupedReferenceAudios.slice(0, Math.max(0, SEEDANCE_AUDIO_LIMIT - continuityAudioSlots));

  const promptAssetsForText = useFirstFrameMode && firstFrameAsset
    ? [firstFrameAsset]
    : subShotActive && subShotAsset
      ? [subShotAsset, ...subShotExtraReferences.map((r) => r.asset)]
      : [...referenceImages, ...referenceVideos, ...referenceAudios].map((item) => item.asset);

  // Compose the text content. If the caller has a user-edited final prompt (`prebuiltText`),
  // keep that text at the head while still appending non-creative @reference binding metadata.
  // The composer is the single source of truth for the assembled text — same code path drives
  // dryRun preview returned by /api/shots/:id/generate?dryRun=true.
  const shotForText = opts.prebuiltText && opts.prebuiltText.trim().length > 0
    ? { ...shot, rawPrompt: opts.prebuiltText.trim(), prompt: opts.prebuiltText.trim() }
    : shot;
  const textContentBase = composeSeedanceVideoText(
    {
      shot: shotForText,
      referencedAssets: promptAssetsForText,
      firstFrameAsset: useFirstFrameMode ? firstFrameAsset : undefined,
      lastFrameAsset: useLastFrameMode ? lastFrameAsset : undefined,
      subShotAsset: subShotActive ? subShotAsset : undefined,
      subShotPanelCount: subShotActive ? subShotPanelCount : undefined,
      hasContinuityVideo: Boolean(continuityVideoUrl),
      hasContinuityAudio: Boolean(continuityAudioUrl),
      resolution: process.env.SEEDANCE_RATIO || "16:9"
    },
    lang
  ).composedPrompt;
  const textContent = textContentBase;

  return {
    model,
    composedText: textContent,
    content: [
      {
        type: "text",
        text: textContent
      },
      ...(useFirstFrameMode
        ? [
            {
              type: "image_url",
              image_url: { url: firstFrameUrl as string },
              role: "first_frame"
            }
          ]
        : []),
      ...(useLastFrameMode
        ? [
            {
              type: "image_url",
              image_url: { url: lastFrameUrl as string },
              role: "last_frame"
            }
          ]
        : []),
      ...(continuityVideoUrl
        ? [
            {
              type: "video_url",
              video_url: { url: continuityVideoUrl },
              role: "reference_video"
            }
          ]
        : []),
      ...(continuityAudioUrl
        ? [
            {
              type: "audio_url",
              audio_url: { url: continuityAudioUrl },
              role: "reference_audio"
            }
          ]
        : []),
      ...referenceImages.map(({ url }) => ({
        type: "image_url",
        image_url: { url },
        role: "reference_image"
      })),
      ...referenceVideos.map(({ url }) => ({
        type: "video_url",
        video_url: { url },
        role: "reference_video"
      })),
      ...referenceAudios.map(({ url }) => ({
        type: "audio_url",
        audio_url: { url },
        role: "reference_audio"
      }))
    ],
    generate_audio: opts.generateAudio !== undefined ? opts.generateAudio : (process.env.SEEDANCE_GENERATE_AUDIO !== "false"),
    ratio: process.env.SEEDANCE_RATIO || "16:9",
    duration: getShotDurationSec(shot),
    watermark: process.env.SEEDANCE_WATERMARK === "true",
    ...(process.env.SEEDANCE_RESOLUTION ? { resolution: process.env.SEEDANCE_RESOLUTION } : {})
  };
}

function resolveFirstFrameAsset(shot: Shot, assets: Asset[]): Asset | undefined {
  if (!shot.firstFrameAssetId) return undefined;
  return assets.find((asset) => asset.id === shot.firstFrameAssetId);
}

function resolveLastFrameAsset(shot: Shot, assets: Asset[]): Asset | undefined {
  if (!shot.lastFrameAssetId) return undefined;
  return assets.find((asset) => asset.id === shot.lastFrameAssetId);
}

function getSeedanceWebUrl(url?: string | null) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
    if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

async function readLocalMediaAsDataUrl(url: string) {
  const mediaPath = resolveMediaPath(url);
  if (!mediaPath) return undefined;
  const bytes = await readFile(mediaPath);
  const ext = path.extname(mediaPath).toLowerCase();
  const mime =
    ext === ".mp4"
      ? "video/mp4"
      : ext === ".mov"
        ? "video/quicktime"
        : ext === ".webm"
          ? "video/webm"
          : ext === ".mp3"
            ? "audio/mpeg"
            : ext === ".wav"
              ? "audio/wav"
              : ext === ".png"
                ? "image/png"
                : ext === ".webp"
                  ? "image/webp"
                  : "image/jpeg";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function resolveMediaPath(url: string) {
  if (!url.startsWith("/media/")) return undefined;
  const mediaFile = decodeURIComponent(url).replace(/^\/media\/?/, "");
  const candidate = path.resolve(MEDIA_DIR, mediaFile);
  return candidate.startsWith(`${MEDIA_DIR}${path.sep}`) ? candidate : undefined;
}

function getAssetMediaUrl(asset: Asset, kind: "image" | "video" | "audio") {
  const mediaKind = asset.mediaKind || (asset.imageUrl ? "image" : "none");
  if (kind === "image" && mediaKind === "image") return toPublicMediaUrl(asset.sourceImageUrl || asset.referenceImageUrl || asset.mediaUrl || asset.imageUrl);
  if (kind === "video" && mediaKind === "video") return toPublicMediaUrl(asset.mediaUrl || asset.imageUrl);
  if (kind === "audio" && mediaKind === "audio") return toPublicMediaUrl(asset.musicAudioUrl || asset.musicLocalAudioUrl || asset.voicePreviewAudioUrl || asset.mediaUrl);
  return undefined;
}

function toPublicMediaUrl(url?: string) {
  if (!url?.startsWith("/media/")) return url;
  const publicBase = process.env.PUBLIC_MEDIA_BASE_URL || process.env.MEDIA_PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL;
  if (!publicBase) return url;
  return `${publicBase.replace(/\/$/, "")}${url}`;
}

function getShotDurationSec(shot: Pick<Shot, "durationSec">) {
  return Math.min(Math.max(Number(shot.durationSec) || 1, 1), 15);
}

export function resolveSeedanceModel(shot: Pick<Shot, "seedanceVariant">, credential: ArkCredential = seedanceCredential()) {
  const usesAgentPlan = credential.source === "agent-plan";
  const usesVolcengineCn = credential.standardRoute === "volcengine-cn";
  if (shot.seedanceVariant === "fast") {
    return usesAgentPlan
      ? process.env.SEEDANCE_AGENT_PLAN_FAST_MODEL || AGENT_PLAN_SEEDANCE_FAST_MODEL
      : usesVolcengineCn
        ? process.env.SEEDANCE_CN_FAST_MODEL || VOLCENGINE_CN_SEEDANCE_FAST_MODEL
      : process.env.SEEDANCE_FAST_MODEL || BYTEPLUS_SEEDANCE_FAST_MODEL;
  }
  return usesAgentPlan
    ? process.env.SEEDANCE_AGENT_PLAN_MODEL || AGENT_PLAN_SEEDANCE_MODEL
    : usesVolcengineCn
      ? process.env.SEEDANCE_CN_MODEL || VOLCENGINE_CN_SEEDANCE_MODEL
    : process.env.SEEDANCE_MODEL || BYTEPLUS_SEEDANCE_MODEL;
}

async function requestSeedanceJson(
  url: string,
  apiKey: string,
  init?: RequestInit & { idempotent?: boolean; tag?: string }
) {
  // Default idempotency from HTTP method: GET is safe to retry on timeout/5xx, POST isn't unless
  // the caller explicitly opts in (cancel-task is idempotent by Seedance contract).
  const method = (init?.method || "GET").toUpperCase();
  const idempotent = init?.idempotent ?? method === "GET";
  const response = await fetchWithRetry(url, {
    ...init,
    headers: {
      ...jsonHeaders(apiKey),
      ...(init?.headers ?? {})
    },
    idempotent,
    tag: init?.tag || `seedance:${method.toLowerCase()}`
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(decorateSeedanceError(response.status, text.slice(0, 1000)));
  return body;
}

function extractTaskId(body: unknown) {
  if (!isRecord(body)) throw new Error("Seedance create response is not an object");
  const data = isRecord(body.data) ? body.data : undefined;
  const taskId = body.id || body.task_id || data?.id || data?.task_id;
  if (!taskId) throw new Error(`Seedance task id not found: ${JSON.stringify(body).slice(0, 1000)}`);
  return String(taskId);
}

function extractStatus(body: unknown) {
  const data = isRecord(body) && isRecord(body.data) ? body.data : body;
  if (!isRecord(data)) return "";
  return String(data.status || "").toLowerCase();
}

function extractGenerationError(body: unknown): unknown {
  const data = isRecord(body) && isRecord(body.data) ? body.data : body;
  if (!isRecord(data)) return body;
  return data.error || data.message || data.reason || body;
}

function findUrl(value: unknown, keys: string[]): string | undefined {
  if (isRecord(value)) {
    for (const key of keys) {
      const found = value[key];
      if (typeof found === "string" && found.startsWith("http")) return found;
      if (isRecord(found) && typeof found.url === "string" && found.url.startsWith("http")) return found.url;
    }
    for (const nested of Object.values(value)) {
      const found = findUrl(nested, keys);
      if (found) return found;
    }
  }
  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findUrl(nested, keys);
      if (found) return found;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function cacheGeneratedVideo(videoUrl: string, renderId: string) {
  if (isLocalReusableVideoUrl(videoUrl) || videoUrl.includes("placehold.co")) {
    return { videoUrl };
  }
  if (!isHttpUrl(videoUrl)) return { videoUrl };

  await mkdir(MEDIA_DIR, { recursive: true });
  const extension = videoExtensionFromUrl(videoUrl);
  const outputName = `shot-render-${sanitizeFilePart(renderId)}${extension}`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  await downloadVideoToFile(videoUrl, outputPath, `render ${renderId}`);
  // Re-mux with `+faststart` so the moov atom lives at the front of the file. Without this, every
  // browser playing the cached mp4 has to download the full file before the player can start
  // (since moov holds the keyframe index). With faststart, the player streams from the first byte
  // and starts within ~100 ms. This is the single biggest UX win for canvas video playback.
  await remuxFaststartIfMp4(outputPath).catch((err) => {
    console.warn(`[cacheGeneratedVideo] faststart remux failed for ${outputName}: ${err instanceof Error ? err.message : err}`);
  });
  return { videoUrl: `/media/${outputName}`, remoteVideoUrl: videoUrl };
}

export async function cacheGeneratedImage(imageUrl: string, assetId: string) {
  if (!imageUrl) return { imageUrl };
  if (imageUrl.startsWith("/media/") || imageUrl.includes("placehold.co")) return { imageUrl };

  await mkdir(MEDIA_DIR, { recursive: true });
  const safeId = sanitizeFilePart(assetId || "asset");
  if (imageUrl.startsWith("data:image/")) {
    const match = imageUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
    if (!match) return { imageUrl };
    const ext = imageExtensionFromContentType(match[1]);
    const outputName = `asset-image-${safeId}-${Date.now()}${ext}`;
    await writeFile(path.join(MEDIA_DIR, outputName), Buffer.from(match[2], "base64"));
    return { imageUrl: `/media/${outputName}` };
  }

  if (!isHttpUrl(imageUrl)) return { imageUrl };

  const digest = createHash("sha1").update(imageUrl).digest("hex").slice(0, 12);
  const outputName = `asset-image-${safeId}-${digest}-${Date.now()}${imageExtensionFromUrl(imageUrl)}`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  await downloadImageToFile(imageUrl, outputPath, `asset ${assetId}`);
  return { imageUrl: `/media/${outputName}`, remoteImageUrl: imageUrl };
}

/**
 * If `filePath` is an mp4/m4v, run a fast `-c copy -movflags +faststart` remux so the moov atom
 * is moved to the front. Atomic — writes to a sibling tmp file then renames over the original.
 * No-op for non-mp4 containers and for files where moov is already at the head.
 */
export async function remuxFaststartIfMp4(filePath: string): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".mp4" && ext !== ".m4v") return;
  // Probe: cheaply check whether faststart is already applied. Use ffmpeg's `-v trace` and inspect
  // the offsets of the first top-level moov / mdat boxes; if moov is before mdat, we're done.
  const probe = await new Promise<string>((resolve) => {
    const child = spawn(ffmpeg.path, ["-v", "trace", "-i", filePath, "-f", "null", "-"], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 64_000) child.kill(); });
    child.on("close", () => resolve(stderr));
    child.on("error", () => resolve(stderr));
  });
  const mdatLine = probe.match(/type:'mdat'\s+parent:'root'\s+sz:\s*\d+\s+(\d+)/);
  const moovLine = probe.match(/type:'moov'\s+parent:'root'\s+sz:\s*\d+\s+(\d+)/);
  if (mdatLine && moovLine) {
    const mdatOff = Number(mdatLine[1]);
    const moovOff = Number(moovLine[1]);
    if (moovOff < mdatOff) return; // already faststart
  }

  const tmpPath = `${filePath}.faststart.tmp.mp4`;
  try {
    await runFfmpegCommand([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filePath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      tmpPath
    ]);
    await rename(tmpPath, filePath);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

export type StitchProgressCallback = (phase: string) => void | Promise<void>;

export interface StitchOptions {
  /** Called with a short human-readable phase string as the job progresses. */
  onProgress?: StitchProgressCallback;
  /** Force a fresh final artifact even when the input signature matches an existing file. */
  force?: boolean;
  /** Independent VideosBatch audio timeline; never derived from the visual prompt. */
  audioTimeline?: VideosBatchAudioTimeline;
}

export async function stitchShotVideos(sessionId: string, shots: Shot[], options: StitchOptions = {}) {
  const urls = shots.map((shot) => shot.videoUrl).filter(Boolean) as string[];
  if (!urls.length) throw new Error("No generated shots to stitch");
  const logTag = `[stitch ${sessionId}]`;
  const report = async (phase: string) => {
    console.log(`${logTag} ${phase}`);
    try {
      await options.onProgress?.(phase);
    } catch (err) {
      console.warn(`${logTag} progress callback threw: ${(err as Error).message}`);
    }
  };

  if (urls.every((url) => url.includes("placehold.co"))) {
    await report("mock final video (placehold inputs)");
    return {
      finalVideoUrl: `https://placehold.co/1280x720/0b0d10/f4c95d?text=${encodeURIComponent("Mock final video")}`,
      signature: createStitchSignature(shots, options.audioTimeline)
    };
  }

  await mkdir(MEDIA_DIR, { recursive: true });
  const signature = createStitchSignature(shots, options.audioTimeline);
  const runSuffix = options.force ? `-${Date.now()}` : "";
  const outputName = `final-${sessionId}-${signature}${runSuffix}.mp4`;
  const outputPath = path.join(MEDIA_DIR, outputName);
  await report(`signature=${signature} target=${outputName} (${urls.length} shot inputs)`);
  if (!options.force && await hasUsableFinalVideo(outputPath, shots)) {
    await report("reused cached final video (signature unchanged)");
    return { finalVideoUrl: `/media/${outputName}`, signature };
  }

  const total = urls.length;
  const materializedInputs = await mapWithConcurrency(urls, stitchDownloadConcurrency(), async (url, index) => {
    const isHttp = isHttpUrl(url);
    if (isHttp) await report(`downloading shot ${index + 1}/${total}`);
    const localPath = await materializeVideo(url, sessionId, index, signature);
    if (isHttp) await report(`downloaded shot ${index + 1}/${total} -> ${path.basename(localPath)}`);
    return localPath;
  });
  const targetSize = await probeVideoDimensions(materializedInputs[0]).catch(() => ({ width: 1280, height: 720 }));
  const inputs = await mapWithConcurrency(materializedInputs, Math.min(2, stitchDownloadConcurrency()), async (input, index) => {
    await report(`normalizing shot ${index + 1}/${total}`);
    return normalizeStitchInputVideo(input, sessionId, index, signature, targetSize);
  });

  const listPath = path.join(MEDIA_DIR, `${sessionId}-${signature}-concat.txt`);
  await writeFile(listPath, inputs.map((input) => `file '${input.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");

  await report(`ffmpeg concat (libx264 preset=medium crf=18) -> ${outputName}`);
  const concatStart = Date.now();
  await runFfmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-level",
    "4.0",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outputPath
  ]);
  await report(`ffmpeg concat done in ${((Date.now() - concatStart) / 1000).toFixed(1)}s`);

  // The final cut must carry the delivered audio. Concat alone produces a
  // silent film because the concatenated segments have no soundtrack, so the
  // delivery mix has to be muxed in explicitly. A `fake://` mix (canonical fake
  // chain) has no bytes to read and is left to the caller's contract tests.
  const mixUrl = typeof options.audioTimeline?.streams?.mix?.audioUrl === "string"
    ? options.audioTimeline.streams.mix.audioUrl.trim()
    : "";
  if (mixUrl && !mixUrl.startsWith("fake://")) {
    const mixPath = await materializeAudio(mixUrl, sessionId, signature);
    if (mixPath) {
      const muxedPath = path.join(MEDIA_DIR, `final-${sessionId}-${signature}${runSuffix}-av.mp4`);
      await report(`ffmpeg mux delivered audio -> ${path.basename(muxedPath)}`);
      await runFfmpeg([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        outputPath,
        "-i",
        mixPath,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-movflags",
        "+faststart",
        muxedPath
      ]);
      await unlink(outputPath).catch(() => undefined);
      return { finalVideoUrl: `/media/${path.basename(muxedPath)}`, signature };
    }
    await report("delivered audio could not be read; keeping the silent cut");
  } else if (mixUrl) {
    await report("delivered audio is a fake:// placeholder; keeping the silent cut");
  }

  return { finalVideoUrl: `/media/${outputName}`, signature };
}

/**
 * Resolve an audio URL to a readable local file. Local `/media/...` paths and
 * `file://` URLs are used directly; remote URLs are downloaded to the media
 * dir. Returns undefined when the source is unusable so the caller can fall
 * back to the silent cut instead of failing the whole stitch.
 */
async function materializeAudio(url: string, sessionId: string, signature: string): Promise<string | undefined> {
  try {
    const localMediaPath = localMediaPathFromUrl(url);
    if (localMediaPath) return (await hasUsableMediaFile(localMediaPath)) ? localMediaPath : undefined;
    if (url.startsWith("file://")) {
      const filePath = new URL(url).pathname;
      return (await hasUsableMediaFile(filePath)) ? filePath : undefined;
    }
    if (!isHttpUrl(url)) return undefined;
    await mkdir(MEDIA_DIR, { recursive: true });
    const outputPath = path.join(MEDIA_DIR, `stitch-${sessionId}-${signature}-delivery-mix.m4a`);
    if (await hasUsableMediaFile(outputPath)) return outputPath;
    await unlink(outputPath).catch(() => undefined);
    await downloadVideoToFile(url, outputPath, "delivery mix");
    return outputPath;
  } catch {
    return undefined;
  }
}

async function materializeVideo(url: string, sessionId: string, index: number, signature = "single") {
  const localMediaPath = localMediaPathFromUrl(url);
  if (localMediaPath) {
    if (await hasUsableMediaFile(localMediaPath)) return localMediaPath;
    throw new Error(`Local media is not a readable video: ${localMediaPath}`);
  }
  if (url.startsWith("file://")) return new URL(url).pathname;
  if (!isHttpUrl(url)) return url;

  await mkdir(MEDIA_DIR, { recursive: true });
  const outputPath = path.join(MEDIA_DIR, `stitch-${sessionId}-${signature}-shot-${index + 1}${videoExtensionFromUrl(url)}`);
  if (await hasUsableMediaFile(outputPath)) return outputPath;
  await unlink(outputPath).catch(() => undefined);
  await downloadVideoToFile(url, outputPath, `shot ${index + 1}`);
  return outputPath;
}

async function normalizeStitchInputVideo(
  inputPath: string,
  sessionId: string,
  index: number,
  signature: string,
  targetSize: { width: number; height: number }
) {
  const width = Math.max(2, Math.floor(targetSize.width / 2) * 2);
  const height = Math.max(2, Math.floor(targetSize.height / 2) * 2);
  const outputPath = path.join(MEDIA_DIR, `stitch-${sessionId}-${signature}-shot-${index + 1}-normalized.mp4`);
  if (await hasUsableMediaFile(outputPath)) return outputPath;
  await unlink(outputPath).catch(() => undefined);
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+genpts",
    "-i",
    inputPath,
    "-t",
    "10",
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS`,
    "-af",
    "aresample=async=1:first_pts=0",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-level",
    "4.0",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    outputPath
  ]);
  return outputPath;
}

export function probeVideoDimensions(filePath: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const child = spawn(ffmpeg.path, ["-hide_banner", "-i", filePath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    child.on("error", reject);
    child.on("close", () => {
      const match = stderr.match(/Video:.*?,\s*(\d+)x(\d+)(?:\s|\[|,)/);
      if (!match) return reject(new Error(`Could not probe video dimensions: ${filePath}`));
      const [, width, height] = match;
      resolve({ width: Number(width), height: Number(height) });
    });
  });
}

async function downloadVideoToFile(url: string, outputPath: string, label: string) {
  // Stream into a sibling .partial file so a torn-down connection can never leave behind a
  // half-written file that later passes the size>0 check in hasUsableMediaFile and gets reused as
  // if it were complete. Only after content-length / etag validation succeeds do we atomically
  // rename it into place.
  const partialPath = `${outputPath}.partial`;
  await unlink(partialPath).catch(() => undefined);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${label}: ${response.status}`);
  if (!response.body) throw new Error(`Failed to download ${label}: empty response body`);

  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      createWriteStream(partialPath)
    );
    await validateDownloadedVideo(partialPath, response, label);
    await rename(partialPath, outputPath);
  } catch (error) {
    await unlink(partialPath).catch(() => undefined);
    throw error;
  }
}

async function downloadImageToFile(url: string, outputPath: string, label: string) {
  const partialPath = `${outputPath}.partial`;
  await unlink(partialPath).catch(() => undefined);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${label} image: ${response.status}`);

  try {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error(`Downloaded ${label} image is empty`);
    await writeFile(partialPath, bytes);
    await rename(partialPath, outputPath);
  } catch (error) {
    await unlink(partialPath).catch(() => undefined);
    throw error;
  }
}

async function validateDownloadedVideo(outputPath: string, response: Response, label: string) {
  const fileStat = await stat(outputPath).catch(() => undefined);
  if (!fileStat?.size) throw new Error(`Downloaded ${label} is empty`);

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > 0 && fileStat.size !== contentLength) {
    throw new Error(`Downloaded ${label} is incomplete: ${fileStat.size}/${contentLength} bytes`);
  }

  const etag = (response.headers.get("etag") || "").replaceAll('"', "").toLowerCase();
  if (/^[a-f0-9]{32}$/.test(etag)) {
    const md5 = createHash("md5").update(await readFile(outputPath)).digest("hex");
    if (md5 !== etag) {
      throw new Error(`Downloaded ${label} checksum mismatch: ${md5} != ${etag}`);
    }
  }
}

function isHttpUrl(url: string) {
  return url.startsWith("http://") || url.startsWith("https://");
}

function isLocalReusableVideoUrl(url: string) {
  return Boolean(localMediaPathFromUrl(url)) || url.startsWith("file://");
}

function localMediaPathFromUrl(url: string) {
  if (url.startsWith("/media/")) return path.join(MEDIA_DIR, path.basename(url));
  try {
    const parsed = new URL(url);
    if (["localhost", "127.0.0.1"].includes(parsed.hostname) && parsed.pathname.startsWith("/media/")) {
      return path.join(MEDIA_DIR, path.basename(parsed.pathname));
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function videoExtensionFromUrl(url: string) {
  try {
    return path.extname(new URL(url).pathname) || ".mp4";
  } catch {
    return path.extname(url) || ".mp4";
  }
}

function imageExtensionFromUrl(url: string) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
  } catch {
    const ext = path.extname(url).toLowerCase();
    return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
  }
}

function imageExtensionFromContentType(contentType: string) {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return ".jpg";
}

function sanitizeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "video";
}

async function hasUsableFile(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function hasUsableMediaFile(filePath: string) {
  if (!(await hasUsableFile(filePath))) return false;
  try {
    await runFfmpeg(["-v", "error", "-i", filePath, "-f", "null", "-"], 2048);
    return true;
  } catch {
    await unlink(filePath).catch(() => undefined);
    return false;
  }
}

async function hasUsableFinalVideo(filePath: string, shots: Shot[]) {
  if (!(await hasUsableMediaFile(filePath))) return false;
  const expectedDurationSec = shots.reduce((sum, shot) => sum + (Number(shot.durationSec) || 0), 0);
  if (!expectedDurationSec) return true;

  const actualDurationSec = await probeVideoDurationSec(filePath).catch(() => 0);
  const minDurationSec = Math.max(1, expectedDurationSec * 0.92);
  const maxDurationSec = Math.max(minDurationSec + 2, expectedDurationSec * 1.2 + 2);
  if (actualDurationSec >= minDurationSec && actualDurationSec <= maxDurationSec) return true;

  await unlink(filePath).catch(() => undefined);
  return false;
}

export function probeMediaDurationSec(filePath: string) {
  return probeVideoDurationSec(filePath);
}

function probeVideoDurationSec(filePath: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(ffmpeg.path, ["-hide_banner", "-i", filePath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    child.on("error", reject);
    child.on("close", () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) return reject(new Error(`Could not probe video duration: ${filePath}`));
      const [, hours, minutes, seconds] = match;
      resolve(Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds));
    });
  });
}

export function createStitchSignature(shots: Shot[], audioTimeline?: VideosBatchAudioTimeline) {
  const selectedVersions = shots.map((shot) => {
    const render = (shot.renders || []).find(
      (item) => item.videoUrl === shot.videoUrl || item.remoteVideoUrl === shot.videoUrl
    );
    return {
      shotId: shot.id,
      index: shot.index,
      renderId: render?.id,
      videoUrl: shot.videoUrl
    };
  });
  const audioSignature = audioTimeline
    ? createHash("sha1").update(JSON.stringify(audioTimeline)).digest("hex").slice(0, 12)
    : undefined;
  return createHash("sha1").update(JSON.stringify({ version: STITCH_SIGNATURE_VERSION, selectedVersions, audioSignature })).digest("hex").slice(0, 12);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
) {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function localMediaPathFromMediaUrl(url: string) {
  return localMediaPathFromUrl(url);
}

export function runFfmpegCommand(args: string[], logBytes?: number) {
  return runFfmpeg(args, logBytes ?? ffmpegLogBytes());
}

function runFfmpeg(args: string[], logBytes = ffmpegLogBytes()) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg.path, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-logBytes);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          [
            `ffmpeg failed with exit code ${code}.`,
            "请确认输入视频可读取，且没有下载损坏或过期。",
            stderrTail.trim()
          ]
            .filter(Boolean)
            .join("\n")
        )
      );
    });
  });
}
