const CANVAS_WIDTH = 1200; 
const CANVAS_HEIGHT = 900; 
const CAR_WIDTH = 14;
const CAR_HEIGHT = 7;
const SENSOR_LENGTH = 180;
const SENSOR_ANGLES = [-Math.PI/2, -Math.PI/3, -Math.PI/6, 0, Math.PI/6, Math.PI/3, Math.PI/2];
const SENSOR_COUNT = SENSOR_ANGLES.length;

// Inline SVGs — avoids calling lucide.createIcons() on every toggle
const SVG_PLAY = `<svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
const SVG_PAUSE = `<svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;

// Cached DOM references — populated once in _initUICache(), used everywhere else
const ui = {};
// Dirty-check values for updateUI — skip DOM writes if unchanged
let _ui_gen = -1, _ui_alive = -1, _ui_allBest = null;

const SETTING_DESCRIPTIONS = {
    speedMultiplier: "Simulation cycles per frame. High values train extremely fast.",
    populationSize: "Number of cars per generation. Scales perfectly via multi-threading.",
    eliteClones: "Top performers copied to the next generation without mutation. Prevents regression.",
    mutationRate: "Randomness in brain evolution. 15-25% provides excellent exploratory learning.",
    hiddenLayers: "Brain complexity. More layers = smarter but heavier computation.",
    initialTTL: "Time to Live. Frames allowed before death if no checkpoint is reached.",
    targetLaps: "Laps needed to trigger the next generation automatically.",
    maxSpeed: "Top speed. Higher speeds require faster AI reaction times.",
    acceleration: "Engine power.", turnSpeed: "Steering sensitivity.", grip: "Lateral Friction. 93% is balanced."
};

function lerp(a, b, t) { return a + (b - a) * t; }

// --- Track Generator ---
function generateTrackFromPath(id, name, pathInput, width, customStartPos, customStartAngle, zones = []) {
    const walls = []; const checkpoints = []; const leftPoly = []; const rightPoly = [];
    const emptyResult = { id, name, path: pathInput || [], trackWidth: width, walls: [], checkpoints: [], startPos: {x:100,y:100}, startAngle: 0, zones: zones||[], leftPoly, rightPoly };

    if (!pathInput || pathInput.length < 3) return emptyResult;
    
    let path = [...pathInput];
    let start = path[0], end = path[path.length - 1];
    if (Math.hypot(start.x - end.x, start.y - end.y) < 5) path.pop(); 
    if(path.length < 3) return emptyResult;

    // --- CORNER ROUNDING (BEZIER FILLET) ---
    let smoothedPath = [];
    for(let i = 0; i < path.length; i++) {
        let curr = path[i];
        let prev = path[(i - 1 + path.length) % path.length];
        let next = path[(i + 1) % path.length];

        let type = curr.type || 'rounded';
        let radius = curr.radius !== undefined ? curr.radius : 60;
        // A fillet tighter than the track's own half-width is geometrically
        // impossible to offset cleanly — the inner wall is forced past the
        // outer wall partway round the arc, flipping the road polygon inside
        // out (a dark wedge cut into the track surface). Floor it so the
        // inside of any curve can always physically fit the track.
        if (type !== 'corner') radius = Math.max(radius, width / 2 + 4);

        if (type === 'corner' || radius <= 0) {
            smoothedPath.push(curr);
        } else {
            let d1x = prev.x - curr.x, d1y = prev.y - curr.y, len1 = Math.hypot(d1x, d1y);
            let d2x = next.x - curr.x, d2y = next.y - curr.y, len2 = Math.hypot(d2x, d2y);
            if (len1 < 1 || len2 < 1) { smoothedPath.push(curr); continue; }

            let n1x = d1x/len1, n1y = d1y/len1;
            let n2x = d2x/len2, n2y = d2y/len2;
            let dot = n1x*n2x + n1y*n2y;
            let angle = Math.acos(Math.max(-1, Math.min(1, dot)));
            
            let T = radius * Math.abs(Math.tan((Math.PI - angle) / 2));
            let maxT = Math.min(len1 / 2.1, len2 / 2.1);
            if (T > maxT || isNaN(T)) T = maxT;

            let Ax = curr.x + n1x*T, Ay = curr.y + n1y*T;
            let Bx = curr.x + n2x*T, By = curr.y + n2y*T;

            let steps = Math.max(3, Math.ceil(T / 15)); 
            for(let t = 0; t <= steps; t++) {
                let ratio = t/steps, mt = 1-ratio;
                smoothedPath.push({
                    x: mt*mt*Ax + 2*mt*ratio*curr.x + ratio*ratio*Bx,
                    y: mt*mt*Ay + 2*mt*ratio*curr.y + ratio*ratio*By
                });
            }
        }
    }

    let densePath = [];
    for(let i=0; i<smoothedPath.length; i++) {
        let p1 = smoothedPath[i], p2 = smoothedPath[(i+1)%smoothedPath.length];
        let dist = Math.hypot(p2.x-p1.x, p2.y-p1.y);
        let steps = Math.max(1, Math.ceil(dist / 40));
        for(let j=0; j<steps; j++) {
            densePath.push({ x: lerp(p1.x, p2.x, j/steps), y: lerp(p1.y, p2.y, j/steps) });
        }
    }

    const len = densePath.length; 
    for(let i=0; i<len; i++) {
        const curr = densePath[i], prev = densePath[(i - 1 + len) % len], next = densePath[(i + 1) % len];
        let dx1 = curr.x - prev.x, dy1 = curr.y - prev.y, d1 = Math.hypot(dx1, dy1); if(d1>0){ dx1/=d1; dy1/=d1; }
        let dx2 = next.x - curr.x, dy2 = next.y - curr.y, d2 = Math.hypot(dx2, dy2); if(d2>0){ dx2/=d2; dy2/=d2; }
        let tx = dx1 + dx2, ty = dy1 + dy2, tlen = Math.hypot(tx, ty);
        let nx, ny; if (tlen < 0.001) { nx = -dy1; ny = dx1; } else { tx /= tlen; ty /= tlen; nx = -ty; ny = tx; }

        let dot = (nx * (-dy1) + ny * dx1);
        // BEVEL-JOIN FALLBACK (fixes "bugged corners"): the raw miter formula
        // (width / dot) blows up on sharp turns — dot -> cos(turnAngle/2) -> 0 near
        // a hairpin — and the old floor of 0.1 let it spike to 10x the track width
        // on BOTH the outer and inner edge, so the inner offset polygon would shoot
        // past the opposite boundary and self-intersect (a visible pinch/crossing
        // right at the corner, and a false wall collision for cars driving through).
        // Raising the floor + tightening the final clamp keeps the join continuous
        // (same formula, just saturates earlier) while capping the spike hard.
        let baseMiterLen = width / Math.max(0.42, dot);
        // maxMiter only needs to stop a spike overshooting past a genuinely
        // sharp, isolated corner with short segments either side (e.g. a tight
        // hand-placed zig-zag) — curvatureRadius below is what actually keeps
        // a smooth filleted arc safe. A fillet's own subdivision packs points
        // as little as 10-15px apart, so the old 0.8x factor made maxMiter the
        // binding (and far too aggressive) constraint along nearly every
        // curve, crushing the track width well below its intended value even
        // on gentle bends.
        let maxMiter = Math.min(Math.hypot(curr.x-prev.x, curr.y-prev.y), Math.hypot(next.x-curr.x, next.y-curr.y)) * 3.0;
        // Hard safety net: an offset curve can never be inset further than its
        // own local radius of curvature without flipping inside-out (a dark
        // wedge cut into the road, and false wall collisions) — this happens
        // whenever a 'rounded' point's fillet radius, or the tangent-length it
        // gets squeezed to by nearby points, ends up tighter than the track's
        // own half-width. Bounding by the densePath's actual local curvature
        // (circumradius of prev/curr/next) catches that regardless of cause.
        const cSide1 = Math.hypot(curr.x-next.x, curr.y-next.y), cSide2 = Math.hypot(prev.x-next.x, prev.y-next.y), cSide3 = Math.hypot(prev.x-curr.x, prev.y-curr.y);
        const cArea2 = Math.abs((curr.x-prev.x)*(next.y-prev.y) - (next.x-prev.x)*(curr.y-prev.y));
        const curvatureRadius = cArea2 > 1e-6 ? (cSide1*cSide2*cSide3) / (2*cArea2) : Infinity;
        const outerMiterLen = Math.min(baseMiterLen, maxMiter, width * 1.2);
        const innerMiterLen = Math.min(outerMiterLen, curvatureRadius);
        const turnCross = dx1*dy2 - dy1*dx2;
        const leftMiterLen = turnCross >= 0 ? innerMiterLen : outerMiterLen;
        const rightMiterLen = turnCross >= 0 ? outerMiterLen : innerMiterLen;

        leftPoly.push({ x: curr.x + nx * leftMiterLen, y: curr.y + ny * leftMiterLen });
        rightPoly.push({ x: curr.x - nx * rightMiterLen, y: curr.y - ny * rightMiterLen });
    }

    for(let i=0; i < len; i++) {
        const i2 = (i+1)%len;
        const w1 = { p1: leftPoly[i], p2: leftPoly[i2], segmentIndex: i }; walls.push(w1);
        const w2 = { p1: rightPoly[i], p2: rightPoly[i2], segmentIndex: i }; walls.push(w2);
        checkpoints.push({ index: i, p1: leftPoly[i], p2: rightPoly[i], center: densePath[i] });
    }
    
    let finalStartAngle = 0;
    if (customStartAngle !== undefined && customStartAngle !== null) finalStartAngle = customStartAngle;
    else if (densePath.length > 1) finalStartAngle = Math.atan2(densePath[1].y - densePath[0].y, densePath[1].x - densePath[0].x);

    let finalStartPos = customStartPos || {x:Math.round(densePath[0].x), y:Math.round(densePath[0].y)};
    
    return { id, name, path: pathInput, trackWidth: width, walls, checkpoints, startPos: finalStartPos, startAngle: finalStartAngle, zones, leftPoly, rightPoly };
}

// --- LIGHTNING ZERO-ALLOCATION WEB WORKER ---
const workerScript = `
    const CAR_WIDTH = 14, CAR_HEIGHT = 7, SENSOR_LENGTH = 180;
    const SENSOR_ANGLES = [-Math.PI/2, -Math.PI/3, -Math.PI/6, 0, Math.PI/6, Math.PI/3, Math.PI/2];
    const SENS_LEN = SENSOR_ANGLES.length;

    let cachedTrack = null;
    let cachedConfig = null;
    let localCars = [];
    let wallsBySegment = [];

    // Pre-compute spatial wall lookup structure ONCE per track load.
    // Bucket walls by segmentIndex first (O(walls)) instead of rescanning the
    // full wall list with an O(n) .includes() check per segment (was O(segs^2)),
    // which matters a lot now that PNG-import/freehand tracks can have far more points.
    function initTrackPrecomp() {
        if (!cachedTrack) return;
        const tSegs = cachedTrack.checkpoints.length;
        const bucket = new Array(tSegs);
        for (let i = 0; i < tSegs; i++) bucket[i] = [];
        const undefWalls = [];
        for (const w of cachedTrack.walls) {
            if (w.segmentIndex === undefined) undefWalls.push(w);
            else bucket[w.segmentIndex].push(w);
        }
        wallsBySegment = new Array(tSegs);
        for (let i = 0; i < tSegs; i++) {
            const set = new Set(undefWalls);
            for (let j = -5; j <= 8; j++) {
                const seg = (i + j + tSegs * 10) % tSegs;
                for (const w of bucket[seg]) set.add(w);
            }
            wallsBySegment[i] = Array.from(set);
        }
    }

    // High performance inline intersection math (zero object allocations)
    function fastIntersect(Ax, Ay, Bx, By, Cx, Cy, Dx, Dy) {
        const bottom = (Dy - Cy) * (Bx - Ax) - (Dx - Cx) * (By - Ay);
        if (bottom === 0) return false;
        const t = ((Dx - Cx) * (Ay - Cy) - (Dy - Cy) * (Ax - Cx)) / bottom;
        if (t < 0 || t > 1) return false;
        const u = ((Cy - Ay) * (Ax - Bx) - (Cx - Ax) * (Ay - By)) / bottom;
        if (u < 0 || u > 1) return false;
        return true;
    }

    function fastIntersectDist(Ax, Ay, Bx, By, Cx, Cy, Dx, Dy) {
        const bottom = (Dy - Cy) * (Bx - Ax) - (Dx - Cx) * (By - Ay);
        if (bottom === 0) return 1.0;
        const t = ((Dx - Cx) * (Ay - Cy) - (Dy - Cy) * (Ax - Cx)) / bottom;
        if (t < 0 || t > 1) return 1.0;
        const u = ((Cy - Ay) * (Ax - Bx) - (Cx - Ax) * (Ay - By)) / bottom;
        if (u >= 0 && u <= 1) return t;
        return 1.0;
    }

    // Pre-allocated flat Float32Array mutation — weightsIH/weightsHO are flat
    // row-major typed arrays (row = source neuron, stride = dest layer size).
    // Flat typed arrays clone MUCH faster through postMessage than arrays-of-arrays
    // of boxed doubles, which is the dominant cost of shipping a generation to workers.
    function feedForwardCPU(c) {
        let b = c.brain, ins = c.sensorsInputs, hL = c.hL, oL = c.oL;
        const hLen = hL.length, oLen = oL.length, inLen = ins.length;
        const wIH = b.weightsIH, wHO = b.weightsHO, bH = b.biasH, bO = b.biasO;
        for (let i = 0; i < hLen; i++) {
            let sum = bH[i];
            for (let j = 0; j < inLen; j++) sum += ins[j] * wIH[j*hLen+i];
            hL[i] = Math.tanh(sum);
        }
        for (let i = 0; i < oLen; i++) {
            let sum = bO[i];
            for (let j = 0; j < hLen; j++) sum += hL[j] * wHO[j*oLen+i];
            oL[i] = Math.tanh(sum);
        }
    }

    function updateCar(c, config) {
        if (c.crashed) return;
        c.timeToLive--; c.framesAlive++;
        if (c.timeToLive <= 0) { c.crashed = true; return; }

        const steer = c.oL[0] || 0;
        const throttle = c.oL[1] || 0;

        const speedFactor = Math.min(c.speed / 4.0, 1.0); 
        c.angle += steer * config.turnSpeed * (0.2 + 0.8 * speedFactor); 

        const cosA = Math.cos(c.angle), sinA = Math.sin(c.angle);
        let vx = c.vx, vy = c.vy;

        if (throttle > 0) { vx += cosA * throttle * config.acceleration; vy += sinA * throttle * config.acceleration; } 
        else { vx *= 0.95; vy *= 0.95; }

        const latVel = vx * (-sinA) + vy * cosA;
        let grip = config.grip; if(Math.abs(latVel) > 2.5) grip *= 0.8;
        
        vx += (-sinA) * -latVel * grip; 
        vy += cosA * -latVel * grip;
        vx *= 0.99; vy *= 0.99;
        
        let speed = Math.sqrt(vx*vx + vy*vy);
        if(speed > config.maxSpeed) { const r = config.maxSpeed/speed; vx *= r; vy *= r; speed = config.maxSpeed; }

        c.vx = vx; c.vy = vy; c.speed = speed;
        const prevX = c.x, prevY = c.y;
        c.x += vx; c.y += vy;
        c.fitness += (speed / config.maxSpeed) * 0.1;

        if(c.x < -100 || c.x > 1300 || c.y < -100 || c.y > 1000) { c.crashed = true; return; }

        const curSeg = cachedTrack.checkpoints[c.nextCheckpointIndex] ? cachedTrack.checkpoints[c.nextCheckpointIndex].index : 0;
        const nearbyWalls = wallsBySegment[curSeg] || [];

        const hw = CAR_WIDTH/2, hh = CAR_HEIGHT/2;
        const cxs = [
            c.x + cosA*hw - sinA*hh, c.x + cosA*hw + sinA*hh,
            c.x - cosA*hw + sinA*hh, c.x - cosA*hw - sinA*hh
        ];
        const cys = [
            c.y + sinA*hw + cosA*hh, c.y + sinA*hw - cosA*hh,
            c.y - sinA*hw - cosA*hh, c.y - sinA*hw + cosA*hh
        ];

        for (let i = 0; i < nearbyWalls.length; i++) {
            let w = nearbyWalls[i];
            if (fastIntersect(prevX, prevY, c.x, c.y, w.p1.x, w.p1.y, w.p2.x, w.p2.y)) { c.crashed = true; c.fitness -= 50; return; }
            for(let j=0; j<4; j++) {
                let jn = (j+1)%4;
                if (fastIntersect(cxs[j], cys[j], cxs[jn], cys[jn], w.p1.x, w.p1.y, w.p2.x, w.p2.y)) { c.crashed = true; c.fitness -= 50; return; }
            }
        }

        let fitMult = 1.0;
        for (let i = 0; i < cachedTrack.zones.length; i++) {
            let z = cachedTrack.zones[i];
            let dx = c.x - z.x, dy = c.y - z.y;
            if (dx*dx + dy*dy < z.radius*z.radius) {
                if (z.type === 'speed' && c.speed > config.maxSpeed * 0.7) c.fitness += 2.0;
                else if (z.type === 'precision') c.fitness += 2.0;
                else if (z.type === 'focus') fitMult = 3.0;
                else if (z.type === 'spawnkill') {
                    const killTimer = (z.killTimer !== undefined ? z.killTimer : 150);
                    if (c.framesAlive >= killTimer) { c.crashed = true; return; }
                }
            }
        }

        const nCP = cachedTrack.checkpoints[c.nextCheckpointIndex];
        if (nCP) {
            let dx = c.x - nCP.center.x, dy = c.y - nCP.center.y;
            if (dx*dx + dy*dy > 160000) { c.crashed = true; return; } // off course

            const cx = (nCP.p1.x+nCP.p2.x)/2, cy = (nCP.p1.y+nCP.p2.y)/2;
            let cdx = c.x - cx, cdy = c.y - cy;
            
            if (cdx*cdx + cdy*cdy < 2500) { 
                 if (fastIntersect(prevX, prevY, c.x, c.y, nCP.p1.x, nCP.p1.y, nCP.p2.x, nCP.p2.y) || (cdx*cdx+cdy*cdy < 400)) { 
                    c.checkpointsReached++; c.nextCheckpointIndex = (c.nextCheckpointIndex + 1) % cachedTrack.checkpoints.length;
                    c.timeToLive += 150; if (c.timeToLive > 600) c.timeToLive = 600;
                    c.fitness += 500 * fitMult; 
                    if (c.nextCheckpointIndex === 0 && cachedTrack.checkpoints.length > 2) {
                        c.completedLaps++; 
                        c.lapTimes.push(c.framesAlive); 
                        c.lastLapTime = (c.lapTimes[c.lapTimes.length-1] - (c.lapTimes[c.lapTimes.length-2]||0)) / 60;
                        c.fitness += 3000 * fitMult; 
                    }
                 }
            }
        }

        for (let i = 0; i < SENS_LEN; i++) {
            let rA = c.angle + SENSOR_ANGLES[i];
            let ex = c.x + Math.cos(rA) * SENSOR_LENGTH, ey = c.y + Math.sin(rA) * SENSOR_LENGTH;
            let minT = 1.0;
            for (let j = 0; j < nearbyWalls.length; j++) {
                let w = nearbyWalls[j];
                let t = fastIntersectDist(c.x, c.y, ex, ey, w.p1.x, w.p1.y, w.p2.x, w.p2.y);
                if (t < minT) minT = t;
            }
            c.sensorsInputs[i] = 1.0 - minT;
            c.sensors[i] = 1.0 - minT; 
        }

        const tX = (nCP.p1.x + nCP.p2.x)/2, tY = (nCP.p1.y + nCP.p2.y)/2;
        let relAng = Math.atan2(tY - c.y, tX - c.x) - c.angle;
        while(relAng > Math.PI) relAng -= 2*Math.PI; while(relAng < -Math.PI) relAng += 2*Math.PI;
        
        c.sensorsInputs[SENS_LEN] = c.speed / config.maxSpeed;
        c.sensorsInputs[SENS_LEN + 1] = relAng / Math.PI;
        
        feedForwardCPU(c);
    }

    self.onmessage = function(e) {
        if(e.data.type === 'initTrack') { 
            cachedTrack = e.data.track; 
            cachedConfig = e.data.config; 
            initTrackPrecomp();
        }
        else if(e.data.type === 'initCars') { 
            localCars = e.data.cars; 
            for(let i=0; i<localCars.length; i++) {
                let c = localCars[i];
                c.hL = new Float32Array(c.brain.biasH.length);
                c.oL = new Float32Array(c.brain.biasO.length);
                c.sensorsInputs = new Float32Array(SENS_LEN + 2);
                c.sensors = new Float32Array(SENS_LEN);
            }
        }
        else if(e.data.type === 'run') {
            const iters = e.data.iters;
            let maxLaps = 0; let allCrashed = true;

            for(let i=0; i<iters; i++) {
                allCrashed = true;
                for(let c=0; c<localCars.length; c++) {
                    if(!localCars[c].crashed) {
                        updateCar(localCars[c], cachedConfig);
                        allCrashed = false;
                        if(localCars[c].completedLaps > maxLaps) maxLaps = localCars[c].completedLaps;
                    }
                }
                if(allCrashed || maxLaps >= cachedConfig.targetLaps) break;
            }

            const stride = 11 + SENS_LEN;
            const buffer = new Float32Array(localCars.length * stride);
            
            for(let i=0; i<localCars.length; i++) {
                let c = localCars[i];
                let idx = i * stride;
                buffer[idx] = c.id;
                buffer[idx+1] = c.crashed ? 1 : 0;
                buffer[idx+2] = c.x;
                buffer[idx+3] = c.y;
                buffer[idx+4] = c.angle;
                buffer[idx+5] = c.speed;
                buffer[idx+6] = c.oL[0] || 0;
                buffer[idx+7] = c.oL[1] || 0;
                buffer[idx+8] = c.completedLaps;
                buffer[idx+9] = c.fitness;
                buffer[idx+10] = c.lastLapTime || 0;
                for(let j=0; j<SENS_LEN; j++) buffer[idx+11+j] = c.sensors[j];
            }
            self.postMessage({ type: 'done', buffer, allCrashed, maxLaps }, [buffer.buffer]);
        }
    };
`;

const Engine = {
    workers: [], coreCount: 1, _runState: null,

    init: function() {
        this.coreCount = navigator.hardwareConcurrency || 4;
        // ui cache isn't ready yet at Engine.init time, so store for later and
        // set it again after _initUICache in app.init via a small defer
        this._pendingCoreLabel = `<i data-lucide="cpu" class="w-3 h-3"></i> ${this.coreCount} Cores Active`;

        const blob = new Blob([workerScript], {type: 'application/javascript'});
        const url = URL.createObjectURL(blob);
        for(let i=0; i<this.coreCount; i++) {
            const w = new Worker(url);
            w.onerror = (err) => console.error("Worker Thread Error:", err.message);
            // Bound once per worker for the app's lifetime — avoids reassigning
            // w.onmessage (a fresh closure + destructure) every animation frame.
            w.onmessage = (e) => this.handleWorkerMessage(e.data);
            this.workers.push(w);
        }
    },

    updateWorkerTrack: function(track, config) {
        const strippedWalls = track.walls.map(w => ({p1:{x:w.p1.x, y:w.p1.y}, p2:{x:w.p2.x, y:w.p2.y}, segmentIndex: w.segmentIndex}));
        const strippedCPs = track.checkpoints.map(c => ({index:c.index, p1:{x:c.p1.x, y:c.p1.y}, p2:{x:c.p2.x, y:c.p2.y}, center:{x:c.center.x, y:c.center.y}}));
        const payload = { type: 'initTrack', track: { walls: strippedWalls, checkpoints: strippedCPs, zones: track.zones }, config };
        this.workers.forEach(w => w.postMessage(payload));
    },
    
    updateWorkerCars: function(cars) {
        const chunkSize = Math.ceil(cars.length / this.workers.length);
        this.workers.forEach((w, i) => w.postMessage({ type: 'initCars', cars: cars.slice(i*chunkSize, (i+1)*chunkSize) }));
    },

    // Brains are stored internally as flat row-major Float32Arrays (fast to
    // mutate/copy and MUCH cheaper to structured-clone through postMessage than
    // arrays-of-arrays of boxed doubles). iC/hC/oC ride along for JSON export.
    createBrain: function(iC, hC, oC) {
        const wIH = new Float32Array(iC * hC); for(let i=0; i<wIH.length; i++) wIH[i] = Math.random()*2-1;
        const wHO = new Float32Array(hC * oC); for(let i=0; i<wHO.length; i++) wHO[i] = Math.random()*2-1;
        const bH = new Float32Array(hC); for(let i=0; i<hC; i++) bH[i] = Math.random()*2-1;
        const bO = new Float32Array(oC); for(let i=0; i<oC; i++) bO[i] = Math.random()*2-1;
        return { iC, hC, oC, weightsIH: wIH, weightsHO: wHO, biasH: bH, biasO: bO };
    },
    copyBrain: function(b) {
        return { iC: b.iC, hC: b.hC, oC: b.oC, weightsIH: b.weightsIH.slice(), weightsHO: b.weightsHO.slice(), biasH: b.biasH.slice(), biasO: b.biasO.slice() };
    },
    mutateBrain: function(b, r) {
        const mutArr = arr => { for(let i=0; i<arr.length; i++) if(Math.random() < r) arr[i] += (Math.random()*2-1)*0.5; };
        mutArr(b.weightsIH); mutArr(b.weightsHO); mutArr(b.biasH); mutArr(b.biasO);
    },
    // Nested-array JSON shape — identical to the original on-disk format, so
    // previously-saved AI files keep loading fine.
    brainToJSON: function(b) {
        const rows = (flat, r, c) => { const out = new Array(r); for(let i=0; i<r; i++) { const row = new Array(c); for(let j=0; j<c; j++) row[j] = flat[i*c+j]; out[i] = row; } return out; };
        return { weightsIH: rows(b.weightsIH, b.iC, b.hC), weightsHO: rows(b.weightsHO, b.hC, b.oC), biasH: Array.from(b.biasH), biasO: Array.from(b.biasO) };
    },
    brainFromJSON: function(j) {
        const iC = j.weightsIH.length, hC = j.biasH.length, oC = j.biasO.length;
        const wIH = new Float32Array(iC*hC); for(let i=0; i<iC; i++) for(let k=0; k<hC; k++) wIH[i*hC+k] = j.weightsIH[i][k];
        const wHO = new Float32Array(hC*oC); for(let i=0; i<hC; i++) for(let k=0; k<oC; k++) wHO[i*oC+k] = j.weightsHO[i][k];
        return { iC, hC, oC, weightsIH: wIH, weightsHO: wHO, biasH: Float32Array.from(j.biasH), biasO: Float32Array.from(j.biasO) };
    },

    runCPUWorkers: function(iters) {
        return new Promise(resolve => {
            this._runState = { completed: 0, totalMaxLaps: 0, total: this.workers.length, resolve };
            for(let i=0; i<this.workers.length; i++) this.workers[i].postMessage({ type: 'run', iters });
        });
    },

    // Set once as each worker's onmessage (see init) — reads/writes the shared
    // per-call _runState instead of a handler recreated every frame.
    handleWorkerMessage: function(data) {
        const st = this._runState;
        if(!st) return;
        const { buffer, maxLaps } = data;
        if(maxLaps > st.totalMaxLaps) st.totalMaxLaps = maxLaps;
        const stride = 11 + SENSOR_COUNT;

        for(let i=0; i<buffer.length/stride; i++) {
            let idx = i * stride;
            const id = buffer[idx];
            const c = app.state.cars[id];
            if(!c) continue;

            c.crashed = buffer[idx+1] === 1;
            c.x = buffer[idx+2];
            c.y = buffer[idx+3];
            c.angle = buffer[idx+4];
            c.speed = buffer[idx+5];
            c.inputs[0] = buffer[idx+6];
            c.inputs[1] = buffer[idx+7];

            const prevLaps = c.completedLaps;
            c.completedLaps = buffer[idx+8];
            c.fitness = buffer[idx+9];

            for(let j=0; j<SENSOR_COUNT; j++) c.sensors[j] = buffer[idx+11+j];

            if(c.completedLaps > prevLaps) {
                c.isLapFinished = true;
                const time = buffer[idx+10];
                if(!app.state.bestTimes.gen || time < app.state.bestTimes.gen) app.state.bestTimes.gen = time;
                if(!app.state.bestTimes.all || time < app.state.bestTimes.all) app.state.bestTimes.all = time;
                // Track lap history for mobile display (keep last 20)
                app.state.lapHistory.push(time);
                if(app.state.lapHistory.length > 20) app.state.lapHistory.shift();
                app.updateLapHistory();
            }
        }

        st.completed++;
        if(st.completed === st.total) {
            const globalCrashed = app.state.cars.every(c => c.crashed);
            st.resolve({ triggerEvolve: globalCrashed || st.totalMaxLaps >= app.state.targetLaps });
        }
    }
};

// --- localStorage persistence (custom tracks + settings) ---
// Every call is try/caught: localStorage can throw (private browsing, quota,
// disabled storage) and none of this should ever be able to crash the sim.
const Persist = {
    SETTINGS_KEY: 'trackml_settings_v1',
    TRACKS_KEY: 'trackml_custom_tracks_v1',

    saveSettings: function(state) {
        try {
            const { populationSize, eliteClones, mutationRate, hiddenLayers, initialTTL, targetLaps, speedMultiplier, physics } = state;
            localStorage.setItem(this.SETTINGS_KEY, JSON.stringify({ populationSize, eliteClones, mutationRate, hiddenLayers, initialTTL, targetLaps, speedMultiplier, physics }));
        } catch (e) { /* ignore — storage unavailable */ }
    },
    loadSettings: function() {
        try {
            const raw = localStorage.getItem(this.SETTINGS_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    },

    // Stores only the raw track definition (id/name/path/width/start/zones) —
    // full geometry (walls, checkpoints, polys) is always rebuilt fresh via
    // generateTrackFromPath, same as the built-in tracks.
    saveCustomTracks: function(tracks, builtInIds) {
        try {
            const custom = tracks.filter(t => !builtInIds.has(t.id)).map(t => ({
                id: t.id, name: t.name, path: t.path, trackWidth: t.trackWidth,
                startPos: t.startPos, startAngle: t.startAngle, zones: t.zones || []
            }));
            localStorage.setItem(this.TRACKS_KEY, JSON.stringify(custom));
        } catch (e) { /* ignore */ }
    },
    loadCustomTracks: function() {
        try {
            const raw = localStorage.getItem(this.TRACKS_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (e) { return []; }
    }
};

// --- Main Application ---
const app = {
    state: {
        populationSize: 200, eliteClones: 10, targetLaps: 3, mutationRate: 0.15, hiddenLayers: 5, initialTTL: 750,
        physics: { maxSpeed: 10, acceleration: 0.05, turnSpeed: 0.04, grip: 0.93 },
        tracks: [], currentTrackIndex: 1, cars: [], generation: 1, isRunning: false, speedMultiplier: 1, hyperMode: false,
        stats: [], globalBest: null, bestTimes: { gen: null, all: null }, isEditing: false, trackToEdit: null,
        bgCanvas: null, lapHistory: [], spectateCarId: null
    },

    _initUICache: function() {
        const $ = id => document.getElementById(id);
        ui.statGen     = $('stat-generation');
        ui.statAlive   = $('stat-alive');
        ui.statGenMain  = $('stat-generation-main');
        ui.statAliveMain = $('stat-alive-main');
        ui.statAllBest  = $('stat-all-best');
        ui.statAllBestM = $('stat-all-best-m');
        ui.lapHistoryM  = $('lap-history-m');
        ui.telSteerL    = $('tel-steer-l');
        ui.telSteerR    = $('tel-steer-r');
        ui.telGas       = $('tel-gas');
        ui.telBrake     = $('tel-brake');
        ui.telSpeed     = $('tel-speed');
        ui.telSpeedVal  = $('tel-speed-val');
        ui.telemetryLabel = $('telemetry-label');
        ui.btnRelease   = $('btn-release-spectate');
        ui.canvas       = $('sim-canvas');
        ui.ctx          = ui.canvas.getContext('2d');
        ui.btnPlay      = $('btn-play');
        ui.btnHyper     = $('btn-hyper');
        ui.btnPlayM     = $('btn-play-m');
        ui.btnHyperM    = $('btn-hyper-m');
        ui.hyperBanner  = $('hyper-banner');
        ui.coreCount    = $('core-count');
        // Apply the pending Engine core label now that the element is cached
        if(ui.coreCount && Engine._pendingCoreLabel) ui.coreCount.innerHTML = Engine._pendingCoreLabel;
        // Click/tap a car to spectate it (independent of the editor's own
        // pointer handlers, which only attach while editing).
        ui.canvas.addEventListener('pointerdown', e => this.handleCanvasClick(e));
    },

    // Resolves which car telemetry/highlight follows: a manually-clicked car
    // (until it crashes or the user releases it), otherwise the fastest alive.
    getSpectatedCar: function() {
        const id = this.state.spectateCarId;
        if (id !== null) {
            const car = this.state.cars[id];
            if (car && !car.crashed) return car;
            this.state.spectateCarId = null; // selection crashed/gone — auto-revert
        }
        if (!this.state.cars.length) return null;
        return this.state.cars.reduce((p,c) => (c.fitness > p.fitness && !c.crashed ? c : p), this.state.cars[0]);
    },

    releaseSpectate: function() { this.state.spectateCarId = null; },

    handleCanvasClick: function(e) {
        if (this.state.isEditing || this.state.hyperMode || !this.state.cars.length) return;
        const rect = ui.canvas.getBoundingClientRect();
        const scale = Math.min(rect.width / CANVAS_WIDTH, rect.height / CANVAS_HEIGHT);
        const offsetX = (rect.width - CANVAS_WIDTH*scale) / 2, offsetY = (rect.height - CANVAS_HEIGHT*scale) / 2;
        const x = (e.clientX - rect.left - offsetX) / scale, y = (e.clientY - rect.top - offsetY) / scale;

        let closest = null, closestDist = 22; // hit radius, canvas units
        for (const c of this.state.cars) {
            if (c.crashed) continue;
            const d = Math.hypot(c.x - x, c.y - y);
            if (d < closestDist) { closestDist = d; closest = c; }
        }
        this.state.spectateCarId = closest ? closest.id : null;
    },

    init: function() {
        try {
            Engine.init();
            this.loadSettingsFromStorage();
            this.resetTracks();
            this.initChart();
            this._initUICache();
            if(window.lucide) lucide.createIcons();
            this.loop();
        } catch (e) { console.error("Init Error:", e); location.reload(); }
    },

    resetTracks: function() {
        // Load tracks from the external tracks.js file
        this.state.tracks = getDefaultTracks(generateTrackFromPath, CANVAS_WIDTH, CANVAS_HEIGHT);
        this._builtInTrackIds = new Set(this.state.tracks.map(t => t.id));

        // Re-add any custom/imported/community tracks saved locally in a
        // previous session — rebuilt fresh from their raw definition.
        const saved = Persist.loadCustomTracks();
        for (const raw of saved) {
            try {
                const t = generateTrackFromPath(raw.id, raw.name, raw.path, raw.trackWidth, raw.startPos, raw.startAngle, raw.zones);
                if (!this._builtInTrackIds.has(t.id) && !this.state.tracks.some(existing => existing.id === t.id)) this.state.tracks.push(t);
            } catch (e) { console.warn('Skipped a corrupt saved track:', e); }
        }

        this.renderTrackList();
        this.switchTrack(0);
    },

    get currentTrack() { return this.state.tracks[this.state.currentTrackIndex]; },

    initPopulation: function(loadedBrain) {
        if(!this.state.tracks.length) return;
        const track = this.currentTrack; this.state.globalBest = null; const newCars = [];

        for(let i=0; i<this.state.populationSize; i++) {
            let brain;
            if(loadedBrain) { brain = Engine.copyBrain(loadedBrain); if(i>0) Engine.mutateBrain(brain, this.state.mutationRate); } 
            else { brain = Engine.createBrain(SENSOR_COUNT+2, this.state.hiddenLayers, 2); }
            newCars.push({
                id: i, x: track.startPos.x, y: track.startPos.y, angle: track.startAngle, vx: 0, vy: 0, speed: 0,
                color: `hsl(${Math.random()*360},80%,60%)`, brain, fitness: 0, crashed: false, sensors: new Float32Array(SENSOR_COUNT), inputs: new Float32Array(2),
                timeToLive: this.state.initialTTL, nextCheckpointIndex: 1, framesAlive: 0, lapTimes: [], completedLaps: 0, checkpointsReached: 0, isLapFinished: false
            });
        }
        this.state.cars = newCars; this.state.bestTimes.gen = null; 
        
        Engine.updateWorkerCars(this.state.cars);
        this.updateUI();
    },

    evolve: function() {
        if(this.state.cars.length === 0) return;
        const sorted = [...this.state.cars].sort((a,b) => b.fitness - a.fitness);
        const best = sorted[0];
        
        if(!this.state.globalBest || best.fitness > this.state.globalBest.fitness) this.state.globalBest = { brain: Engine.copyBrain(best.brain), fitness: best.fitness };

        const avgFit = this.state.cars.reduce((a,c)=>a+c.fitness,0)/this.state.cars.length;
        this.state.stats.push({ gen: this.state.generation, best: best.fitness, avg: avgFit, time: this.state.bestTimes.gen ? this.state.bestTimes.gen.toFixed(2) : null }); 
        this.updateChart();

        const newCars = []; const track = this.currentTrack;
        if(this.state.globalBest) {
            for(let k=0; k<Math.min(this.state.eliteClones, this.state.populationSize); k++) {
                newCars.push({
                    id: k, x: track.startPos.x, y: track.startPos.y, angle: track.startAngle, vx: 0, vy: 0, speed: 0, color: k===0?'#22c55e':'#84cc16',
                    brain: Engine.copyBrain(this.state.globalBest.brain), fitness: 0, crashed: false, sensors: new Float32Array(SENSOR_COUNT), inputs: new Float32Array(2),
                    timeToLive: this.state.initialTTL, nextCheckpointIndex: 1, framesAlive: 0, lapTimes: [], completedLaps: 0, checkpointsReached: 0, isLapFinished: false
                });
            }
        }

        const parentPoolSize = Math.max(2, Math.floor(sorted.length * 0.2)); 
        for(let i=newCars.length; i<this.state.populationSize; i++) {
            const p1 = sorted[Math.floor(Math.random() * parentPoolSize)]; 
            const p2 = sorted[Math.floor(Math.random() * parentPoolSize)];
            
            const childBrain = Engine.createBrain(SENSOR_COUNT+2, this.state.hiddenLayers, 2);
            for(let k=0; k<childBrain.weightsIH.length; k++) childBrain.weightsIH[k] = Math.random() < 0.5 ? p1.brain.weightsIH[k] : p2.brain.weightsIH[k];
            for(let k=0; k<childBrain.weightsHO.length; k++) childBrain.weightsHO[k] = Math.random() < 0.5 ? p1.brain.weightsHO[k] : p2.brain.weightsHO[k];
            for(let k=0; k<childBrain.biasH.length; k++) childBrain.biasH[k] = Math.random() < 0.5 ? p1.brain.biasH[k] : p2.brain.biasH[k];
            for(let k=0; k<childBrain.biasO.length; k++) childBrain.biasO[k] = Math.random() < 0.5 ? p1.brain.biasO[k] : p2.brain.biasO[k];

            Engine.mutateBrain(childBrain, this.state.mutationRate);
            newCars.push({
                id: i, x: track.startPos.x, y: track.startPos.y, angle: track.startAngle, vx: 0, vy: 0, speed: 0, color: `hsl(${Math.random()*360},80%,60%)`,
                brain: childBrain, fitness: 0, crashed: false, sensors: new Float32Array(SENSOR_COUNT), inputs: new Float32Array(2),
                timeToLive: this.state.initialTTL, nextCheckpointIndex: 1, framesAlive: 0, lapTimes: [], completedLaps: 0, checkpointsReached: 0, isLapFinished: false
            });
        }
        this.state.cars = newCars; this.state.generation++; this.state.bestTimes.gen = null; 
        
        Engine.updateWorkerCars(this.state.cars);
        this.updateUI();
    },

    loop: async function() {
        if(this.state.isRunning && !this.state.isEditing) {
            const iters = this.state.hyperMode ? 500 : this.state.speedMultiplier;
            const result = await Engine.runCPUWorkers(iters);
            if(result.triggerEvolve) this.evolve();
        }
        
        this.updateUI(); 
        this.draw(); 
        requestAnimationFrame(this.loop.bind(this));
    },

    cacheBackgroundRender: function() {
        this.state.bgCanvas = document.createElement('canvas');
        this.state.bgCanvas.width = CANVAS_WIDTH;
        this.state.bgCanvas.height = CANVAS_HEIGHT;
        const ctx = this.state.bgCanvas.getContext('2d');
        const t = this.currentTrack;

        ctx.fillStyle = '#3a5a40'; ctx.fillRect(0,0,CANVAS_WIDTH,CANVAS_HEIGHT);
        if(!t) return;

        if (t.leftPoly && t.rightPoly) {
             ctx.fillStyle = '#343a40';
             for(let i=0; i<t.leftPoly.length; i++) {
                 const n = (i+1)%t.leftPoly.length; ctx.beginPath(); ctx.moveTo(t.leftPoly[i].x, t.leftPoly[i].y); ctx.lineTo(t.leftPoly[n].x, t.leftPoly[n].y);
                 ctx.lineTo(t.rightPoly[n].x, t.rightPoly[n].y); ctx.lineTo(t.rightPoly[i].x, t.rightPoly[i].y); ctx.fill();
             }
        }
        
        // Zones are intentionally NOT rendered in normal view — only visible in the editor

        ctx.lineCap = 'round';
        ctx.strokeStyle='#e2e8f0'; ctx.lineWidth=4; ctx.beginPath(); t.walls.forEach(w => { ctx.moveTo(w.p1.x, w.p1.y); ctx.lineTo(w.p2.x, w.p2.y); }); ctx.stroke();
        ctx.strokeStyle='#ef4444'; ctx.lineWidth=4; ctx.setLineDash([15,15]); ctx.beginPath(); t.walls.forEach(w => { ctx.moveTo(w.p1.x, w.p1.y); ctx.lineTo(w.p2.x, w.p2.y); }); ctx.stroke(); ctx.setLineDash([]);

        if(t.checkpoints.length > 0) { const cp = t.checkpoints[0]; ctx.strokeStyle='#ffffff'; ctx.lineWidth=6; ctx.beginPath(); ctx.moveTo(cp.p1.x, cp.p1.y); ctx.lineTo(cp.p2.x, cp.p2.y); ctx.stroke(); ctx.setLineDash([6,6]); ctx.strokeStyle='#000'; ctx.stroke(); ctx.setLineDash([]); }
    },

    draw: function() {
        const ctx = ui.ctx; // cached — no getElementById every frame
        
        if(this.state.isEditing && this.state.trackToEdit) { 
            ctx.fillStyle = '#3a5a40'; ctx.fillRect(0,0,CANVAS_WIDTH,CANVAS_HEIGHT);
            editor.draw(ctx); 
            return; 
        }

        if(this.state.bgCanvas) ctx.drawImage(this.state.bgCanvas, 0, 0);

        if(!this.state.hyperMode) {
            // Render ALL cars persistently, no color flashing, no hiding.
            // Telemetry/highlight follows a manually-clicked car, or else
            // auto-follows the fastest alive car.
            const spectated = this.getSpectatedCar();
            const isManual = this.state.spectateCarId !== null;

            if(ui.telemetryLabel) {
                ui.telemetryLabel.textContent = spectated
                    ? (isManual ? `Spectating Car #${spectated.id} (Manual)` : 'Live Telemetry (Auto — Fastest)')
                    : 'Live Telemetry';
            }
            if(ui.btnRelease) ui.btnRelease.classList.toggle('hidden', !isManual);

            if(spectated && !spectated.crashed) {
                const i = spectated.inputs || [0,0];
                ui.telSteerL.style.width = i[0] < 0 ? Math.abs(i[0])*50 + '%' : '0%';
                ui.telSteerR.style.width = i[0] > 0 ? i[0]*50 + '%' : '0%';
                if(i[1] > 0) { ui.telGas.style.width = i[1]*100 + '%'; ui.telBrake.style.width = '0%'; }
                else { ui.telGas.style.width = '0%'; ui.telBrake.style.width = Math.abs(i[1])*100 + '%'; }
                ui.telSpeed.style.width = Math.min((spectated.speed / this.state.physics.maxSpeed)*100, 100) + '%';
                ui.telSpeedVal.textContent = Math.round(spectated.speed);
            }

            this.state.cars.forEach(c => {
                if(c.crashed) return;
                ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.angle); ctx.scale(1.5,1.5);
                ctx.globalAlpha = 1.0;
                ctx.fillStyle = c.color;
                ctx.fillRect(-7, -4, 14, 8);
                ctx.fillStyle='#0f172a'; ctx.fillRect(-2, -3, 4, 6);
                ctx.fillStyle='#fbbf24'; ctx.fillRect(6, -3, 1, 2); ctx.fillRect(6, 1, 1, 2);
                ctx.restore();

                if(c === spectated) {
                    // Highlight ring around the spectated car — solid cyan when
                    // manually picked, a subtle dashed ring when auto-following.
                    ctx.save();
                    ctx.strokeStyle = isManual ? '#22d3ee' : 'rgba(255,255,255,0.55)';
                    ctx.lineWidth = isManual ? 2.5 : 1.5;
                    if(!isManual) ctx.setLineDash([4,3]);
                    ctx.beginPath(); ctx.arc(c.x, c.y, 16, 0, Math.PI*2); ctx.stroke();
                    ctx.restore();

                    if(c.sensors) {
                        c.sensors.forEach((s,k) => {
                            const ang = c.angle + SENSOR_ANGLES[k];
                            ctx.strokeStyle='rgba(234,179,8,0.3)'; ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x+Math.cos(ang)*SENSOR_LENGTH, c.y+Math.sin(ang)*SENSOR_LENGTH); ctx.stroke();
                            if(s>0) { const d=(1-s)*SENSOR_LENGTH; ctx.fillStyle='#f59e0b'; ctx.beginPath(); ctx.arc(c.x+Math.cos(ang)*d, c.y+Math.sin(ang)*d, 2, 0, Math.PI*2); ctx.fill(); }
                        });
                    }
                }
            });
        }
    },

    toggleRun: function() { 
        this.state.isRunning = !this.state.isRunning; 
        const running = this.state.isRunning;
        const icon = running ? SVG_PAUSE : SVG_PLAY;
        const txt = running ? 'Pause' : 'Start';
        const clsBase = "rounded-lg font-bold flex items-center justify-center gap-1.5 transition-all border text-sm ";
        const clsOn  = clsBase + "px-3 py-2 bg-red-500/20 text-red-400 border-red-500/50 hover:bg-red-500/30";
        const clsOff = clsBase + "px-3 py-2 bg-emerald-500/20 text-emerald-400 border-emerald-500/50 hover:bg-emerald-500/30";
        // Desktop sidebar button
        if(ui.btnPlay) { 
            ui.btnPlay.innerHTML = `${icon} <span>${txt}</span>`; 
            ui.btnPlay.className = (running ? clsOn : clsOff) + " flex-1 py-2";
        }
        // Mobile control-bar button
        if(ui.btnPlayM) { 
            ui.btnPlayM.innerHTML = `${icon} <span>${txt}</span>`; 
            ui.btnPlayM.className = running ? clsOn : clsOff;
        }
        // No lucide.createIcons() — inline SVGs don't need it
    },
    toggleHyper: function() { 
        this.state.hyperMode = !this.state.hyperMode; 
        const active = this.state.hyperMode;
        [ui.btnHyper, ui.btnHyperM].forEach(btn => {
            if(!btn) return;
            btn.classList.toggle('bg-yellow-500', active); 
            btn.classList.toggle('text-slate-900', active); 
            btn.classList.toggle('bg-slate-700', !active);
            btn.classList.toggle('text-slate-400', !active);
            btn.classList.toggle('border-yellow-500', active);
            btn.classList.toggle('border-slate-600', !active);
        });
        if(ui.hyperBanner) ui.hyperBanner.classList.toggle('hidden', !active);
    },

    reset: function() {
        this.state.isRunning=false; this.state.generation=1; this.state.stats=[];
        this.state.bestTimes={gen:null,all:null}; this.state.lapHistory=[]; this.state.spectateCarId=null;
        _ui_gen=-1; _ui_alive=-1; _ui_allBest=null;
        if(ui.lapHistoryM) ui.lapHistoryM.innerHTML = '<span class="text-[10px] text-slate-600 italic">No laps yet</span>';
        this.initPopulation(); 
        if(this.chart) { this.chart.data.labels = []; this.chart.data.datasets.forEach(d => d.data = []); this.chart.update(); }
        this.updateUI(); this.toggleRun(); this.toggleRun(); 
    },
    
    updatePhysics: function(k, v) { this.state.physics[k] = parseFloat(v); document.getElementById('val-'+(k==='maxSpeed'?'maxSpeed':(k==='acceleration'?'accel':(k==='turnSpeed'?'turn':'grip')))).innerText = k==='grip'?Math.round(v*100)+'%':v; Engine.updateWorkerTrack(this.currentTrack, this.state.physics); this.queueSaveSettings(); },
    updateConfig: function(k, v) {
        this.state[k] = parseFloat(v);
        let id = 'val-'+(k==='populationSize'?'pop':k==='targetLaps'?'laps':k==='speedMultiplier'?'speed':k==='eliteClones'?'elite':k==='mutationRate'?'mut':k==='hiddenLayers'?'hidden':'ttl');
        let d = v; if(k==='speedMultiplier') d+='x'; if(k==='mutationRate') d=Math.round(v*100)+'%';
        const el = document.getElementById(id); if(el) el.innerText = d;
        this.queueSaveSettings();
    },

    _saveSettingsTimer: null,
    queueSaveSettings: function() {
        clearTimeout(this._saveSettingsTimer);
        this._saveSettingsTimer = setTimeout(() => Persist.saveSettings(this.state), 400);
    },

    // Restores sliders left the way the user had them last session.
    loadSettingsFromStorage: function() {
        const s = Persist.loadSettings();
        if (!s) return;
        ['populationSize','eliteClones','mutationRate','hiddenLayers','initialTTL','targetLaps','speedMultiplier'].forEach(k => {
            if (typeof s[k] === 'number' && isFinite(s[k])) this.state[k] = s[k];
        });
        if (s.physics) {
            ['maxSpeed','acceleration','turnSpeed','grip'].forEach(k => {
                if (typeof s.physics[k] === 'number' && isFinite(s.physics[k])) this.state.physics[k] = s.physics[k];
            });
        }
        this.syncSettingsUI();
    },
    syncSettingsUI: function() {
        const st = this.state;
        const apply = (inputId, val, labelId, fmt) => {
            const inp = document.getElementById(inputId); if (inp) inp.value = val;
            const lbl = document.getElementById(labelId); if (lbl) lbl.innerText = fmt ? fmt(val) : val;
        };
        apply('cfg-speedMultiplier', st.speedMultiplier, 'val-speed', v => v+'x');
        apply('cfg-populationSize', st.populationSize, 'val-pop');
        apply('cfg-eliteClones', st.eliteClones, 'val-elite');
        apply('cfg-mutationRate', st.mutationRate, 'val-mut', v => Math.round(v*100)+'%');
        apply('cfg-hiddenLayers', st.hiddenLayers, 'val-hidden');
        apply('cfg-initialTTL', st.initialTTL, 'val-ttl');
        apply('cfg-targetLaps', st.targetLaps, 'val-laps');
        apply('cfg-maxSpeed', st.physics.maxSpeed, 'val-maxSpeed');
        apply('cfg-acceleration', st.physics.acceleration, 'val-accel');
        apply('cfg-turnSpeed', st.physics.turnSpeed, 'val-turn');
        apply('cfg-grip', st.physics.grip, 'val-grip', v => Math.round(v*100)+'%');
    },

    showInfo: function(k) {
        const el = document.getElementById('setting-info'); if(!el) return;
        if(k && SETTING_DESCRIPTIONS[k]) { el.innerHTML = `<span class="text-emerald-400 font-bold block mb-1 uppercase">${k.replace(/([A-Z])/g, ' $1').trim()}</span>${SETTING_DESCRIPTIONS[k]}`; el.className = "text-[10px] text-slate-300 min-h-[50px] border-t border-slate-600 pt-2 mt-2 transition-colors"; } 
        else { el.innerText = "Hover over a setting to see how it affects the AI and simulation."; el.className = "text-[10px] text-slate-500 italic min-h-[50px] border-t border-slate-600 pt-2 mt-2 transition-colors"; }
    },

    updateUI: function() {
        const gen = this.state.generation;
        const alive = this.state.cars.filter(c=>!c.crashed).length;
        
        // Only write to DOM if value changed (dirty check — huge win on ARM)
        if(_ui_gen !== gen) {
            if(ui.statGen) ui.statGen.textContent = gen;
            if(ui.statGenMain) ui.statGenMain.textContent = gen;
            _ui_gen = gen;
        }
        if(_ui_alive !== alive) {
            if(ui.statAlive) ui.statAlive.textContent = alive;
            if(ui.statAliveMain) ui.statAliveMain.textContent = alive;
            _ui_alive = alive;
        }

        const allBestStr = this.state.bestTimes.all ? this.state.bestTimes.all.toFixed(2)+'s' : '--';
        if(_ui_allBest !== allBestStr) {
            if(ui.statAllBest) ui.statAllBest.textContent = allBestStr;
            if(ui.statAllBestM) ui.statAllBestM.textContent = allBestStr;
            _ui_allBest = allBestStr;
        }
        // No lucide.createIcons() here — that was being called EVERY frame and is
        // the #1 performance killer on ARM. Buttons now use inline SVGs instead.
    },

    updateLapHistory: function() {
        if(!ui.lapHistoryM) return;
        const hist = this.state.lapHistory;
        if(!hist.length) return;
        ui.lapHistoryM.innerHTML = hist.slice(-7).reverse().map((l,i) =>
            `<span class="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded ${i===0?'bg-emerald-500/20 text-emerald-400':'bg-slate-700/60 text-slate-400'}">${l.toFixed(2)}s</span>`
        ).join('');
    },

    saveBrain: function() { if(!this.state.cars.length) return; const b = this.state.cars.reduce((p,c) => c.fitness>p.fitness?c:p); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(Engine.brainToJSON(b.brain))], {type:'application/json'})); a.download = `trackml-g${this.state.generation}.json`; a.click(); },
    loadBrain: function(inp) { if(!inp.files[0]) return; const r = new FileReader(); r.onload = e => { try { const brain = Engine.brainFromJSON(JSON.parse(e.target.result)); this.reset(); this.initPopulation(brain); } catch(er) { alert('Invalid File'); } }; r.readAsText(inp.files[0]); },

    renderTrackList: function() {
        const sel = document.getElementById('track-dropdown'); sel.innerHTML = '';
        this.state.tracks.forEach((t, i) => { const opt = document.createElement('option'); opt.value = i; opt.text = t.name; opt.selected = this.state.currentTrackIndex === i; sel.appendChild(opt); });
        const search = document.getElementById('track-search');
        if (search && search.value) this.filterTrackList(search.value);
    },
    filterTrackList: function(query) {
        const sel = document.getElementById('track-dropdown'); if (!sel) return;
        const q = query.trim().toLowerCase();
        let visibleCount = 0, firstVisible = -1;
        for (const opt of sel.options) {
            const match = !q || opt.text.toLowerCase().includes(q);
            opt.style.display = match ? '' : 'none';
            if (match) { visibleCount++; if (firstVisible === -1) firstVisible = parseInt(opt.value); }
        }
        // if the currently-selected track got filtered out, jump to the first visible match
        if (visibleCount > 0 && sel.selectedOptions.length && sel.selectedOptions[0].style.display === 'none') {
            sel.value = firstVisible;
        }
    },
    
    switchTrack: function(i) {
        i = parseInt(i); if (i < 0 || i >= this.state.tracks.length) i = 0;
        this.state.currentTrackIndex = i; this.state.isRunning = false; this.state.generation = 1; this.state.globalBest = null; this.state.stats = []; this.state.spectateCarId = null; this.updateChart();
        const sel = document.getElementById('track-dropdown'); if(sel) sel.value = i;
        const t = this.state.tracks[i];
        
        this.cacheBackgroundRender(); 
        Engine.updateWorkerTrack(t, this.state.physics);
        this.initPopulation(); 
        this.updateUI();
        
        // Reset play buttons using inline SVGs — no lucide needed
        const clsOff = "rounded-lg font-bold flex items-center justify-center gap-1.5 transition-all border text-sm px-3 py-2 bg-emerald-500/20 text-emerald-400 border-emerald-500/50 hover:bg-emerald-500/30";
        if(ui.btnPlay) { ui.btnPlay.innerHTML = `${SVG_PLAY} <span>Start</span>`; ui.btnPlay.className = clsOff + " flex-1 py-2"; }
        if(ui.btnPlayM) { ui.btnPlayM.innerHTML = `${SVG_PLAY} <span>Start</span>`; ui.btnPlayM.className = clsOff; }
        // No lucide.createIcons() needed here
    },

    createNewTrack: function() { 
        const t = generateTrackFromPath("custom"+Date.now(), "New Track", [{x:200,y:200},{x:1000,y:200},{x:1000,y:700},{x:200,y:700}], 60); 
        this.state.isEditing = true; this.state.trackToEdit = t; editor.init(t); this.state.isRunning = false; 
        document.getElementById('editor-controls').classList.remove('hidden'); 
        closeSidebar();
    },
    editTrack: function() {
        this.state.isEditing = true; this.state.trackToEdit = JSON.parse(JSON.stringify(this.currentTrack));
        editor.init(this.state.trackToEdit); this.state.isRunning = false;
        document.getElementById('editor-controls').classList.remove('hidden');
        closeSidebar();
    },
    duplicateTrack: function() {
        const src = this.currentTrack; if (!src) return;
        const copy = generateTrackFromPath('custom'+Date.now(), src.name + ' (Copy)', JSON.parse(JSON.stringify(src.path)), src.trackWidth, src.startPos, src.startAngle, JSON.parse(JSON.stringify(src.zones || [])));
        this.state.isEditing = true; this.state.trackToEdit = copy; editor.init(copy); this.state.isRunning = false;
        document.getElementById('editor-controls').classList.remove('hidden');
        closeSidebar();
    },
    saveTrack: function(t) {
        const idx = this.state.tracks.findIndex(tr => tr.id === t.id);
        if(idx !== -1) this.state.tracks[idx] = t;
        else { this.state.tracks.push(t); this.state.currentTrackIndex = this.state.tracks.length-1; }
        this.state.isEditing = false;
        document.getElementById('editor-controls').classList.add('hidden');
        this.switchTrack(this.state.currentTrackIndex); this.renderTrackList();
        Persist.saveCustomTracks(this.state.tracks, this._builtInTrackIds || new Set());
    },
    deleteTrack: function() {
        if(confirm("Delete this track?")) {
            if(this.state.tracks.length > 1) {
                this.state.tracks.splice(this.state.currentTrackIndex, 1); this.switchTrack(0); this.renderTrackList();
                Persist.saveCustomTracks(this.state.tracks, this._builtInTrackIds || new Set());
            } else alert("Cannot delete last track.");
        }
    },

    chart: null,
    initChart: function() { 
        const ctx = document.getElementById('fitness-chart').getContext('2d'); 
        this.chart = new Chart(ctx, { 
            type: 'line', 
            data: { 
                labels: [], 
                datasets: [
                    {label:'Best Fitness', data:[], borderColor:'#34d399', backgroundColor:'rgba(52, 211, 153, 0.1)', borderWidth:2, pointRadius:2, fill: true},
                    {label:'Avg Fitness', data:[], borderColor:'#60a5fa', borderWidth:2, pointRadius:0}
                ] 
            }, 
            options: { 
                responsive: true, 
                maintainAspectRatio: false, 
                scales: { 
                    x: { display:false }, 
                    y: { grid: { color: '#334155' } } 
                }, 
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: { 
                    legend: { 
                        display:true, 
                        labels: { color: '#cbd5e1', boxWidth: 10, font: { size: 10 } }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label = context.dataset.label || '';
                                let val = Math.round(context.parsed.y);
                                let time = app.state.stats[context.dataIndex]?.time;
                                if(context.datasetIndex === 0 && time) return `${label}: ${val} (Lap: ${time}s)`;
                                return `${label}: ${val}`;
                            }
                        }
                    }
                } 
            } 
        }); 
    },
    updateChart: function() { 
        if(!this.chart) return; 
        this.chart.data.labels = this.state.stats.map(s => `Gen ${s.gen}`); 
        this.chart.data.datasets[0].data = this.state.stats.map(s => s.best); 
        this.chart.data.datasets[1].data = this.state.stats.map(s => s.avg); 
        this.chart.update(); 
    }
};

// --- Mobile/Desktop Track Editor ---
// --- Mobile/Desktop Track Editor ---

// --- Mobile/Desktop Track Editor ---
const editor = {
    track: null, mode: 'path', dragIndex: null, hoverIndex: null, isDraggingStart: false, isResizingZone: false, selectedZone: null, selectedIndex: null,
    isDrawing: false, drawPoints: [],

    init: function(t) {
        this.track = t;
        document.getElementById('edit-name').value = t.name;
        document.getElementById('edit-width').value = t.trackWidth;
        document.getElementById('edit-angle').value = Math.round((t.startAngle || 0) * (180/Math.PI));
        this.setMode('path');
        const c = document.getElementById('sim-canvas');
        c.style.touchAction = 'none';
        c.onpointerdown = e => { e.preventDefault(); c.setPointerCapture(e.pointerId); this.onDown(e); };
        c.onpointermove = e => { e.preventDefault(); this.onMove(e); };
        c.onpointerup = c.onpointercancel = e => { c.releasePointerCapture(e.pointerId); this.dragIndex=null; this.isDraggingStart=false; this.isResizingZone=false; if(this.isDrawing) this.finishDrawing(); };
    },

    setMode: function(m) {
        this.mode = m; this.selectedZone = null; this.selectedIndex = null;
        this.isDrawing = false; this.drawPoints = [];
        if(document.getElementById('btn-del-point')) document.getElementById('btn-del-point').classList.add('hidden');
        if(document.getElementById('point-tools')) {
            document.getElementById('point-tools').classList.add('hidden');
            document.getElementById('point-tools').classList.remove('flex');
        }
        const ktc = document.getElementById('kill-timer-container');
        if (ktc) ktc.style.display = 'none';
        ['path','draw','zones'].forEach(x => {
            const btn = document.getElementById('btn-mode-'+x);
            if(btn) btn.className = m===x?'px-2 py-1 text-xs rounded flex items-center gap-1 bg-blue-600 text-white':'px-2 py-1 text-xs rounded flex items-center gap-1 text-slate-400';
            const tools = document.getElementById(x+'-tools');
            if(tools) tools.style.display = m===x?'flex':'none';
        });
        document.getElementById('sim-canvas').style.cursor = m === 'draw' ? 'crosshair' : 'default';
    },

    clearDrawing: function() { this.isDrawing = false; this.drawPoints = []; },

    // Ramer-Douglas-Peucker: reduce a dense freehand stroke to its essential
    // corners/curves so the resulting track path stays editable.
    rdp: function(pts, epsilon) {
        if (pts.length < 3) return pts.slice();
        const perpDist = (p, a, b) => {
            const dx = b.x-a.x, dy = b.y-a.y, len = Math.hypot(dx,dy);
            if (len === 0) return Math.hypot(p.x-a.x, p.y-a.y);
            const t = ((p.x-a.x)*dx + (p.y-a.y)*dy) / (len*len);
            const cx = a.x + t*dx, cy = a.y + t*dy;
            return Math.hypot(p.x-cx, p.y-cy);
        };
        let maxD = 0, idx = 0;
        for (let i=1; i<pts.length-1; i++) {
            const d = perpDist(pts[i], pts[0], pts[pts.length-1]);
            if (d > maxD) { maxD = d; idx = i; }
        }
        if (maxD > epsilon) {
            const left = this.rdp(pts.slice(0, idx+1), epsilon);
            const right = this.rdp(pts.slice(idx), epsilon);
            return left.slice(0, -1).concat(right);
        }
        return [pts[0], pts[pts.length-1]];
    },

    // Simplify a CLOSED freehand loop: naive RDP (first point -> last point as
    // the baseline) collapses a loop almost to nothing since those two points
    // are nearly coincident. Instead split the loop at its two most distant
    // points into two open chains, simplify each independently, then rejoin.
    simplifyClosedLoop: function(points, epsilon) {
        let pts = points.slice();
        if (pts.length > 1 && Math.hypot(pts[0].x-pts[pts.length-1].x, pts[0].y-pts[pts.length-1].y) < 20) pts.pop();
        if (pts.length < 6) return pts;

        let bestD = -1, bi = 0, bj = 1;
        const step = Math.max(1, Math.floor(pts.length/150));
        for (let i=0; i<pts.length; i+=step) for (let j=i+1; j<pts.length; j+=step) {
            const d = (pts[i].x-pts[j].x)**2 + (pts[i].y-pts[j].y)**2;
            if (d > bestD) { bestD = d; bi = i; bj = j; }
        }
        if (bi > bj) { const tmp = bi; bi = bj; bj = tmp; }

        const chainA = pts.slice(bi, bj+1);
        const chainB = pts.slice(bj).concat(pts.slice(0, bi+1));
        const simpA = this.rdp(chainA, epsilon);
        const simpB = this.rdp(chainB, epsilon);
        let merged = simpA.slice(0, -1).concat(simpB.slice(0, -1));

        // Safety cap: very detailed/jittery strokes can still leave too many
        // points for wallsBySegment / the point-tools UI to stay comfortable.
        const MAX_POINTS = 70;
        if (merged.length > MAX_POINTS) {
            const stride = Math.ceil(merged.length / MAX_POINTS);
            merged = merged.filter((_, i) => i % stride === 0);
        }
        return merged;
    },

    finishDrawing: function() {
        if (!this.isDrawing) return;
        this.isDrawing = false;
        const raw = this.drawPoints;
        this.drawPoints = [];
        if (raw.length < 4) return;

        const simplified = this.simplifyClosedLoop(raw, 9);
        if (simplified.length < 3) { alert('Draw a bigger loop — that stroke was too small to build a track from.'); return; }

        // 'corner' (no bezier fillet) — with this many samples the polyline is
        // already smooth on its own, and it sidesteps the fillet self-overlap
        // risk that hit 'rounded' points here (see generateTrackFromPath).
        this.track.path = simplified.map(p => ({ x: Math.round(p.x), y: Math.round(p.y), type: 'corner', radius: 35 }));
        // Re-derive a concrete start pos/angle from the new path (the old ones
        // belonged to whatever shape was there before) — computed once now
        // rather than left null, since save() reads track.startPos.x directly.
        const derived = generateTrackFromPath(this.track.id, this.track.name, this.track.path, this.track.trackWidth);
        this.track.startPos = derived.startPos;
        this.track.startAngle = derived.startAngle;
        document.getElementById('edit-angle').value = Math.round((derived.startAngle || 0) * (180/Math.PI));
        this.selectedIndex = null;
        this.setMode('path');
    },

    updateZoneUI: function() {
        const ktc = document.getElementById('kill-timer-container');
        if (!ktc) return;
        if (this.selectedZone && this.selectedZone.type === 'spawnkill') {
            ktc.style.display = 'flex';
            const t = this.selectedZone.killTimer !== undefined ? this.selectedZone.killTimer : 150;
            document.getElementById('kill-timer-slider').value = t;
            document.getElementById('kill-timer-val').textContent = t;
        } else {
            ktc.style.display = 'none';
        }
    },
    updateZoneKillTimer: function(val) {
        if (this.selectedZone && this.selectedZone.type === 'spawnkill') {
            this.selectedZone.killTimer = parseInt(val);
            document.getElementById('kill-timer-val').textContent = val;
        }
    },

    selectAllPoints: function() {
        if(this.track && this.track.path && this.track.path.length > 0) {
            this.selectedIndex = 'all';
            this.updatePointUI();
        }
    },

    updatePointType: function(type) {
        if(this.selectedIndex === 'all') {
            this.track.path.forEach(p => p.type = type);
            this.updatePointUI();
        } else if(this.selectedIndex !== null) {
            this.track.path[this.selectedIndex].type = type;
            this.updatePointUI();
        }
    },

    updatePointRadius: function(val) {
        if(this.selectedIndex === 'all') {
            this.track.path.forEach(p => p.radius = parseInt(val));
            document.getElementById('pt-radius-val').innerText = val;
        } else if(this.selectedIndex !== null) {
            this.track.path[this.selectedIndex].radius = parseInt(val);
            document.getElementById('pt-radius-val').innerText = val;
        }
    },

    updatePointUI: function() {
        const pt = document.getElementById('point-tools');
        if(!pt) return;
        if (this.selectedIndex !== null) {
            pt.classList.remove('hidden');
            pt.classList.add('flex');
            
            let type = 'rounded';
            let radius = 60;

            if (this.selectedIndex === 'all') {
                // If "all" is selected, hide the delete button
                if(document.getElementById('btn-del-point')) document.getElementById('btn-del-point').classList.add('hidden');
            } else {
                // If a single point is selected, grab its specific data
                const p = this.track.path[this.selectedIndex];
                type = p.type || 'rounded';
                radius = p.radius !== undefined ? p.radius : 60;
                if(document.getElementById('btn-del-point')) document.getElementById('btn-del-point').classList.remove('hidden');
            }
            
            document.getElementById('btn-pt-corner').className = type === 'corner' ? 'px-2 py-1 text-[10px] rounded bg-blue-600 text-white' : 'px-2 py-1 text-[10px] rounded text-slate-400 hover:bg-slate-700 transition-colors';
            document.getElementById('btn-pt-rounded').className = type === 'rounded' ? 'px-2 py-1 text-[10px] rounded bg-blue-600 text-white' : 'px-2 py-1 text-[10px] rounded text-slate-400 hover:bg-slate-700 transition-colors';
            
            document.getElementById('radius-container').style.display = type === 'rounded' ? 'flex' : 'none';
            document.getElementById('pt-radius-slider').value = radius;
            document.getElementById('pt-radius-val').innerText = radius;
        } else {
            pt.classList.add('hidden');
            pt.classList.remove('flex');
            if(document.getElementById('btn-del-point')) document.getElementById('btn-del-point').classList.add('hidden');
        }
    },

    save: function() { 
        const name = document.getElementById('edit-name').value || 'Custom Track';
        this.track.name = name;
        
        const cleanPath = this.track.path.map(p => ({
            x: Math.round(p.x),
            y: Math.round(p.y),
            type: p.type || 'rounded',
            radius: p.radius !== undefined ? Math.round(p.radius) : 60
        }));

        this.track.path = cleanPath;
        const t = generateTrackFromPath(this.track.id, this.track.name, cleanPath, this.track.trackWidth, this.track.startPos, this.track.startAngle, this.track.zones);
        app.saveTrack(t);

        let pathStr = JSON.stringify(cleanPath)
            .replace(/"x":/g, 'x: ').replace(/"y":/g, 'y: ')
            .replace(/"type":/g, 'type: ').replace(/"radius":/g, 'radius: ')
            .replace(/}/g, ' }').replace(/{/g, '{ ');
            
        const zonesStr = this.track.zones && this.track.zones.length ? `, ${JSON.stringify(this.track.zones)}` : '';
        const startAng = this.track.startAngle ? Number(this.track.startAngle.toFixed(4)) : 0;
        
        const code = `generateTrackFromPath("${this.track.id}", "${name}", ${pathStr}, ${this.track.trackWidth}, {x:${Math.round(this.track.startPos.x)}, y:${Math.round(this.track.startPos.y)}}, ${startAng}${zonesStr}),`;
        document.getElementById('code-output').value = code;
        document.getElementById('code-modal').classList.remove('hidden');
    },

    // "Publish" — best-effort community sharing with no backend of our own:
    // opens a prefilled GitHub issue carrying the track as JSON. A repo
    // GitHub Action (.github/workflows/import-track.yml) validates it and
    // opens a PR to add it to tracks.js for everyone, once a maintainer merges.
    publishTrack: function() {
        const name = document.getElementById('edit-name').value || this.track.name || 'Custom Track';
        this.track.name = name;
        const cleanPath = this.track.path.map(p => ({
            x: Math.round(p.x), y: Math.round(p.y),
            type: p.type || 'rounded',
            radius: p.radius !== undefined ? Math.round(p.radius) : 60
        }));
        const payload = {
            id: 'community' + Date.now(),
            name,
            path: cleanPath,
            trackWidth: Math.round(this.track.trackWidth),
            startPos: { x: Math.round(this.track.startPos.x), y: Math.round(this.track.startPos.y) },
            startAngle: Number((this.track.startAngle || 0).toFixed(4)),
            zones: this.track.zones || []
        };
        const json = JSON.stringify(payload, null, 2);
        const title = `[Track Submission] ${name}`;
        const REPO = 'AZP3001/main';
        const body = `Submitting a track built in the TrackML in-app editor.\n\nAn automated workflow will validate this and open a pull request to add it for everyone — no manual copy/paste needed. Please don't edit the JSON block below.\n\n\`\`\`json\n${json}\n\`\`\`\n`;

        // GitHub's issue-prefill URL has a practical length limit — very large
        // hand-edited tracks could overflow it. Fall back to clipboard + a
        // blank prefilled issue (title/label only) rather than sending a
        // broken/truncated link.
        if (body.length > 6000) {
            const blankUrl = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&labels=${encodeURIComponent('track-submission')}`;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(body).then(() => {
                    alert('This track is large, so its JSON was copied to your clipboard instead of being pre-filled. A new GitHub issue tab is opening — paste the clipboard contents into the issue body and submit it.');
                    window.open(blankUrl, '_blank', 'noopener');
                }).catch(() => alert('This track is too large to publish via a link, and your browser blocked clipboard access. Try Save Track + the code export instead.'));
            } else {
                alert('This track is too large to publish via a link on this browser. Try Save Track + the code export instead.');
            }
            return;
        }

        const url = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&labels=${encodeURIComponent('track-submission')}&body=${encodeURIComponent(body)}`;
        window.open(url, '_blank', 'noopener');
    },

    cancel: function() {
        app.state.isEditing = false; 
        document.getElementById('editor-controls').classList.add('hidden'); 
        const cv = document.getElementById('sim-canvas'); cv.onpointerdown = null; cv.onpointermove = null; cv.onpointerup = null; cv.onpointercancel = null;
    },
    updateWidth: function(v) { this.track.trackWidth = parseInt(v); },
    updateAngle: function(v) { this.track.startAngle = parseFloat(v) * (Math.PI/180); },
    addZone: function(type) { 
        const z = { id:Date.now().toString(), x:CANVAS_WIDTH/2, y:CANVAS_HEIGHT/2, radius:80, type };
        if (type === 'spawnkill') { z.killTimer = 150; z.x = this.track.startPos.x; z.y = this.track.startPos.y; }
        this.track.zones.push(z); this.selectedZone = z; this.updateZoneUI();
    },
    deleteZone: function() { if(this.selectedZone) this.track.zones = this.track.zones.filter(z => z !== this.selectedZone); this.selectedZone = null; },
    deleteSelectedPoint: function() {
        if(this.selectedIndex !== null && this.selectedIndex !== 'all' && this.track.path.length > 3) {
            this.track.path.splice(this.selectedIndex, 1);
            this.selectedIndex = null;
            this.updatePointUI();
        }
    },

    getPos: function(e) { 
        const r = document.getElementById('sim-canvas').getBoundingClientRect(); 
        const scale = Math.min(r.width / CANVAS_WIDTH, r.height / CANVAS_HEIGHT);
        const offsetX = (r.width - (CANVAS_WIDTH * scale)) / 2;
        const offsetY = (r.height - (CANVAS_HEIGHT * scale)) / 2;
        return { x: (e.clientX - r.left - offsetX) / scale, y: (e.clientY - r.top - offsetY) / scale }; 
    },

    onDown: function(e) {
        const {x,y} = this.getPos(e);

        if (this.mode === 'draw') {
            this.isDrawing = true;
            this.drawPoints = [{x, y}];
            return;
        }

        if (this.mode === 'zones') {
            if(this.selectedZone && Math.hypot(x-(this.selectedZone.x+this.selectedZone.radius), y-this.selectedZone.y) < 30) { this.isResizingZone = true; return; }
            this.selectedZone = [...this.track.zones].reverse().find(z => Math.hypot(z.x-x, z.y-y) < z.radius) || null; 
            this.updateZoneUI();
            return;
        }
        
        if(Math.hypot(x - this.track.startPos.x, y - this.track.startPos.y) < 30) { this.isDraggingStart = true; return; }
        
        const idx = this.track.path.findIndex(p => Math.hypot(p.x-x, p.y-y) < 40);
        if(idx !== -1) { 
            this.selectedIndex = idx;
            this.dragIndex = idx;
            this.updatePointUI();
            return;
        } 
        
        let bI = -1, mD = 40;
        for(let i=0; i<this.track.path.length; i++) {
            const p1 = this.track.path[i], p2 = this.track.path[(i+1)%this.track.path.length];
            const l2 = (p1.x-p2.x)**2+(p1.y-p2.y)**2; if(l2===0) continue;
            const t = Math.max(0, Math.min(1, ((x-p1.x)*(p2.x-p1.x)+(y-p1.y)*(p2.y-p1.y))/l2));
            const d = Math.hypot(x-(p1.x+t*(p2.x-p1.x)), y-(p1.y+t*(p2.y-p1.y)));
            if(d<mD) { mD=d; bI=i; }
        }
        if(bI !== -1) { 
            this.track.path.splice(bI+1, 0, {x, y, type: 'rounded', radius: 60}); 
            this.dragIndex = bI+1; 
            this.selectedIndex = bI+1;
            this.updatePointUI();
        } else {
            this.selectedIndex = null;
            this.updatePointUI();
        }
    },

    onMove: function(e) {
        const {x,y} = this.getPos(e);
        if(this.mode === 'draw') {
            if(this.isDrawing && (e.buttons === 1 || e.type==="touchmove")) {
                const last = this.drawPoints[this.drawPoints.length-1];
                if(!last || Math.hypot(x-last.x, y-last.y) > 4) this.drawPoints.push({x,y});
            }
            return;
        }
        if(this.mode === 'zones') {
            if(this.selectedZone && (e.buttons === 1 || e.type==="touchmove")) {
                if(this.isResizingZone) this.selectedZone.radius = Math.max(30, Math.hypot(x - this.selectedZone.x, y - this.selectedZone.y)); 
                else { this.selectedZone.x = x; this.selectedZone.y = y; }
            } return;
        }
        if(this.isDraggingStart) this.track.startPos = {x,y};
        else if(this.dragIndex !== null) {
            this.track.path[this.dragIndex].x = x;
            this.track.path[this.dragIndex].y = y;
        } 
        else this.hoverIndex = this.track.path.findIndex(p => Math.hypot(p.x-x, p.y-y)<20);
    },

    draw: function(ctx) {
        const p = generateTrackFromPath(this.track.id, this.track.name, this.track.path, this.track.trackWidth, this.track.startPos, this.track.startAngle, this.track.zones);
        if (p.leftPoly && p.rightPoly) {
             ctx.fillStyle = '#343a40';
             for(let i=0; i<p.leftPoly.length; i++) {
                 const n = (i+1)%p.leftPoly.length; ctx.beginPath(); ctx.moveTo(p.leftPoly[i].x, p.leftPoly[i].y); ctx.lineTo(p.leftPoly[n].x, p.leftPoly[n].y);
                 ctx.lineTo(p.rightPoly[n].x, p.rightPoly[n].y); ctx.lineTo(p.rightPoly[i].x, p.rightPoly[i].y); ctx.fill();
             }
        }
        ctx.strokeStyle='#334155'; ctx.lineWidth=4; ctx.beginPath(); p.walls.forEach(w => { ctx.moveTo(w.p1.x, w.p1.y); ctx.lineTo(w.p2.x, w.p2.y); }); ctx.stroke();
        ctx.strokeStyle='#38bdf8'; ctx.lineWidth=2; ctx.beginPath(); p.checkpoints.forEach(cp => { ctx.moveTo(cp.p1.x, cp.p1.y); ctx.lineTo(cp.p2.x, cp.p2.y); }); ctx.stroke();
        
        p.zones.forEach(z => {
            ctx.beginPath(); ctx.arc(z.x, z.y, z.radius, 0, Math.PI*2);
            let zColor = z.type==='speed' ? 'rgba(239,68,68,0.2)' : z.type==='spawnkill' ? 'rgba(249,115,22,0.25)' : 'rgba(59,130,246,0.2)';
            ctx.fillStyle = zColor;
            ctx.fill(); 
            ctx.lineWidth = z===this.selectedZone?3:1; 
            let zStroke = z.type==='speed' ? '#ef4444' : z.type==='spawnkill' ? '#f97316' : '#3b82f6';
            ctx.strokeStyle = z===this.selectedZone?'#fff':zStroke;
            if(z===this.selectedZone) ctx.setLineDash([5,5]); ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            let zLabel = z.type==='speed' ? 'SPEED BOOST' : z.type==='spawnkill' ? '☠ SPAWN KILL' : 'POINTS';
            ctx.fillText(zLabel, z.x, z.y);
            if (z.type === 'spawnkill') { 
                const kt = z.killTimer !== undefined ? z.killTimer : 150;
                ctx.font = '11px sans-serif'; ctx.fillStyle = 'rgba(253,186,116,0.9)';
                ctx.fillText(`kill @ ${kt}f`, z.x, z.y + 16);
            }
            if (z===this.selectedZone) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(z.x+z.radius, z.y, 8, 0, Math.PI*2); ctx.fill(); ctx.strokeStyle='#000'; ctx.lineWidth=2; ctx.stroke(); }
        });

        if(this.mode === 'draw') {
            if(this.isDrawing && this.drawPoints.length > 1) {
                ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
                ctx.beginPath(); ctx.moveTo(this.drawPoints[0].x, this.drawPoints[0].y);
                for(let i=1; i<this.drawPoints.length; i++) ctx.lineTo(this.drawPoints[i].x, this.drawPoints[i].y);
                ctx.stroke();
                ctx.fillStyle = '#22d3ee'; ctx.beginPath(); ctx.arc(this.drawPoints[0].x, this.drawPoints[0].y, 6, 0, Math.PI*2); ctx.fill();
            } else if(!this.isDrawing) {
                ctx.fillStyle = 'rgba(226,232,240,0.7)'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
                ctx.fillText('Click & drag to draw a track loop', CANVAS_WIDTH/2, CANVAS_HEIGHT/2);
            }
        }

        if(this.mode === 'path') {
            ctx.strokeStyle='#3b82f6'; ctx.lineWidth=2; ctx.setLineDash([5,5]); ctx.beginPath();
            if(this.track.path.length>0) { ctx.moveTo(this.track.path[0].x, this.track.path[0].y); for(let i=1; i<this.track.path.length; i++) ctx.lineTo(this.track.path[i].x, this.track.path[i].y); if(this.track.path.length>2) ctx.lineTo(this.track.path[0].x, this.track.path[0].y); }
            ctx.stroke(); ctx.setLineDash([]);
            
            this.track.path.forEach((p, i) => { 
                const isSelected = (this.selectedIndex === i || this.selectedIndex === 'all');
                ctx.fillStyle = i===0 ? '#22c55e' : (isSelected ? '#ef4444' : (i===this.hoverIndex ? '#fbbf24' : '#60a5fa')); 
                
                ctx.beginPath(); 
                if (p.type === 'corner') {
                    ctx.rect(p.x - 6, p.y - 6, 12, 12); // Square for corners
                } else {
                    ctx.arc(p.x, p.y, 6, 0, Math.PI*2); // Circle for rounded
                }
                ctx.fill(); 
                
                // Add a red border to the green start point if it is selected by "Select All"
                ctx.strokeStyle = (i===0 && isSelected) ? '#ef4444' : '#fff'; 
                ctx.lineWidth=2; 
                ctx.stroke(); 
            });

            ctx.save(); ctx.translate(p.startPos.x, p.startPos.y); ctx.rotate(p.startAngle); ctx.fillStyle='rgba(34,197,94,0.5)'; ctx.fillRect(-10,-5,20,10); ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(-5, 0); ctx.lineTo(5, 0); ctx.lineTo(2, -3); ctx.moveTo(5, 0); ctx.lineTo(2, 3); ctx.stroke(); ctx.restore();
            ctx.fillStyle = this.isDraggingStart ? '#fff' : '#22c55e'; ctx.beginPath(); ctx.arc(p.startPos.x, p.startPos.y, 10, 0, Math.PI*2); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth=2; ctx.stroke();
        }
    }
};

window.onload = () => app.init();

function openSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('show');
}
function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('show');
}
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('sidebar-close-btn');
    if(btn) btn.onclick = closeSidebar;
});

// --- Keyboard shortcuts: Space=play/pause, H=hyper, R=reset, Esc=cancel edit/release spectate ---
document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return; // don't hijack typing

    if (app.state.isEditing) {
        if (e.key === 'Escape') { e.preventDefault(); editor.cancel(); }
        return;
    }

    switch (e.key) {
        case ' ':
        case 'Spacebar':
            e.preventDefault(); app.toggleRun(); break;
        case 'h': case 'H':
            app.toggleHyper(); break;
        case 'r': case 'R':
            app.reset(); break;
        case 'Escape':
            if (app.state.spectateCarId !== null) app.releaseSpectate();
            break;
    }
});
