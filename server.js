const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const { Server } = require('node-osc');
const open = require('open');
const ffmpeg = require('fluent-ffmpeg');
const { ViscaCamera, ViscaCommand } = require('visca-over-ip');
const { Bonjour } = require('bonjour-service');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');

// True when running inside a pkg-built standalone executable (pkg sets this itself).
// Packaging changes two things: __dirname points into a read-only embedded snapshot instead of
// a real directory (so writable/bundled files need a different home), and the tracker is a
// bundled standalone executable instead of a "python3 tracker.py" invocation.
const IS_PACKAGED = !!process.pkg;

// Directory containing bundled app resources (the tracker executable, ffmpeg) - these ship as
// part of the app itself, not user data. This is the folder the packaged executable lives in;
// in dev it's just the project directory.
const EXECUTABLE_DIR = IS_PACKAGED ? path.dirname(process.execPath) : __dirname;

// Directory for user data that must survive the app being replaced/updated (config.json,
// .config_path). Deliberately NOT the same as EXECUTABLE_DIR when packaged: a macOS .app is
// conventionally treated as disposable/replaceable (dragging a new build over the old one, or
// even just deleting and reinstalling), and anything written inside the bundle itself would be
// lost when that happens. ~/Library/Application Support is the standard macOS location for
// exactly this kind of per-app persistent data. In dev it's just the project directory, same
// as before.
const WRITABLE_DIR = IS_PACKAGED
    ? path.join(os.homedir(), 'Library', 'Application Support', 'PTZ Follow')
    : __dirname;
if (IS_PACKAGED) {
    fs.mkdirSync(WRITABLE_DIR, { recursive: true });
}

// In-app console viewer support. The packaged app runs with no visible Terminal window, so its
// only "screen" is the web GUI - this mirrors every console.log/warn/error into an in-memory
// ring buffer (for the "Open Console" panel's scrollback) and broadcasts each line live to any
// connected /console websocket clients. Also written to a log file when packaged, since that's
// the only way to see what happened if the server fails before a browser ever connects.
// Installed this early so it captures everything, including startup messages below.
const CONSOLE_BUFFER_MAX = 500;
const consoleBuffer = [];
const consoleClients = new Set();

let consoleLogStream = null;
if (IS_PACKAGED) {
    try {
        consoleLogStream = fs.createWriteStream(path.join(WRITABLE_DIR, 'server.log'), { flags: 'a' });
    } catch (e) {
        // Best-effort - the in-memory buffer and any connected /console clients still work.
    }
}

function formatConsoleArg(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    try {
        return JSON.stringify(arg);
    } catch (e) {
        return String(arg);
    }
}

function captureConsole(level, originalFn) {
    return (...args) => {
        originalFn(...args);
        const line = `[${new Date().toISOString()}] [${level}] ${args.map(formatConsoleArg).join(' ')}`;
        consoleBuffer.push(line);
        if (consoleBuffer.length > CONSOLE_BUFFER_MAX) consoleBuffer.shift();
        if (consoleLogStream) consoleLogStream.write(line + '\n');
        consoleClients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({ type: 'log', line }));
            }
        });
    };
}

console.log = captureConsole('LOG', console.log.bind(console));
console.warn = captureConsole('WARN', console.warn.bind(console));
console.error = captureConsole('ERROR', console.error.bind(console));

// When packaged, point fluent-ffmpeg at the bundled, self-contained ffmpeg binary (built from
// the same Homebrew ffmpeg this project already depends on in dev, with its dynamic library
// dependencies collected alongside it via dylibbundler) instead of relying on a system install.
// In dev, fall back to whatever "ffmpeg" resolves to on PATH, same as before.
if (IS_PACKAGED) {
    const bundledFfmpegPath = path.join(EXECUTABLE_DIR, 'resources', 'ffmpeg', 'ffmpeg');
    if (fs.existsSync(bundledFfmpegPath)) {
        ffmpeg.setFfmpegPath(bundledFfmpegPath);
    } else {
        console.warn(`Bundled ffmpeg not found at ${bundledFfmpegPath} - falling back to PATH, which likely isn't set up on an end-user machine.`);
    }
}

const PORT = 9356;
const OSC_PORT = 9357; // Listen on a different port for OSC
const VISCA_PORT = 1259; // Matches the camera's "UDP Port" setting (its VISCA-over-IP control port).
const VISCA_RECONNECT_THRESHOLD = 2; // consecutive missed ACKs before auto-recreating the VISCA socket

// Tracking speed tuning. The camera's hardware speed range is pan 1-24, tilt 1-20, but driving
// it at full speed on every large tracking error (e.g. subject jumps to the far side of frame,
// or stands up suddenly) causes it to overshoot the target and bounce back and forth. Capping
// well under hardware max gives smoother, more stable tracking at the cost of being slower to
// catch up on big/sudden movements. Raise these if tracking feels too sluggish; lower them
// further if it still overshoots.
const MAX_PAN_SPEED = 12;  // out of a hardware max of 24
const MAX_TILT_SPEED = 10; // out of a hardware max of 20

const app = express();
const wsInstance = expressWs(app);

app.use(express.static(path.join(__dirname, 'public')));

// Video stream websocket handler
app.ws('/stream', (ws, req) => {
    const camId = req.query.id;
    const rtspQuery = req.query.rtsp;

    // Resolve RTSP link: try from state first (OSC setup), then query param
    let rtspLink = null;
    if (camId && state.cameras[camId] && state.cameras[camId].rtsp) {
        rtspLink = state.cameras[camId].rtsp;
    } else if (rtspQuery) {
        rtspLink = rtspQuery;
    }

    if (!rtspLink) {
        console.error("No RTSP link provided or configured for the given ID.");
        ws.close();
        return;
    }

    // The RTSP connection can transiently fail right after server startup - most often because
    // it's briefly contending with the tracker process's own always-on RTSP connection to the
    // same camera (many PTZ cameras cap concurrent RTSP sessions). Retry a few times instead of
    // requiring the user to manually refresh the page to get a fresh attempt.
    let currentCommand = null;
    let retryCount = 0;
    const MAX_STREAM_RETRIES = 4;
    const STREAM_RETRY_DELAY_MS = 1500;

    function startFfmpegStream() {
        if (ws.readyState !== 1) return; // client already gone, nothing to do

        console.log(`Starting FFmpeg for stream: ${rtspLink}${retryCount > 0 ? ` (retry ${retryCount}/${MAX_STREAM_RETRIES})` : ''}`);

        const command = ffmpeg(rtspLink)
            .inputOptions([
                '-rtsp_transport tcp',
                '-analyzeduration 100M',
                '-probesize 100M',
            ])
            .outputOptions([
                '-f mpegts',
                '-codec:v mpeg1video',
                '-b:v 1000k',
                '-r 30',
                '-s 640x480',
                '-bf 0'
            ])
            .on('error', (err) => {
                console.error('FFmpeg Error:', err.message);
                if (ws.readyState === 1 && retryCount < MAX_STREAM_RETRIES) {
                    retryCount++;
                    setTimeout(startFfmpegStream, STREAM_RETRY_DELAY_MS);
                } else if (retryCount >= MAX_STREAM_RETRIES) {
                    console.error(`Giving up on stream for ${rtspLink} after ${MAX_STREAM_RETRIES} retries.`);
                }
            });

        currentCommand = command;
        const stream = command.pipe();
        stream.on('data', (data) => {
            if (ws.readyState === 1) {
                ws.send(data, { binary: true });
            }
        });
    }

    startFfmpegStream();

    ws.on('close', () => {
        console.log(`Closing FFmpeg stream for: ${rtspLink}`);
        if (currentCommand) currentCommand.kill();
    });
});

// Store global state
const state = {
    cameras: {}, // Format: { id: { ip, rtsp, trackingEnabled: boolean } }
    viscaDevices: {} // Format: { id: Visca Camera instance }
};

// Format: { id: ChildProcess instance }. Declared here (rather than next to the functions that
// use it) because loadConfig() below pre-warms tracker processes via ensureTrackerProcess() at
// startup, so this needs to exist before loadConfig() is called - a repeat of the VISCA_PORT
// ordering bug fixed earlier.
const activeTrackers = {};

// Format: { id: consecutive missed-ACK count }. A VISCA UDP socket created (or last known to
// work) while the camera was still booting/unreachable can end up permanently unable to reach
// it, even after the camera comes online - that's OS/socket-level state, not anything our own
// code controls, and only opening a brand-new socket clears it. This tracks repeated failures
// so sendPanTilt() can detect a wedged connection and recreate it automatically instead of
// requiring a full server restart.
const viscaMissedAckStreak = {};

// Persistent Configuration
// Anchored to WRITABLE_DIR, not process.cwd() - a plain relative path here would resolve
// against whatever directory the server happens to be launched from (a shortcut, a launcher
// script, a different terminal cwd), silently reading/writing a different config.json each
// time and "forgetting" previously configured camera IPs. When packaged, WRITABLE_DIR is
// ~/Library/Application Support/PTZ Follow (see above) rather than __dirname, both because
// __dirname there points into a read-only snapshot, and so config survives the .app itself
// being replaced.
let configPath = path.join(WRITABLE_DIR, 'config.json');
const configPathOverrideFile = path.join(WRITABLE_DIR, '.config_path');
try {
    if (fs.existsSync(configPathOverrideFile)) {
        configPath = fs.readFileSync(configPathOverrideFile, 'utf8').trim();
    }
} catch (e) {
    console.error("Error reading .config_path", e);
}
console.log(`Using camera config file: ${configPath}`);

function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
            state.cameras = JSON.parse(data);
            console.log(`Loaded configuration from ${configPath}`);

            // Re-initialize cameras
            Object.keys(state.cameras).forEach(id => {
                initVisca(id, state.cameras[id].ip);
                // Assume tracking is off on startup for safety
                state.cameras[id].trackingEnabled = false;
                // Pre-warm the tracker process/RTSP connection so "Enable Tracking" is fast later.
                if (state.cameras[id].rtsp) {
                    ensureTrackerProcess(id, state.cameras[id].rtsp);
                }
            });
        }
    } catch (e) {
        console.error("Error loading config", e);
    }
}

function saveConfig() {
    try {
        // Only save ip and rtsp, don't persist tracking state
        const configToSave = {};
        Object.keys(state.cameras).forEach(id => {
            configToSave[id] = {
                ip: state.cameras[id].ip,
                rtsp: state.cameras[id].rtsp
            };
        });
        fs.writeFileSync(configPath, JSON.stringify(configToSave, null, 2));
    } catch (e) {
        console.error("Error saving config", e);
    }
}

// Load config on startup
loadConfig();

// Camera Discovery
const discoveredIps = new Set();

function broadcastDiscoveredIps() {
    const ips = Array.from(discoveredIps);
    if (ips.length > 0) {
        wsInstance.getWss().clients.forEach(client => {
            if (client.readyState === 1) { // WebSocket.OPEN
                client.send(JSON.stringify({
                    type: 'discovered_cameras',
                    ips: ips
                }));
            }
        });
    }
}

// Bonjour/mDNS: passive - picks up whatever advertises itself, which in practice is a mix of
// PTZ cameras and unrelated LAN devices (and misses cameras that don't advertise via mDNS at
// all, which many budget PTZ cameras don't). Kept as a supplementary signal alongside the
// active HTTP scan below, since it's cheap and occasionally catches something the scan misses
// (e.g. a camera on a different subnet than the server).
const bonjour = new Bonjour();
const browser = bonjour.find();

browser.on('up', (service) => {
    if (service.addresses && service.addresses.length > 0) {
        // Collect IPv4 addresses
        const ipv4 = service.addresses.filter(addr => addr.includes('.'));
        ipv4.forEach(addr => discoveredIps.add(addr));
    }
});

setInterval(broadcastDiscoveredIps, 5000);

// Active discovery scan: fetches http://IP:80/ from every address on the server's local /24
// subnet(s) and treats an HTML response as a hit.
//
// This used to send a VISCA inquiry command to UDP port 1259 on every candidate IP instead,
// which is a more specific signal in principle - but in practice it turned out to disrupt real
// cameras: the extra unsolicited inquiry packet confused at least one camera's embedded VISCA
// responder badly enough that it stopped ACKing legitimate pan/tilt commands afterward. An HTTP
// GET to the camera's web UI is a completely separate subsystem from its VISCA responder, so it
// can't interfere with control traffic the same way.
function getLocalSubnetBases() {
    const bases = new Set();
    const ownIps = new Set();
    const interfaces = os.networkInterfaces();
    Object.values(interfaces).forEach(addrs => {
        (addrs || []).forEach(addr => {
            if (addr.family === 'IPv4' && !addr.internal) {
                ownIps.add(addr.address);
                const parts = addr.address.split('.');
                if (parts.length === 4) {
                    bases.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
                }
            }
        });
    });
    return { bases: Array.from(bases), ownIps };
}

function probeHttpCamera(ip, timeoutMs = 500) {
    return new Promise((resolve) => {
        let finished = false;
        let body = '';

        const finish = (result) => {
            if (finished) return;
            finished = true;
            req.destroy();
            resolve(result);
        };

        const req = http.get({ host: ip, port: 80, path: '/', timeout: timeoutMs }, (res) => {
            res.on('data', (chunk) => {
                body += chunk;
                // We just need enough of the response to tell it's an HTML page - no need to
                // download the whole thing.
                if (body.length > 2000) res.destroy();
            });
            res.on('end', () => finish(/<html/i.test(body)));
            res.on('close', () => finish(/<html/i.test(body)));
        });

        req.on('timeout', () => finish(false));
        req.on('error', () => finish(false));
    });
}

let networkScanInProgress = false;
async function scanForPtzCameras() {
    if (networkScanInProgress) {
        console.log('Network scan already in progress, skipping.');
        return;
    }
    networkScanInProgress = true;

    try {
        const { bases, ownIps } = getLocalSubnetBases();
        if (bases.length === 0) {
            console.log('Network scan: no active IPv4 network interfaces found, skipping.');
            return;
        }

        // No need to re-probe an IP we already know is a configured camera.
        const knownCameraIps = new Set(Object.values(state.cameras).map(cam => cam.ip).filter(Boolean));

        console.log(`Network scan: sweeping ${bases.map(b => b + '.0/24').join(', ')} for camera web UIs...`);
        const CONCURRENCY = 40;
        let foundCount = 0;

        for (const base of bases) {
            const candidates = [];
            for (let i = 1; i <= 254; i++) {
                const ip = `${base}.${i}`;
                if (!ownIps.has(ip) && !knownCameraIps.has(ip)) candidates.push(ip);
            }

            for (let i = 0; i < candidates.length; i += CONCURRENCY) {
                const batch = candidates.slice(i, i + CONCURRENCY);
                const results = await Promise.all(batch.map(ip => probeHttpCamera(ip).then(ok => ok ? ip : null)));
                results.forEach(ip => {
                    if (ip && !discoveredIps.has(ip)) {
                        discoveredIps.add(ip);
                        foundCount++;
                        console.log(`Network scan: found candidate camera at ${ip}`);
                    }
                });
            }
        }

        console.log(`Network scan complete: ${foundCount} new candidate(s) found.`);
        broadcastDiscoveredIps();
    } catch (e) {
        console.error('Network scan error:', e);
    } finally {
        networkScanInProgress = false;
    }
}

// Sweep once at startup; the GUI can also trigger a fresh sweep on demand (e.g. after powering
// on a camera) via the 'rescan_network' control message.
scanForPtzCameras();

// Function to initialize VISCA device
function initVisca(camId, ip) {
    console.log(`Initializing VISCA device for ${camId} at ${ip}:${VISCA_PORT}...`);

    // Close out any previous instance's socket first, so repeated re-inits (a repeat
    // /camera/setup, or the auto-reconnect in sendPanTilt below) don't leak UDP sockets.
    const previous = state.viscaDevices[camId];
    if (previous && previous.client) {
        try { previous.client.close(); } catch (e) { /* already closed */ }
    }

    try {
        const camera = new ViscaCamera(ip, VISCA_PORT);

        // The visca-over-ip library only surfaces these if a handler is registered for BOTH
        // 'error' and 'closed' - without both, network errors (wrong IP/port, unreachable host,
        // etc.) are silently swallowed and nothing appears in the console.
        camera.on('connected', () => console.log(`[VISCA] ${camId}: socket connected`));
        camera.on('closed', () => console.warn(`[VISCA] ${camId}: connection closed`));
        camera.on('error', (err) => console.error(`[VISCA] ${camId}: camera-level error:`, err));

        console.log(`VISCA initialized for ${camId}`);
        state.viscaDevices[camId] = camera;
        viscaMissedAckStreak[camId] = 0;
    } catch (err) {
        console.error(`VISCA init failed for ${camId}:`, err);
    }
}

// Centralized pan/tilt sender so every VISCA command is logged and its ACK/error is tracked.
function sendPanTilt(camId, xSpeed, ySpeed, xMode, yMode) {
    const camera = state.viscaDevices[camId];
    if (!camera) {
        console.error(`[VISCA] ${camId}: no camera instance - was /camera/setup or the UI setup form ever called for this ID?`);
        return;
    }

    const cmd = ViscaCommand.cameraPanTilt(xSpeed, ySpeed, xMode, yMode);
    let acked = false;
    cmd.on('ack', () => {
        acked = true;
        console.log(`[VISCA] ${camId}: pan/tilt ACKed by camera (x=${xSpeed} y=${ySpeed})`);
    });
    cmd.on('error', (err) => console.error(`[VISCA] ${camId}: pan/tilt command REJECTED by camera:`, err));

    console.log(`[VISCA] ${camId}: sending pan/tilt to ${camera.ip}:${camera.port} x=${xSpeed} y=${ySpeed}`);
    camera.sendCommand(cmd);

    // UDP has no delivery guarantee, so a missing ACK after a beat means the packet almost
    // certainly never reached the camera: wrong IP, wrong VISCA port, camera not in
    // VISCA-over-IP mode, a firewall/VLAN blocking UDP between this host and the camera - or a
    // socket that was created (or last known to work) while the camera was still booting and
    // is now permanently unable to reach it, which only recreating the socket clears.
    setTimeout(() => {
        if (!acked) {
            const streak = (viscaMissedAckStreak[camId] || 0) + 1;
            viscaMissedAckStreak[camId] = streak;
            console.warn(`[VISCA] ${camId}: no ACK received for last pan/tilt command (${streak} in a row) - check IP, port ${VISCA_PORT}, and that the camera has VISCA-over-IP enabled.`);

            if (streak >= VISCA_RECONNECT_THRESHOLD) {
                console.warn(`[VISCA] ${camId}: ${streak} consecutive missed ACKs - recreating the VISCA connection in case it's wedged (e.g. it was opened while the camera was still booting).`);
                initVisca(camId, camera.ip);
            }
        } else {
            viscaMissedAckStreak[camId] = 0;
        }
    }, 1000);
}

// Spawns the python tracker process for a camera if it isn't already running, and keeps it
// running in standby (RTSP connection open, frames being read, no CSRT tracking active) until
// startTracking() sends it a rect. This is what lets "Enable Tracking" be near-instant: the
// slow part - process spawn + cv2 import + RTSP handshake/keyframe wait - happens ahead of time
// at camera setup, not at the moment tracking is requested.
// Resolves the command used to launch the tracker, in either mode:
//  - Dev: "python3 -u tracker.py" against the source script.
//  - Packaged: the standalone tracker executable built with PyInstaller, bundled next to the
//    packaged server executable under resources/tracker/ - no Python install needed.
function getTrackerCommand() {
    if (IS_PACKAGED) {
        const ext = process.platform === 'win32' ? '.exe' : '';
        return { command: path.join(EXECUTABLE_DIR, 'resources', 'tracker', `tracker${ext}`), baseArgs: [] };
    }
    return { command: 'python3', baseArgs: ['-u', path.join(__dirname, 'tracker.py')] };
}

function ensureTrackerProcess(camId, rtsp) {
    const existing = activeTrackers[camId];
    if (existing) {
        if (existing.rtsp === rtsp) return; // already running against the correct URL

        // The camera was re-pointed at a different RTSP URL (e.g. a repeat /camera/setup with
        // a new IP for the same id) while its tracker process was still connected to the old
        // one. ensureTrackerProcess() alone won't pick this up since a process already exists
        // for this camId, so restart it explicitly against the new URL.
        console.log(`RTSP URL changed for ${camId} (${existing.rtsp} -> ${rtsp}), restarting tracker process...`);
        stopPythonTracker(camId);
    }

    console.log(`Starting standby tracker for ${camId} on ${rtsp}`);
    const { command, baseArgs } = getTrackerCommand();
    const child = spawn(command, [...baseArgs, rtsp], {
        env: { ...process.env, PYTHONUNBUFFERED: '1' } // real-time stdout in both modes
    });
    child.rtsp = rtsp; // remember which URL this process is connected to, for the check above
    activeTrackers[camId] = child;

    const stdoutLines = readline.createInterface({ input: child.stdout });
    stdoutLines.on('line', function (message) {
        try {
            const data = JSON.parse(message);
            if (data.type === 'tracking') {
                // Object tracking (CSRT) keeps running and the box below keeps updating even
                // while movement is paused - only the VISCA commands are withheld.
                //
                // Also gate on trackingEnabled, not just movementPaused: disabling tracking
                // sends an async 'stop_tracking' message to the python process, so a frame it
                // already computed just before receiving that can still arrive here afterward.
                // trackingEnabled flips to false synchronously the instant disable is
                // processed, so checking it too stops that stale frame from sneaking out one
                // last real pan/tilt command after the deliberate stop was already sent.
                const camState = state.cameras[camId];
                const movementPaused = camState && camState.movementPaused;
                const trackingActive = camState && camState.trackingEnabled;

                if (trackingActive && !movementPaused) {
                    let pan = data.pan;
                    let tilt = data.tilt;

                    if (Math.abs(pan) < 0.1) pan = 0;
                    if (Math.abs(tilt) < 0.1) tilt = 0;

                    if (pan !== 0 || tilt !== 0) {
                        let panSpeed = Math.floor(Math.abs(pan) * MAX_PAN_SPEED);
                        let tiltSpeed = Math.floor(Math.abs(tilt) * MAX_TILT_SPEED);

                        if (panSpeed > MAX_PAN_SPEED) panSpeed = MAX_PAN_SPEED;
                        if (panSpeed < 1 && pan !== 0) panSpeed = 1;
                        if (tiltSpeed > MAX_TILT_SPEED) tiltSpeed = MAX_TILT_SPEED;
                        if (tiltSpeed < 1 && tilt !== 0) tiltSpeed = 1;

                        let panDir = pan > 0 ? 'right' : (pan < 0 ? 'left' : 'stop');
                        let tiltDir = tilt > 0 ? 'up' : (tilt < 0 ? 'down' : 'stop');

                        let xSpeed = panDir === 'right' ? panSpeed : (panDir === 'left' ? -panSpeed : 0);
                        // visca-over-ip's ySpeed convention is "positive = increasing y = downward"
                        // (see its Command.js comment), so tilting UP requires a NEGATIVE ySpeed.
                        let ySpeed = tiltDir === 'up' ? -tiltSpeed : (tiltDir === 'down' ? tiltSpeed : 0);

                        sendPanTilt(camId, xSpeed, ySpeed);
                    } else {
                        sendPanTilt(camId, 0, 0, 0x03, 0x03);
                    }
                }

                // Broadcast rect back to UI to draw it (always, even while movement is paused,
                // so the box still visibly tracks the subject on screen)
                wsInstance.getWss().clients.forEach(client => {
                    if (client.readyState === 1) {
                        client.send(JSON.stringify({
                            type: 'tracking_update',
                            camId: camId,
                            rect: data.rect
                        }));
                    }
                });
            } else if (data.type === 'lost') {
                if (data.permanent) {
                    // tracker.py gave up after its grace period rather than risk drifting
                    // onto a different subject - reflect that in shared state so the GUI
                    // resets back to "Enable Tracking" and prompts a redraw.
                    console.log(`Tracking permanently lost for ${camId} - stopping and awaiting a new bounding box.`);
                    if (state.cameras[camId]) {
                        state.cameras[camId].trackingEnabled = false;
                        state.cameras[camId].movementPaused = false;
                    }
                    sendPanTilt(camId, 0, 0, 0x03, 0x03);
                    wsInstance.getWss().clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(JSON.stringify({
                                type: 'state',
                                cameras: state.cameras
                            }));
                        }
                    });
                } else {
                    console.log(`Tracking briefly lost for ${camId}, still trying to reacquire...`);
                    if (state.cameras[camId] && state.cameras[camId].trackingEnabled && !state.cameras[camId].movementPaused) {
                        sendPanTilt(camId, 0, 0, 0x03, 0x03);
                    }
                }
            } else if (data.type === 'error') {
                console.error(`Tracker error for ${camId}:`, data.message);
            }
        } catch (e) {
            console.error("Error parsing tracker output:", e, message);
        }
    });

    const stderrLines = readline.createInterface({ input: child.stderr });
    stderrLines.on('line', (line) => {
        console.error(`[Tracker] ${camId} stderr: ${line}`);
    });

    child.on('error', (err) => {
        console.error(`[Tracker] ${camId}: failed to start:`, err);
    });

    child.on('close', (code, signal) => {
        console.log(`Tracker process stopped for ${camId} (code=${code}, signal=${signal})`);
        // Guard against a race when restarting for a changed RTSP URL: the old process's
        // 'close' event can fire after a newer process has already been registered under the
        // same camId - only clear the registration if it's still this exact process.
        if (activeTrackers[camId] === child) {
            delete activeTrackers[camId];
        }
    });
}

// Starts (or resumes) active tracking on an already-warm process, so this is just a stdin
// message - no process spawn or RTSP renegotiation delay. Falls back to spawning if the
// process somehow isn't running yet (e.g. it crashed).
function startTracking(camId, rtsp, rect) {
    ensureTrackerProcess(camId, rtsp);
    const proc = activeTrackers[camId];
    if (proc) {
        proc.stdin.write(JSON.stringify({ type: 'update_rect', rect }) + '\n');
    }
}

// Stops active tracking but keeps the process/RTSP connection alive and warm for next time.
function pauseTracking(camId) {
    const proc = activeTrackers[camId];
    if (proc) {
        proc.stdin.write(JSON.stringify({ type: 'stop_tracking' }) + '\n');
    }
}

// Actually kills the tracker process (RTSP connection included). Only use this when the
// camera itself is being removed, not for a normal "disable tracking".
function stopPythonTracker(camId) {
    if (activeTrackers[camId]) {
        try {
            activeTrackers[camId].kill();
        } catch (e) {
            console.error("Error killing python shell:", e);
        }
        delete activeTrackers[camId];
    }
}

// Console-viewer websocket: streams captured console.log/warn/error output to the "Open
// Console" panel in the web GUI. Sends the recent scrollback immediately on connect so opening
// the panel isn't starting from a blank screen.
app.ws('/console', (ws, req) => {
    ws.send(JSON.stringify({ type: 'history', lines: consoleBuffer }));
    consoleClients.add(ws);
    ws.on('close', () => consoleClients.delete(ws));
});

// Control websocket handler for UI -> Server
app.ws('/control', (ws, req) => {
    // When a control client connects, send the current tracking state and cameras
    ws.send(JSON.stringify({
        type: 'state',
        cameras: state.cameras
    }));

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'setup') {
                const trackingEnabled = state.cameras[data.camId] ? state.cameras[data.camId].trackingEnabled : false;
                const movementPaused = state.cameras[data.camId] ? state.cameras[data.camId].movementPaused : false;
                state.cameras[data.camId] = { ip: data.camIp, rtsp: data.camRtsp, trackingEnabled, movementPaused };
                console.log(`UI Setup updated for ID ${data.camId}: IP=${data.camIp}, RTSP=${data.camRtsp}`);
                initVisca(data.camId, data.camIp);
                ensureTrackerProcess(data.camId, data.camRtsp);
                saveConfig();

                // Broadcast state update so the new/edited camera appears immediately for
                // every connected client, instead of only after a page refresh.
                wsInstance.getWss().clients.forEach(client => {
                    if (client.readyState === 1) {
                        client.send(JSON.stringify({
                            type: 'state',
                            cameras: state.cameras
                        }));
                    }
                });
            } else if (data.type === 'set_rect') {
                if (state.cameras[data.camId] && data.rect) {
                    state.cameras[data.camId].rect = data.rect;
                }
            } else if (data.type === 'rescan_network') {
                console.log('Network rescan requested from UI.');
                scanForPtzCameras(); // fire-and-forget; results broadcast automatically when done
            } else if (data.type === 'tracking_toggle') {
                if (state.cameras[data.camId]) {
                    state.cameras[data.camId].trackingEnabled = data.enabled;
                    console.log(`Tracking toggled via UI for ${data.camId}: ${data.enabled}`);

                    if (data.enabled && data.rect) {
                        state.cameras[data.camId].rect = data.rect;
                        state.cameras[data.camId].movementPaused = false;
                        startTracking(data.camId, state.cameras[data.camId].rtsp, data.rect);
                    } else if (!data.enabled) {
                        state.cameras[data.camId].movementPaused = false;
                        pauseTracking(data.camId);
                        sendPanTilt(data.camId, 0, 0, 0x03, 0x03);
                    }

                    // Broadcast state update
                    wsInstance.getWss().clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(JSON.stringify({
                                type: 'state',
                                cameras: state.cameras
                            }));
                        }
                    });
                }

            } else if (data.type === 'movement_pause') {
                if (state.cameras[data.camId]) {
                    state.cameras[data.camId].movementPaused = !!data.paused;
                    console.log(`Camera movement ${data.paused ? 'paused' : 'resumed'} via UI for ${data.camId}`);

                    if (data.paused) {
                        // Halt the camera immediately rather than waiting for the next tracking frame.
                        sendPanTilt(data.camId, 0, 0, 0x03, 0x03);
                    }

                    // Broadcast state update
                    wsInstance.getWss().clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(JSON.stringify({
                                type: 'state',
                                cameras: state.cameras
                            }));
                        }
                    });
                }
            } else if (data.type === 'remove_camera') {
                if (state.cameras[data.camId]) {
                    console.log(`Removing camera ${data.camId}`);

                    // Stop camera if it was tracking
                    if (state.cameras[data.camId].trackingEnabled) {
                        sendPanTilt(data.camId, 0, 0, 0x03, 0x03);
                    }

                    delete state.cameras[data.camId];
                    delete state.viscaDevices[data.camId];
                    stopPythonTracker(data.camId);

                    // Broadcast state update
                    wsInstance.getWss().clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(JSON.stringify({
                                type: 'state',
                                cameras: state.cameras
                            }));
                        }
                    });
                }
            } else if (data.type === 'shutdown') {
                // The packaged app has no visible Terminal window to close as a way to stop it,
                // so this button in the GUI is the actual way to quit. Stop tracker child
                // processes explicitly first - process.exit() doesn't automatically signal them
                // the way closing a terminal (and its whole process group) used to.
                console.log('Shutdown requested from UI - stopping all trackers and exiting.');
                Object.keys(activeTrackers).forEach(camId => stopPythonTracker(camId));
                ws.send(JSON.stringify({ type: 'shutting_down' }));
                setTimeout(() => process.exit(0), 300);
            }
        } catch (err) {
            console.error("Control WS parse error", err);
        }
    });
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    if (IS_PACKAGED) {
        // End users running the packaged app don't know (or need to know) about localhost
        // ports - open the GUI for them automatically, same as the existing /gui/open OSC
        // command does on request. Left out in dev mode so it doesn't pop a browser tab on
        // every "node server.js" restart during development.
        open(`http://localhost:${PORT}`);
    }
});

// OSC Server setup
const oscServer = new Server(OSC_PORT, '0.0.0.0', () => {
  console.log(`OSC Server is listening on port ${OSC_PORT}`);
});

oscServer.on('message', (msg) => {
    console.log(`Received OSC message: ${msg}`);
    const address = msg[0];
    const args = msg.slice(1);

    if (address === '/tracking') {
        if (args.length >= 2) {
            const id = args[0];
            const enabled = args[1] === 1;
            if (!state.cameras[id]) {
                state.cameras[id] = { trackingEnabled: enabled };
            } else {
                state.cameras[id].trackingEnabled = enabled;
            }
            console.log(`Tracking enabled via OSC for ${id}: ${enabled}`);

            if (enabled) {
                const cam = state.cameras[id];
                cam.movementPaused = false;
                if (!cam.rtsp) {
                    console.error(`Cannot start tracking for ${id}: no camera configured (use /camera/setup first).`);
                    cam.trackingEnabled = false;
                } else if (!cam.rect) {
                    console.error(`Cannot start tracking for ${id}: no bounding box has been drawn yet. Draw one in the web GUI first.`);
                    cam.trackingEnabled = false;
                } else {
                    startTracking(id, cam.rtsp, cam.rect);
                }
            } else {
                // Stop camera if tracking is disabled
                state.cameras[id].movementPaused = false;
                pauseTracking(id);
                sendPanTilt(id, 0, 0, 0x03, 0x03);
            }

            // Broadcast state update to all UI clients so they can start/stop OpenCV
            wsInstance.getWss().clients.forEach(client => {
                if (client.readyState === 1) { // WebSocket.OPEN
                    client.send(JSON.stringify({
                        type: 'state',
                        cameras: state.cameras
                    }));
                }
            });
        }
    } else if (address === '/tracking/pause') {
        if (args.length >= 2) {
            const id = args[0];
            const paused = args[1] === 1;

            if (!state.cameras[id]) {
                console.error(`Cannot pause/resume movement for ${id}: camera not configured (use /camera/setup first).`);
                return;
            }

            state.cameras[id].movementPaused = paused;
            console.log(`Camera movement ${paused ? 'paused' : 'resumed'} via OSC for ${id}`);

            if (paused) {
                // Halt the camera immediately rather than waiting for the next tracking frame.
                sendPanTilt(id, 0, 0, 0x03, 0x03);
            }

            // Broadcast state update to all UI clients
            wsInstance.getWss().clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: 'state',
                        cameras: state.cameras
                    }));
                }
            });
        }
    } else if (address === '/gui/open') {
        open(`http://localhost:${PORT}`);
    } else if (address === '/camera/setup') {
        if (args.length >= 2) {
            const id = args[0];
            const ip = args[1];
            const rtsp = `rtsp://${ip}:554/live/av0`;
            const trackingEnabled = state.cameras[id] ? state.cameras[id].trackingEnabled : false;
            const movementPaused = state.cameras[id] ? state.cameras[id].movementPaused : false;
            state.cameras[id] = { ip, rtsp, trackingEnabled, movementPaused };
            console.log(`Camera setup updated for ID ${id}: IP=${ip}, RTSP=${rtsp}`);
            initVisca(id, ip);
            ensureTrackerProcess(id, rtsp);
            saveConfig();
            // Broadcast state update
            wsInstance.getWss().clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: 'state',
                        cameras: state.cameras
                    }));
                }
            });
        }
    }
});