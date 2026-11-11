# MarketPulse 手机版（独立 PWA）

2026-11-11 配色更新：同步网页当前的独立明暗主题与按用途分配的颜色。主要操作和导航用暖金，选择与普通数据用柔和紫色，排行强度分用清晰的绿色数字与浅底，热度用铜色。S/A/B/C/D 评级同色呈现；风险橙黄分开并增加文字标识，首板密度独立显示。等待状态不因研究优先级而染成可打的绿色，首屏与 PWA 状态栏一起适配。

本次为外观更新，手机版继续使用原有 unified-2.0.0 判断模型；计算、通知和存储模块原样保留。颜色同步可运行 `node scripts/sync-workspace.mjs --appearance-only`。同版本模型对照可通过 `MP_DESKTOP_MODEL_ROOT` 指定匹配版本的桌面参考目录；跨大版本不声称判决一致。

2026-11-10 已按当前桌面功能重做手机工作区，采用独立手机布局和底部导航，并同步网页当前的矿物配色、主题揭幕、刷新反馈与导航图标。统一判决、买卖参考和排行筛选的纯计算模块与桌面同源，手机行情和推送继续独立运行。

- 数据来自东方财富公开接口，由**手机浏览器直接抓取**（CORS 已验证 `*`），**无后端、无服务器、不依赖电脑开机**。
- 四个入口：市场（指数、情绪、主线、核心、全市场股票）/ 打板（判断速览、候选筛选、风险与各池）/ 排行（涨停天梯、人气板块、热度榜）/ 工具（买卖参考、历史与复盘、决策助手、资料导出、设置）。
- 详情支持20/60/120日K、MA5/10/20、成交量和逐日查看；移动端独立排布。完整功能对照和数据边界见 [手机工作区](docs/mobile-workspace.md)。桌面服务端回测、审计结算、数据中心与回放继续在桌面运行。

配色、刷新和交互对照见 [对齐检查](docs/mobile-alignment-audit.md)。

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
- 一键发布会先构建共享后台包并运行测试；失败不会推送。
- **版本号无需手动改**：`发布到手机.cmd` 会自动运行 `scripts/bump-sw.mjs`，递增 `sw.js` 的 `CACHE`，同步 `version.js` 和HTML资源地址（设置页可见当前版本）。
- 手机更新方式：重新打开 app 即可（导航已是 network-first + 新 SW 接管后自动重载一次）；离线/弱网冷启动会先显示上次成功的「快照」数据。

### 手动命令行（等价于脚本）
```
cd D:\codex-mobile
node scripts/build-worker.mjs
npm test
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

127项冒烟检查、18项通知行为测试、16项工作区行为测试及13项主题/刷新/配色测试：个股相似案例形状、决策助手三层输出、mergePools 三池部分失败降级、封单星级、情绪三指标（市场断板率/昨首板溢价/昨高位溢价）、题材升降方向、晋级八维硬否决、自由文本路由、gap 缓存策略、K线缓存复用、搜索结果价格、token 存取、信号快照对比、sw.js↔version.js 版本一致性、**整文件语法护栏**（12个运行时JS全部经vm.SourceTextModule编译，改坏语法会被抓住）。

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
- 复盘、旧交易资料、历史池、通知设置与快照仅存本机浏览器（IndexedDB），工具页可导出。
- 自选里「非涨停」股票的实时价/资金流走 `push2.eastmoney.com` 批量接口；若该接口临时限流，会优雅降级显示 `--`，涨停池内的自选则始终有数据。
- **打板通知**：点击顶栏铃铛，默认手机独立发送；首板/接力/回封均覆盖，临板3档、精确开板、重试和刷新去重与桌面对齐。旧ntfy主题保留，后台不保证即时。详见 [通知说明](docs/notifications.md)。

## 通知维护

页面和经典Service Worker使用同一实现，后台包由 `scripts/build-worker.mjs` 生成。没有新增设置页导航，仅增加轻量通知弹层；旧“支持periodicSync就能准时”的探测已移除。

| 日期 | 位置 | 保留项 | 原因 | 清偿条件 |
|---|---|---|---|---|
| 2026-11-09 | IDB旧 `preSealRepeat/preSealDigest/preSealPrevSnap` KV键 | 旧通知账本数据仍保留 | 供一次性迁移和旧版回退，避免升级丢失已提醒状态；旧运行代码已移除 | 新版稳定使用且不再支持旧版回退时，可清理旧通知KV键；不涉及历史和交易数据 |
