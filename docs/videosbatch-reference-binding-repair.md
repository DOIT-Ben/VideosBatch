# VideosBatch 参考图绑定修复落地

Status: active
Date: 2026-09-02
Canonical spec: `specs/videosbatch-workflow-canonical.md`
Scope: 只修复 VideosBatch 的 FINAL_STORYBOARD -> native Shot -> NewAPI H3 参考图绑定链路。

## 目标

让同一个镜头的语义引用、上传图片顺序和 H3 提示词位置引用成为同一份可审计合同，避免资产全局表顺序改变后出现人物、场景和道具错绑。

## 假设与边界

1. `FINAL_STORYBOARD.references` 仍是语义标签，不增加模型输出的稳定资产 ID。
2. native `Shot.assetIds` 的声明顺序是本镜头参考图顺序；`Asset` 全局数组顺序不是业务顺序。
3. H3 只接收现有图片 URL 候选，仍遵守 2-9 张参考图和现有 HTTPS/本地缓存校验。
4. 执行快照写入现有 `Shot`/`ShotRender` JSON，不新增数据库或 Provider 配置。
5. URL 审计只保存 SHA-256，不把签名 URL、Token 或密钥写入日志。
6. 不改音频、六个文本生成阶段（`COPYABLE_PROMPT` 的派生完整性除外）、UI、其他 Provider 和 `.env`。

## 当前缺口

```text
FINAL_STORYBOARD.references
  -> nativeProjection 只保存 assetIds
  -> getAssetsForShot 按全局 data.assets.filter 返回
  -> H3 重新计算 referenceSets 并 append images
  -> rawPrompt 没有 Image N 映射
```

`assetIds` 数组本身可以有序；缺口是读取层把它降级成全局资产表过滤结果，且没有把语义引用和 Provider ordinal 一起保存。

## 目标合同

每个可提交的 VideosBatch H3 镜头都建立一份 1-based 有序列表：

```text
{
  referenceId,       // 当前分镜语义引用或 assetKey
  ordinal,           // 1..N，按 FINAL_STORYBOARD.references 声明顺序
  assetKey,          // 模型在本资产计划内的稳定业务键
  assetId,           // native Asset.id，仅服务端审计使用
  semanticLabel,     // 提示词中显示的资产名称，不含稳定公开编号
  imageUrlHash       // 实际提交 URL 的 SHA-256
}
```

必须同时满足：

- `getAssetsForShot(shot)` 按 `shot.assetIds` 顺序返回可见资产；额外的显式 @ 绑定按其声明顺序追加。
- `nativeProjection` 按 `FINAL_STORYBOARD.references` 解析并保存 binding，不能按全局资产数组重排。
- H3 适配器由同一 ordered list 生成提示词映射和 `form.append("images", file)`。
- H3 提示词包含 `Image N = 资产名称` 和“严格按 Image N 对应图片，不得交换人物、场景和道具”；不得包含 `Pxxx-Axxx`。
- 真实 URL 解析完成后才写入 `imageUrlHash`；绑定快照先于付费 POST 持久化，重试沿用快照。
- `ShotRender` 保存本次提交的 binding 快照；日志只输出 `{ordinal, assetKey, assetId, imageUrlHash}`。

### 兼容与失败策略

- 旧 Shot 没有 binding 时，以已经按声明顺序读取的 `assets` 生成一次兼容 binding。
- ordinal 不连续、重复 asset、超过 9 张或必需图片没有可读 URL 时，提交前失败，不静默丢图或重排。
- 已有快照的 URL 哈希与本次解析结果不一致时，提交前失败并要求重新确认资产；不得用新 URL 静默替换旧绑定。
- 轮询已有 task 时不重新上传图片；沿用 Shot/Render 中的快照。

## COPYABLE_PROMPT 完整性

`referenceAssetIds` 必须按 `FINAL_STORYBOARD.references` 的解析顺序返回，并与当前镜头的稳定 ID 集合完全一致。稳定 ID 已解析但语义文字没有出现在任何画面效果子镜头时，把标记插入第一个画面效果子镜头的开头；这不会改变去除标记后的正文，因此不应因此把整条镜头标为 `PARTIAL`。只有无法解析资产或没有可放置的画面效果时才进入 `failedSegments`。

## 实施步骤与检查点

1. **顺序读取**：改 `CinemaStore.getAssetsForShot`，先按声明 ID 逐项解析，再按声明顺序处理额外显式绑定。检查点：反向插入全局资产仍返回 `[A, B, C]`。
2. **投影快照**：改 `nativeProjection`，把语义引用解析为 ordered binding，并写入 native Shot。检查点：`assetIds`、binding ordinal 和语义名称一一对应。
3. **H3 编译器**：改 `newApiH3Video`，由一个列表生成安全的 H3 prompt、文件和审计回调。检查点：prompt 映射顺序、FormData 文件顺序、URL 哈希来自同一列表。
4. **执行持久化**：改 `nativeMediaStages`、直接 Shot 生成入口 `src/server/index.ts` 和现有类型扩展，在付费提交前保存 binding，在 Render 中保存提交快照。检查点：恢复/重试不重新解析全局资产表。
5. **副本回退**：改 `llmTextStages` 的 `COPYABLE_PROMPT` 派生和校验。检查点：第 7/9/10 类“语义位置未命中”镜头仍为 `READY`，且引用集合等于正式分镜。

## 定向测试

```text
npm run smoke:videosbatch-newapi-h3
npm run smoke:videosbatch-native-projection
npm run smoke:videosbatch-llm-text-stages
npm run smoke:videosbatch-native-media-stages
npm run smoke:specs
npm run smoke:secrets
npm run build
```

测试必须覆盖：全局资产逆序、H3 prompt/FormData 同序、无语义位置时首个子镜头回退、快照字段和不发送稳定公开 ID。

## 真实 3 镜头验收

仅在上述离线检查通过后执行，使用已有提示词、已确认资产和现有受保护运行时配置；不修改 `.env`，不打印凭据。

1. 临时进程环境切到现有 `native + newapi-h3` 路由，确认参考图是公开或签名 HTTPS URL。
2. 只串行生成 3 个 10 秒镜头，不执行全量工作流、不拼接、不生成第 4 个镜头。
3. 每个镜头核对脱敏 binding、提交 prompt 的 `Image N` 映射、实际上传顺序、taskId 和视频文件；出现未知提交、余额/策略拒绝或绑定证据缺失立即停止。
4. 只做生成结果的角色/场景/道具目视核对；旧视频不回溯修改，受影响镜头需重新生成。

## 完成标准

- [x] 代码和测试满足本文件目标合同。
- [x] 定向 smoke、规范、秘密扫描和构建通过。
- [x] 3 个真实镜头各有可审计的 binding 与视频结果，且没有超出授权范围的提交。
- [x] 真实运行事实只记录脱敏摘要；未验证项和 Provider 阻塞如实保留。

## 2026-09-02 真实验收证据

- 目标会话为既有 `ses_5e3ff36a`，只重新生成第 1、2、3 条镜头；没有调用文本/图片 Provider，没有执行 stitch，也没有生成第 4 条。
- 三条新 Render 均为 `minimax_h3`，各 1376x768、约 10.125 秒、包含 H.264 视频和 AAC 音轨。
- 第 1 条使用 2 张绑定，第 2 条 3 张，第 3 条 5 张；三条的 prompt 映射检查均通过，均未出现 `Pxxx-Axxx` 稳定公开编号，URL 哈希均为 64 位 SHA-256。
- 中段画面抽检分别看到乐乐/展厅、乐乐/管理员/展厅、人物/展厅/阶梯模型/图纸。第 3 条画面出现额外儿童形象，这是 Provider 内容漂移，不是参考图 ordinal 错绑；需后续创作复核时单独判断。
- 第一次提交曾返回 HTTP 502 且无 taskId；该 Render 保留为 `error` 历史记录。修复后的失败收敛已验证，当前没有孤儿 `generating` Render。
- 目标旧会话没有持久化 StoryPlan，因此本次证据是“参考绑定专项通过”，不代表完整剧本/画布终审通过。三条真实视频路径和完整脱敏字段保存在本机隔离证据摘要中，不写入仓库。
