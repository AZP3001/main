#!/usr/bin/env node
// Validates a community track submission (from a GitHub issue body's ```json
// block, produced by the app's "Publish Track" button) and, if it passes,
// appends it to tracks.js. Only ever consumes the parsed JSON as DATA — every
// value that reaches tracks.js goes through JSON.stringify(), so nothing in
// the issue body is ever interpreted as code.
'use strict';
const fs = require('fs');
const path = require('path');

function setOutput(name, value) {
    const out = process.env.GITHUB_OUTPUT;
    const delim = `EOF_${Math.random().toString(36).slice(2)}`;
    const line = `${name}<<${delim}\n${value}\n${delim}\n`;
    if (out) fs.appendFileSync(out, line);
    else process.stdout.write(line);
}

function fail(msg) {
    setOutput('success', 'false');
    setOutput('error', msg);
    console.error('Validation failed:', msg);
    process.exit(0); // exit clean — the workflow still needs to post a comment
}

const isFiniteNum = v => typeof v === 'number' && Number.isFinite(v);

function main() {
    const body = process.env.ISSUE_BODY || '';
    const match = body.match(/```json\s*([\s\S]*?)```/);
    if (!match) return fail('No ```json code block found in the issue body. Please submit tracks using the "Publish Track" button in the app rather than a hand-written issue.');

    let data;
    try { data = JSON.parse(match[1]); } catch (e) { return fail('Could not parse the JSON block: ' + e.message); }

    const errors = [];
    const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(id);
    if (!validId(data.id)) errors.push('id must be an alphanumeric/dash/underscore slug, 1-40 chars');

    if (typeof data.name !== 'string' || data.name.length < 1 || data.name.length > 60 || /[<>`]/.test(data.name)) {
        errors.push('name must be a plain string, 1-60 chars, with no < > ` characters');
    }

    if (!isFiniteNum(data.trackWidth) || data.trackWidth < 15 || data.trackWidth > 200) {
        errors.push('trackWidth must be a number between 15 and 200');
    }

    if (!Array.isArray(data.path) || data.path.length < 3 || data.path.length > 200) {
        errors.push('path must be an array of 3 to 200 points');
    } else {
        for (const p of data.path) {
            if (!p || !isFiniteNum(p.x) || !isFiniteNum(p.y) || p.x < -2000 || p.x > 3200 || p.y < -2000 || p.y > 2400) {
                errors.push('every path point needs numeric x/y within a sane range'); break;
            }
            if (p.type !== undefined && p.type !== 'corner' && p.type !== 'rounded') { errors.push('path point type must be "corner" or "rounded"'); break; }
            if (p.radius !== undefined && (!isFiniteNum(p.radius) || p.radius < 0 || p.radius > 500)) { errors.push('path point radius must be between 0 and 500'); break; }
        }
    }

    if (data.startPos !== undefined && data.startPos !== null) {
        if (!data.startPos || !isFiniteNum(data.startPos.x) || !isFiniteNum(data.startPos.y)) errors.push('startPos must have numeric x/y');
    }
    if (data.startAngle !== undefined && data.startAngle !== null && !isFiniteNum(data.startAngle)) errors.push('startAngle must be a number');

    if (data.zones !== undefined && data.zones !== null) {
        if (!Array.isArray(data.zones) || data.zones.length > 20) errors.push('zones must be an array of at most 20 items');
        else {
            const allowedTypes = ['speed', 'precision', 'spawnkill'];
            for (const z of data.zones) {
                if (!z || !isFiniteNum(z.x) || !isFiniteNum(z.y) || !isFiniteNum(z.radius) || !allowedTypes.includes(z.type)) {
                    errors.push('every zone needs numeric x/y/radius and a valid type (speed, precision, spawnkill)'); break;
                }
                if (z.killTimer !== undefined && !isFiniteNum(z.killTimer)) { errors.push('zone killTimer must be a number'); break; }
            }
        }
    }

    if (errors.length) return fail(errors.join('; '));

    const tracksPath = path.join(__dirname, '..', 'tracks.js');
    let src = fs.readFileSync(tracksPath, 'utf8');

    const existingIds = [...src.matchAll(/generateTrackFromPath\("([^"]+)"/g)].map(m => m[1]);
    let id = data.id;
    if (existingIds.includes(id)) id = id + '-' + Date.now().toString(36);

    const cleanPath = data.path.map(p => ({
        x: Math.round(p.x), y: Math.round(p.y),
        type: p.type === 'corner' ? 'corner' : 'rounded',
        radius: p.radius !== undefined ? Math.round(p.radius) : 60
    }));
    const cleanZones = Array.isArray(data.zones) ? data.zones.map(z => {
        const zone = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), x: Math.round(z.x), y: Math.round(z.y), radius: Math.round(z.radius), type: z.type };
        if (z.type === 'spawnkill') zone.killTimer = z.killTimer !== undefined ? Math.round(z.killTimer) : 150;
        return zone;
    }) : [];

    const hasStartPos = data.startPos && isFiniteNum(data.startPos.x) && isFiniteNum(data.startPos.y);
    const startPos = hasStartPos ? { x: Math.round(data.startPos.x), y: Math.round(data.startPos.y) } : null;
    const startAngle = isFiniteNum(data.startAngle) ? Number(data.startAngle.toFixed(4)) : 0;

    let call = `generateTrackFromPath(${JSON.stringify(id)}, ${JSON.stringify(data.name)}, ${JSON.stringify(cleanPath)}, ${Math.round(data.trackWidth)}`;
    if (startPos) {
        call += `, ${JSON.stringify(startPos)}, ${startAngle}`;
        if (cleanZones.length) call += `, ${JSON.stringify(cleanZones)}`;
    } else if (cleanZones.length) {
        call += `, undefined, undefined, ${JSON.stringify(cleanZones)}`;
    }
    call += '),';

    // tracks.js uses CRLF line endings — match either so this doesn't silently
    // no-op (and thus report success without actually writing anything) if run
    // against a checkout with different line endings.
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const markerRe = / {4}\];\r?\n\};/;
    if (!markerRe.test(src)) return fail('Internal error: could not find the insertion point in tracks.js (has its structure changed?)');
    const insertion = `        // Community submission via issue #${process.env.ISSUE_NUMBER || '?'}${eol}        ${call}${eol}`;
    src = src.replace(markerRe, (m) => insertion + m);
    fs.writeFileSync(tracksPath, src);

    setOutput('success', 'true');
    setOutput('trackName', data.name);
    console.log('Added community track', id, JSON.stringify(data.name));
}

main();
