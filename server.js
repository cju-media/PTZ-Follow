const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const { Server } = require('node-osc');
const open = require('open');
const ffmpeg = require('fluent-ffmpeg');
const { Camera } = require('visca-over-ip');

const PORT = 9356;
const OSC_PORT = 9357; // Listen on a different port for OSC
const app = express();
const wsInstance = expressWs(app);

app.use(express.static(path.join(__dirname, 'public')));

// Video stream websocket handler
app.ws('/stream', (ws, req) => {
    const camId = req.query.id;
    const rtmpQuery = req.query.rtmp;

    // Resolve RTMP link: try from state first (OSC setup), then query param
    let rtmpLink = null;
    if (camId && state.cameras[camId] && state.cameras[camId].rtmp) {
        rtmpLink = state.cameras[camId].rtmp;
    } else if (rtmpQuery) {
        rtmpLink = rtmpQuery;
    }

    if (!rtmpLink) {
        console.error("No RTMP link provided or configured for the given ID.");
        ws.close();
        return;
    }

    console.log(`Starting FFmpeg for stream: ${rtmpLink}`);

    const command = ffmpeg(rtmpLink)
        .inputOptions([
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
        console.log(`Closing FFmpeg stream for: ${rtmpLink}`);
        command.kill();
    });
});

// Store global state
const state = {
    trackingEnabled: false,
    cameras: {}, // Format: { id: { ip, rtmp } }
    viscaDevices: {} // Format: { id: Visca Camera instance }
};

// Function to initialize VISCA device
function initVisca(camId, ip) {
    console.log(`Initializing VISCA device for ${camId} at ${ip}...`);
    try {
        const camera = new Camera(ip);
        console.log(`VISCA initialized for ${camId}`);
        state.viscaDevices[camId] = camera;
    } catch (err) {
        console.error(`VISCA init failed for ${camId}:`, err);
    }
}

// Control websocket handler for UI -> Server
app.ws('/control', (ws, req) => {
    // When a control client connects, send the current tracking state and cameras
    ws.send(JSON.stringify({
        type: 'state',
        trackingEnabled: state.trackingEnabled,
        cameras: state.cameras
    }));

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'setup') {
                state.cameras[data.camId] = { ip: data.camIp, rtmp: data.camRtmp };
                console.log(`UI Setup updated for ID ${data.camId}: IP=${data.camIp}, RTMP=${data.camRtmp}`);
                initVisca(data.camId, data.camIp);
            } else if (data.type === 'ptz_correction') {
                if (!state.trackingEnabled) return;

                const camera = state.viscaDevices[data.camId];
                if (camera) {
                    let pan = data.pan;
                    let tilt = data.tilt;

                    if (Math.abs(pan) < 0.1) pan = 0;
                    if (Math.abs(tilt) < 0.1) tilt = 0;

                    if (pan !== 0 || tilt !== 0) {
                        // VISCA speeds: Pan 0x01-0x18 (1-24), Tilt 0x01-0x14 (1-20)
                        let panSpeed = Math.floor(Math.abs(pan) * 24);
                        let tiltSpeed = Math.floor(Math.abs(tilt) * 20);

                        // clamp
                        if (panSpeed > 24) panSpeed = 24;
                        if (panSpeed < 1 && pan !== 0) panSpeed = 1;
                        if (tiltSpeed > 20) tiltSpeed = 20;
                        if (tiltSpeed < 1 && tilt !== 0) tiltSpeed = 1;

                        let panDir = pan > 0 ? 'right' : (pan < 0 ? 'left' : 'stop');
                        let tiltDir = tilt > 0 ? 'up' : (tilt < 0 ? 'down' : 'stop');

                        // In visca-over-ip, to do diagonal or single axis:
                        camera.ptz({
                            pan: panDir,
                            tilt: tiltDir,
                            panSpeed: panSpeed,
                            tiltSpeed: tiltSpeed
                        }).catch(e => {
                            console.error("PTZ Move Error", e);
                        });
                    } else {
                        camera.ptz({
                            pan: 'stop',
                            tilt: 'stop',
                            panSpeed: 1,
                            tiltSpeed: 1
                        }).catch(e => {
                            console.error("PTZ Stop Error", e);
                        });
                    }
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
        state.trackingEnabled = args[0] === 1;
        console.log(`Tracking enabled via OSC: ${state.trackingEnabled}`);
        // Broadcast state update to all UI clients so they can start/stop OpenCV
        wsInstance.getWss().clients.forEach(client => {
            if (client.readyState === 1) { // WebSocket.OPEN
                client.send(JSON.stringify({
                    type: 'state',
                    trackingEnabled: state.trackingEnabled,
                    cameras: state.cameras
                }));
            }
        });
    } else if (address === '/gui/open') {
        open(`http://localhost:${PORT}`);
    } else if (address === '/camera/setup') {
        if (args.length >= 3) {
            const id = args[0];
            const ip = args[1];
            const rtmp = args[2];
            state.cameras[id] = { ip, rtmp };
            console.log(`Camera setup updated for ID ${id}: IP=${ip}, RTMP=${rtmp}`);
            initVisca(id, ip);
            // Broadcast state update
            wsInstance.getWss().clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: 'state',
                        trackingEnabled: state.trackingEnabled,
                        cameras: state.cameras
                    }));
                }
            });
        }
    }
});
