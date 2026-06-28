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
  // background only if its color matches one of several clusters sampled
  // along the border (handles scenes with more than one background region,
  // e.g. a closet wall plus shelving). Growth is connectivity-only - a
  // pixel's match is always checked against the original border colors,
  // never against whatever its neighbor was reclassified as. A "close to
  // the previous pixel" rule was tried here before, but it let the fill
  // walk arbitrarily far from the sampled colors over many small steps,
  // which could eat straight through a garment whose color is only subtly
  // different from the background - exactly the case where preserving the
  // garment's real color matters most.
  //
  // Even with that fixed, a garment that's simply close in color to its
  // background (a white tee on a light wall) can still match the cluster
  // threshold directly. Since erasing the clothing itself is far worse than
  // leaving a sliver of background behind, a single attempt that clears out
  // most of the photo is retried with a tighter threshold until a
  // garment-sized region survives. The retained pixel COUNT isn't a safe
  // signal for "did the garment survive" - a high-contrast logo or seam can
  // stay opaque while the rest of the garment is erased around it, which
  // looks fine by raw count but is exactly the failure being guarded
  // against. So the check instead looks at the size of the largest
  // connected opaque region: a real garment survives as one big blob, while
  // an over-aggressive cut leaves only small disconnected fragments.
  function removeBackground(ctx, w, h, threshold = 38, mode = 'garment') {
    const original = ctx.getImageData(0, 0, w, h);
    const od = original.data;

    let transparentCount = 0;
    for (let i = 3; i < od.length; i += 4) if (od[i] < 200) transparentCount++;
    if (transparentCount / (w * h) > 0.04) return original; // already cut out

    function attempt(thr) {
      const imgData = new ImageData(new Uint8ClampedArray(od), w, h);
      const d = imgData.data;

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
        for (const c of clusters) if (colorDist(r, g, b, c.r, c.g, c.b) <= thr) return true;
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

      function tryPush(x, y) {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        const idx = y * w + x;
        if (visited[idx]) return;
        const i = idx * 4;
        if (matchesBackground(d[i], d[i + 1], d[i + 2])) {
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
        tryPush(x - 1, y); tryPush(x + 1, y);
        tryPush(x, y - 1); tryPush(x, y + 1);
      }

      // Size of the largest 4-connected opaque region, as a fraction of the
      // photo - see the note above on why this (and not raw opaque count) is
      // the signal used to decide whether this attempt kept the garment.
      const seen = new Uint8Array(w * h);
      const stack = new Int32Array(w * h);
      let largest = 0;
      for (let start = 0; start < w * h; start++) {
        if (seen[start] || d[start * 4 + 3] <= 200) { seen[start] = 1; continue; }
        let sp = 0;
        stack[sp++] = start;
        seen[start] = 1;
        let count = 0;
        while (sp > 0) {
          const idx = stack[--sp];
          count++;
          const x = idx % w, y = (idx - x) / w;
          const nbrs = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
          for (const [nx, ny] of nbrs) {
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nIdx = ny * w + nx;
            if (seen[nIdx] || d[nIdx * 4 + 3] <= 200) { seen[nIdx] = 1; continue; }
            seen[nIdx] = 1;
            stack[sp++] = nIdx;
          }
        }
        if (count > largest) largest = count;
      }

      // Bounding-box fill ratio of the surviving opaque pixels - how
      // "solid" the result is within its own outline, vs. hollowed out by
      // a leaky flood fill. Only consulted in head mode (see below); unused
      // here, so it can't change garment-mode output.
      let opaqueCount = 0;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let idx = 0; idx < w * h; idx++) {
        if (d[idx * 4 + 3] > 200) {
          opaqueCount++;
          const x = idx % w, y = (idx - x) / w;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      const bboxArea = maxX >= minX ? (maxX - minX + 1) * (maxY - minY + 1) : 0;
      const fillRatio = bboxArea > 0 ? opaqueCount / bboxArea : 0;

      return { imgData, blobFrac: largest / (w * h), totalOpaqueFrac: opaqueCount / (w * h), fillRatio };
    }

    // Head photos can't legitimately have a large interior gap the way a
    // garment can (an open jacket, a sleeve/armpit gap), so for heads it's
    // safe to pick whichever threshold leaves the most "solid" silhouette
    // instead of stopping at the first one with a big enough blob. That
    // matters because a single high-contrast feature (e.g. dark hair) can
    // satisfy the blob-size bar on its own while a separate, lower-contrast
    // part of the same subject (skin near the background color) is erased
    // out from under it - the garment logic below would stop right there
    // and ship the hollowed-out result.
    if (mode === 'head') {
      const attempts = [attempt(threshold)];
      for (const mul of [0.65, 0.45, 0.3, 0.2, 0.13]) attempts.push(attempt(threshold * mul));
      const cap = 0.55; // guards against the same background-gradient leakage risk that rules out chasing fillRatio for garments
      let best = null;
      for (const a of attempts) {
        if (a.totalOpaqueFrac > cap) continue;
        if (!best || a.fillRatio > best.fillRatio) best = a;
      }
      return (best || attempts[0]).imgData;
    }

    let result = attempt(threshold);
    for (const mul of [0.65, 0.45, 0.3, 0.2, 0.13]) {
      if (result.blobFrac >= 0.15) break;
      result = attempt(threshold * mul);
    }
    return result.imgData;
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

  // Fills small holes punched into the garment by the flood fill. A thin,
  // almost-invisible trail of background-colored pixels - fabric grain,
  // compression noise, a fold - can connect the border all the way to a
  // speck deep inside the garment, leaving "salt" noise scattered across an
  // otherwise intact cutout. Because that noise is reached via a real path
  // from the border, it's topologically one connected region with the rest
  // of the removed background - despeckle's component counting can't catch
  // it, since it only sees one giant component. Closing (dilate, then
  // erode) instead looks at local geometry: any transparent gap small
  // enough to be fully surrounded by opaque pixels gets reclaimed and its
  // original color restored, while the real surrounding background (much
  // larger than the kernel) is left alone.
  function closeHoles(imgData, original, w, h, radius = 3) {
    const d = imgData.data;
    const od = original.data;
    const n = w * h;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = d[i * 4 + 3] > 10 ? 1 : 0;

    function grow(src, dilate) {
      const out = new Uint8Array(n);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let v = dilate ? 0 : 1;
          outer:
          for (let dy = -radius; dy <= radius; dy++) {
            const ny = y + dy;
            for (let dx = -radius; dx <= radius; dx++) {
              const nx = x + dx;
              const inBounds = nx >= 0 && ny >= 0 && nx < w && ny < h;
              const s = inBounds ? src[ny * w + nx] : 0;
              if (dilate) {
                if (s) { v = 1; break outer; }
              } else if (!s) {
                v = 0; break outer;
              }
            }
          }
          out[y * w + x] = v;
        }
      }
      return out;
    }

    const closed = grow(grow(mask, true), false);
    for (let i = 0; i < n; i++) {
      if (closed[i] && !mask[i]) {
        const j = i * 4;
        d[j] = od[j]; d[j + 1] = od[j + 1]; d[j + 2] = od[j + 2]; d[j + 3] = 255;
      }
    }
    return imgData;
  }

  // Removes small disconnected speckles left over from background removal
  // (stray pixels that matched neither a background cluster nor a neighbor
  // closely enough) so the cutout edge doesn't look torn/jagged. Keeps every
  // opaque region above a tiny size floor - real garment parts (a collar, a
  // dangling sleeve, a strap) are always far bigger than a noise speck.
  function despeckle(imgData, w, h, minArea = 24) {
    const d = imgData.data;
    const n = w * h;
    const visited = new Uint8Array(n);
    const stack = new Int32Array(n);
    const isOpaque = (idx) => d[idx * 4 + 3] > 10;

    for (let start = 0; start < n; start++) {
      if (visited[start] || !isOpaque(start)) continue;
      let sp = 0;
      stack[sp++] = start;
      visited[start] = 1;
      const region = [start];
      while (sp > 0) {
        const idx = stack[--sp];
        const x = idx % w, y = (idx - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nIdx = ny * w + nx;
            if (visited[nIdx] || !isOpaque(nIdx)) continue;
            visited[nIdx] = 1;
            stack[sp++] = nIdx;
            region.push(nIdx);
          }
        }
      }
      if (region.length < minArea) {
        for (const idx of region) d[idx * 4 + 3] = 0;
      }
    }
    return imgData;
  }

  // Softens the hard binary cutout edge with a light blur on the alpha
  // channel only (color stays crisp) so the silhouette boundary doesn't look
  // jagged once it's scaled up to fit the figure.
  function featherAlpha(imgData, w, h, radius = 1) {
    const d = imgData.data;
    const srcA = new Uint8ClampedArray(w * h);
    for (let i = 0; i < w * h; i++) srcA[i] = d[i * 4 + 3];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, count = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            sum += srcA[ny * w + nx];
            count++;
          }
        }
        d[(y * w + x) * 4 + 3] = Math.round(sum / count);
      }
    }
    return imgData;
  }

  // Full "AI" pipeline: remove background, clean up the cutout, crop to
  // contour. No auto-rotation: a real garment's silhouette (sleeves, collar,
  // folds) is too asymmetric for a whole-shape tilt estimate to be reliable -
  // it was as likely to rotate a perfectly upright photo into a diagonal mess
  // as to fix a genuinely tilted one. Cropping tight to the actual cutout and
  // anchoring it on the body (done in applyDynamicFit/CSS) is what makes it
  // look "worn"; almost every flat-lay/hanger/product photo is upright enough
  // already for that alone to look organic.
  async function processGarment(file, category, onStatus) {
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
    const original = ctx.getImageData(0, 0, w, h);
    let imgData = removeBackground(ctx, w, h);
    closeHoles(imgData, original, w, h);
    despeckle(imgData, w, h);
    featherAlpha(imgData, w, h);
    ctx.putImageData(imgData, 0, 0);

    const box = bbox(imgData, w, h) || { minX: 0, minY: 0, maxX: w - 1, maxY: h - 1 };

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
    const original = ctx.getImageData(0, 0, w, h);
    const imgData = removeBackground(ctx, w, h, 38, 'head');
    closeHoles(imgData, original, w, h);
    despeckle(imgData, w, h);
    featherAlpha(imgData, w, h);
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
      { category: 'top', name: 'Demo: T-shirt', svg: DEMO_SVG.tshirt, w: 200, h: 220 },
      { category: 'top', name: 'Demo: Shirt', svg: DEMO_SVG.shirt, w: 200, h: 220 },
      { category: 'bottom', name: 'Demo: Jeans', svg: DEMO_SVG.jeans, w: 180, h: 260 },
      { category: 'bottom', name: 'Demo: Shorts', svg: DEMO_SVG.shorts, w: 180, h: 170 },
      { category: 'shoes', name: 'Demo: Sneakers', svg: DEMO_SVG.sneaker, w: 220, h: 120 },
      { category: 'shoes', name: 'Demo: Sandals', svg: DEMO_SVG.sandal, w: 220, h: 100 },
      { category: 'accessories', subtype: 'bag', name: 'Demo: Bag', svg: DEMO_SVG.bag, w: 160, h: 160 },
      { category: 'accessories', subtype: 'glasses', name: 'Demo: Glasses', svg: DEMO_SVG.glasses, w: 200, h: 90 },
      { category: 'accessories', subtype: 'hat', name: 'Demo: Hat', svg: DEMO_SVG.hat, w: 200, h: 120 },
      { category: 'accessories', subtype: 'watch', name: 'Demo: Watch', svg: DEMO_SVG.watch, w: 120, h: 160 },
    ];
    state.wardrobe = demo.map((d) => ({
      id: uid(),
      category: d.category,
      subtype: d.subtype,
      name: d.name,
      src: svgDataUrl(d.svg),
      w: d.w,
      h: d.h,
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

  // Sizes a garment slot from the item's own cutout proportions instead of a
  // fixed box: width/top stay anchored to the body's shoulder/waist line
  // (set in CSS), height is derived from the item's real aspect ratio so a
  // cropped t-shirt, a longer jacket and a full-length dress each extend
  // down by their true length. CSS min/max-height clamp the rare extreme case.
  function applyDynamicFit(sel, item) {
    const el = $(sel);
    el.style.aspectRatio = (item && item.w && item.h) ? `${item.w} / ${item.h}` : '';
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
    applyDynamicFit('#figTorso', state.equipped.top);
    setSlotImage('#slotBottom', state.equipped.bottom);
    applyDynamicFit('#figLegs', state.equipped.bottom);
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
