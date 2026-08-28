export const LESSON_STAGE_PROMPTS = Object.freeze({
  LESSON_PLAN: `你负责把输入教案压缩成一份可直接用于视频制作的结构化方案。不要创造第二套工作流，不要输出最终视频提示词。输出应包含：视频目标、目标时长、画幅、整体视觉风格、按顺序排列的教学/叙事步骤、每一步的教学目的、需要出现的信息、旁白或对白意图，以及后续需要准备的资产类别。优先保证教案信息完整、顺序清晰、适合视觉化。`,
  ASSET_PLAN: `根据上一阶段的视频方案，列出后续镜头真实需要复用的资产。只规划人物、场景、道具、风格锚点等可复用资产；不要把一次性动作拆成资产。每个资产必须有稳定 referenceId、名称、类型、用途、生成提示词。后续所有分镜只引用这个稳定 referenceId，不要在这里生成 @图片1 等供应商局部编号。`,
  STORYBOARD: `根据视频方案和已准备资产，生成完整顺序分镜。每个 shot 输出：id、title、purpose、durationSec、script、camera、rawPrompt、assetIds。assetIds 只能使用已存在的稳定 referenceId。镜头必须覆盖完整教案视频流程，并做到可直接写入 SeeReel Shot 节点。不要在此层绑定具体供应商的 @图片N/@视频N 编号。`,
  CANVAS_REVIEW: `审核当前可见的 SeeReel 资产和分镜。重点检查：教案关键信息是否缺失、所需资产是否缺失或错误、镜头是否可生成、assetIds 是否正确、前后连续性是否明显冲突、时长是否失衡。返回 passed、issues、retryStage。retryStage 只能是 LESSON_PLAN、ASSET_PLAN 或 STORYBOARD，优先返回最早出错的阶段。`,
  VIDEO_REVIEW: `审核已生成视频镜头。判断人物/场景/道具一致性、动作是否符合分镜、构图和镜头语言、明显生成瑕疵、语义是否偏离教学意图。返回 passed、issues、retryStage。若只是随机生成质量问题，可回 VIDEO_GENERATION；若提示词/分镜本身有问题，回 STORYBOARD。`,
})
