const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const { Server } = require('node-osc');
const open = require('open');
const ffmpeg = require('fluent-ffmpeg');
const { PythonShell } = require('python-shell');
const { ViscaCamera, ViscaCommand } = require('visca-over-ip');
const { Bonjour } = require('bonjour-service');
const fs = require('fs');

const PORT = 9356;
const OSC_PORT = 9357; // Listen on a different port for OSC
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

    console.log(`Starting FFmpeg for stream: ${rtspLink}`);

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
        });

    const stream = command.pipe();
    stream.on('data', (data) => {
        if (ws.readyState === 1) {
            ws.send(data, { binary: true });
        }
    });

    ws.on('close', () => {
        console.log(`Closing FFmpeg stream for: ${rtspLink}`);
        command.kill();
    });
});

// Store global state
const state = {
    cameras: {}, // Format: { id: { ip, rtsp, trackingEnabled: boolean } }
    viscaDevices: {} // Format: { id: Visca Camera instance }
};

// Persistent Configuration
let configPath = 'config.json';
try {
    if (fs.existsSync('.config_path')) {
        configPath = fs.readFileSync('.config_path', 'utf8').trim();
    }
} catch (e) {
    console.error("Error reading .config_path", e);
}

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

// Bonjour Discovery
const discoveredIps = new Set();
const bonjour = new Bonjour();
const browser = bonjour.find();

browser.on('up', (service) => {
    if (service.addresses && service.addresses.length > 0) {
        // Collect IPv4 addresses
        const ipv4 = service.addresses.filter(addr => addr.includes('.'));
        ipv4.forEach(addr => discoveredIps.add(addr));
    }
});

setInterval(() => {
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
}, 5000); // Broadcast discovered IPs every 5 seconds

// Function to initialize VISCA device
function initVisca(camId, ip) {
    console.log(`Initializing VISCA device for ${camId} at ${ip}...`);
    try {
        // visca-over-ip requires an IP and a port (default VISCA port is usually 5678 or 52381)
        const camera = new ViscaCamera(ip, 52381);
        console.log(`VISCA initialized for ${camId}`);
        state.viscaDevices[camId] = camera;
    } catch (err) {
        console.error(`VISCA init failed for ${camId}:`, err);
    }
}


    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'setup') {
                const trackingEnabled = state.cameras[data.camId] ? state.cameras[data.camId].trackingEnabled : false;
                state.cameras[data.camId] = { ip: data.camIp, rtsp: data.camRtsp, trackingEnabled };
                console.log(`UI Setup updated for ID ${data.camId}: IP=${data.camIp}, RTSP=${data.camRtsp}`);
                initVisca(data.camId, data.camIp);
                saveConfig();
            } else if (data.type === 'ptz_correction') {
                const trackingEnabled = state.cameras[data.camId] ? state.cameras[data.camId].trackingEnabled : false;
                if (!trackingEnabled) return;

function startPythonTracker(camId, rtsp, rect) {
    if (activeTrackers[camId]) {
        activeTrackers[camId].send(JSON.stringify({ type: 'update_rect', rect }));
        return;
    }
    console.log(`Starting python tracker for ${camId} on ${rtsp}`);
    const options = {
        mode: 'text',
        pythonPath: 'python3',
        pythonOptions: ['-u'], // get print results in real-time
        scriptPath: __dirname,

        args: [rtsp, JSON.stringify(rect)]
    };

    const pyshell = new PythonShell('tracker.py', options);
    activeTrackers[camId] = pyshell;

    pyshell.on('message', function (message) {
        try {
            const data = JSON.parse(message);
            if (data.type === 'tracking') {
                // Send VISCA commands
                const camera = state.viscaDevices[camId];
                if (camera && state.cameras[camId] && state.cameras[camId].trackingEnabled) {
                    let pan = data.pan;
                    let tilt = data.tilt;

                    if (Math.abs(pan) < 0.1) pan = 0;
                    if (Math.abs(tilt) < 0.1) tilt = 0;

                    if (pan !== 0 || tilt !== 0) {
                        let panSpeed = Math.floor(Math.abs(pan) * 24);
                        let tiltSpeed = Math.floor(Math.abs(tilt) * 20);

                        if (panSpeed > 24) panSpeed = 24;
                        if (panSpeed < 1 && pan !== 0) panSpeed = 1;
                        if (tiltSpeed > 20) tiltSpeed = 20;
                        if (tiltSpeed < 1 && tilt !== 0) tiltSpeed = 1;

                        let panDir = pan > 0 ? 'right' : (pan < 0 ? 'left' : 'stop');
                        let tiltDir = tilt > 0 ? 'up' : (tilt < 0 ? 'down' : 'stop');

                        let xSpeed = panDir === 'right' ? panSpeed : (panDir === 'left' ? -panSpeed : 0);
                        let ySpeed = tiltDir === 'up' ? tiltSpeed : (tiltDir === 'down' ? -tiltSpeed : 0);

                        camera.sendCommand(ViscaCommand.cameraPanTilt(xSpeed, ySpeed)).catch(e => {
                            console.error("PTZ Move Error", e);
                        });
                    } else {
                        camera.sendCommand(ViscaCommand.cameraPanTilt(0, 0, 0x03, 0x03)).catch(e => {
                            console.error("PTZ Stop Error", e);
                        });
                    }
                }

                // Broadcast rect back to UI to draw it
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
                console.log(`Tracking lost for ${camId}`);
                const camera = state.viscaDevices[camId];
                if (camera && state.cameras[camId] && state.cameras[camId].trackingEnabled) {
                    camera.sendCommand(ViscaCommand.cameraPanTilt(0, 0, 0x03, 0x03)).catch(e => {});
                }
            } else if (data.type === 'error') {
                console.error(`Tracker error for ${camId}:`, data.message);
            }
        } catch (e) {
            console.error("Error parsing tracker output:", e, message);
        }
    });

    pyshell.end(function (err, code, signal) {
        if (err) console.error(`Python shell error for ${camId}:`, err);
        console.log(`Python tracker stopped for ${camId}`);
        delete activeTrackers[camId];
    });
}

function stopPythonTracker(camId) {
    if (activeTrackers[camId]) {
        activeTrackers[camId].send(JSON.stringify({ type: 'stop' }));
        // It will delete itself on exit
    }
}

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
                state.cameras[data.camId] = { ip: data.camIp, rtsp: data.camRtsp, trackingEnabled };
                console.log(`UI Setup updated for ID ${data.camId}: IP=${data.camIp}, RTSP=${data.camRtsp}`);
                initVisca(data.camId, data.camIp);
            } else if (data.type === 'tracking_toggle') {
                if (state.cameras[data.camId]) {
                    state.cameras[data.camId].trackingEnabled = data.enabled;
                    console.log(`Tracking toggled via UI for ${data.camId}: ${data.enabled}`);

                    if (data.enabled && data.rect) {
                        startPythonTracker(data.camId, state.cameras[data.camId].rtsp, data.rect);
                    } else if (!data.enabled) {
                        stopPythonTracker(data.camId);
                        const camera = state.viscaDevices[data.camId];
                        if (camera) {
                            camera.sendCommand(ViscaCommand.cameraPanTilt(0, 0, 0x03, 0x03)).catch(e => {
                                console.error("PTZ Stop Error on Toggle", e);
                            });
                        }
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
                    const camera = state.viscaDevices[data.camId];
                    if (camera && state.cameras[data.camId].trackingEnabled) {
                        camera.sendCommand(ViscaCommand.cameraPanTilt(0, 0, 0x03, 0x03)).catch(() => {});
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
            }
        } catch (err) {
            console.error("Control WS parse error", err);
        }
    });
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
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

            // Stop camera if tracking is disabled
            if (!enabled) {
                stopPythonTracker(id);
                const camera = state.viscaDevices[id];
                if (camera) {
                    camera.sendCommand(ViscaCommand.cameraPanTilt(0, 0, 0x03, 0x03)).catch(e => {
                        console.error("PTZ Stop Error on OSC Toggle", e);
                    });
                }
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
    } else if (address === '/gui/open') {
        open(`http://localhost:${PORT}`);
    } else if (address === '/camera/setup') {
        if (args.length >= 2) {
            const id = args[0];
            const ip = args[1];
            const rtsp = `rtsp://${ip}:554/live/av0`;
            const trackingEnabled = state.cameras[id] ? state.cameras[id].trackingEnabled : false;
            state.cameras[id] = { ip, rtsp, trackingEnabled };
            console.log(`Camera setup updated for ID ${id}: IP=${ip}, RTSP=${rtsp}`);
            initVisca(id, ip);
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
