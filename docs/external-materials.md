# 外部材料恢复侧车

该格式补回作答必需材料，不替换原题或原答案。完整题始终按原始签名答案判分，历史答案争议仍只是注释。Python 校验不联网、不抓取 URL，不修改任何原始文件。

## 作者数据

Repair 批次仍放在 `supplements/repairs/batches/<batch>/`。每条记录可增加 `externalMaterials`（最多 8 项）。旧记录不增加任何字段，保持原投影逐字节一致。

每项字段：

- `materialId`：非空、最多 200 个 UTF-16 单元，同题唯一。
- `kind`：`image`、`text-summary` 或 `text-data`。
- `title`：最多 300 个 UTF-16 单元。
- `sourcePageUrl`：HTTPS 公共域名来源页，仅为引用。
- `sourceAssetUrl`：`null` 或符合相同约束的 HTTPS 资源引用。
- `checkedOn`：有效的 `YYYY-MM-DD` 日期。
- `identityEvidence`：非空纯文本，最多 4000 个 UTF-16 单元。
- `contentSha256`：64 位小写十六进制 SHA256。
- `text`：图片为 `null`；文本类为非空纯文本，最多 16000 个 UTF-16 单元，精确保留所有字节，包括换行和尾随空格。摘要对 UTF-8 原文计算，不添加换行。
- `asset`：文本类为 `null`；图片为 `{path,sha256,byteLength,mimeType,width,height}`。路径严格为 `assets/<完整摘要>.png|jpg|bmp`，物理文件位于 `supplements/repairs/assets/`。`contentSha256` 必须等于 `asset.sha256`。

URL 不接受凭据、非 443 端口、控制符、空白、反斜线、IP 或本地域名，最长 2048 字符。不解析 DNS，也不因保存引用而访问来源。所有文字仅按纯文本展示，不渲染 HTML、SVG 或嵌入 URL。

## 独立复核

同批次可提供 `external-material-reviews.jsonl`，由 `batch.json.externalMaterialReviewsSha256` 绑定整个文件。存在但未绑定、摘要错误、重复题、未知题或过期复核都会使构建失败。没有文件及绑定时，投影 `externalReview` 为 `null`。

每行字段：

- `key`：原题五字段完全一致，不能包含额外字段。
- `materialHashes`：本条记录所有材料的 `contentSha256`，必须唯一且集合精确相等；不能遗漏、增加或复用旧材料摘要。
- `reviewStatus`：`reviewed` 或 `needs-review`。
- `coverage`：`sufficient` 或 `partial`。
- `reviewedOn`：有效的 `YYYY-MM-DD`。
- `identityChecks`：最多 32 条具体题组、题干和选项比较，每条非空且最多 4000 UTF-16 单元。
- `coverageReason`：非空，最多 4000 UTF-16 单元。
- `limitations`：最多 32 条，每条非空且最多 4000 UTF-16 单元。

`sufficient` 要求 `reviewed`、至少 3 条身份比较及空 `limitations`。`partial` 要求明确列出非空 `limitations`。最多 2000 行，每题最多一行。

生成器只投影以上已验证字段到 `externalReview`。作者记录内自行填写的 `externalReview`、`complete:true` 不能替代独立复核。记录自己的 `reviewStatus` 不能解除外部材料缺失。只有与当前所有材料绑定的 `reviewed/sufficient` 复核及已验证资源才能解除缺失标记；`sourceIssues` 审计原样保留。未复核或部分复核即使 AI 已清掉缺失标记也必须暂停判分。已独立复核（`externalReview.reviewStatus=reviewed`）的部分材料可以显示，但仍暂停判分；无独立复核或 `needs-review` 时不显示外部正文。部分材料、复核限制和作者证据仍完整保存在投影，不以通用占位记录替换。记录自身的 `reviewStatus` 与外部复核独立，充分恢复不要求它同为 `reviewed`。已有答案建议不因此生效，仍按原答案政策处理。

## 图片与依赖

构建带外部图片的记录需要已有的 Pillow（`PIL`）；本脚本不会安装依赖。外部图验证 PNG/JPEG/BMP 扩展名、magic、实际解码格式和尺寸、精确长度及 SHA256，不允许动画。每图最多 8 MiB、边长最多 8192；同题内部关联图与外部图合计最多 32 张、16 MiB、6400 万解码像素。带外部材料的记录也会解码检查内部关联图片并累计预算。仅含旧式内部链接的记录保留原有签名及资源核验流程，网页仍须对实际加载及解码失败保守暂停判分。

测试：`python3 -m unittest discover -s tests -p 'test_*.py'`。

## 网页消费与验收

`online/external-materials.mjs` 在 repair 分片的精确摘要校验后再次验证外部字段、独立复核 key 和全部内容摘要。读取目录为 `supplements/repairs/reader/`，图片只能读取相邻 `../assets/<sha256>.<ext>`。来源 URL 只显示为用户主动打开的引用，不自动抓取或作为图片地址。文本用 `textContent`，不处理 Markdown、HTML 或数学指令；摘要和重新排版的表格分别明确标注。

网页只展示 `externalReview.reviewStatus=reviewed` 的正文。`coverage=partial` 可显示已经核验的部分，但继续暂停判分；无复核或待复核不展示正文。身份和内容摘要相符并不意味着已补齐条件，只有 `reviewed/sufficient` 才能解除外部材料缺失。详细覆盖判断、限制和核验比较可能透露解题思路，因此仅在查看答案后的核验记录展示。题前保留部分恢复提示与材料来源。

本地图片首先检查精确长度、SHA256、magic 与头部尺寸，之后经浏览器实际解码与声明尺寸比较。内部关联图也做头部尺寸检查。所有相关图的实际解码像素和边长受限。加载、摘要、尺寸、解码或超时失败时显示重试，不把失败当作没有补充材料；导航取消不显示旧题内容。旧的判分结果在重试时失效，原答案本身始终不改。

构建示例（由统一发布流程选择并替换批次名）：

```sh
python3 scripts/build_question_repairs.py \
  --ai-batch 2026-11-06-seven-samples \
  --ai-batch 2026-11-06-batch-0001 \
  --repair-batch 2026-11-06-batch-0001
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
node tests/check-external-materials.mjs /path/to/aptitude-batch-0001
python3 scripts/verify_repository.py
```

`check-external-materials.mjs` 为候选输入提供只读的真实银行集成测试：验证签名题目身份、原答案判分、纯文本摘要、同源本地图像摘要与图像头部，并确保部分恢复仍暂停。输入目录包含 `external-recovery/materials-to-publish.jsonl`、`external-material-reviews.jsonl`、`material-assets-to-copy.json` 及对应本地图像。它不发布侧车，也不访问第三方页面，不能代替独立内容审阅、Pillow 完整解码和真实浏览器验收。

目前已完成 Node/轻量 DOM 与 Python 验证。当前执行环境不允许 Chromium 创建本地 socket，因此真实浏览器解码、视觉布局及正式部署仍须后续验收，不能由这些测试宣称通过。
