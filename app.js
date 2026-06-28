(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const tick = (ms = 180) => new Promise((r) => setTimeout(r, ms));

  const STORAGE_KEY = 'sw_fitting_room_v1';

  const state = {
    size: 'm',
    gender: 'female',
    headPhoto: null,
    background: 'city-day',
    activeTab: 'top',
    activeAccFilter: 'bag',
    wardrobe: [],
    equipped: { top: null, bottom: null, shoes: null, bag: null, hat: null, glasses: null, watch: null },
    bagSide: 'right',
    seeded: false,
  };

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* quota / private mode */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) Object.assign(state, JSON.parse(raw));
    } catch (e) { /* corrupt data, ignore */ }
  }

  // ===================================================================
  // Image helpers
  // ===================================================================
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function colorDist(r1, g1, b1, r2, g2, b2) {
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  }

  // Background removal: flood fill from the border, treating a pixel as
  // background if it matches one of several color clusters sampled along
  // the border (handles scenes with more than one background region, e.g.
  // a closet wall plus shelving) OR is close to the neighbor that reached
  // it (handles smooth gradients/shadows within a single region).
  function removeBackground(ctx, w, h, threshold = 38) {
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;

    let transparentCount = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 200) transparentCount++;
    if (transparentCount / (w * h) > 0.04) return imgData; // already cut out

    const clusters = [];
    const mergeDist = 30;
    function addSample(r, g, b) {
      for (const c of clusters) {
        if (colorDist(r, g, b, c.r, c.g, c.b) <= mergeDist) {
          c.r = (c.r * c.n + r) / (c.n + 1);
          c.g = (c.g * c.n + g) / (c.n + 1);
          c.b = (c.b * c.n + b) / (c.n + 1);
          c.n++;
          return;
        }
      }
      if (clusters.length < 16) clusters.push({ r, g, b, n: 1 });
    }
    for (let x = 0; x < w; x++) {
      let i = x * 4; addSample(d[i], d[i + 1], d[i + 2]);
      i = ((h - 1) * w + x) * 4; addSample(d[i], d[i + 1], d[i + 2]);
    }
    for (let y = 0; y < h; y++) {
      let i = (y * w) * 4; addSample(d[i], d[i + 1], d[i + 2]);
      i = (y * w + w - 1) * 4; addSample(d[i], d[i + 1], d[i + 2]);
    }
    function matchesBackground(r, g, b) {
      for (const c of clusters) if (colorDist(r, g, b, c.r, c.g, c.b) <= threshold) return true;
      return false;
    }

    const visited = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let qh = 0, qt = 0;

    function seed(x, y) {
      const idx = y * w + x;
      if (visited[idx]) return;
      visited[idx] = 1;
      d[idx * 4 + 3] = 0;
      queue[qt++] = idx;
    }
    // The whole border is assumed to be background (the item shouldn't touch the frame edge).
    for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
    for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }

    const neighborThreshold = threshold * 0.72;
    function tryPush(x, y, pr, pg, pb) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const idx = y * w + x;
      if (visited[idx]) return;
      const i = idx * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (matchesBackground(r, g, b) || colorDist(r, g, b, pr, pg, pb) <= neighborThreshold) {
        visited[idx] = 1;
        d[i + 3] = 0;
        queue[qt++] = idx;
      } else {
        visited[idx] = 2;
      }
    }

    while (qh < qt) {
      const idx = queue[qh++];
      const x = idx % w, y = (idx - x) / w;
      const i = idx * 4;
      const pr = d[i], pg = d[i + 1], pb = d[i + 2];
      tryPush(x - 1, y, pr, pg, pb); tryPush(x + 1, y, pr, pg, pb);
      tryPush(x, y - 1, pr, pg, pb); tryPush(x, y + 1, pr, pg, pb);
    }
    return imgData;
  }

  function bbox(imgData, w, h) {
    const d = imgData.data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX) return null;
    return { minX, minY, maxX, maxY };
  }

  // Principal axis angle (degrees, in (-90,90]) of the opaque pixel cloud via image moments.
  function principalAngleDeg(imgData, w, h, box) {
    const d = imgData.data;
    const step = 2;
    let n = 0, sx = 0, sy = 0;
    for (let y = box.minY; y <= box.maxY; y += step) {
      for (let x = box.minX; x <= box.maxX; x += step) {
        if (d[(y * w + x) * 4 + 3] > 10) { sx += x; sy += y; n++; }
      }
    }
    if (!n) return 0;
    const cx = sx / n, cy = sy / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let y = box.minY; y <= box.maxY; y += step) {
      for (let x = box.minX; x <= box.maxX; x += step) {
        if (d[(y * w + x) * 4 + 3] > 10) {
          const dx = x - cx, dy = y - cy;
          sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
        }
      }
    }
    return 0.5 * Math.atan2(2 * sxy, sxx - syy) * 180 / Math.PI;
  }

  function angleDiffToTarget(theta, target) {
    let diff = target - theta;
    while (diff > 90) diff -= 180;
    while (diff < -90) diff += 180;
    return diff;
  }

  function rotateCanvas(srcCanvas, angleDeg, w, h) {
    const rad = (angleDeg * Math.PI) / 180;
    const diag = Math.ceil(Math.sqrt(w * w + h * h));
    const c = document.createElement('canvas');
    c.width = diag; c.height = diag;
    const ctx = c.getContext('2d');
    ctx.translate(diag / 2, diag / 2);
    ctx.rotate(rad);
    ctx.drawImage(srcCanvas, -w / 2, -h / 2, w, h);
    return c;
  }

  // Full "AI" pipeline: remove background, straighten ("iron flat"), crop to contour.
  async function processGarment(file, category, onStatus) {
    const dataUrl = await fileToDataURL(file);
    const img = await loadImage(dataUrl);

    const MAX_DIM = 640;
    const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
    let w = Math.round(img.width * scale), h = Math.round(img.height * scale);

    let canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    let ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);

    onStatus && onStatus('Removing background…');
    await tick();
    let imgData = removeBackground(ctx, w, h);
    ctx.putImageData(imgData, 0, 0);

    let box = bbox(imgData, w, h) || { minX: 0, minY: 0, maxX: w - 1, maxY: h - 1 };

    onStatus && onStatus('Straightening item…');
    await tick();

    if (category === 'top' || category === 'bottom' || category === 'shoes') {
      const target = category === 'shoes' ? 0 : 90;
      const theta = principalAngleDeg(imgData, w, h, box);
      let diff = angleDiffToTarget(theta, target);
      diff = Math.max(-20, Math.min(20, diff));

      if (Math.abs(diff) > 1.5) {
        let rotated = rotateCanvas(canvas, diff, w, h);
        let rCtx = rotated.getContext('2d');
        let rData = rCtx.getImageData(0, 0, rotated.width, rotated.height);
        let rBox = bbox(rData, rotated.width, rotated.height);

        if (rBox) {
          const newTheta = principalAngleDeg(rData, rotated.width, rotated.height, rBox);
          const newDiff = Math.abs(angleDiffToTarget(newTheta, target));
          if (newDiff > Math.abs(diff) + 1) {
            // sign convention was backwards for this case - flip and redo
            rotated = rotateCanvas(canvas, -diff, w, h);
            rCtx = rotated.getContext('2d');
            rData = rCtx.getImageData(0, 0, rotated.width, rotated.height);
            rBox = bbox(rData, rotated.width, rotated.height) || rBox;
          }
        }

        canvas = rotated; ctx = rCtx; w = canvas.width; h = canvas.height;
        imgData = rData;
        box = rBox || { minX: 0, minY: 0, maxX: w - 1, maxY: h - 1 };
      }
    }

    onStatus && onStatus('Cropping to outline…');
    await tick();

    const pad = 6;
    const cx0 = Math.max(0, box.minX - pad), cy0 = Math.max(0, box.minY - pad);
    const cw = Math.min(w, box.maxX + pad) - cx0;
    const ch = Math.min(h, box.maxY + pad) - cy0;
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = Math.max(1, cw);
    finalCanvas.height = Math.max(1, ch);
    finalCanvas.getContext('2d').drawImage(canvas, cx0, cy0, cw, ch, 0, 0, cw, ch);

    onStatus && onStatus('Done!');
    await tick(220);

    return { src: finalCanvas.toDataURL('image/png'), w: finalCanvas.width, h: finalCanvas.height };
  }

  // Cuts the face photo out by its contour (background removed, cropped tight)
  // instead of a plain circular crop, so it follows the head/hair outline.
  async function processHeadPhoto(file, onStatus) {
    const dataUrl = await fileToDataURL(file);
    const img = await loadImage(dataUrl);

    const MAX_DIM = 640;
    const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);

    onStatus && onStatus('Removing background…');
    await tick();
    const imgData = removeBackground(ctx, w, h);
    ctx.putImageData(imgData, 0, 0);

    onStatus && onStatus('Cropping to outline…');
    await tick();
    const box = bbox(imgData, w, h) || { minX: 0, minY: 0, maxX: w - 1, maxY: h - 1 };

    const pad = 4;
    const cx0 = Math.max(0, box.minX - pad), cy0 = Math.max(0, box.minY - pad);
    const cw = Math.min(w, box.maxX + pad) - cx0;
    const ch = Math.min(h, box.maxY + pad) - cy0;
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = Math.max(1, cw);
    finalCanvas.height = Math.max(1, ch);
    finalCanvas.getContext('2d').drawImage(canvas, cx0, cy0, cw, ch, 0, 0, cw, ch);

    onStatus && onStatus('Done!');
    await tick(220);

    return finalCanvas.toDataURL('image/png');
  }

  // ===================================================================
  // Demo wardrobe (flat vector placeholders standing in for the user's own photos)
  // ===================================================================
  function svgDataUrl(svg) {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  const DEMO_SVG = {
    tshirt: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 220"><path d="M70 8 L100 28 L130 8 L168 36 L150 68 L130 56 L130 205 Q100 218 70 205 L70 56 L50 68 L32 36 Z" fill="#5648E0"/></svg>`,
    shirt: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 220"><path d="M72 8 L100 24 L128 8 L166 34 L148 64 L130 54 L130 90 L142 100 L130 112 L130 205 Q100 218 70 205 L70 112 L58 100 L70 90 L70 54 L52 64 L34 34 Z" fill="#F8F7FC" stroke="#1A1922" stroke-width="3"/></svg>`,
    jeans: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 260"><path d="M30 8 H150 L158 250 L118 250 L100 110 L80 250 L42 250 Z" fill="#3A3650"/></svg>`,
    shorts: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 170"><path d="M30 8 H150 L156 160 L112 160 L100 70 L80 160 L44 160 Z" fill="#56535F"/></svg>`,
    sneaker: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 120"><path d="M10 92 Q10 60 42 55 L72 30 Q92 14 120 25 L172 46 Q206 56 206 86 L206 100 H14 Z" fill="#2C2186"/><rect x="14" y="96" width="192" height="10" rx="3" fill="#1A1922"/></svg>`,
    sandal: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 100"><ellipse cx="110" cy="76" rx="100" ry="18" fill="#C9A26B"/><path d="M40 76 Q60 20 110 30 Q160 20 180 76" fill="none" stroke="#7A5A33" stroke-width="9"/></svg>`,
    bag: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><path d="M50 55 V35 a30 30 0 0160 0 V55" fill="none" stroke="#2C2186" stroke-width="8"/><rect x="20" y="55" width="120" height="95" rx="12" fill="#5648E0"/></svg>`,
    glasses: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 90"><rect x="10" y="20" width="75" height="50" rx="20" fill="#1A1922"/><rect x="115" y="20" width="75" height="50" rx="20" fill="#1A1922"/><rect x="85" y="38" width="30" height="8" fill="#1A1922"/></svg>`,
    hat: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><path d="M30 95 a70 62 0 01140 0 Z" fill="#2C2186"/><path d="M150 88 Q192 82 197 97 Q192 108 150 102 Z" fill="#1A1922"/></svg>`,
    watch: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 160"><rect x="35" y="0" width="50" height="42" rx="8" fill="#3A3650"/><circle cx="60" cy="80" r="36" fill="#EDEBFB" stroke="#1A1922" stroke-width="6"/><rect x="35" y="118" width="50" height="42" rx="8" fill="#3A3650"/></svg>`,
  };

  function seedDemoWardrobe() {
    const demo = [
      { category: 'top', name: 'Demo: T-shirt', svg: DEMO_SVG.tshirt },
      { category: 'top', name: 'Demo: Shirt', svg: DEMO_SVG.shirt },
      { category: 'bottom', name: 'Demo: Jeans', svg: DEMO_SVG.jeans },
      { category: 'bottom', name: 'Demo: Shorts', svg: DEMO_SVG.shorts },
      { category: 'shoes', name: 'Demo: Sneakers', svg: DEMO_SVG.sneaker },
      { category: 'shoes', name: 'Demo: Sandals', svg: DEMO_SVG.sandal },
      { category: 'accessories', subtype: 'bag', name: 'Demo: Bag', svg: DEMO_SVG.bag },
      { category: 'accessories', subtype: 'glasses', name: 'Demo: Glasses', svg: DEMO_SVG.glasses },
      { category: 'accessories', subtype: 'hat', name: 'Demo: Hat', svg: DEMO_SVG.hat },
      { category: 'accessories', subtype: 'watch', name: 'Demo: Watch', svg: DEMO_SVG.watch },
    ];
    state.wardrobe = demo.map((d) => ({
      id: uid(),
      category: d.category,
      subtype: d.subtype,
      name: d.name,
      src: svgDataUrl(d.svg),
      demo: true,
    }));
  }

  // ===================================================================
  // Rendering
  // ===================================================================
  function setSlotImage(sel, item, mirror) {
    const el = $(sel);
    const img = el.tagName === 'IMG' ? el : el.querySelector('img');
    if (item) {
      if (img.getAttribute('src') !== item.src) img.src = item.src;
      img.style.transform = mirror ? 'scaleX(-1)' : '';
    } else {
      img.removeAttribute('src');
    }
    if (el.classList.contains('fig-accessory')) el.classList.toggle('filled', !!item);
  }

  function popAnimate(el) {
    el.classList.remove('pop');
    // restart animation
    void el.offsetWidth;
    el.classList.add('pop');
    setTimeout(() => el.classList.remove('pop'), 400);
  }

  function renderFigure() {
    const stage = $('#figureStage');
    if (!stage) return;
    stage.dataset.size = state.size;
    stage.dataset.gender = state.gender;
    $('#figPhoto').src = `assets/silhouette-${state.gender}.png`;

    const headPhotoEl = $('#headPhoto');
    if (state.headPhoto) {
      headPhotoEl.innerHTML = `<img src="${state.headPhoto}" alt="Face photo">`;
      headPhotoEl.classList.remove('empty');
    } else {
      headPhotoEl.innerHTML = '';
      headPhotoEl.classList.add('empty');
    }

    setSlotImage('#slotTop', state.equipped.top);
    setSlotImage('#slotBottom', state.equipped.bottom);
    setSlotImage('#slotShoeL', state.equipped.shoes);
    setSlotImage('#slotShoeR', state.equipped.shoes, true);
    setSlotImage('#slotBag', state.equipped.bag);
    setSlotImage('#slotHat', state.equipped.hat);
    setSlotImage('#slotGlasses', state.equipped.glasses);
    setSlotImage('#slotWatch', state.equipped.watch);

    const bagSlot = $('#slotBag');
    bagSlot.classList.toggle('side-left', state.bagSide === 'left');
    bagSlot.classList.toggle('side-right', state.bagSide !== 'left');
  }

  function renderBackground() {
    const scene = $('#scene');
    if (scene) scene.dataset.bg = state.background;
    $$('#bgPicker button').forEach((b) => b.classList.toggle('active', b.dataset.bg === state.background));
  }

  function categoryLabel(cat) {
    return { top: 'top', bottom: 'bottom', shoes: 'shoes', accessories: 'accessory' }[cat] || cat;
  }

  function renderWardrobeGrid() {
    $$('#wpTabs button').forEach((b) => b.classList.toggle('active', b.dataset.cat === state.activeTab));

    const accFilterBar = $('#accFilterBar');
    accFilterBar.hidden = state.activeTab !== 'accessories';
    if (state.activeTab === 'accessories') {
      $$('#accFilterBar button').forEach((b) => b.classList.toggle('active', b.dataset.sub === state.activeAccFilter));
    }

    let items = state.wardrobe.filter((it) => it.category === state.activeTab);
    if (state.activeTab === 'accessories' && state.activeAccFilter !== 'all') {
      items = items.filter((it) => it.subtype === state.activeAccFilter);
    }

    const grid = $('#wpGrid');
    grid.innerHTML = '';
    grid.appendChild(buildAddCard());
    items.forEach((item) => grid.appendChild(buildItemCard(item)));

    $('#wpEmptyHint').hidden = items.length > 0;
    $('#wpCount').textContent = `${state.wardrobe.length} ${pluralize(state.wardrobe.length)}`;
  }

  function pluralize(n) {
    return n === 1 ? 'item' : 'items';
  }

  function buildAddCard() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wp-card wp-add';
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>Add photo</span>`;
    btn.addEventListener('click', () => $('#itemFileInput').click());
    return btn;
  }

  function buildItemCard(item) {
    const equippedKey = item.category === 'accessories' ? item.subtype : item.category;
    const isEquipped = state.equipped[equippedKey] && state.equipped[equippedKey].id === item.id;

    const card = document.createElement('div');
    card.className = 'wp-card' + (isEquipped ? ' equipped' : '');

    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'wp-thumb';
    thumb.setAttribute('aria-label', `${isEquipped ? 'Remove' : 'Wear'}: ${item.name}`);
    thumb.innerHTML = `<img src="${item.src}" alt="${item.name}">` + (isEquipped ? '<span class="wp-check">✓</span>' : '');
    thumb.addEventListener('click', () => equipItem(item));

    const name = document.createElement('span');
    name.className = 'wp-name';
    name.textContent = item.name;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'wp-del';
    del.setAttribute('aria-label', 'Remove item');
    del.textContent = '×';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeItem(item.id); });

    card.append(thumb, name, del);
    return card;
  }

  // ===================================================================
  // Actions
  // ===================================================================
  function equipItem(item) {
    const slotKey = item.category === 'accessories' ? item.subtype : item.category;
    const current = state.equipped[slotKey];
    state.equipped[slotKey] = current && current.id === item.id ? null : item;
    renderFigure();
    renderWardrobeGrid();
    save();

    const slotSelMap = { top: '#slotTop', bottom: '#slotBottom', shoes: '#figLegs', bag: '#slotBag', hat: '#slotHat', glasses: '#slotGlasses', watch: '#slotWatch' };
    const el = $(slotKey === 'shoes' ? '#slotShoeL' : slotSelMap[slotKey]);
    if (el && state.equipped[slotKey]) popAnimate(el);
    if (slotKey === 'shoes') { const r = $('#slotShoeR'); if (r && state.equipped.shoes) popAnimate(r); }
  }

  function removeItem(id) {
    state.wardrobe = state.wardrobe.filter((it) => it.id !== id);
    Object.keys(state.equipped).forEach((k) => {
      if (state.equipped[k] && state.equipped[k].id === id) state.equipped[k] = null;
    });
    renderFigure();
    renderWardrobeGrid();
    save();
  }

  function flipBag(dir) {
    state.bagSide = dir;
    renderFigure();
    save();
  }

  async function addGarmentFromFile(file) {
    showAiOverlay();
    try {
      const category = state.activeTab;
      const subtype = category === 'accessories' ? (state.activeAccFilter === 'all' ? 'bag' : state.activeAccFilter) : undefined;
      const result = await processGarment(file, category, setAiStatus);
      const item = {
        id: uid(),
        category,
        subtype,
        name: defaultName(category, subtype),
        src: result.src,
        w: result.w,
        h: result.h,
        demo: false,
      };
      state.wardrobe.push(item);
      renderWardrobeGrid();
      save();
    } catch (err) {
      console.error(err);
      alert('Could not process the photo. Try a different image.');
    } finally {
      hideAiOverlay();
    }
  }

  function defaultName(category, subtype) {
    const names = {
      top: 'Top', bottom: 'Bottom', shoes: 'Shoes',
      bag: 'Bag', glasses: 'Glasses', hat: 'Hat', watch: 'Watch',
    };
    return names[subtype || category] || 'Item';
  }

  function showAiOverlay() { $('#aiOverlay').hidden = false; }
  function hideAiOverlay() { $('#aiOverlay').hidden = true; }
  function setAiStatus(text) { $('#aiStatus').textContent = text; }

  // ===================================================================
  // Wiring
  // ===================================================================
  function bindEvents() {
    $$('#sizeChips button').forEach((b) => {
      b.addEventListener('click', () => {
        state.size = b.dataset.size;
        $$('#sizeChips button').forEach((x) => x.classList.toggle('active', x === b));
        renderFigure();
        save();
      });
    });

    $$('#genderChips button').forEach((b) => {
      b.addEventListener('click', () => {
        state.gender = b.dataset.gender;
        $$('#genderChips button').forEach((x) => x.classList.toggle('active', x === b));
        renderFigure();
        save();
      });
    });

    $('#continueBtn').addEventListener('click', () => {
      $('#screenFit').hidden = false;
      $('#screenSetup').hidden = true;
      $('#fitFigureSlot').appendChild($('#figureStage'));
      window.scrollTo(0, 0);
    });

    $('#backBtn').addEventListener('click', () => {
      $('#screenSetup').hidden = false;
      $('#screenFit').hidden = true;
      $('#setupFigureSlot').appendChild($('#figureStage'));
      window.scrollTo(0, 0);
    });

    $('#headAddBtn').addEventListener('click', () => $('#headFileInput').click());
    $('#headFileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      showAiOverlay();
      try {
        state.headPhoto = await processHeadPhoto(file, setAiStatus);
        renderFigure();
        popAnimate($('#figHead'));
        save();
      } catch (err) {
        console.error(err);
        alert('Could not process the photo. Try a different image.');
      } finally {
        hideAiOverlay();
      }
    });

    $$('#bgPicker button').forEach((b) => {
      b.addEventListener('click', () => {
        state.background = b.dataset.bg;
        renderBackground();
        save();
      });
    });

    $$('#wpTabs button').forEach((b) => {
      b.addEventListener('click', () => {
        state.activeTab = b.dataset.cat;
        renderWardrobeGrid();
      });
    });

    $$('#accFilterBar button').forEach((b) => {
      b.addEventListener('click', () => {
        state.activeAccFilter = b.dataset.sub;
        renderWardrobeGrid();
      });
    });

    $('#bagFlip').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-dir]');
      if (!btn) return;
      flipBag(btn.dataset.dir);
    });

    $('#itemFileInput').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      for (const file of files) {
        await addGarmentFromFile(file);
      }
    });
  }

  // ===================================================================
  // Init
  // ===================================================================
  function init() {
    load();

    const tpl = $('#figureTpl');
    $('#setupFigureSlot').appendChild(tpl.content.cloneNode(true));

    if (!state.wardrobe.length && !state.seeded) {
      seedDemoWardrobe();
      state.seeded = true;
    }

    $$('#sizeChips button').forEach((b) => b.classList.toggle('active', b.dataset.size === state.size));
    $$('#genderChips button').forEach((b) => b.classList.toggle('active', b.dataset.gender === state.gender));

    renderFigure();
    renderBackground();
    renderWardrobeGrid();
    bindEvents();
    save();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
