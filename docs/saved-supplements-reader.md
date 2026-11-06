# 网页读取已保存的补充

`online/` 只读取静态保存稿，不调用模型，不请求密钥，不修改题干、原答案、原解析或签名。单题和套卷的每道可练题都有独立的 **AI解析** 和 **模型索引** 按钮，原解析仍独立展开或收起。

AI解析固定展示「重点解析」「秒杀技巧」。网页原样展示保存文本，不替作者补结论，不自动生成捷径。文本中的 HTML、Markdown 链接或 TeX 命令不执行，也不会访问其中的地址。

## 审核状态

- AI沿用应用兼容的 `reviewed`、`needs-review`、`blocked`，不新增审核枚举。`reviewed` 仍不等于绝对正确或用户逐题批准。
- 模型索引展示 `pending`、`reviewed`、`quarantined`；词条自身状态另列。候选与空维度明确标注，网页不据此创建正式模型或筛选授权。
- 缺图、缺材料、答案冲突与来源待核验照实展示。阻断稿不作为解题结论。
- 没有保存记录与网络、404、JSON、摘要校验失败是不同状态。错误提供重试；缺记录或版本失配提供刷新索引，失败不会永久缓存成“无解析”。

## 生成消费索引

原格式仍保存在 `supplements/ai/batches/<批次>/` 与 `candidates/model-index/<批次>/`。额外的 `supplements/reader/` 是可重建的只读网页投影。

```sh
python3 scripts/build_reader_supplements.py \
  --ai-batch 2026-11-06-seven-samples \
  --model-batch 2026-11-06-seven-samples
```

加入新批次时，分别重复 `--ai-batch` 和 `--model-batch` 参数。**按从旧到新的顺序列出，后面的批次覆盖同一道题的对应补充。** AI与模型的优先顺序分别处理。不自动扫描目录选“最新”，防止备份、旧样题或未完成批次意外覆盖。

例如首批完成后，各自先列 `2026-11-06-seven-samples`，再列 `2026-11-06-batch-0001`。生成器校验批次 `recordsSha256`、模型 `dictionarySha256`、数量、身份、状态与原始题目 revisionDigest。加 `--check` 可验证当前投影与这些来源生成的结果逐字节一致。

同批数据与投影一起提交。`index.json` 为小目录，按 questionId 首两位分片。每个分片文件名含完整 SHA256，已有分片保留，避免打开旧目录的浏览器立即遇到失效路径。目录非签名授权证明；SHA256 检查只证明目录与分片一致，不能证明解析正确或作者身份。

## 绑定和资源预算

必须同时匹配 `bankId`、`releaseId`、`manifestHash`、`questionId`、`revisionDigest`。原题仍经独立的 Ed25519、文件长度及 SHA256 验证；补充失效不阻止原题练习。

- AI与模型正文首次点对应按钮才加载，不全库预取，不因切题调用模型。题前材料与勘误目录在选题时核对，见 [受控材料与勘误](question-repairs.md)。
- 目录最多 256 KiB、256 个分片；单分片最多 4 MiB、2000 条记录。
- 最多同时读取 4 个分片，成功缓存最多 4 个；点击同分片共享请求。
- 每段 AI 文本最多 16000 字符，四维每维最多 32 个词条，词条定义最多 2000 字符。
- 保留原网络层 30 秒超时、解压后字节预算、同源固定路径、禁止重定向及精确 SHA256/长度检查。
- 切题或页面离开会停止旧内容展示；迟到响应、连续点开/收起不改变当前题的展开状态。

## 验证

```sh
python3 scripts/verify_repository.py
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_question_repairs.py'
python3 scripts/build_reader_supplements.py \
  --ai-batch 2026-11-06-seven-samples \
  --model-batch 2026-11-06-seven-samples --check
```

生成检查参数必须包含实际已发布的全部批次，顺序与发布时一致。Node 测试包含不随新批次变动的七题数据契约、实际发布投影校验、异常/重试/版本隔离，以及 DOM 层的独立按钮和不执行 HTML 检查。

`tests/browser-saved-supplements.py` 另提供真实 Chromium 测试：单题/套卷入口、原解析与补充独立、导航清理、小屏横向溢出、错误重试、恶意文本及连续点击。先在仓库根目录启动 `python3 -m http.server 8791 --bind 127.0.0.1`，再运行脚本。需要 Python Playwright 与 `/usr/bin/chromium`，可通过 `KYMIND_TEST_URL` 指定服务地址。

当前实施环境中，Chromium 启动被运行环境的本地 socket 权限限制阻止；一次提权重试仍失败。**真实浏览器交互、视觉排版及上线站点验收尚未通过，不能以 Node/DOM 测试代替。** 内容首批是否完成、是否推送及部署结果由批次报告另行记录。
