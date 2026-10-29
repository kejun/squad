import { describe, it } from 'vitest';
import { concurrentAcceptance, sandboxAcceptance, acknowledgementAcceptance, cliFailureAcceptance, crashAcceptance, guardAcceptance, leaseAcceptance, namespaceAcceptance, permissionAcceptance, registryAcceptance, serviceAcceptance, serviceRecoveryAcceptance, skillErrorAcceptance, stopAcceptance } from './local-tools-acceptance.js';
describe('local operation boundary and recovery integration', () => {
  it('[BT_L01] startup catalog and archived snapshots stay bound across a restart', registryAcceptance);
  it.each(['普通额度耗尽','评审汇总保留','后台讨论保留','已停止','工作过期','旧目标版本','权限关闭','解析阶段','旧任务缺少授权','租约不可用'])('[BT_L03] refuses %s before I/O', constraint => { guardAcceptance(constraint); });
  it('[BT_L04] actual runners queue on a shared lease and continue after committed settlement', concurrentAcceptance);
  it('[BT_L04] repeated message identities in different rooms keep default roots and copies isolated', namespaceAcceptance);
  it('[BT_L04] atomically serializes a shared workspace across rooms', () => leaseAcceptance());
  it.each(['queued', 'claimed', 'running'])('[BT_L05] holds %s physical work through stop', stopAcceptance);
  it.each(['保存前','已保存未领取','领取后启动前','启动后回执前','回执后模型前'])('[BT_L06] recovers SQLite at %s without duplicate effects', crashAcceptance);
  it.each([['缺失目录','empty'],['同名冲突','SKILL_AMBIGUOUS'],['路径穿越','SKILL_PATH_INVALID'],['内部链接逃逸','SKILL_PATH_ESCAPE'],['激活前修改','SKILL_VERSION_CHANGED'],['已激活后修改','pinned'],['恢复缺少版本','SKILL_VERSION_UNAVAILABLE']])('[BT_L08] reports %s', skillErrorAcceptance);
  it.each([['命令缺失','CLI_NOT_FOUND'],['沙箱不可用','CLI_SANDBOX_UNAVAILABLE'],['非零退出','failed'],['超时','timeout'],['取消与后代','cancelled'],['大量输出','truncated']])('[BT_L10] settles %s truthfully', cliFailureAcceptance);
  it('[BT_L06] [BT_L11] startup reconciles a durable receipt before scheduling', () => serviceRecoveryAcceptance(false));
  it('[BT_L06] startup retains a possibly launched command without guessing', () => serviceRecoveryAcceptance(true));
  it('[BT_L11] wires local tools through WebService and durable execution details', serviceAcceptance);
  it('[BT_L15] runs local operations through the real offline state graph templates', sandboxAcceptance);
  it('[BT_L14] acknowledges reviewed effects only after confirmed process exit', acknowledgementAcceptance);
  it('[BT_L12] current revocation wins over previously active local work', permissionAcceptance);
});
