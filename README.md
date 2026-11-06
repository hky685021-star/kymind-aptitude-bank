# KyMind 行测题库

这是 **hky685021-star 的公开题库版本仓库**，保留完整原始题库，并按批次保存独立 AI 补充及待审核的解题模型索引。兼容 GitHub Pages 的独立网页副本提供在线练习；AI补充与模型索引独立保存，AI审核和待审核状态分别标注；不覆盖签名原题。

## 在线练习

- 入口：https://hky685021-star.github.io/kymind-aptitude-bank/
- GitHub Pages 从 `main` 分支根目录发布，根入口跳转到 `online/index.html`；练习页仍读取 `original/bank-civil-aptitude/` 的原始签名数据。
- `original/` 下的签名题库和原网页保持原字节。`online/` 仅修正压缩传输的长度判断及数据相对路径，仍验证签名、解压后字节上限、精确长度和文件摘要。
- 首次进入需要下载题库清单和当前题目相关数据，速度取决于网络；部分旧浏览器可能不支持 Ed25519。

## 当前范围

- 原题库：70,575 道题、51,054 个原始文件、699,118,078 字节。
- 发行：`release-1791732747093-cdd4c2a3`。
- 题目、原答案、原解析、图片、索引、签名文件和原有网页均按原字节保留，没有重签名。
- 首批逐题处理1000个唯一题目ID，包含此前7个样例的重新处理及993题新增补充。旧样例文件原样保留。
- 当前数量、完整性、独立复核覆盖和模型审核状态以[首批报告](provenance/batches/2026-11-06-batch-0001/summary.json)为准，不把已保存等同于全部审核通过。
- 完整题仍按原始答案判分；解析冲突只作客观备注。真实缺失及部分恢复的题单独放在[缺失内容目录](missing-content/2026-11-06-batch-0001/)。

## 目录

- `original/bank-civil-aptitude/`：完整原始签名题库，不直接改写。
- `online/`：线上阅读器副本，保留原版界面并修复 GitHub Pages gzip 图片长度兼容问题。
- `supplements/ai/batches/`：重点解析、秒杀技巧及问题说明，与原题独立保存。
- `candidates/model-index/`：按真实字典版本分批的AI审核/待审模型索引，提交不等于用户逐题批准。
- `supplements/repairs/`：同卷材料链接及经独立核验的外部图表/数据补充。
- `provenance/batches/`：批次完整性清单、审核依据、字典与材料修复追溯。
- `review/2026-11-06-seven-samples.html`：现有七题审阅页，不是正式练习入口；其中记录仍待审核。
- `provenance/`：原始迁移清单、导入来源和文件校验记录。
- `scripts/verify_repository.py`：原始文件摘要、Ed25519 签名、题目数量与样题状态检查。
- `docs/batch-workflow.md`：后续批次保存与同步约定。

原先审阅包的应用源码、运行数据库、测试日志、完整研究账本和大型 ZIP 不在本仓库中。这里保存的是题库及补充数据，不是完整KyMind程序；尚未宣称已写入本机应用运行库。

## 校验

需要 Python 3 和 `cryptography`。在仓库根目录运行：

```sh
python3 scripts/verify_repository.py
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p test_question_repairs.py
```

原迁移 ZIP 的 SHA256 为 `0fb1a4bb77efc7531a4fa557c38b327b5cd2bff1d79593cde6ad2d7f202d6075`。ZIP 本身不提交；解包文件与迁移清单逐项一致。Ed25519 验证使用原包附带的公钥，只证明包内一致性，不证明原作者身份或每道题答案正确。

## 已知限制与授权边界

- 原迁移清单记录 1 个已有 PNG 解码异常，原字节保留，路径见 `provenance/transfer-manifest.json` 的 `summary.imageDecodeErrors`。不能把完整性验证通过理解成所有图片可正常显示。
- 原缺用水量图2题已找到可核验原材料，通过独立补充层恢复；原题文件不改。仍未完整恢复的题以本批缺失清单为准，不编造内容。
- 模型映射缺准确词条时保留空值和待复核原因，不为填满四维而编造正式代码。`practiceEligible` 是原始题目属性，不是本次候选审核通过标志。
- 原始签名元数据中的 `visibility: public` 等字段保持原字节；仓库已公开，并使用 GitHub Pages 提供独立线上阅读器入口。
- 原包许可为“仅供测试；对外再发行前须核对原题授权”。仓库公开不改变该限制，也不代表取得原题版权许可；使用或再次传播前须自行核对授权。
- 网页按钮只显示已保存的解析与索引，不发起实时模型请求。AI审核不表示用户逐题批准；缺准确词条继续保留待核原因。
- Node/DOM及数据合同测试与真实浏览器视觉验收不同。当前运行环境曾阻止Chromium本地socket，未完成的浏览器验收会如实列入报告。
