// Перетаскивание для смены порядка (мышь и палец), с анимацией.
// Элементы помечаются data-sort="<ключ>" — двигаются только среди соседей с тем же ключом в том же родителе.
// Если внутри элемента есть [data-handle], тянуть можно только за него, иначе — за любое место, кроме кнопок и полей.
// Пока тянешь: копия элемента увеличивается и едет за курсором, на старом месте — пустое место-«тень»,
// соседи плавно расступаются. После отпускания копия «садится» на место, потом вызывается onDrop(ключ, элементы по порядку).

const LIFT = 1.06;      // во сколько раз копия больше, пока её тянут
const MOVE_MS = 180;    // время анимации соседей и посадки

export function sortable(root, { onDrop, axis = (key) => "y" }) {
  root.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    const h = e.target.closest("[data-handle]");
    let item = (h || e.target).closest("[data-sort]");
    if (!item || !root.contains(item)) return;
    if (!h && (item.querySelector("[data-handle]") || e.target.closest("button, input, textarea, select, a"))) return;
    start(e, item, h);
  });

  function start(e, item, handle) {
    const key = item.dataset.sort, box = item.parentElement;
    const sibs = () => [...box.children].filter((c) => c.dataset.sort === key);
    if (sibs().length < 2) return;
    const dir = axis(key);
    const sx = e.clientX, sy = e.clientY;
    let ghost = null, rect = null, px = sx, py = sy, raf = 0, startOrder = null;
    if (handle && e.pointerType !== "mouse") e.preventDefault();

    const begin = () => {
      startOrder = sibs();
      rect = item.getBoundingClientRect();
      ghost = item.cloneNode(true);
      // в копии полей ввода — текущие значения, а не исходные
      const src = item.querySelectorAll("input, textarea"), dst = ghost.querySelectorAll("input, textarea");
      src.forEach((x, i) => { dst[i].value = x.value; });
      ghost.removeAttribute("data-sort");
      ghost.classList.add("sort-ghost");
      Object.assign(ghost.style, { left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
      document.body.append(ghost);
      item.classList.add("sort-ph");
      document.body.classList.add("sorting");
      requestAnimationFrame(() => ghost.classList.add("lifted"));
      navigator.vibrate?.(8);
      loop();
    };

    // соседи плавно переезжают на новые места (FLIP)
    const flip = (els, before) => {
      els.forEach((el, i) => {
        const a = before[i], b = el.getBoundingClientRect();
        const dx = a.left - b.left, dy = a.top - b.top;
        if (!dx && !dy) return;
        el._sortMoving = performance.now() + MOVE_MS;
        el.style.transition = "none";
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => { el.style.transition = `transform ${MOVE_MS}ms cubic-bezier(.2,.8,.2,1)`; el.style.transform = ""; });
      });
    };

    // вертикальный список: смотрим на край копии — нижний, когда тянем вниз, верхний — когда вверх
    const placeY = () => {
      const list = sibs(), i = list.indexOf(item);
      const top = rect.top + (py - sy), bottom = top + rect.height;
      const next = list[i + 1], prev = list[i - 1];
      const busy = (el) => el._sortMoving > performance.now();
      if (next && !busy(next)) {
        const r = next.getBoundingClientRect();
        if (bottom > r.top + Math.min(r.height, rect.height) / 2) {
          const before = list.map((el) => el.getBoundingClientRect());
          box.insertBefore(item, next.nextSibling); flip(list, before); return;
        }
      }
      if (prev && !busy(prev)) {
        const r = prev.getBoundingClientRect();
        if (top < r.bottom - Math.min(r.height, rect.height) / 2) {
          const before = list.map((el) => el.getBoundingClientRect());
          box.insertBefore(item, prev); flip(list, before);
        }
      }
    };

    const place = () => {
      if (dir === "y") return placeY();
      const over = document.elementFromPoint(px, py)?.closest(`[data-sort="${CSS.escape(key)}"]`);
      if (!over || over === item || over.parentElement !== box || over.dataset.sort !== key) return;
      if (over._sortMoving > performance.now()) return; // ещё едет — ждём, иначе дёргается
      const r = over.getBoundingClientRect();
      const list = sibs(), from = list.indexOf(item), to = list.indexOf(over);
      const after = py > r.bottom ? true : py < r.top ? false : px > r.left + r.width / 2;
      if ((after && to === from - 1) || (!after && to === from + 1)) return;
      const before = list.map((el) => el.getBoundingClientRect());
      box.insertBefore(item, after ? over.nextSibling : over);
      flip(list, before);
    };

    // прокрутка, когда тянешь к краю
    const scroller = (() => {
      for (let el = box; el && el !== document.body; el = el.parentElement) {
        const o = getComputedStyle(el).overflowY;
        if ((o === "auto" || o === "scroll") && el.scrollHeight > el.clientHeight) return el;
      }
      return document.scrollingElement;
    })();
    const loop = () => {
      if (!ghost) return;
      const vr = scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
      const edge = 56;
      const v = py < vr.top + edge ? -Math.ceil((vr.top + edge - py) / 6) : py > vr.bottom - edge ? Math.ceil((py - vr.bottom + edge) / 6) : 0;
      if (v) scroller.scrollTop += v;
      place(); // и при прокрутке, и чтобы догнать быстрый рывок через несколько пунктов
      raf = requestAnimationFrame(loop);
    };

    const move = (ev) => {
      px = ev.clientX; py = ev.clientY;
      if (!ghost) {
        if (Math.hypot(px - sx, py - sy) < 5) return;
        begin();
      }
      ev.preventDefault();
      ghost.style.left = rect.left + (px - sx) + "px";
      ghost.style.top = rect.top + (py - sy) + "px";
      place();
    };

    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!ghost) return;
      cancelAnimationFrame(raf);
      const g = ghost; ghost = null;
      const r = item.getBoundingClientRect();
      g.classList.add("landing");
      g.classList.remove("lifted");
      Object.assign(g.style, { left: r.left + "px", top: r.top + "px" });
      // клик после перетаскивания не должен нажимать кнопку под курсором
      const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener("click", stop, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 50);
      setTimeout(() => {
        g.remove();
        item.classList.remove("sort-ph");
        document.body.classList.remove("sorting");
        const order = sibs();
        if (order.some((el, i) => el !== startOrder[i])) onDrop(item.dataset.sort, order, startOrder);
      }, MOVE_MS);
    };

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }
}
