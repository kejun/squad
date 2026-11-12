---
name: verify-squad-authority
description: "执行许可、LOCAL_* 宿主审批、工作区占用、停止/恢复或授权作用域改动时，运行有限 TLC、双存储回放及真实许可负对照。"
---

# Verify Squad authority

先读 AGENTS.md、[当前实现对应](references/correspondence.md)和[单向交付维护](../../../docs/implementation/forward-delivery-formal.md)。精确覆盖文件、候选/已同步提交以 references/*coverage.json 为准；历史审查保留在 references/drift-review-*.json。本轮以新流程替代旧审核承诺，不沿用旧证明宣称新流程通过。

## 运行

使用本 checkout 的锁定依赖（缺少依赖时才运行 npm ci）、受支持的 Node、Python3.10+ 与 Java11+。设置 TLA2TOOLS_JAR 指向官方 TLA+ Tools1.7.4 / TLC2.19；SHA256 必须为 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`。命令支持 --jar 和 --evidence（全新目录）。

为避免导入本机模型配置，当前进程先使用 `env -u MODEL_API_KEY MODEL_BASE_URL=http://127.0.0.1:1/v1 MODEL_NAME=formal-fixture MODEL_NO_AUTH=true` 前缀；实际回放用显式固定配置，不调用该端点、不改用户 .env。

```sh
python3 .agents/skills/verify-squad-authority/scripts/check.py
python3 .agents/skills/verify-squad-authority/scripts/composition-check.py
```

- Execution：一个已领取 owner、固定 attempt1；一次重开、停止与重复/旧 permit，保留一次性已提交执行许可。
- Host：单操作、固定旧 approval 与 parent attempt、四个授权阶段；领取/启动/审批到期/停止/恢复/其他工程持有者交错，检查 NoUnauthorizedStart。
- SessionScope：八个二值作用域、revoked 共 512 个有限输入；这是输入域对应，不是 512 条事务历史。
- ApprovalComposition：撤销、重新审批及 parent attempt 更新后的旧授权不能启动；精确域见 composition-spec.json。
- 原有双存储生命周期、commandDigest 文件/参数输入探针保留；不启动真实宿主命令，也不证明已发生的副作用被撤回。

## 完成条件

源码漂移先按[维护流程](references/maintenance.md)审查；不能只更新指纹。完整流程应包括 TLC 全有限图及适用的独立活性、MemoryStore/SQLite 每条标记边的代表前缀回放、独立可达见证、隔离真实源码负对照、移除变体后的原版复验和独立读回。源码变异必须由对应行为断言检出，导入/依赖/超时/哈希错误不算检出。

仅完整退出0、run.json.status=verified、清理全真且读回成功算通过。原始 TLC 日志须有完整探索、零剩余队列和适用的 temporal checking 完成；不得把缩小范围、模拟、部分输出或过期证据当成通过。记录实际命令、性质、边界、源码与 checker 输入哈希和反例，不照抄历史统计。

对每个生产器输出的实际证据目录分别设置 SQUAD_FORMAL_EVIDENCE 后，只运行对应入口的读回命令：

```sh
python3 .agents/skills/verify-squad-authority/scripts/check.py --verify-evidence "$SQUAD_FORMAL_EVIDENCE"
python3 .agents/skills/verify-squad-authority/scripts/composition-check.py --verify-evidence "$SQUAD_FORMAL_EVIDENCE"
```

每条抽象边只比较一个具体前缀，加上代码对应审查，不是任意 TypeScript 历史的等价证明。数据库事务原子性、可信执行器及各切片明确列出的公平性是前提；模型内容正确性、供应商可用性、强制归档删除、任意规模/无限故障和 UI 不在本证明中。快照探针与真实进程实例单独报告，不扩张成 TLC 域。

维护时请求 `$create-formal-verification-skill 维护 squad 的 verify-squad-authority`。只有对应审查、全部受影响正负检查及独立读回通过后才推进 syncCommit；产品真实违约保留为 bug，按用户既有修复授权另提产品提交。TLC 模型看不到任意源码改动，真实变异和回放证明对列出的故障敏感，不保证检出全部缺陷。
