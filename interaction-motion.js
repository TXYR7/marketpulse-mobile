// 动画只管理呈现，不延迟导航，也不改写行情或判决数据。
export function createInteractionMotion({ doc = document, win = window } = {}) {
  const active = new Map();
  const values = new WeakMap();
  const selections = new WeakMap();
  const visibility = new WeakMap();
  const pressLayers = new WeakMap();
  const pressSelector = '.nav-link,.icon-button:not(#themeButton),.profile-button,.quick-filter button,.quick-detail,.inspector-chart-controls button,.inspector-reader-tabs button,.inspector-reader-tools button,.inspector-research-fold > summary,#detailDrawer .detail-drawer-body button,.segment,.outline-button,.primary-button,.adv-btn,.adv-tab,.board-full-data > summary,.detail-extra-section > summary';
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  const ease = 'cubic-bezier(.25,.8,.25,1)';
  let currentPage = null;
  let themeTimer = null;
  let themeSequence = 0, themeTransition = null, pendingThemeCommit = null;
  let themeAnimations = [];

  function stop(element) {
    const record = active.get(element);
    if (record) {
      active.delete(element); record.animation.cancel();
      if (record.clip) element.style.overflow = record.overflow;
      element.classList?.remove?.('motion-layer');
    }
  }

  function capture(element) {
    const record = active.get(element);
    if (!record) return null;
    const elapsed = Math.max(0, (Number(record.animation.currentTime) || 0) - record.delay);
    const sampled = record.sample?.(Math.min(1, elapsed / record.duration));
    const style = win.getComputedStyle?.(element);
    const position = (style?.translate || '').split(/\s+/).map(parseFloat);
    const values = { ...sampled?.values };
    values.x = Number.isFinite(position[0]) ? position[0] : values.x || 0;
    values.y = Number.isFinite(position[1]) ? position[1] : values.y || 0;
    for (const key of ['scale', 'opacity', 'height', 'width', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight']) {
      const value = parseFloat(style?.[key]);
      if (Number.isFinite(value)) values[key] = value;
    }
    return { values, velocity: sampled?.velocity || {} };
  }

  function play(element, frames, duration = 260, options = {}) {
    if (!element) return Promise.resolve();
    const previous = active.get(element);
    if (previous && win.getComputedStyle && options.easing !== 'linear') {
      const style = win.getComputedStyle(element);
      const start = {};
      for (const key of Object.keys(frames[0])) {
        if (!['offset', 'easing', 'composite'].includes(key)) start[key] = style[key] || frames[0][key];
      }
      frames = [start, frames[frames.length - 1]];
    }
    stop(element);
    if (doc.hidden || reduced?.matches || typeof element.animate !== 'function') return Promise.resolve();
    const { sample, clip = false, ...timing } = options;
    const overflow = element.style?.overflow || '';
    if (clip && element.style) element.style.overflow = 'clip';
    if (frames.some(frame => 'translate' in frame || 'opacity' in frame)) element.classList?.add?.('motion-layer');
    const animation = element.animate(frames, { duration, easing: ease, fill: 'both', ...timing });
    const record = { animation, sample, clip, overflow, duration, delay: Number(timing.delay) || 0 };
    active.set(element, record);
    return animation.finished.catch(() => {}).then(() => {
      if (active.get(element) === record) stop(element);
    });
  }

  // 重定向保留位置与速度。大面板和布局使用临界阻尼；小控件保留轻微回弹。
  // 最后四分之一平滑收敛到零速度，避免长尾末帧被截断。
  function spring(element, from, to, duration = 480, options = {}) {
    if (!element) return Promise.resolve();
    if (doc.hidden || reduced?.matches || typeof element.animate !== 'function') { stop(element); return Promise.resolve(); }
    const { clip = false, surface = false, velocity = {}, ...timing } = options;
    const lengths = Object.keys(to).filter(key => !['x', 'y', 'scale', 'opacity'].includes(key));
    const current = capture(element);
    const initialVelocity = { ...velocity, ...current?.velocity };
    if (current) {
      from = { ...from };
      for (const key of Object.keys(to)) if (Number.isFinite(current.values[key])) from[key] = current.values[key];
    }
    function sample(t) {
      const u = Math.max(0, Math.min(1, (t - .75) / .25));
      const blend = u ** 3 * (10 - 15 * u + 6 * u * u);
      const slope = 120 * u * u * (1 - u) ** 2;
      const values = {}, speeds = {};
      for (const key of Object.keys(to)) {
        const delta = from[key] - to[key];
        const speed = (initialVelocity[key] || 0) * duration;
        let value, derivative;
        if (surface || key === 'opacity' || lengths.includes(key)) {
          const omega = 6.5;
          const decay = Math.exp(-omega * t);
          value = to[key] + (delta + (speed + omega * delta) * t) * decay;
          derivative = (speed - omega * (speed + omega * delta) * t) * decay;
        } else {
          const damping = 7.6, frequency = 4.8;
          const decay = Math.exp(-damping * t), c = Math.cos(frequency * t), s = Math.sin(frequency * t);
          const term = (speed + damping * delta) / frequency;
          value = to[key] + decay * (delta * c + term * s);
          derivative = decay * ((-damping * delta + frequency * term) * c + (-damping * term - frequency * delta) * s);
        }
        const finalValue = t === 0 ? from[key] : t === 1 ? to[key] : value * (1 - blend) + to[key] * blend;
        values[key] = key === 'opacity' ? Math.max(0, Math.min(1, finalValue)) : lengths.includes(key) ? Math.max(0, finalValue) : finalValue;
        speeds[key] = t === 0 ? initialVelocity[key] || 0 : t === 1 ? 0 : values[key] === finalValue ? (derivative * (1 - blend) + (to[key] - value) * slope) / duration : 0;
      }
      return { values, velocity: speeds };
    }
    const frames = Array.from({ length: 61 }, (_, index) => {
      const t = index / 60, { values } = sample(t);
      const frame = { offset: t, translate: `${values.x}px ${values.y}px` };
      if ('scale' in to) frame.scale = values.scale;
      if ('opacity' in to) frame.opacity = values.opacity;
      for (const key of lengths) frame[key] = values[key] + 'px';
      return frame;
    });
    return play(element, frames, duration, { ...timing, sample, clip, easing: 'linear' });
  }

  function stagger(elements, { distance = 6, delay = 0, duration = 300 } = {}) {
    return Promise.all(elements.map((element, index) => spring(element,
      { x: 0, y: distance, opacity: .82 }, { x: 0, y: 0, opacity: 1 }, duration,
      { delay: delay + index * 16, surface: true })));
  }

  function page(element, { direction = 1 } = {}) {
    if (!element || currentPage === element) return Promise.resolve();
    if (currentPage) { stop(currentPage); currentPage.classList.remove?.('motion-page'); }
    currentPage = element;
    if (doc.hidden || reduced?.matches || typeof element.animate !== 'function') return Promise.resolve();
    // 单个合成层入场，不叠加子区块动画，也不逐个测量长页面。
    element.classList.add?.('motion-page');
    return spring(element, { x: 12 * direction, y: 0, opacity: .88 }, { x: 0, y: 0, opacity: 1 }, 260, { surface: true })
      .then(() => { if (currentPage === element) element.classList.remove?.('motion-page'); });
  }

  function inspector(element, { opening, docked, replacement = false } = {}) {
    if (replacement) return spring(element?.querySelector('.detail-drawer-body'),
      { x: 0, y: 4, opacity: .92 }, { x: 0, y: 0, opacity: 1 }, 200, { surface: true });
    const rect = element?.getBoundingClientRect?.();
    const sheet = !docked && win.innerWidth <= 680;
    const resting = { x: 0, y: 0, scale: 1, opacity: 1 };
    const away = { x: docked ? (rect?.width || 480) : 0, y: sheet ? (rect?.height || 640) : docked ? 0 : 40, scale: docked || sheet ? 1 : .98, opacity: docked || sheet ? 1 : .5 };
    return opening ? spring(element, away, resting, 420, { surface: true })
      : spring(element, resting, { ...away, opacity: docked || sheet ? 1 : 0 }, 300, { surface: true });
  }

  function search(element, opening = true) {
    return opening ? spring(element, { x: 0, y: -5, scale: .995, opacity: .8 }, { x: 0, y: 0, scale: 1, opacity: 1 }, 220, { surface: true })
      : spring(element, { x: 0, y: 0, scale: 1, opacity: 1 }, { x: 0, y: -3, scale: .995, opacity: 0 }, 160, { surface: true });
  }

  function searchResults(element) {
    return stagger([...(element?.querySelectorAll('.stock-search-option, .adv-suggest-item') || [])].slice(0, 8), { distance: 4, duration: 240 });
  }

  function content(element, { distance = 4, duration = 220, direction = 0, fromHeight } = {}) {
    if (!element || element.hidden || element.closest?.('[hidden]')) return Promise.resolve();
    const from = { x: direction * 10, y: distance, opacity: .9 }, to = { x:0, y:0, opacity:1 };
    let snapshot, clip = false;
    if (Number.isFinite(fromHeight)) {
      snapshot = capture(element); stop(element);
      Object.assign(from, snapshot?.values);
      const height = element.getBoundingClientRect?.().height;
      const start = snapshot?.values.height ?? fromHeight;
      if (Number.isFinite(height) && Math.abs(height-start) > 1) { from.height=start; to.height=height; clip=true; }
    }
    return spring(element, from, to, duration, { surface:true, clip, velocity:snapshot?.velocity });
  }

  function press(element, point = {}) {
    if (!element || element.isConnected === false || element.disabled || element.inert || element.id === 'themeButton' || element.getAttribute?.('aria-disabled') === 'true' || doc.hidden || reduced?.matches || !doc.createElement) return Promise.resolve();
    const rect = element.getBoundingClientRect?.();
    if (!rect?.width || !rect.height || !element.appendChild) return Promise.resolve();
    const previous = pressLayers.get(element);
    if (previous) { stop(previous.wave); previous.layer.remove(); }
    const x = Math.max(0, Math.min(rect.width, Number.isFinite(point.x) ? point.x - rect.left : rect.width / 2));
    const y = Math.max(0, Math.min(rect.height, Number.isFinite(point.y) ? point.y - rect.top : rect.height / 2));
    const radius = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));
    if (win.getComputedStyle?.(element)?.position === 'static') element.classList.add('motion-press-surface');
    const layer = doc.createElement('span'), wave = doc.createElement('span');
    layer.className = 'motion-tap-layer'; layer.setAttribute('aria-hidden', 'true');
    wave.className = 'motion-tap-wave';
    for (const [key,value] of Object.entries({ left:x-radius, top:y-radius, width:radius*2, height:radius*2 })) wave.style.setProperty(key, value+'px');
    layer.appendChild(wave); element.appendChild(layer);
    const record = { layer, wave }; pressLayers.set(element, record);
    return play(wave, [{ scale:.03, opacity:.9 }, { scale:1, opacity:0 }], 440, { easing:'cubic-bezier(.16,1,.3,1)' }).then(() => {
      layer.remove();
      if (pressLayers.get(element) === record) pressLayers.delete(element);
    });
  }

  function reveal(element, opening, { popup = false, ...options } = {}) {
    if (!element) return Promise.resolve();
    const previous = visibility.get(element);
    if (previous?.opening === opening || (!previous && element.hidden === !opening)) return Promise.resolve();
    const state = { opening }; visibility.set(element, state);
    element.inert = !opening;
    if (opening) { element.hidden = false; element.removeAttribute?.('aria-hidden'); }
    else element.setAttribute?.('aria-hidden', 'true');
    const completion = popup ? search(element, opening) : block(element, opening, options);
    return completion.then(() => { if (visibility.get(element) === state && !opening) element.hidden = true; });
  }

  function stopTheme() {
    themeSequence += 1;
    pendingThemeCommit?.(); pendingThemeCommit = null;
    themeTransition?.skipTransition(); themeTransition = null;
    themeAnimations.forEach(animation => animation.cancel()); themeAnimations = [];
    clearTimeout(themeTimer);
    doc.documentElement?.classList.remove('motion-theme', 'motion-theme-reveal', 'motion-refresh-reveal');
  }

  function revealPage(change, origin = {}, kind = 'theme') {
    // 被打断的切换仍提交一次；快速连点不会丢掉点击或让旧回调翻回旧主题。
    stopTheme();
    const sequence = themeSequence;
    const root = doc.documentElement, button = doc.getElementById(kind === 'refresh' ? 'refreshButton' : 'themeButton');
    const revealClass = kind === 'refresh' ? 'motion-refresh-reveal' : 'motion-theme-reveal';
    let committed = false, commitError = null;
    const commit = () => {
      if (committed) return;
      committed = true;
      try { change(); } catch (error) { commitError = error; }
      if (pendingThemeCommit === commit) pendingThemeCommit = null;
    };
    const fallback = () => {
      commit();
      if (commitError) return Promise.reject(commitError);
      if (doc.hidden || reduced?.matches) return Promise.resolve();
      if (kind === 'refresh') return play(doc.querySelector?.('.app-shell') || doc.body,
        [{ opacity:.92 }, { opacity:1 }], 220);
      root?.classList.add('motion-theme');
      themeTimer = setTimeout(() => { if (themeSequence === sequence) root?.classList.remove('motion-theme'); }, 340);
      return play(button, [{ rotate: '-90deg', scale: .7, opacity: .45 }, { rotate: '0deg', scale: 1, opacity: 1 }], 420);
    };
    if (doc.hidden || reduced?.matches || !root?.animate || typeof doc.startViewTransition !== 'function') return fallback();

    const rect = button?.getBoundingClientRect?.();
    const width = win.innerWidth || root.clientWidth || 1024, height = win.innerHeight || root.clientHeight || 768;
    const x = Math.max(0, Math.min(width, Number.isFinite(origin.x) ? origin.x : rect ? rect.left + rect.width / 2 : width / 2));
    const y = Math.max(0, Math.min(height, Number.isFinite(origin.y) ? origin.y : rect ? rect.top + rect.height / 2 : height / 2));
    const radius = Math.hypot(Math.max(x, width - x), Math.max(y, height - y)) + 2;
    root.classList.add(revealClass);
    pendingThemeCommit = commit;
    let transition;
    try { transition = doc.startViewTransition(commit); }
    catch { pendingThemeCommit = null; root.classList.remove(revealClass); return fallback(); }
    themeTransition = transition;
    const animate = (frames, options) => {
      const animation = root.animate(frames, { duration: kind === 'refresh' ? 600 : 520, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both', ...options });
      themeAnimations.push(animation);
      animation.finished.catch(() => {});
    };
    transition.ready.then(() => {
      if (sequence !== themeSequence) return;
      animate([{ clipPath: `circle(0px at ${x}px ${y}px)` }, { clipPath: `circle(${radius}px at ${x}px ${y}px)` }], { easing: 'cubic-bezier(.22,.8,.25,1)', pseudoElement: '::view-transition-new(root)' });
      if (button && kind === 'theme') animate([
        { rotate: '-60deg', scale: .85, opacity: .8 },
        { rotate: '4deg', scale: 1.04, opacity: 1, offset: .7 },
        { rotate: '0deg', scale: 1, opacity: 1 }
      ], { duration: 420, pseudoElement: '::view-transition-new(theme-toggle)' });
    }).catch(() => {
      if (sequence !== themeSequence) return;
      commit(); transition.skipTransition();
    });
    return transition.finished.catch(() => {}).then(() => {
      commit();
      if (sequence === themeSequence) {
        themeTransition = null;
        themeAnimations.forEach(animation => animation.cancel()); themeAnimations = [];
        root.classList.remove(revealClass);
      }
      if (commitError) throw commitError;
    });
  }

  function theme(change, origin) { return revealPage(change, origin, 'theme').catch(() => {}); }
  function refreshPage(change, origin) { return revealPage(change, origin, 'refresh'); }

  function block(element, opening, { fade = false, axis = 'height' } = {}) {
    if (!element) return Promise.resolve();
    const snapshot = capture(element), current = snapshot?.values;
    const from = { x: current?.x || 0, y: current?.y || 0, opacity: current?.opacity ?? .85 };
    stop(element);
    const dimension = axis === 'width' ? 'width' : 'height';
    const size = element.getBoundingClientRect?.()[dimension];
    const natural = win.getComputedStyle?.(element);
    const to = { x: 0, y: 0, opacity: 1 };
    if (!fade && size > 0) {
      const padding = dimension === 'width' ? ['paddingLeft', 'paddingRight'] : ['paddingTop', 'paddingBottom'];
      to[dimension] = size;
      for (const key of padding) to[key] = parseFloat(natural?.[key]) || 0;
      for (const key of [dimension, ...padding]) from[key] = current?.[key] || 0;
    }
    const timing = { clip: !fade, surface: true, velocity: snapshot?.velocity };
    if (opening) return spring(element, from, to, 320, timing);
    const start = { ...to, ...current }, end = { x: 0, y: 0, opacity: 0 };
    // 只传递当前区块参与动画的属性，避免把旧层的缩放或尺寸带入。
    for (const key of Object.keys(to)) { start[key] = current?.[key] ?? to[key]; if (!(key in end)) end[key] = 0; }
    return spring(element, start, end, 240, timing);
  }

  function syncSelections() {
    for (const selector of ['.topbar-nav', '#themeModeTabs', '#workspaceSections', '#heatSectorTabs', '.adv-tabs', '#inspectorKlineControls', '.inspector-reader-tabs', '.quick-filter']) {
      const track = doc.querySelector?.(selector);
      const target = track?.querySelector(selector === '.topbar-nav'
        ? ':scope > .nav-link.is-active, :scope > .nav-more > .nav-more-toggle.is-active'
        : selector === '#inspectorKlineControls' ? '[data-kline-days][aria-pressed="true"]' : selector === '.inspector-reader-tabs' ? '[data-inspector-view][aria-selected="true"]' : selector === '.quick-filter' ? 'button[aria-pressed="true"]' : 'button.is-active');
      if (!track || !target || track.hidden || !target.getClientRects?.().length) continue;
      let selection = selections.get(track);
      // 先建立定位容器，再读取 offset；否则首次测量会带入祖先的页面坐标。
      if (!selection && win.getComputedStyle?.(track)?.position === 'static') track.classList.add('motion-track-relative');
      const bounds = track.getBoundingClientRect();
      const next = target.getBoundingClientRect();
      if (!next.width || !next.height) continue;
      let left = target.offsetLeft, top = target.offsetTop;
      for (let parent = target.offsetParent; parent && parent !== track; parent = parent.offsetParent) {
        left += parent.offsetLeft; top += parent.offsetTop;
      }
      const geometry = { left, top, width: target.offsetWidth, height: target.offsetHeight };
      if (selection?.target === target && Object.keys(geometry).every(key => Math.abs(geometry[key] - selection.geometry[key]) < .5)) continue;
      const previous = selection?.marker.getBoundingClientRect();
      const momentum = selection ? capture(selection.marker)?.velocity : null;
      if (!selection) {
        const marker = doc.createElement('span'); marker.className = 'motion-selection'; marker.setAttribute('aria-hidden', 'true');
        track.classList.add('motion-track');
        track.appendChild(marker);
        selection = { marker }; selections.set(track, selection);
      }
      const changed = selection.target && selection.target !== target;
      stop(selection.marker);
      for (const [key, value] of Object.entries(geometry)) selection.marker.style.setProperty(key, value + 'px');
      selection.marker.style.setProperty('border-radius', win.getComputedStyle(target).borderRadius);
      selection.target = target; selection.geometry = geometry;
      if (changed && previous) spring(selection.marker,
        { x: previous.left - (bounds.left + left - track.scrollLeft + track.clientLeft), y: previous.top - (bounds.top + top - track.scrollTop + track.clientTop) }, { x: 0, y: 0 }, 400, { velocity: momentum });
      else stop(selection.marker);
    }
  }

  function refresh() {
    syncSelections();
    const score = doc.getElementById('statusScore');
    const number = parseFloat(score?.textContent);
    const item = doc.getElementById('emotionStatusItem');
    item?.style.setProperty?.('--emotion-angle', (Number.isFinite(number) ? Math.max(0, Math.min(100, number)) * 3.6 : 0) + 'deg');
    item?.classList.toggle('has-score', Number.isFinite(number));
    for (const card of doc.querySelectorAll('.theme-card')) {
      const strength = parseFloat(card.querySelector?.('.rank-card-score')?.textContent);
      card.style.setProperty?.('--theme-strength', (Number.isFinite(strength) ? Math.max(0, Math.min(100, strength)) : 0) + '%');
    }
    for (const element of doc.querySelectorAll('#statusScore, #statusLimitUp, #statusLimitDown, #statusBroken, #statusMaxBoard, #statusMainTheme')) {
      const value = element.textContent;
      const before = values.get(element);
      values.set(element, value);
      if (before !== undefined && before !== value && !element.closest?.('[hidden]')) {
        play(element, [{ opacity: .5, translate: '0 3px' }, { opacity: 1, translate: '0 0' }], 180);
      }
    }
  }

  function reduceMotion() { if (reduced?.matches) { stopTheme(); for (const element of [...active.keys()]) stop(element); } }
  doc.addEventListener?.('pointerdown', event => {
    if (event.button != null && event.button !== 0) return;
    press(event.target.closest?.(pressSelector), { x:event.clientX, y:event.clientY });
  }, true);
  doc.addEventListener?.('keydown', event => {
    if (!event.repeat && !event.isComposing && event.keyCode !== 229 && ['Enter',' '].includes(event.key)) press(event.target.closest?.(pressSelector));
  });
  reduced?.addEventListener?.('change', reduceMotion);
  doc.addEventListener?.('visibilitychange', () => { if (doc.hidden) { stopTheme(); for (const element of [...active.keys()]) stop(element); } });
  refresh();
  return { page, inspector, search, searchResults, block, content, reveal, theme, refreshPage, press, refresh, play, stop };
}
