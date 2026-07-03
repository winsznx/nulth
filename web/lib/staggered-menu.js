// StaggeredMenu — vanilla port of the React Bits component (GSAP). Full-screen mobile nav:
// colored prelayers slide in, a white panel slides in, big menu items stagger up with numbering.
// window.CovenantMenu.open({items,socials,accent,colors,onAct}) builds + opens; self-closes on
// item click / close button / click-away. Nulth-tokened.
(function () {
  const gsap = () => window.gsap;
  let inst = null;

  function open(opts) {
    opts = opts || {};
    if (inst) inst.destroy();
    const position = opts.position || 'right';
    const colors = opts.colors || ['#16C088', '#0B0B0C'];
    const accent = opts.accent || '#0E9466';
    const items = opts.items || [];
    const socials = opts.socials || [];
    const offscreen = position === 'left' ? -100 : 100;
    const side = position === 'left' ? 'left:0;' : 'right:0;';

    const root = document.createElement('div');
    root.className = 'cv-sm'; root.setAttribute('data-position', position);
    root.style.cssText = 'position:fixed;inset:0;z-index:200;pointer-events:auto';

    const pre = document.createElement('div');
    pre.style.cssText = 'position:absolute;top:0;bottom:0;' + side + 'width:100%;pointer-events:none;z-index:5';
    const layers = colors.slice(0, 3).map((c) => { const l = document.createElement('div'); l.style.cssText = 'position:absolute;top:0;bottom:0;' + side + 'height:100%;width:100%;background:' + c; pre.appendChild(l); return l; });

    const panel = document.createElement('aside');
    panel.style.cssText = 'position:absolute;top:0;bottom:0;' + side + 'height:100%;width:100%;max-width:560px;background:#fff;display:flex;flex-direction:column;padding:84px 28px 32px;overflow-y:auto;z-index:10;box-sizing:border-box';

    const closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', 'Close menu');
    closeBtn.style.cssText = 'position:absolute;top:22px;right:24px;width:40px;height:40px;border:none;background:transparent;cursor:pointer;color:#111;display:flex;align-items:center;justify-content:center;font-family:inherit';
    closeBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    panel.appendChild(closeBtn);

    const list = document.createElement('ul');
    list.style.cssText = 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px';
    items.forEach((it, idx) => {
      const li = document.createElement('li'); li.style.cssText = 'position:relative;overflow:hidden;line-height:1.05';
      const a = document.createElement('a'); a.href = it.link || '#'; if (it.ariaLabel) a.setAttribute('aria-label', it.ariaLabel);
      a.style.cssText = 'position:relative;display:flex;align-items:baseline;gap:12px;color:#0B0B0C;font-weight:600;font-size:30px;letter-spacing:-.02em;line-height:1.12;text-decoration:none;padding:9px 0;cursor:pointer';
      a.onmouseenter = () => { label.style.color = accent; }; a.onmouseleave = () => { label.style.color = '#0B0B0C'; };
      const label = document.createElement('span'); label.className = 'cv-sm-label'; label.textContent = it.label;
      label.style.cssText = 'display:inline-block;transform-origin:50% 100%;will-change:transform;transition:color .15s';
      a.appendChild(label);
      if (opts.numbering !== false) { const num = document.createElement('span'); num.className = 'cv-sm-num'; num.textContent = String(idx + 1).padStart(2, '0');
        num.style.cssText = "font-family:'Geist Mono',ui-monospace,monospace;font-size:13px;font-weight:400;color:" + accent + ';opacity:0'; a.appendChild(num); }
      a.addEventListener('click', (e) => { if (it.act) { e.preventDefault(); close(() => { if (opts.onAct) opts.onAct(it.act); }); } else { close(); } });
      li.appendChild(a); list.appendChild(li);
    });
    panel.appendChild(list);

    if (socials.length) {
      const wrap = document.createElement('div'); wrap.style.cssText = 'margin-top:auto;padding-top:28px;display:flex;flex-direction:column;gap:10px';
      const title = document.createElement('div'); title.className = 'cv-sm-social-title'; title.textContent = 'SOCIALS';
      title.style.cssText = "font-family:'Geist Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.14em;color:" + accent + ';opacity:0';
      const row = document.createElement('div'); row.style.cssText = 'display:flex;flex-wrap:wrap;gap:16px';
      socials.forEach((s) => { const a = document.createElement('a'); a.href = s.link; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = s.label; a.className = 'cv-sm-social';
        a.style.cssText = 'font-size:15px;font-weight:500;color:#111;text-decoration:none;opacity:0'; row.appendChild(a); });
      wrap.appendChild(title); wrap.appendChild(row); panel.appendChild(wrap);
    }

    root.appendChild(pre); root.appendChild(panel); document.body.appendChild(root);
    const prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';

    const labels = Array.from(panel.querySelectorAll('.cv-sm-label'));
    const nums = Array.from(panel.querySelectorAll('.cv-sm-num'));
    const socialTitle = panel.querySelector('.cv-sm-social-title');
    const socialLinks = Array.from(panel.querySelectorAll('.cv-sm-social'));
    let tl = null, closed = false;

    if (gsap()) {
      gsap().set([panel, ...layers], { xPercent: offscreen });
      gsap().set(labels, { yPercent: 140, rotate: 8 }); gsap().set(nums, { opacity: 0 });
      if (socialTitle) gsap().set(socialTitle, { opacity: 0 }); gsap().set(socialLinks, { y: 20, opacity: 0 });
      tl = gsap().timeline();
      layers.forEach((l, i) => tl.fromTo(l, { xPercent: offscreen }, { xPercent: 0, duration: 0.5, ease: 'power4.out' }, i * 0.07));
      const t = layers.length * 0.07;
      tl.fromTo(panel, { xPercent: offscreen }, { xPercent: 0, duration: 0.62, ease: 'power4.out' }, t);
      tl.to(labels, { yPercent: 0, rotate: 0, duration: 0.9, ease: 'power4.out', stagger: 0.08 }, t + 0.12);
      tl.to(nums, { opacity: 1, duration: 0.5, stagger: 0.06 }, t + 0.22);
      if (socialTitle) tl.to(socialTitle, { opacity: 1, duration: 0.4 }, t + 0.3);
      if (socialLinks.length) tl.to(socialLinks, { y: 0, opacity: 1, duration: 0.5, stagger: 0.06 }, t + 0.34);
    } else { root.style.opacity = '1'; }

    function close(cb) {
      if (closed) return; closed = true;
      document.body.style.overflow = prevOverflow;
      root.removeEventListener('mousedown', onAway);
      window.removeEventListener('keydown', onKey);
      const done = () => { root.remove(); if (inst && inst._root === root) inst = null; if (opts.onClose) opts.onClose(); if (cb) cb(); };
      if (gsap()) { if (tl) tl.kill(); gsap().to([panel, ...layers], { xPercent: offscreen, duration: 0.3, ease: 'power3.in', onComplete: done }); }
      else done();
    }
    const onAway = (e) => { if (!panel.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    root.addEventListener('mousedown', onAway);
    window.addEventListener('keydown', onKey);
    closeBtn.addEventListener('click', () => close());

    inst = { _root: root, close, destroy() { document.body.style.overflow = prevOverflow; if (tl) tl.kill(); root.remove(); if (inst && inst._root === root) inst = null; } };
    if (opts.onOpen) opts.onOpen();
    return inst;
  }

  window.CovenantMenu = { open, current: () => inst };
})();
