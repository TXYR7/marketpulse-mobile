// 首屏主题与状态栏颜色由共享主题生成。
let initialTheme='dark';try{if(localStorage.getItem('mp-theme')==='light')initialTheme='light';}catch{}
document.documentElement.dataset.theme=initialTheme;
document.querySelector('meta[name="theme-color"]')?.setAttribute('content',initialTheme==='light'?'#fafafa':'#0c0c0d');
document.querySelector('meta[name="color-scheme"]')?.setAttribute('content',initialTheme);
