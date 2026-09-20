// image-import.js — turns a user-supplied PNG/JPG into a track.
//
// Pipeline: threshold to a binary mask (auto-detects dark-on-light vs
// light-on-dark), Zhang-Suen skeletonize down to a 1px centerline, prune
// stray spurs, trace the skeleton into an ordered loop (trying several start
// points and keeping the longest trace — a single start can strand part of
// the shape when the skeleton isn't a perfectly clean loop), estimate local
// track width from a distance transform, then hand the simplified loop to
// generateTrackFromPath and open it in the editor for the user to refine.
const ImageImport = {
    MAX_DIM: 460,

    handleFile: function(inputEl) {
        const file = inputEl.files && inputEl.files[0];
        inputEl.value = ''; // allow re-selecting the same file next time
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
            const img = new Image();
            img.onload = () => {
                try { this.processImage(img); }
                catch (err) { console.error('Image import failed:', err); alert('Could not analyze that image: ' + err.message); }
            };
            img.onerror = () => alert('Could not load that image file.');
            img.src = e.target.result;
        };
        reader.onerror = () => alert('Could not read that file.');
        reader.readAsDataURL(file);
    },

    processImage: function(img) {
        let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!w || !h) { alert('That image has no readable pixels.'); return; }
        const scale = Math.min(1, this.MAX_DIM / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));

        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);

        const mask = this.thresholdToMask(imageData);
        if (this.countForeground(mask) < 40) {
            alert('Could not find a clear track shape in that image — try a higher-contrast drawing or photo of a track loop.');
            return;
        }

        const dist = this.distanceTransform(mask, w, h);
        let skel = this.zhangSuenThin(mask, w, h);
        skel = this.pruneSpurs(skel, w, h, 8);
        const traced = this.traceSkeletonLoop(skel, w, h);
        if (traced.length < 8) {
            alert('Could not trace a track loop from that image — try a clearer or simpler track shape.');
            return;
        }

        // Fit the traced pixel coords into the sim canvas, centered with a margin.
        let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
        traced.forEach(p => { minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); });
        const srcW = Math.max(1, maxX-minX), srcH = Math.max(1, maxY-minY);
        const margin = 90;
        const fitScale = Math.min((CANVAS_WIDTH - margin*2) / srcW, (CANVAS_HEIGHT - margin*2) / srcH);
        const offX = (CANVAS_WIDTH - srcW*fitScale) / 2, offY = (CANVAS_HEIGHT - srcH*fitScale) / 2;
        const mapped = traced.map(p => ({ x: (p.x-minX)*fitScale + offX, y: (p.y-minY)*fitScale + offY }));

        // Local half-width (distance transform, in SOURCE pixels) scaled by
        // the same fit factor so it stays proportional to the mapped path.
        let widths = traced.map(p => dist[p.y*w+p.x] * 2 * fitScale).filter(v => v > 4).sort((a,b)=>a-b);
        let trackWidth = widths.length ? Math.round(widths[Math.floor(widths.length/2)]) : 55;
        trackWidth = Math.max(24, Math.min(140, trackWidth));

        // Reuse the editor's own closed-loop simplifier (same algorithm the
        // freehand Draw mode uses) so point density/behavior stays consistent.
        const simplified = editor.simplifyClosedLoop(mapped, 9);
        if (simplified.length < 3) {
            alert('That track shape was too small or simple to build a track from.');
            return;
        }
        // Same thinning the Draw tool does: leave each vertex enough straight
        // either side for the generator to fit a real corner arc into.
        const spaced = editor.spaceOutPoints(simplified, Math.max(18, trackWidth * 1.1));
        if (spaced.length < 3) {
            alert('That track shape was too small or simple to build a track from.');
            return;
        }
        const path = spaced.map(p => ({ x: Math.round(p.x), y: Math.round(p.y), type: 'corner', radius: 35 }));

        const t = generateTrackFromPath('img' + Date.now(), 'Imported Track', path, trackWidth);
        app.state.isEditing = true;
        app.state.trackToEdit = t;
        editor.init(t);
        app.state.isRunning = false;
        document.getElementById('editor-controls').classList.remove('hidden');
        closeSidebar();
    },

    thresholdToMask: function(imageData) {
        const { width, height, data } = imageData;
        const mask = new Uint8Array(width * height);
        let darkCount = 0, total = 0;
        const lum = new Float32Array(width * height);
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
            const a = data[i+3];
            if (a < 32) { lum[p] = 255; continue; } // transparent -> background
            const l = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
            lum[p] = l;
            if (l < 128) darkCount++;
            total++;
        }
        // Auto-detect polarity: the smaller class is almost always the drawn
        // track/line, whether it's dark-on-light or light-on-dark art.
        const darkIsForeground = darkCount <= total - darkCount;
        for (let p = 0; p < lum.length; p++) {
            const isDark = lum[p] < 128;
            mask[p] = (darkIsForeground ? isDark : !isDark) ? 1 : 0;
        }
        return mask;
    },

    // Two-pass chamfer distance transform (approximate distance to nearest
    // background pixel) — used to estimate local track half-width.
    distanceTransform: function(mask, w, h) {
        const INF = 1e6;
        const dist = new Float32Array(w*h).fill(INF);
        for (let i = 0; i < mask.length; i++) if (!mask[i]) dist[i] = 0;
        const at = (x,y) => dist[y*w+x];
        for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
            if (!mask[y*w+x]) continue;
            let d = dist[y*w+x];
            if (x>0) d = Math.min(d, at(x-1,y)+1);
            if (y>0) d = Math.min(d, at(x,y-1)+1);
            if (x>0 && y>0) d = Math.min(d, at(x-1,y-1)+1.4142);
            if (x<w-1 && y>0) d = Math.min(d, at(x+1,y-1)+1.4142);
            dist[y*w+x] = d;
        }
        for (let y=h-1; y>=0; y--) for (let x=w-1; x>=0; x--) {
            if (!mask[y*w+x]) continue;
            let d = dist[y*w+x];
            if (x<w-1) d = Math.min(d, at(x+1,y)+1);
            if (y<h-1) d = Math.min(d, at(x,y+1)+1);
            if (x<w-1 && y<h-1) d = Math.min(d, at(x+1,y+1)+1.4142);
            if (x>0 && y<h-1) d = Math.min(d, at(x-1,y+1)+1.4142);
            dist[y*w+x] = d;
        }
        return dist;
    },

    // Zhang-Suen thinning: iteratively erodes the mask down to a 1px skeleton.
    zhangSuenThin: function(mask, w, h) {
        let img = Uint8Array.from(mask);
        const idx = (x,y) => y*w+x;
        const P = (x,y) => (x<0||y<0||x>=w||y>=h) ? 0 : img[idx(x,y)];
        let changed = true, iterations = 0;
        while (changed && iterations < 200) {
            changed = false; iterations++;
            for (let step = 0; step < 2; step++) {
                const toClear = [];
                for (let y=1; y<h-1; y++) for (let x=1; x<w-1; x++) {
                    if (!P(x,y)) continue;
                    const p2=P(x,y-1), p3=P(x+1,y-1), p4=P(x+1,y), p5=P(x+1,y+1);
                    const p6=P(x,y+1), p7=P(x-1,y+1), p8=P(x-1,y), p9=P(x-1,y-1);
                    const neighbors = [p2,p3,p4,p5,p6,p7,p8,p9];
                    const B = neighbors.reduce((a,b)=>a+b,0);
                    if (B < 2 || B > 6) continue;
                    let A = 0;
                    for (let i=0;i<8;i++) if (neighbors[i]===0 && neighbors[(i+1)%8]===1) A++;
                    if (A !== 1) continue;
                    if (step === 0) {
                        if (p2*p4*p6 !== 0) continue;
                        if (p4*p6*p8 !== 0) continue;
                    } else {
                        if (p2*p4*p8 !== 0) continue;
                        if (p2*p6*p8 !== 0) continue;
                    }
                    toClear.push(idx(x,y));
                }
                if (toClear.length) { changed = true; for (const i of toClear) img[i] = 0; }
            }
        }
        return img;
    },

    // Prune short spurs (degree-1 branches) so a mostly-loop skeleton becomes
    // a clean loop before tracing.
    pruneSpurs: function(skel, w, h, maxSpurLen) {
        let img = Uint8Array.from(skel);
        const idx = (x,y) => y*w+x;
        const neighborsOf = (x,y) => {
            const n = [];
            for (let dy=-1; dy<=1; dy++) for (let dx=-1; dx<=1; dx++) {
                if (dx===0 && dy===0) continue;
                const nx=x+dx, ny=y+dy;
                if (nx>=0 && ny>=0 && nx<w && ny<h && img[idx(nx,ny)]) n.push([nx,ny]);
            }
            return n;
        };
        for (let iter=0; iter<maxSpurLen; iter++) {
            const endpoints = [];
            for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
                if (!img[idx(x,y)]) continue;
                if (neighborsOf(x,y).length === 1) endpoints.push([x,y]);
            }
            if (!endpoints.length) break;
            for (const [x,y] of endpoints) img[idx(x,y)] = 0;
        }
        return img;
    },

    countForeground: function(mask) { let c=0; for (let i=0;i<mask.length;i++) if(mask[i]) c++; return c; },

    // Greedy walk of the (pruned) skeleton graph, preferring to continue in a
    // similar direction. Tries multiple candidate start points (every real
    // endpoint plus a sample across the component) and keeps the longest
    // resulting trace, since a single arbitrary start can strand part of the
    // shape when the skeleton has a gap or a branchy tip.
    traceSkeletonLoop: function(skel, w, h) {
        const idx = (x,y) => y*w+x;
        const pixels = [];
        for (let y=0; y<h; y++) for (let x=0; x<w; x++) if (skel[idx(x,y)]) pixels.push([x,y]);
        if (pixels.length < 8) return [];

        const visited = new Uint8Array(w*h);
        let best = [];
        for (const [sx,sy] of pixels) {
            if (visited[idx(sx,sy)]) continue;
            const comp = []; const stack = [[sx,sy]]; visited[idx(sx,sy)] = 1;
            while (stack.length) {
                const [x,y] = stack.pop(); comp.push([x,y]);
                for (let dy=-1; dy<=1; dy++) for (let dx=-1; dx<=1; dx++) {
                    if (!dx && !dy) continue;
                    const nx=x+dx, ny=y+dy;
                    if (nx<0||ny<0||nx>=w||ny>=h) continue;
                    if (skel[idx(nx,ny)] && !visited[idx(nx,ny)]) { visited[idx(nx,ny)]=1; stack.push([nx,ny]); }
                }
            }
            if (comp.length > best.length) best = comp;
        }
        if (best.length < 8) return [];

        const compSet = new Set(best.map(([x,y]) => idx(x,y)));
        const neighborsOf = (x,y) => {
            const n = [];
            for (let dy=-1; dy<=1; dy++) for (let dx=-1; dx<=1; dx++) {
                if (!dx && !dy) continue;
                const nx=x+dx, ny=y+dy;
                if (compSet.has(idx(nx,ny))) n.push([nx,ny]);
            }
            return n;
        };

        const maxSteps = best.length * 2;
        function walkFrom(startPixel) {
            let [cx,cy] = startPixel;
            const path = [[cx,cy]];
            const used = new Set([idx(cx,cy)]);
            let dirX = 0, dirY = 0;
            for (let step=0; step<maxSteps; step++) {
                const neigh = neighborsOf(cx,cy).filter(([x,y]) => !used.has(idx(x,y)));
                if (!neigh.length) break;
                let choice = neigh[0], bestScore = -Infinity;
                for (const [nx,ny] of neigh) {
                    const vx = nx-cx, vy = ny-cy;
                    const len = Math.hypot(vx,vy) || 1;
                    const score = (dirX*vx+dirY*vy)/len;
                    if (score > bestScore) { bestScore = score; choice = [nx,ny]; }
                }
                dirX = choice[0]-cx; dirY = choice[1]-cy;
                cx = choice[0]; cy = choice[1];
                used.add(idx(cx,cy));
                path.push([cx,cy]);
            }
            return path;
        }

        const endpoints = best.filter(([x,y]) => neighborsOf(x,y).length === 1);
        const sampleStride = Math.max(1, Math.floor(best.length / 10));
        const sampled = best.filter((_, i) => i % sampleStride === 0);
        const candidates = (endpoints.length ? endpoints : []).concat(sampled).slice(0, 20);

        let path = walkFrom(candidates[0] || best[0]);
        for (let i = 1; i < candidates.length; i++) {
            const p = walkFrom(candidates[i]);
            if (p.length > path.length) path = p;
        }
        return path.map(([x,y]) => ({x,y}));
    }
};
