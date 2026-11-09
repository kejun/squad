
## KEJ-107/108

- 阅读 AGENTS、官方 Uncle Bob Mode、生成器与维护/TLA结果规范、原Delivery模型与全部回放、交付/验证/来源生产入口。
- 原样开发入口先被 local-runtime/local-skills 的工作树漂移阻断；逐段审查后只刷新这两项指纹并保留blocked证据与旧sync。
- 先写BT_F50–F53和独立图草稿，再实现Verification/Cycles/SourceLineage及公开API驱动。
- 主动纠正早期宏动作粒度：将本地操作、负责人领取/交付、检查领取/请求/结果逐事务拆分；早期统计仅作为开发证据。
- 覆盖正常、拒绝、失败、停止、迟到、版本变化、回滚/重开、旧发布保留与直接来源；BDD另行直接执行。
- 负对照最初使用delete清旧publication未能检出，因为XState assign合并会保留缺省字段；改为类型合法地清空artifactIds，验证真正破坏旧发布选择。不把未检出的变异算通过。
- 增加独立原始证据读回：模型完成/活性、全图、各后端全边与逐步目标、见证、七类真实代码性质失败和清理。

- 最终统一命令132秒退出0：原31/79，新47/91、79/203、71/226；十类真实负对照×两后端命中，原版恢复全过，289件独立读回，全清理及checker输入未变。
- BT_F50–F53共10场景/488步骤直接通过。全部62项源码hash逐项等于e77f052；只推进sync/审查元数据并再次读回原证据，不重复冒称完整执行。

- 独立review发现raw读回只信摘要与corrupt-freeze反例层级不符；增加必需raw/fixture/config门禁，并用badFrozenContent修正内容故障事实，重做完整统一检查131.474秒退出0，290件读回通过。
- 后续仅只读reader补原Delivery根域必需证据；模型/driver/producer函数AST与captured inputs相等。十一类自洽删raw/目录/fixture/性质及摘要冲突全部被拒，正本未动且仍通过；不为只读补强冒称另一次全跑。

- 独立四控进一步发现旧根JSONL只核摘要；补原baseline/restored双存储实际边Counter与actual目标核对。新reader正本290件、十一类自身反控及独立四控全过；红记录保留，模型/driver/producer AST不变，未重复TLC。
