# 按次宿主 CLI 授权验证

基线：`3695dc6673b4a10f321f395f156eef3a9b13d966`，2026-11-04。场景 BT_L23–BT_L30，状态图见 [宿主命令按次授权](state-diagrams.md#宿主命令按次授权)。

## 实现前模型门槛

在接入进程、HTTP 或网页之前运行真实 taskMachine，每步 persistTask / restoreTask；无真实文件、进程、数据库、网络或模型 I/O。

命令：`node node_modules/vitest/vitest.mjs run tests/host-approval-model.unit.test.ts tests/local-operation-model.unit.test.ts --maxWorkers=1 --reporter=verbose`。

结果：55/55 通过（新增16项、原有39项），完整退出0。轨迹：请求→预备领取→awaitingApproval→批准→重新领取→running→succeeded；拒绝直接失败并保存模型回执；停止/过期/错标识/旧目标拒绝；RECOVER 使未消费批准重新等待并更换标识，已领取命令保持 uncertain 待核对。

受测 SHA-256：

- task.machine.ts：`24e1a16651b085a7ba677b366a51a9c29d901860ee707a054d7f4a434390c80e`
- local-operation.ts：`b3b31894755fb6f8d0ffa6350a9353e74477ec9913d040416c0b517ec41b7384`
- task/lifecycle.ts：`bc45b38da77fefdaf156aeaebdd4e19b49a0eaf602c07c137e51f67b1a10cdcf`

工作区与可执行文件变化属于后续 I/O 接线验收，不把模型测试当作真实宿主执行证据。
