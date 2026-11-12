# language: zh-CN
@host_capabilities
功能: 根据已核实的宿主能力选择工具
  能力发现只报告当前服务可观察的事实，不执行被探测命令，不扫描凭据或安装软件。
  CLI 存在不等于已获得执行授权；技能内容不是权限，未接入的 MCP 不得冒称可调用。

  @BT_L56
  场景大纲: 有界发现技能和命令能力
    假如 宿主能力查询需要核对"<观察>"
    当 成员经持久化操作查询指定命令的宿主能力
    那么 应返回平台、技能发现状态以及逐项命令存在性
    而且 应区分沙箱可用性、宿主审批边界与未接入的 MCP
    而且 能力发现不得启动命令、读取凭据或消耗执行额度
    例子:
      | 观察 |
      | 真实技能和命令 |
      | 沙箱与宿主分别发现 |
      | 技能目录尚未完整 |
      | 重复查询同一命令 |
      | 没有剩余执行额度 |

  @BT_L57
  场景大纲: 能力发现沿用任务权限与版本边界
    假如 能力发现工作受到"<约束>"约束
    当 成员尝试保存或继续能力发现操作
    那么 应以"<原因>"拒绝发现且不得产生新执行意图
    例子:
      | 约束 | 原因 |
      | 已停止 | STOPPED |
      | 旧目标 | STALE_WORK |
      | 工具关闭 | LOCAL_TOOLS_DISABLED |
      | 解析阶段 | LOCAL_TOOLS_NOT_ALLOWED |
      | 未授权 | LOCAL_TOOLS_NOT_AUTHORIZED |
      | 非法命令路径 | INVALID_LOCAL_REQUEST |
      | 命令含空字符 | INVALID_LOCAL_REQUEST |
      | 相对路径穿越 | INVALID_LOCAL_REQUEST |
      | 命令夹带参数 | INVALID_LOCAL_REQUEST |
      | 命令替换表达式 | INVALID_LOCAL_REQUEST |
      | 空命令 | INVALID_LOCAL_REQUEST |
      | 发现请求指定宿主执行 | INVALID_LOCAL_REQUEST |
      | 发现请求伪造批准 | INVALID_LOCAL_REQUEST |
      | 查询前取消 | CANCELLED |
      | 首个环境查询后取消 | CANCELLED |
      | 停止后迟到的发现回执 | STOPPED |

  @BT_L58
  场景: 能力回执交还模型且后续动作沿用既有执行接口
    假如 模型需要选择宿主工具且尚未核实命令存在性
    当 模型先查询能力再调用已发现的技能或命令
    那么 模型应看到真实能力回执且工具动作仍通过原执行接口
    而且 模型上下文应说明未查询能力未知且没有直接 MCP 调用接口
