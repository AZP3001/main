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
        let miterLen = width / Math.max(0.1, dot); 
        let maxMiter = Math.min(Math.hypot(curr.x-prev.x, curr.y-prev.y), Math.hypot(next.x-curr.x, next.y-curr.y)) * 0.9;
        miterLen = Math.min(miterLen, maxMiter, width * 1.5);
        
        leftPoly.push({ x: curr.x + nx * miterLen, y: curr.y + ny * miterLen });
        rightPoly.push({ x: curr.x - nx * miterLen, y: curr.y - ny * miterLen });
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

    // Pre-compute spatial wall lookup structure ONCE per track load
    function initTrackPrecomp() {
        if (!cachedTrack) return;
        const tSegs = cachedTrack.checkpoints.length;
        wallsBySegment = new Array(tSegs);
        for (let i = 0; i < tSegs; i++) {
            wallsBySegment[i] = [];
            for (let j = -5; j <= 8; j++) {
                let seg = (i + j + tSegs * 10) % tSegs;
                for (let w of cachedTrack.walls) {
                    if (w.segmentIndex === undefined || w.segmentIndex === seg) {
                        if (!wallsBySegment[i].includes(w)) wallsBySegment[i].push(w);
                    }
                }
            }
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

    // Pre-allocated flat array mutation
    function feedForwardCPU(c) {
        let b = c.brain, ins = c.sensorsInputs, hL = c.hL, oL = c.oL;
        for (let i = 0; i < hL.length; i++) {
            let sum = b.biasH[i];
            for (let j = 0; j < ins.length; j++) sum += ins[j] * b.weightsIH[j][i];
            hL[i] = Math.tanh(sum);
        }
        for (let i = 0; i < oL.length; i++) {
            let sum = b.biasO[i];
            for (let j = 0; j < hL.length; j++) sum += hL[j] * b.weightsHO[j][i];
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
    workers: [], coreCount: 1, 

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

    createBrain: function(iC, hC, oC) {
        const r = (r, c) => Array(r).fill(0).map(() => Array(c).fill(0).map(() => Math.random() * 2 - 1));
        const b = (c) => Array(c).fill(0).map(() => Math.random() * 2 - 1);
        return { weightsIH: r(iC, hC), weightsHO: r(hC, oC), biasH: b(hC), biasO: b(oC) };
    },
    copyBrain: function(b) { return { weightsIH: b.weightsIH.map(r=>[...r]), weightsHO: b.weightsHO.map(r=>[...r]), biasH: [...b.biasH], biasO: [...b.biasO] }; },
    mutateBrain: function(b, r) {
        const mut = v => Math.random() < r ? v + (Math.random() * 2 - 1) * 0.5 : v;
        b.weightsIH = b.weightsIH.map(rw => rw.map(mut)); b.weightsHO = b.weightsHO.map(rw => rw.map(mut));
        b.biasH = b.biasH.map(mut); b.biasO = b.biasO.map(mut);
    },

    runCPUWorkers: function(iters) {
        return new Promise(resolve => {
            let completed = 0; let shouldEvolve = false; let totalMaxLaps = 0;
            const stride = 11 + SENSOR_COUNT;
            
            this.workers.forEach(w => {
                w.onmessage = (e) => {
                    const { buffer, allCrashed, maxLaps } = e.data;
                    if(maxLaps > totalMaxLaps) totalMaxLaps = maxLaps;
                    if(allCrashed || maxLaps >= app.state.targetLaps) shouldEvolve = true;
                    
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
                    
                    completed++;
                    if(completed === this.workers.length) {
                        const globalCrashed = app.state.cars.every(c => c.crashed);
                        resolve({ triggerEvolve: globalCrashed || totalMaxLaps >= app.state.targetLaps });
                    }
                };
                w.postMessage({ type: 'run', iters });
            });
        });
    }
};

// --- Main Application ---
const app = {
    state: {
        populationSize: 200, eliteClones: 10, targetLaps: 3, mutationRate: 0.15, hiddenLayers: 5, initialTTL: 750,
        physics: { maxSpeed: 10, acceleration: 0.05, turnSpeed: 0.04, grip: 0.93 },
        tracks: [], currentTrackIndex: 1, cars: [], generation: 1, isRunning: false, speedMultiplier: 1, hyperMode: false,
        stats: [], globalBest: null, bestTimes: { gen: null, all: null }, isEditing: false, trackToEdit: null,
        bgCanvas: null, lapHistory: []
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
    },

    init: function() {
        try {
            Engine.init();
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
                color: `hsl(${Math.random()*360},80%,60%)`, brain, fitness: 0, crashed: false, sensors: Array(SENSOR_COUNT).fill(0), inputs: [0,0],
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
                    brain: Engine.copyBrain(this.state.globalBest.brain), fitness: 0, crashed: false, sensors: Array(SENSOR_COUNT).fill(0), inputs: [0,0], 
                    timeToLive: this.state.initialTTL, nextCheckpointIndex: 1, framesAlive: 0, lapTimes: [], completedLaps: 0, checkpointsReached: 0, isLapFinished: false
                });
            }
        }

        const parentPoolSize = Math.max(2, Math.floor(sorted.length * 0.2)); 
        for(let i=newCars.length; i<this.state.populationSize; i++) {
            const p1 = sorted[Math.floor(Math.random() * parentPoolSize)]; 
            const p2 = sorted[Math.floor(Math.random() * parentPoolSize)];
            
            const childBrain = Engine.createBrain(SENSOR_COUNT+2, this.state.hiddenLayers, 2);
            for(let j=0; j<childBrain.weightsIH.length; j++) {
                for(let k=0; k<childBrain.weightsIH[j].length; k++) childBrain.weightsIH[j][k] = Math.random() < 0.5 ? p1.brain.weightsIH[j][k] : p2.brain.weightsIH[j][k];
            }
            for(let j=0; j<childBrain.weightsHO.length; j++) {
                for(let k=0; k<childBrain.weightsHO[j].length; k++) childBrain.weightsHO[j][k] = Math.random() < 0.5 ? p1.brain.weightsHO[j][k] : p2.brain.weightsHO[j][k];
            }
            childBrain.biasH = childBrain.biasH.map((v, idx) => Math.random() < 0.5 ? p1.brain.biasH[idx] : p2.brain.biasH[idx]);
            childBrain.biasO = childBrain.biasO.map((v, idx) => Math.random() < 0.5 ? p1.brain.biasO[idx] : p2.brain.biasO[idx]);

            Engine.mutateBrain(childBrain, this.state.mutationRate);
            newCars.push({
                id: i, x: track.startPos.x, y: track.startPos.y, angle: track.startAngle, vx: 0, vy: 0, speed: 0, color: `hsl(${Math.random()*360},80%,60%)`,
                brain: childBrain, fitness: 0, crashed: false, sensors: Array(SENSOR_COUNT).fill(0), inputs: [0,0], 
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
            // Render ALL cars persistently, no color flashing, no hiding
            const best = this.state.cars.reduce((p,c) => (c.fitness > p.fitness && !c.crashed ? c : p), this.state.cars[0]);
            
            if(best && !best.crashed) {
                const i = best.inputs || [0,0];
                ui.telSteerL.style.width = i[0] < 0 ? Math.abs(i[0])*50 + '%' : '0%';
                ui.telSteerR.style.width = i[0] > 0 ? i[0]*50 + '%' : '0%';
                if(i[1] > 0) { ui.telGas.style.width = i[1]*100 + '%'; ui.telBrake.style.width = '0%'; } 
                else { ui.telGas.style.width = '0%'; ui.telBrake.style.width = Math.abs(i[1])*100 + '%'; }
                ui.telSpeed.style.width = Math.min((best.speed / this.state.physics.maxSpeed)*100, 100) + '%';
                ui.telSpeedVal.textContent = Math.round(best.speed);
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

                if(c === best) {
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
        this.state.bestTimes={gen:null,all:null}; this.state.lapHistory=[];
        _ui_gen=-1; _ui_alive=-1; _ui_allBest=null;
        if(ui.lapHistoryM) ui.lapHistoryM.innerHTML = '<span class="text-[10px] text-slate-600 italic">No laps yet</span>';
        this.initPopulation(); 
        if(this.chart) { this.chart.data.labels = []; this.chart.data.datasets.forEach(d => d.data = []); this.chart.update(); }
        this.updateUI(); this.toggleRun(); this.toggleRun(); 
    },
    
    updatePhysics: function(k, v) { this.state.physics[k] = parseFloat(v); document.getElementById('val-'+(k==='maxSpeed'?'maxSpeed':(k==='acceleration'?'accel':(k==='turnSpeed'?'turn':'grip')))).innerText = k==='grip'?Math.round(v*100)+'%':v; Engine.updateWorkerTrack(this.currentTrack, this.state.physics); },
    updateConfig: function(k, v) { 
        this.state[k] = parseFloat(v); 
        let id = 'val-'+(k==='populationSize'?'pop':k==='targetLaps'?'laps':k==='speedMultiplier'?'speed':k==='eliteClones'?'elite':k==='mutationRate'?'mut':k==='hiddenLayers'?'hidden':'ttl');
        let d = v; if(k==='speedMultiplier') d+='x'; if(k==='mutationRate') d=Math.round(v*100)+'%';
        const el = document.getElementById(id); if(el) el.innerText = d; 
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

    saveBrain: function() { if(!this.state.cars.length) return; const b = this.state.cars.reduce((p,c) => c.fitness>p.fitness?c:p); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(b.brain)], {type:'application/json'})); a.download = `trackml-g${this.state.generation}.json`; a.click(); },
    loadBrain: function(inp) { if(!inp.files[0]) return; const r = new FileReader(); r.onload = e => { try { this.reset(); this.initPopulation(JSON.parse(e.target.result)); } catch(er) { alert('Invalid File'); } }; r.readAsText(inp.files[0]); },

    renderTrackList: function() { const sel = document.getElementById('track-dropdown'); sel.innerHTML = ''; this.state.tracks.forEach((t, i) => { const opt = document.createElement('option'); opt.value = i; opt.text = t.name; opt.selected = this.state.currentTrackIndex === i; sel.appendChild(opt); }); },
    
    switchTrack: function(i) {
        i = parseInt(i); if (i < 0 || i >= this.state.tracks.length) i = 0;
        this.state.currentTrackIndex = i; this.state.isRunning = false; this.state.generation = 1; this.state.globalBest = null; this.state.stats = []; this.updateChart();
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
    saveTrack: function(t) { 
        const idx = this.state.tracks.findIndex(tr => tr.id === t.id); 
        if(idx !== -1) this.state.tracks[idx] = t; 
        else { this.state.tracks.push(t); this.state.currentTrackIndex = this.state.tracks.length-1; } 
        this.state.isEditing = false; 
        document.getElementById('editor-controls').classList.add('hidden'); 
        this.switchTrack(this.state.currentTrackIndex); this.renderTrackList(); 
    },
    deleteTrack: function() { if(confirm("Delete this track?")) { if(this.state.tracks.length > 1) { this.state.tracks.splice(this.state.currentTrackIndex, 1); this.switchTrack(0); this.renderTrackList(); } else alert("Cannot delete last track."); } },

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
        c.onpointerup = c.onpointercancel = e => { c.releasePointerCapture(e.pointerId); this.dragIndex=null; this.isDraggingStart=false; this.isResizingZone=false; };
    },

    setMode: function(m) {
        this.mode = m; this.selectedZone = null; this.selectedIndex = null;
        if(document.getElementById('btn-del-point')) document.getElementById('btn-del-point').classList.add('hidden');
        if(document.getElementById('point-tools')) {
            document.getElementById('point-tools').classList.add('hidden');
            document.getElementById('point-tools').classList.remove('flex');
        }
        const ktc = document.getElementById('kill-timer-container');
        if (ktc) ktc.style.display = 'none';
        ['path','zones'].forEach(x => { 
            const btn = document.getElementById('btn-mode-'+x);
            if(btn) btn.className = m===x?'px-2 py-1 text-xs rounded flex items-center gap-1 bg-blue-600 text-white':'px-2 py-1 text-xs rounded flex items-center gap-1 text-slate-400'; 
            const tools = document.getElementById(x+'-tools');
            if(tools) tools.style.display = m===x?'flex':'none'; 
        });
        document.getElementById('sim-canvas').style.cursor = 'default';
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
