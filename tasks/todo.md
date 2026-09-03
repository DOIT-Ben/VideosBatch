# 参考图绑定修复任务

- [x] 更新唯一规范和修复落地文档
- [x] 保留 `shot.assetIds` 声明顺序读取资产
- [x] 生成并持久化 ordered reference binding
- [x] H3 用同一列表生成 `Image N` 映射和 multipart 图片
- [x] 保存脱敏审计字段与 ShotRender 快照
- [x] 修复 `COPYABLE_PROMPT` 首个画面子镜头回退
- [x] 增加并通过定向测试
- [x] 实跑并验收 3 个真实 10 秒镜头

## 音频就绪门禁与 PARTIAL 重试

- [x] `COPYABLE_PROMPT` PARTIAL/FAILED 不再显示 ready
- [x] legacy 状态自动收敛并支持带 lineage 的显式重试
- [x] STITCH 拒绝空 TTS、未就绪音效和 pending mix
- [x] 补充 API/native media 回归测试并通过
