# KyMind 行测题库

这是 **hky685021-star 的公开题库版本仓库**，保留完整原始题库，并按批次保存独立 AI 补充及待审核的解题模型索引。原始网页通过 GitHub Pages 提供在线练习；AI 补充和模型候选仍未批准，没有合入原始练习题库。

## 在线练习

- 入口：https://hky685021-star.github.io/kymind-aptitude-bank/
- GitHub Pages 从 `main` 分支根目录发布，根入口跳转到 `original/bank-civil-aptitude/site/index.html`。
- 原始签名题库、网页和相对资源路径保持不变。题库加载会验证签名及文件摘要。
- 首次进入需要下载题库清单和当前题目相关数据，速度取决于网络；部分旧浏览器可能不支持 Ed25519。

## 当前范围

- 原题库：70,575 道题、51,054 个原始文件、699,118,078 字节。
- 发行：`release-1791732747093-cdd4c2a3`。
- 题目、原答案、原解析、图片、索引、签名文件和原有网页均按原字节保留，没有重签名。
- AI 样题补充：7 条，其中 6 条 `needs-review`、1 条 `blocked`，没有已批准记录。
- 模型索引：仅现有 7 题候选，全为 `pending`；没有全库模型批准或生产关联。

## 目录

- `original/bank-civil-aptitude/`：完整原始签名题库，不直接改写。
- `supplements/ai/batches/`：重点解析、秒杀技巧及问题说明，与原题独立保存。
- `candidates/model-index/`：未获批准的模型字典和索引候选。提交到 GitHub 不等于审核通过。
- `review/2026-11-06-seven-samples.html`：现有七题审阅页，不是正式练习入口；其中记录仍待审核。
- `provenance/`：原始迁移清单、导入来源和文件校验记录。
- `scripts/verify_repository.py`：原始文件摘要、Ed25519 签名、题目数量与样题状态检查。
- `docs/batch-workflow.md`：后续批次保存与同步约定。

原先审阅包的应用源码、运行数据库、测试日志、完整研究账本和大型 ZIP 不在本仓库中。这里备份的是题库及相关样题数据，不是完整 KyMind 程序。

## 校验

需要 Python 3 和 `cryptography`。在仓库根目录运行：

```sh
python3 scripts/verify_repository.py
```

原迁移 ZIP 的 SHA256 为 `0fb1a4bb77efc7531a4fa557c38b327b5cd2bff1d79593cde6ad2d7f202d6075`。ZIP 本身不提交；解包文件与迁移清单逐项一致。Ed25519 验证使用原包附带的公钥，只证明包内一致性，不证明原作者身份或每道题答案正确。

## 已知限制与授权边界

- 原迁移清单记录 1 个已有 PNG 解码异常，原字节保留，路径见 `provenance/transfer-manifest.json` 的 `summary.imageDecodeErrors`。不能把完整性验证通过理解成所有图片可正常显示。
- 七题中的用水量题缺“图2/全国平均值”材料，AI 记录仍阻断，不补造材料。
- 模型映射缺准确词条时保留空值和待复核原因，不为填满四维而编造正式代码。`practiceEligible` 是原始题目属性，不是本次候选审核通过标志。
- 原始签名元数据中的 `visibility: public` 等字段保持原字节；仓库已公开，并使用 GitHub Pages 提供原始网页入口。
- 原包许可为“仅供测试；对外再发行前须核对原题授权”。仓库公开不改变该限制，也不代表取得原题版权许可；使用或再次传播前须自行核对授权。
- 这里只新增在线访问入口；没有批量继续处理新题、没有定时后台上传任务、没有自动批准候选。
