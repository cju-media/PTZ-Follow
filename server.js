const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const { Server } = require('node-osc');
const open = require('open');
const ffmpeg = require('fluent-ffmpeg');
const onvif = require('node-onvif');

const PORT = 9356;
const OSC_PORT = 9357; // Listen on a different port for OSC
const app = express();
expressWs(app);

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
    onvifDevices: {} // Format: { id: OnvifDevice instance }
};

// Function to initialize ONVIF device
function initOnvif(camId, ip) {
    if (state.onvifDevices[camId]) {
        return; // Already initialized
    }
    console.log(`Initializing ONVIF device for ${camId} at ${ip}...`);
    const device = new onvif.OnvifDevice({
        xaddr: `http://${ip}/onvif/device_service`
    });

    device.init().then(() => {
        console.log(`ONVIF initialized for ${camId}`);
        state.onvifDevices[camId] = device;
    }).catch(err => {
        console.error(`ONVIF init failed for ${camId}:`, err);
    });
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
                initOnvif(data.camId, data.camIp);
            } else if (data.type === 'ptz_correction') {
                if (!state.trackingEnabled) return;

                const device = state.onvifDevices[data.camId];
                if (device) {
                    let pan = data.pan;
                    let tilt = data.tilt;

                    if (Math.abs(pan) < 0.1) pan = 0;
                    if (Math.abs(tilt) < 0.1) tilt = 0;

                    if (pan !== 0 || tilt !== 0) {
                        const profileToken = device.getCurrentProfile().token;
                        device.services.ptz.continuousMove({
                            ProfileToken: profileToken,
                            Velocity: {
                                PanTilt: { x: pan, y: tilt },
                                Zoom: { x: 0 }
                            }
                        }).catch(e => {
                           console.error("PTZ ContinuousMove Error", e);
                        });
                    } else {
                        const profileToken = device.getCurrentProfile().token;
                        device.services.ptz.stop({
                            ProfileToken: profileToken,
                            PanTilt: true,
                            Zoom: true
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
        expressWs.getWss().clients.forEach(client => {
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
            initOnvif(id, ip);
            // Broadcast state update
            expressWs.getWss().clients.forEach(client => {
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
