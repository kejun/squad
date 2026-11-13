---
name: verify-squad-delivery
description: "交付候选、下游直接修正、缺口交付、验证状态、来源冻结或发布原子性改动时，运行 TLC、双存储对应回放和真实源码负对照。"
---

# Verify Squad delivery

先读 AGENTS.md、[当前实现对应](references/correspondence.md)和[单向交付维护](../../../docs/implementation/forward-delivery-formal.md)。精确覆盖文件、候选/已同步提交以 references/*coverage.json 为准；历史审查保留在 references/drift-review-*.json。本轮以新流程替代旧审核承诺，不沿用旧证明宣称新流程通过。

## 运行

使用本 checkout 的锁定依赖（缺少依赖时才运行 npm ci）、受支持的 Node、Python3.10+ 与 Java11+。设置 TLA2TOOLS_JAR 指向官方 TLA+ Tools1.7.4 / TLC2.19；SHA256 必须为 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`。命令支持 --jar 和 --evidence（全新目录）。

为避免导入本机模型配置，当前进程先使用 `env -u MODEL_API_KEY MODEL_BASE_URL=http://127.0.0.1:1/v1 MODEL_NAME=formal-fixture MODEL_NO_AUTH=true` 前缀；实际回放用显式固定配置，不调用该端点、不改用户 .env。

```sh
python3 .agents/skills/verify-squad-delivery/scripts/check.py
```

- Delivery：单任务、候选、文档及固定技能回执，goal1..2，一次崩溃/回滚。AtomicPublication、CurrentCandidate、VersionIsolation 与 Progress 保留；九种损坏回执是独立有限输入检查。
- Verification：单检查、一次验证成功/失败、最多两次请求（含提前补救）、两个工作区版本、一次最终复核与回滚/重开。允许验证前请求模型；HonestVerification 要求缺失/失败/版本变化进入正文，OrderedPublication 保护停止及发布原子性。
- Cycles：三个明确用户周期、四个文档修订、一次下游直接修正、一次回滚/重开。RetainedPublication、CurrentCandidate、OneFinalPerCycle 与 Progress 保留；不再经过作者自动修订。
- SourceLineage：同群三个任务，A 两版，B 冻结 A1，C 只引用 B，包含停止/续办和一次重开。FrozenSource 与 DirectLineage 保留。
- 主 check.py 自动运行三个组合切片；临时开发可单独运行 composition-check.py，不能据此宣称完整技能通过。

## 完成条件

源码漂移先按[维护流程](references/maintenance.md)审查；不能只更新指纹。完整流程应包括 TLC 全有限图及适用的独立活性、MemoryStore/SQLite 每条标记边的代表前缀回放、独立可达见证、隔离真实源码负对照、移除变体后的原版复验和独立读回。源码变异必须由对应行为断言检出，导入/依赖/超时/哈希错误不算检出。

仅完整退出0、run.json.status=verified、清理全真且读回成功算通过。原始 TLC 日志须有完整探索、零剩余队列和适用的 temporal checking 完成；不得把缩小范围、模拟、部分输出或过期证据当成通过。记录实际命令、性质、边界、源码与 checker 输入哈希和反例，不照抄历史统计。

对每个生产器输出的实际证据目录分别设置 SQUAD_FORMAL_EVIDENCE 后，只运行对应入口的读回命令：

```sh
python3 .agents/skills/verify-squad-delivery/scripts/check.py --verify-evidence "$SQUAD_FORMAL_EVIDENCE"
```

每条抽象边只比较一个具体前缀，加上代码对应审查，不是任意 TypeScript 历史的等价证明。数据库事务原子性、可信执行器及各切片明确列出的公平性是前提；模型内容正确性、供应商可用性、强制归档删除、任意规模/无限故障和 UI 不在本证明中。快照探针与真实进程实例单独报告，不扩张成 TLC 域。

维护时请求 `$create-formal-verification-skill 维护 squad 的 verify-squad-delivery`。只有对应审查、全部受影响正负检查及独立读回通过后才推进 syncCommit；产品真实违约保留为 bug，按用户既有修复授权另提产品提交。TLC 模型看不到任意源码改动，真实变异和回放证明对列出的故障敏感，不保证检出全部缺陷。
