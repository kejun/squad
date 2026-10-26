# 面板布局与字号

用户调整左右面板、折叠导航并在手机上操作，群聊正文保持可读。

## Sub-features

- `layout-drag`：两侧真实指针拖拽与 Home 键。
- `layout-collapse`：导航折叠、刷新恢复并展开。
- `layout-mobile`：390px 手机导航抽屉。
- `layout-font`：群聊正文 14px 和实际字体证据。
- `layout-more`：其他键盘操作、取消、宽度保存与详情叠层（扩展）。

## How to get to it (user POV)

侧栏右边界「调整导航宽度」，成员详情左边界「调整详情宽度」；顶部导航切换按钮和手机抽屉内关闭按钮。分隔条支持 Home/End/方向键/Shift+方向键/Enter，拖动时 Escape 取消。

## Driving it with verify-squad

Preconditions: 1440×1000 视口、空浏览器偏好、完成合成任务后打开方案师过程；中文实际可显示。

- **运行。** `node .agents/skills/verify-squad/scripts/verify.mjs --feature layout`；动作位于 `layout()`。
- **拖拽。** 依次定位 separator「调整导航宽度」「调整详情宽度」，从边界框计算指针位置、按下、向扩宽方向移动 40px、释放；aria-valuenow 必须增加。focus 后 `press('Home')`，value 必须等于 aria-valuemin。
- **折叠。** 点顶部「收起导航」，侧栏不可见；刷新仍显示「展开导航」。展开后读取时间线 `.message-text` computed fontSize=14px，保存 `layout-desktop`。
- **手机。** 改为 390×844，点「展开导航」，保存 `layout-mobile`；在 complementary「群聊和成员」内点「收起导航」，恢复桌面视口。
- **证据。** 比较 `layout-before`/`layout-desktop`/`layout-mobile`，检查 ARIA、字体 JSON 和 trace 指针动作。没有通过 localStorage 写预期宽度。
- **扩展。** 另验 End/Shift+方向键/Enter、拖动中 Escape、已提交宽度刷新读回、窄桌面详情叠层与触屏拖动，各自记录边界值与截图。

## Gotchas

- 手机打开抽屉时可能有两个「收起导航」，限定侧栏，不用任意 first() 混淆入口。
- 左侧向右、右侧向左才扩宽。刷新关闭详情不代表宽度丢失。
- 只断言群聊正文 14px，不宣称逐个检查全页字号。远程字体关闭后用系统字体，字体 JSON 中无中文 glyph 时先修复环境。
