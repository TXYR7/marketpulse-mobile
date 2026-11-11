// Android installed apps can draw behind the system navigation bar while env() is zero.
// Detect the display mode before paint; browser tabs and iOS keep their native inset.
(() => {
  const root = document.documentElement;
  const android = /Android/i.test(navigator.userAgent || '');
  const modes = ['standalone', 'fullscreen', 'minimal-ui'].map(mode => window.matchMedia('(display-mode: ' + mode + ')'));
  function update() {
    root.dataset.mobilePlatform = android ? 'android' : 'other';
    root.dataset.mobileDisplay = modes.some(mode => mode.matches) || navigator.standalone === true ? 'installed' : 'browser';
  }
  modes.forEach(mode => mode.addEventListener?.('change', update));
  update();
})();
