# MarketPulse 手机版（独立 PWA）

基于桌面版 `D:\codex` 的概念，**独立新建**的手机看盘 app。现有桌面项目**未做任何改动**。

- 数据来自东方财富公开接口，由**手机浏览器直接抓取**（CORS 已验证 `*`），**无后端、无服务器、不依赖电脑开机**。
- 仅保留看盘核心：涨停池 / 连板梯队 / 题材强度 / 跌停炸板 / 自选 / 个股详情。
- 砍掉了：回测、交易记账、复盘、数据中心、历史晋级、决策助手等重型功能。

## 目录
```
index.html  app.js  data.js  store.js  styles.css
manifest.webmanifest  sw.js  icons/
```
- `data.js`：东方财富接口封装（fetch 直连 + 字段解析 + 轻量情绪计算）
- `store.js`：自选 / 设置的 IndexedDB 本地存储
- `app.js`：渲染、导航、刷新、详情抽屉、设置
- `sw.js`：缓存 app 外壳（离线可启动），行情接口直连不缓存

## 本地预览（开发用）
```
cd D:\codex-mobile
python -m http.server 8099
```
浏览器打开 http://127.0.0.1:8099/ （必须走 http，不能双击 file:// 打开，否则 ES 模块不加载）。

## 发布到手机（任选一个免费静态托管）
app 外壳只需托管在任意静态站点，**数据不走这里**。以下均免费：

### A. GitHub Pages（推荐，常驻可用）
1. 在 github.com 新建一个仓库（如 `marketpulse-mobile`）。
2. 把本目录所有文件推上去：
   ```
   cd D:\codex-mobile
   git init
   git add -A
   git commit -m "MarketPulse 手机版"
   git branch -M main
   git remote add origin https://github.com/你的用户名/marketpulse-mobile.git
   git push -u origin main
   ```
3. 仓库 Settings → Pages → Source 选 `main` / `/root`，保存。
4. 几分钟后访问 `https://你的用户名.github.io/marketpulse-mobile/`。

### B. surge（一行命令，免仓库）
```
npx surge .   # 按提示填邮箱/域名，得到一个 *.surge.sh 地址
```

## 在 Android 上安装为 app
1. 用 Chrome 打开上面的托管地址（必须 **https**）。
2. 点右上角 ⋮ → **“安装应用” / “添加到主屏幕”**。
3. 桌面出现 MarketPulse 图标，全屏无地址栏，离线可启动外壳。

## 说明 / 边界
- 行情有延迟，仅供信息展示，不构成投资建议。
- 涨停池价格为厘（÷1000 得元）；封单/成交额/市值单位为元。
- 非交易时段显示最近交易日快照；点 ↻ 手动刷新。
- 自选仅存本机浏览器（IndexedDB）。
- 自选里「非涨停」股票的实时价/资金流走 `push2.eastmoney.com` 批量接口；若该接口临时限流，会优雅降级显示 `--`，涨停池内的自选则始终有数据。
