// 首屏主题与状态栏颜色由网页品牌皮肤生成。
try { const theme=localStorage.getItem('mp-theme')==='light'?'light':'dark';document.documentElement.dataset.theme=theme;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='light'?'#f5f2ec':'#11100e'); } catch {document.documentElement.dataset.theme='dark';}
