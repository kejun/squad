# KEJ-98 实施记录

基线 e7c42eb。需求评估：合理，无阻断问题。现有群历史有数量/文本预算且含草稿，不能保证指定已发布原文。采用现有房间事务内固定单份Markdown来源，独立新任务和原交付检查，无新表、新阶段或并发机制。影响可信入口、任务输入、模型材料、交付校验和网页引用。

设计取舍：不依赖群历史或宿主CLI读取，不将跨任务来源作为同任务replacesArtifactId。原文32KiB完整传递；缺失、歧义、忙碌及不合格来源明确拒绝。执行角色及检查上下文不足失败关闭。来源与输出身份隔离。

依据：GitHub永久链接 https://docs.github.com/en/repositories/working-with-files/using-files/getting-permanent-links-to-files ；SQLite事务 https://www.sqlite.org/transactional.html 。源码核对 engine.submit/receipt、publicationIds、conversationHistory、task context/operations/delivery 和网页发送入口。

## 顺序与验证记录

1. 阅读项目规则、Uncle Bob Mode、需求及既有代码，按路由、执行、网页并行只读评估，确认无阻断问题。
2. 先写 BT_A29–BT_A39 与房间事务、任务初始化及交付细化图；模型层验证先于Store/HTTP/网页接线。

模型层、集成及界面验证记录如下。实现不修改来源任务，不新增存储设施。

## 模型层验证

模型版本：基线 e7c42eb 的真实 XState taskMachine，加入可选 sourceArtifact、固定引用与 Markdown 门禁；XState 5.33.3。先运行新增模型测试观察到 9 项缺失功能失败，再实现并通过。

命令：`MODEL_BASE_URL=https://example.test/v1 MODEL_NAME=fixture node node_modules/vitest/vitest.mjs run tests/source-artifact-model.unit.test.ts tests/delivery-version-model.unit.test.ts tests/delivery-acceptance-model.unit.test.ts --maxWorkers=1`；结果 3 文件、40/40 用例通过。`node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` 通过。MODEL_BASE_URL/MODEL_NAME 是测试配置，transport 不调用供应商；环境只有注入 MODEL_API_KEY 时需提供完整测试配置。

关键轨迹：初始化克隆 source 并排除群历史重复 → 规则/模型解析保留同一来源 → owner → HELP/B → owner → DELIVER 新 Markdown → check 固定同份完整正文及本轮要求 → 当前 CHECK_RESULT 发布新 artifactId/documentId。旧 ID 候选/背景/修订基底及 ARTIFACT 注入拒绝；长纯结论、非 Markdown、空文档不能成功发布。独立检查将未保留内容判为 failed 后进入既有有界修订，不发布；该测试证明负面结果接线，不冒充模型语义判断。STOP → 迟到 DELIVER 拒绝 → persist/restore/RECOVER 保留来源；无来源旧快照路径维持原行为。

此门槛通过后才开始 Store、HTTP、网页与模型适配器接线。


## 接线、自审与验证

3. 门槛通过后接入房间事务、MemoryStore/SQLite、HTTP、模型适配器与网页。引用只提交两个ID；来源正文由服务端复核并固定。消歧只返回当前群元数据；等待用户与活动任务保持隔离。已有存储结构直接保存新增可选字段。
4. 独立审查修正了活动房间busy优先级、旧长回答在历史message.detailText中的重复正文、无法确认发布清单的旧草稿误显引用按钮，以及合法中文文件名和代码块边界。新增去重持久回归；消歧的两个When分别执行歧义请求与实际选择；并发测试通过真实HTTP验证同ID幂等与不同ID互斥。
5. 定向结果：来源解析29项、Engine事务28项、HTTP9项、UI9项加相关回归13项；新增BT_A29–BT_A39共34个Gherkin展开用例已直接执行通过。来源模型/适配器共20项；新增history去重2项。构建与前后端、测试TypeScript检查通过。
6. 按仓库verify-squad技能运行独立真实浏览器验收。真实SQLite、HTTP、React、适配器与下载，只替换本地模型provider边界。8组入口通过：预览引用、新文档与检查同原文、来源回跳与原下载逐字对比、旧任务/消息隔离、服务重启、直接名称引用、同名消歧、busy保留及移除；Doctor三次通过，清理四项全true。证据保存在执行工作区 `work/kej-98/browser-2026-11-06T09-36-23.627Z`；这些证据针对该次工作树，不冒充供应商语义质量证明。
7. 首次完整检查发现新增引用条13px违反现有14px下限，修为14px且样式7/7通过。既有CLI夹具中npm更新通知在全新HOME联网耗时约5秒，单变量禁用该通知后子进程从5275ms降为183ms，原构建/隔离断言通过。修复只在测试夹具设置npm环境参数，未更改产品、超时或断言，单独提交。原生命名空间验收需要允许bwrap创建命名空间的执行权限；外层执行沙箱受限时不能视作产品失败或跳过断言。

完整检查的最终命令及退出结果在完成后补记。保持原有验收缺口登记不变，不声称真实供应商质量、跨群引用、多源合并或原生平台之外的验收。
