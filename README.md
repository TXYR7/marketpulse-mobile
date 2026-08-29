# MarketPulse 手机版（独立 PWA）

基于桌面版 `D:\codex` 的概念，**独立新建**的手机看盘 app。现有桌面项目**未做任何改动**。

- 数据来自东方财富公开接口，由**手机浏览器直接抓取**（CORS 已验证 `*`），**无后端、无服务器、不依赖电脑开机**。
- 仅保留看盘核心：涨停池 / 连板梯队 / 题材强度 / 跌停炸板 / 自选 / 个股详情。
- 不含：回测、数据中心等桌面端重型功能（手机端保留交易记账/复盘/决策助手/历史晋级，见 `views-extra.js`）。

## 目录
```
index.html  app.js  analytics.js  views.js  views-extra.js  data.js  store.js  styles.css
version.js  manifest.webmanifest  sw.js  icons/
package.json  scripts/bump-sw.mjs  scripts/smoke.mjs  发布到手机.cmd
```
- `data.js`：东方财富接口封装（fetch 直连 + 字段解析 + 轻量情绪计算）
- `store.js`：自选 / 设置的 IndexedDB 本地存储
- `app.js`：渲染、导航、刷新、详情抽屉、设置
- `sw.js`：缓存 app 外壳（离线可启动），行情接口直连不缓存
- `version.js`：应用版本号单一事实源（设置页展示；由 bump-sw.mjs 与 CACHE 同步写入）
- `scripts/bump-sw.mjs`：发布时自动递增 sw.js CACHE 并同步 version.js
- `scripts/smoke.mjs`：轻量冒烟测试（纯函数断言 + 整文件语法护栏）

## 本地预览（开发用）
```
cd D:\codex-mobile
python -m http.server 8099
```
浏览器打开 http://127.0.0.1:8099/ （必须走 http，不能双击 file:// 打开，否则 ES 模块不加载）。

## 发布到手机（已定：GitHub Pages）

仓库：`https://github.com/TXYR7/marketpulse-mobile`
线上地址：`https://txyr7.github.io/marketpulse-mobile/`

### 一键发布
双击本目录的 **`发布到手机.cmd`** 即可（git add → commit → push，Pages 一两分钟内自动生效）。

- 首次推送若弹出 GitHub 登录窗口，完成一次浏览器授权即可，之后永久免密。
- **版本号无需手动改**：`发布到手机.cmd` 会自动运行 `scripts/bump-sw.mjs`，递增 `sw.js` 的 `CACHE` 并同步 `version.js`（设置页可见当前版本）。
- 手机更新方式：重新打开 app 即可（导航已是 network-first + 新 SW 接管后自动重载一次）；离线/弱网冷启动会先显示上次成功的「快照」数据。

### 手动命令行（等价于脚本）
```
cd D:\codex-mobile
node scripts/bump-sw.mjs   # 递增版本号（sw.js + version.js 同步）
git add -A
git commit -m "mobile update"
git push origin main
```

## 在 Android 上安装为 app
1. 用 Chrome 打开上面的托管地址（必须 **https**）。
2. 点右上角 ⋮ → **“安装应用” / “添加到主屏幕”**。
3. 桌面出现 MarketPulse 图标，全屏无地址栏，离线可启动外壳。

## 在 iPhone / iPad 上安装
1. 用 Safari 打开上面的托管地址。
2. 分享按钮 → **“添加到主屏幕”**（apple-* meta 已配置，添加后全屏独立运行）。

## 测试

```
cd D:\codex-mobile
npm test
```

47 项冒烟断言：个股相似案例形状、决策助手三层输出、mergePools 三池部分失败降级、封单星级、情绪三指标（市场断板率/昨首板溢价/昨高位溢价）、题材升降方向、晋级八维硬否决、自由文本路由、gap 缓存策略、K线缓存复用、搜索结果价格、token 存取、信号快照对比、sw.js↔version.js 版本一致性、**整文件语法护栏**（7 个运行时 JS 全部经 vm.SourceTextModule 编译，改坏语法会被抓住）。

## 数据源 token 配置（可选）

东财 `push2` 接口偶尔需要 token；默认内置一个公共值，失效时可用以下任一方式覆盖（非密钥，仅接口参数）：
- **设置页「数据接口 Token」输入框**（推荐，改后即时生效）；
- 控制台执行 `localStorage['mp_ema_token'] = '新token'` 后刷新；
- 页面加载前注入 `window.MP_CONFIG = { emaToken: '新token' }`。

接口 401/403 全败时，离线空态会提示「Token 可能失效，去设置更换」。

## 说明 / 边界
- 行情有延迟，仅供信息展示，不构成投资建议。
- 涨停池价格为厘（÷1000 得元）；封单/成交额/市值单位为元。
- 非交易时段显示最近交易日快照；点 ↻ 手动刷新（开盘价 9:25 定型后刷新不再重拉预期差报价，秒回）。
- 自选仅存本机浏览器（IndexedDB）。
- 自选里「非涨停」股票的实时价/资金流走 `push2.eastmoney.com` 批量接口；若该接口临时限流，会优雅降级显示 `--`，涨停池内的自选则始终有数据。
- 设置页可开「信号变化通知」：前台运行时标的升级/新入 S 级/检查表转可接力会发本地系统通知（需授权；零后端约束下无后台推送）。
