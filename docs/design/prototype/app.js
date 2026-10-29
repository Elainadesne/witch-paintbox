// 魔女画匣原型「颜料未干」：交互
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const body = document.body;
  const root = document.documentElement;
  const nav = $('.nav');
  const mark = $('.wash-mark');
  const content = $('.content');
  const still = () => body.classList.contains('still') || matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- 颜色：板块颜料 / 出图后取自画面（witch-paintbox:pet-palette） ----------
  let picture = null;
  try {
    const p = JSON.parse(localStorage.getItem('witch-paintbox:pet-palette') || 'null');
    if (Array.isArray(p) && p.length) picture = p;
  } catch { /* 无痕模式 */ }
  const rgb = c => `rgb(${c.map(v => Math.round(v)).join(' ')})`;
  const setWash = colour => root.style.setProperty('--wash', colour);

  // ---------- 导航：色块滑到新项，旧位置留下一道渐淡拖痕 ----------
  function place(btn, animate) {
    const top = btn.offsetTop;
    if (animate && !still() && mark.dataset.top) {
      const from = +mark.dataset.top, to = top;
      const t = document.createElement('i');
      t.className = 'trail';
      t.style.top = `${Math.min(from, to) + 18}px`;
      t.style.height = `${Math.abs(to - from) + 8}px`;
      t.style.setProperty('--trail-c', getComputedStyle(root).getPropertyValue('--wash'));
      nav.insertBefore(t, nav.firstChild);
      t.addEventListener('animationend', () => t.remove());
    }
    mark.style.top = `${top}px`;
    mark.dataset.top = top;
    // 手机端是横排：同步横向位置与宽度
    mark.style.left = `${btn.offsetLeft}px`;
    mark.style.width = `${btn.offsetWidth}px`;
  }

  function go(id, animate = true) {
    const btn = $(`.nav button[data-page="${id}"]`);
    if (!btn) return;
    $$('.nav button').forEach(b => b.removeAttribute('aria-current'));
    btn.setAttribute('aria-current', 'page');
    const colour = picture && id === 'image-api' ? rgb(picture[1] || picture[0]) : btn.style.getPropertyValue('--c');
    place(btn, animate);
    setWash(colour);
    $$('.head .tabs').forEach(t => { t.hidden = t.dataset.only !== id; });
    $$('.page').forEach(p => {
      const on = p.dataset.page === id;
      p.hidden = !on;
      p.classList.remove('fresh');
      if (on && animate) { void p.offsetWidth; p.classList.add('fresh'); }
    });
    content.scrollTop = 0;
    if (btn.scrollIntoView && matchMedia('(max-width: 640px)').matches) btn.scrollIntoView({ inline: 'center', block: 'nearest', behavior: still() ? 'auto' : 'smooth' });
    location.hash = id;
  }
  nav.addEventListener('click', e => { const b = e.target.closest('button[data-page]'); if (b) go(b.dataset.page); });
  $$('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));

  // ---------- 二选一：手绘圈 ----------
  $$('.choice').forEach(g => g.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $$('button', g).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  }));

  // ---------- 输入：墨水从点击处沿线洇开；离开时合法则写干 ----------
  $$('.line').forEach(line => {
    line.addEventListener('pointerdown', e => {
      const r = line.getBoundingClientRect();
      line.style.setProperty('--from', `${Math.max(0, e.clientX - r.left)}px`);
    });
    line.addEventListener('focusin', () => {
      line.classList.remove('dry');
      line.classList.remove('inking'); void line.offsetWidth; line.classList.add('inking');
    });
    line.addEventListener('focusout', () => {
      line.classList.remove('inking');
      const input = $('input', line);
      if (input && input.value.trim()) line.classList.add('dry');
      line.style.setProperty('--from', '0px');
    });
  });

  // ---------- 主按钮：颜料滴压下、晕开；密钥为空时禁用并就近说明 ----------
  const test = $('[data-test]');
  const key = $('[data-check="key"]');
  const why = $('[data-why]');
  const sync = () => {
    const empty = !key.value.trim();
    test.disabled = empty;
    why.textContent = empty ? '先填好密钥，才能试画。' : '';
  };
  key.addEventListener('input', sync); sync();
  test.addEventListener('click', () => {
    test.classList.remove('pressing'); void test.offsetWidth; test.classList.add('pressing');
    setTimeout(() => { test.classList.add('busy'); test.lastElementChild.textContent = '正在铺色……'; }, 700);
    setTimeout(() => {
      test.classList.remove('busy', 'pressing');
      test.lastElementChild.textContent = '试画一张';
      why.innerHTML = '';
      const ok = document.createElement('span'); ok.className = 'dried'; ok.textContent = '干透了，连接可用';
      why.append(ok);
    }, 2600);
  });

  // ---------- 原型控制条 ----------
  const bar = $('.proto-bar');
  bar.addEventListener('click', e => {
    const k = e.target.dataset.proto;
    if (k === 'replay') { body.classList.remove('opening'); void body.offsetWidth; body.classList.add('opening'); go(currentId(), true); }
    if (k === 'error') {
      go('image-api');
      const n = $('[data-state="error"]'); n.hidden = !n.hidden;
      if (!n.hidden) { n.classList.remove('fresh'); void n.offsetWidth; n.classList.add('fresh'); }
    }
    if (k === 'palette') {
      picture = [[92, 61, 140], [70, 120, 170], [210, 160, 190]];   // 假设刚画完一张蓝紫调的夜景
      go(currentId(), false); setWash(rgb(picture[1]));
    }
    if (k === 'still') { body.classList.toggle('still'); e.target.textContent = body.classList.contains('still') ? '恢复动态' : '减少动态'; }
  });
  const currentId = () => $('.nav button[aria-current="page"]')?.dataset.page || 'guide';

  // 开场从画匣（右下角悬浮位）晕开
  root.style.setProperty('--ox', '92%'); root.style.setProperty('--oy', '90%');
  const first = (location.hash || '#guide').slice(1);
  const q = new URLSearchParams(location.search);
  if (q.has('proto')) body.classList.add('proto');
  if (q.has('still')) body.classList.add('still');
  requestAnimationFrame(() => {
    go(first, true);
    if (q.has('error')) $('[data-state="error"]').hidden = false;
    if (q.has('key')) { key.value = 'pst-demo'; sync(); }
  });
  addEventListener('resize', () => { const b = $('.nav button[aria-current="page"]'); if (b) place(b, false); });
  setTimeout(() => body.classList.remove('opening'), 2200);
})();
