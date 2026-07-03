// CardSwap — vanilla port of the React Bits component (GSAP 3D auto-swapping card stack).
// Faithful to the original: makeSlot / placeNow / elastic timeline (drop → promote → return).
// window.CovenantCardSwap.mount(container, opts) -> { destroy() }.
//   opts.cards            array of card DOM nodes (default: container's .cv-cs-card children)
//   opts.cardDistance     x-spacing (default 60)   opts.verticalDistance  y-spacing (default 70)
//   opts.delay            ms between swaps (5000)   opts.skewAmount        skewY deg (6)
//   opts.easing           'elastic' | 'linear'      opts.pauseOnHover      bool
//   opts.onCardClick(i)   click callback (i = the card's fixed content index)
(function () {
  const gsap = () => window.gsap;

  const makeSlot = (i, distX, distY, total) => ({ x: i * distX, y: -i * distY, z: -i * distX * 1.5, zIndex: total - i });
  const placeNow = (el, slot, skew) => gsap().set(el, {
    x: slot.x, y: slot.y, z: slot.z, xPercent: -50, yPercent: -50,
    skewY: skew, transformOrigin: 'center center', zIndex: slot.zIndex, force3D: true,
  });

  function mount(container, opts) {
    opts = opts || {};
    if (!container || !gsap()) return { destroy() {} };
    const cards = opts.cards || Array.from(container.querySelectorAll('.cv-cs-card'));
    const total = cards.length;
    if (!total) return { destroy() {} };

    const cardDistance = opts.cardDistance != null ? opts.cardDistance : 60;
    const verticalDistance = opts.verticalDistance != null ? opts.verticalDistance : 70;
    const delay = opts.delay != null ? opts.delay : 5000;
    const skewAmount = opts.skewAmount != null ? opts.skewAmount : 6;
    const pauseOnHover = !!opts.pauseOnHover;
    const onCardClick = opts.onCardClick;
    const config = opts.easing === 'linear'
      ? { ease: 'power1.inOut', durDrop: 0.8, durMove: 0.8, durReturn: 0.8, promoteOverlap: 0.45, returnDelay: 0.2 }
      : { ease: 'elastic.out(0.6,0.9)', durDrop: 2, durMove: 2, durReturn: 2, promoteOverlap: 0.9, returnDelay: 0.05 };

    let order = Array.from({ length: total }, (_, i) => i);
    let tl = null, interval = null, destroyed = false;

    cards.forEach((el, i) => placeNow(el, makeSlot(i, cardDistance, verticalDistance, total), skewAmount));

    const swap = () => {
      if (destroyed || order.length < 2) return;
      const [front, ...rest] = order;
      const elFront = cards[front];
      tl = gsap().timeline();
      tl.to(elFront, { y: '+=500', duration: config.durDrop, ease: config.ease });
      tl.addLabel('promote', `-=${config.durDrop * config.promoteOverlap}`);
      rest.forEach((idx, i) => {
        const el = cards[idx];
        const slot = makeSlot(i, cardDistance, verticalDistance, total);
        tl.set(el, { zIndex: slot.zIndex }, 'promote');
        tl.to(el, { x: slot.x, y: slot.y, z: slot.z, duration: config.durMove, ease: config.ease }, `promote+=${i * 0.15}`);
      });
      const backSlot = makeSlot(total - 1, cardDistance, verticalDistance, total);
      tl.addLabel('return', `promote+=${config.durMove * config.returnDelay}`);
      tl.call(() => { gsap().set(elFront, { zIndex: backSlot.zIndex }); }, undefined, 'return');
      tl.to(elFront, { x: backSlot.x, y: backSlot.y, z: backSlot.z, duration: config.durReturn, ease: config.ease }, 'return');
      tl.call(() => { order = [...rest, front]; });
    };

    swap();
    interval = window.setInterval(swap, delay);

    const clickHandlers = cards.map((el, i) => { const h = (e) => { if (onCardClick) onCardClick(i, e); }; el.addEventListener('click', h); return [el, h]; });

    let onEnter, onLeave;
    if (pauseOnHover) {
      onEnter = () => { if (tl) tl.pause(); clearInterval(interval); };
      onLeave = () => { if (tl) tl.play(); interval = window.setInterval(swap, delay); };
      container.addEventListener('mouseenter', onEnter);
      container.addEventListener('mouseleave', onLeave);
    }

    return {
      destroy() {
        if (destroyed) return;
        destroyed = true;
        clearInterval(interval);
        if (tl) tl.kill();
        clickHandlers.forEach(([el, h]) => el.removeEventListener('click', h));
        if (pauseOnHover) { container.removeEventListener('mouseenter', onEnter); container.removeEventListener('mouseleave', onLeave); }
      },
    };
  }

  // Scroll-driven variant: the stack advances with scroll position instead of a timer.
  // Returns { setActive(f), total, destroy() } — the host maps scroll progress -> setActive(0..total-1).
  // active is a float: the front card is the one whose index === floor(active); the leaving card
  // (fractional part) drops down and fades; the cards behind cascade one slot forward.
  function mountScroll(container, opts) {
    opts = opts || {};
    if (!container || !gsap()) return { setActive() {}, total: 0, destroy() {} };
    const cards = opts.cards || Array.from(container.querySelectorAll('.cv-cs-card'));
    const total = cards.length;
    if (!total) return { setActive() {}, total: 0, destroy() {} };
    const distX = opts.cardDistance != null ? opts.cardDistance : 48;
    const distY = opts.verticalDistance != null ? opts.verticalDistance : 54;
    const skew = opts.skewAmount != null ? opts.skewAmount : 6;
    const onCardClick = opts.onCardClick;

    const setActive = (active) => {
      active = Math.max(0, Math.min(total - 1, active));
      cards.forEach((el, i) => {
        const d = i - active;
        if (d >= -0.0001) {
          const dc = Math.min(d, total - 1);
          const slot = makeSlot(dc, distX, distY, total);
          gsap().set(el, { x: slot.x, y: slot.y, z: slot.z, xPercent: -50, yPercent: -50, skewY: skew,
            transformOrigin: 'center center', opacity: d > total - 1 + 0.6 ? 0 : 1, scale: 1,
            zIndex: total - Math.round(dc), force3D: true });
        } else {
          const k = Math.max(d, -1); // the front card leaves: drop down and fade out FAST (gone by ~55%, so it never overlaps the incoming front)
          const slot = makeSlot(0, distX, distY, total);
          gsap().set(el, { x: slot.x, y: slot.y - k * 300, z: slot.z, xPercent: -50, yPercent: -50, skewY: skew,
            transformOrigin: 'center center', opacity: Math.max(0, 1 + k * 1.8), scale: 1 + k * 0.06,
            zIndex: total + 5, force3D: true });
        }
      });
    };
    setActive(0);

    const clickHandlers = cards.map((el, i) => { const h = (e) => { if (onCardClick) onCardClick(i, e); }; el.addEventListener('click', h); return [el, h]; });
    return { setActive, total, destroy() { clickHandlers.forEach(([el, h]) => el.removeEventListener('click', h)); } };
  }

  window.CovenantCardSwap = { mount, mountScroll };
})();
