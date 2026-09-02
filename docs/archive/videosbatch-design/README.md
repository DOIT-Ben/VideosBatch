# VideosBatch 历史设计归档

本目录保存阶段 2 归档的旧手册、旧计划、旧产品规格和旧版工作流技能。归档内容仅用于追溯与恢复，不参与当前开发，也不定义现行阶段、提示词或产物合同。

当前唯一有效的 VideosBatch 阶段规范是：

- [`specs/videosbatch-workflow-canonical.md`](../../../specs/videosbatch-workflow-canonical.md)

归档清单见 [`manifest.json`](manifest.json)。每项的 `bytes/sha256` 是仓库内归档文件的实际字节数和 SHA-256；如果来源文件在入库时经过 `.gitattributes` 换行规范化，则以 `sourceBytes/sourceSha256` 保留原始来源指纹，并记录 `archiveNormalization`。恢复时必须按清单反向移动并重新校验归档及来源哈希；不得在活动目录保留重复副本。
