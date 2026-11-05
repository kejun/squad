# SRT 0.0.81 最小挂载顺序兼容补丁

## 依据

PR 36 的真实 Linux CI 已通过 namespace 和首轮文件/网络边界检查，但只读输入、可写输出检查因 `dist/build.txt` 返回 EROFS 失败。固定依赖的 `pushReadDenyDirMounts` 先恢复可写子目录，再恢复只读父目录，后者遮盖子挂载。生成命令可不启动 namespace 直接复现，同 singleton 配置缓存无关。

2026-11-05 查询 npm latest 和[官方发布](https://github.com/anthropics/sandbox-runtime/releases/tag/v0.0.81) 均为 0.0.81，没有可升级的已发布修复。

## 最小修改

`patches/sandbox-runtime-0.0.81.json` 保存明确版本、原文件与结果 SHA-256、唯一插入位置及八行补丁。`npm ci` 的 postinstall 只修补该版本的 `dist/sandbox/linux-sandbox-utils.js`；原始或已经修补的字节才接受，版本或任一哈希不符均抛错退出，不猜测新版结构。不要使用 `--ignore-scripts` 绕开补丁。

补丁在同一函数恢复只读路径后，仅重放已经由原函数验证、且被只读祖先覆盖的写挂载。后续原有 denyWrite、读取拒绝、凭据掩蔽和必须拒绝规则仍在其后执行。没有增加任何授权路径，不关闭 sandbox，不改变系统安全设置，也不在最终命令末尾追加可绕过拒绝规则的 bind。

## 验收与升级

- `tests/sandbox-mount-order.test.js` 使用实际依赖生成 argv，验证只读父目录先于明确写子目录，拒写子目录和拒写祖先仍最终优先。这是命令生成集成测试，不冒充 OS 执行。
- `tests/sandbox-runtime-patch.test.js` 验证原始转换、幂等、错误版本、被改动字节和错误目标哈希均按契约处理。
- BT_L22 的真实沙箱入口验证源文件只读、输出可写、输出内敏感文件仍拒写，且被拒绝祖先下的显式输出不能写入。
- 本地 namespace 不可用时，真实 OS 验收仍须在 CI 运行，不标记为通过。

官方修复发布后，应先确认它修复相同案例并通过上述回归，再升级锁文件并移除此补丁及 postinstall；不能仅更新版本/哈希让未知源码自动套用。

## 生产写规则范围

Linux SRT 0.0.81 会丢弃去除尾部 `/**` 后仍含 glob 的 denyWrite 字符串，不能把它们当作生效规则。工作区根 `.env`、`.git/hooks`、`.git/config` 使用明确 literal 拒写；空 hooks 且没有 HEAD 时也必须生效。`tests/sandbox-production-deny.test.ts` 通过真实 sandboxPolicy 和公开 SandboxManager 验证转换后 argv，而非手工传递理想规则。

现存嵌套 `.env`、`.env.*`、SQLite 文件可能由 denyRead 展开后的掩蔽限制读取与写入，但这不是嵌套 denyWrite glob 生效的证据。任意未来目录中新建的同名文件、尚不存在的嵌套 Git hooks 不能仅靠当前静态路径策略保证拒写；不能据本次根目录修复宣称全模式写隔离。
