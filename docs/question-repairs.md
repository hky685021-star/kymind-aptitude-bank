# 受控补充材料与答案勘误

原始签名题库不改写。网页把已核实的来源材料放在目标题干前，原答案与原解析继续保留。独立侧车只表达材料关联、明确答案勘误或暂停判分，不把 AI 解析文本自动当成答案字段。

## 数据位置与格式

- 作者侧车：`supplements/repairs/batches/<batch>/records.jsonl`。
- 批次元数据：同目录 `batch.json`，包含 `bankId`、`sourceReleaseId`、`sourceManifestHash`、`recordCount`、`recordsSha256`。
- 网页投影：`supplements/repairs/reader/index.json` 及 `v1/<前缀>-<SHA256>.json`。
- AI 的 `reviewStatus` 和 `sourceIssues` 仍遵循原 SDK，不能因另有 repair 就把未解决的 AI 稿标成 `reviewed`。

每条 repair 字段：

| 字段 | 约束 |
| --- | --- |
| `schemaVersion` | 固定 1 |
| `key` | `bankId/questionId/releaseId/manifestHash/revisionDigest` 五项完全绑定原题 |
| `reviewStatus` | `reviewed`、`needs-review` 或 `blocked` |
| `materialLinks` | 最多 8 条，空数组表示没有补充材料 |
| `answerCorrection` | `null` 或下述受控勘误 |

每个材料关联保存 `sourceQuestionId`、`sourceRevisionDigest`、`sourceFile`、`collectionId`、`evidence`、`stemBlockIndexes`。`stemBlockIndexes` 是来源题 `stem.doc.content` 的零基索引，严格递增、不重复、最多 128 个。`null` 明确表示展示完整来源题干，并提示其中可能含来源题提问。任何方式都不带入来源题选项、答案或解析。

来源题和目标题必须属于同一份原始签名试卷。生成器同时检查签名、声明文件 SHA256/长度、原题 canonical 摘要、网页索引身份、同卷成员身份、所选材料块、图片声明及图片字节摘要。网页再次检查当前发行、文件 SHA256/长度、来源题 canonical 摘要、同卷成员和材料范围。来源题已隔离或不可练时，不作为补充材料展示。

## 判分规则

`answerCorrection` 包含：

- `action`：`replace`、`withhold` 或 `keep-original`。
- `originalOptionIds`：必须与原库答案完全一致，不重复。
- `correctedOptionIds`：只有 `replace` 可以非空，必须是原题真实存在的选项 ID。
- `reason`：清楚说明勘误或暂缓原因。
- `evidence`：非空依据数组，最多 32 项，每项最多 2000 字符。

只有 `reviewed + replace`、证据非空、原答案匹配、选项有效、题型允许，而且所需补充材料与图片已加载核验，才按修正答案判分。网页同时明确列出“勘误后参考选项”和“原库参考选项”，不会覆盖原解析。

单选/判断题只能替换为一个选项。原题为单选、答案字段写 A、原解析写 AD 等情况，必须 `withhold`，不能把交互仍为单选的题目按 AD 判分。本实现不变更题型。

`withhold` 即便是 `needs-review` 也会安全停用自动判分。原库内容仍可查看，但明确标为未确认参考。`keep-original` 必须经过复核并给出依据。后续批次不能用 `answerCorrection:null` 静默清除已有勘误，需要明确的 `keep-original`。

目录 404、超时、摘要不符、旧版本、来源材料缺失、图片加载/解码失败等情况也暂停自动判分，并提供重试。失败不是“没有勘误”。只有成功读取当前目录并确认本题无 repair，才直接使用原库判分。

重试会使旧的答案显示及判分依据失效，需重新核对。浏览器保存作答时额外记录判分模式、repair 摘要和所用选项，原题 revisionDigest 不改。恢复旧进度只恢复作答，不复用旧的正确/错误判定。

## 生成与发布

```sh
python3 scripts/build_question_repairs.py \
  --ai-batch 2026-11-06-seven-samples
```

首批完成后，为 AI 参数补上新的批次，并以 `--repair-batch <batch>` 指定对应 repair 批次。所有参数均按从旧到新的顺序重复，后面的批次优先。`--check` 校验生成结果，不写文件。

生成器检查所列最新 AI 记录的来源问题。已知答案冲突、缺材料、缺图或来源待核验，而没有覆盖该问题的已复核 repair 时，产生保守的 `withhold`，绝不据 AI 文字猜出一个修正答案。若作者已经提供详细的 `withhold`，保留其原因和证据。投影中的 `sourceIssues` 是审计字段，可能包括已被 repair 解决的旧标记，实际状态由 `reviewStatus` 和 `answerCorrection` 决定。

正式发布要同时提交 AI/模型投影、repair 批次及 repair 投影。即使没有任何 repair，也要生成一个空的有效 repair 目录，不能用缺文件代表“无勘误”。当前初始投影只为原有缺图缺材料的七题样例之一生成暂停判分记录，不声称首批新内容已发布。

## 资源和安全边界

- 选择题目时核对 repair 元数据，AI 与模型正文仍由各自按钮按需加载，不调用模型。
- 沿用目录 256 KiB、分片 4 MiB、每片 2000 条、4 个并发/缓存分片的上限。
- 每份材料最多 20000 个节点、64 层、200000 UTF-16 字符；每个目标题最多 32 张相关图片、16 MiB 图片原始字节。
- 图片只读同一签名发行声明的 PNG/JPEG/BMP，经原有图片摘要校验后用对象 URL 展示。解码超时 10 秒，像素总数超过 6400 万拒绝；重试与离开题目释放对象 URL。
- 勘误和证据使用纯文本，源材料通过原有白名单 Tiptap 渲染器展示。侧车不提供任意 URL、HTML 或脚本执行入口。
- 侧车摘要只证明目录/文件一致，不能证明勘误内容绝对正确或用户逐题批准。独立内容复核仍不可省略。

## 测试

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_question_repairs.py'
python3 scripts/build_question_repairs.py --ai-batch 2026-11-06-seven-samples --check
node tests/check-repair-examples.mjs /path/to/repair-records.jsonl
python3 scripts/verify_repository.py
```

真实样例集成检查已验证 4 条材料关联、1 张来源图片摘要与 3 条暂停判分记录，源数据未改动。运行环境仍不允许 Chromium 创建本地 socket，真实浏览器、视觉布局与线上部署验收尚未完成；Node/DOM 测试不能代替这些验收。
