# 工具发现规划（KEJ-115）

## 目标

在保持宿主授权、版本隔离与事实边界的前提下，用 **BM25 + 主模型扩展召回 + 渐进加载** 取代每轮全量 `tool_inventory`，降低模型输入 token 浪费。

## EARS 摘要

| 编号 | 要求 |
|------|------|
| TDP-01 | 需要发现工具时执行 BM25 与精确名称/来源匹配；未进首批候选者仍可通过后续发现可取。 |
| TDP-02 | 常规模型请求提供核心接口、相关卡片、已激活知识与必要观测，**不**默认附整机完整目录。 |
| TDP-12 | `discoverHost` 允许一次提交用途词、`terms` 同义词与多个 `commands` 候选名。 |
| TDP-13 | 批量发现合并去重各通道命中，保留匹配原因；名称命中条目返回完整目录资料。 |
| TDP-14 | 仅来自世界知识的候选名为检索假设；目录未登记、PATH 未找到、用途未知与执行结果分别呈现。 |

## 实现要点

- `CliCatalog.recall`：SQLite FTS5 BM25；通用「用途未知」模板不参与相关性评分。
- `projectModelToolInventory`：模型侧只投影已发现 CLI 与已激活技能；`catalogInventory` 保留完整快照供元数据变更核对。
- `discoverHost` 增加可选 `terms[]`；`host-capabilities` 仅探测请求名与召回名，不再对整机目录逐条 PATH 探测。

## 验收

见 `features/69_tool_discovery_planning.feature` 的 BT_Y173、BT_Y174、BT_Y175 与修订后的统一工具上下文场景；真实任务 token A/B 另册记录。

原 PR 为本功能误用了已由 `features/69_cli_stdin.feature` 占用的 BT_Y145、BT_Y146、BT_Y147。完整枚举当前全部 feature 后，确认仅这三组编号重复，Y 组既有最大编号为 BT_Y172。本功能依次更正为 BT_Y173（首次渐进上下文）、BT_Y174（合并发现召回）、BT_Y175（后续请求保留已召回条目）；既有标准输入功能的编号和验证器引用保持原值。更正只消除身份冲突，不删除场景或改变验收行为。
