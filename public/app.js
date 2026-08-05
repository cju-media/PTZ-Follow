// Initialize WebSocket
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${window.location.host}/stream`;

// Initialize JSMpeg
const videoCanvas = document.getElementById('video-canvas');
let player = null;

function startVideo(camId, rtmpLink) {
    if (player) {
        player.destroy();
    }
    const streamUrl = `${wsUrl}?id=${encodeURIComponent(camId)}&rtmp=${encodeURIComponent(rtmpLink)}`;
    player = new JSMpeg.Player(streamUrl, {
        canvas: videoCanvas,
        autoplay: true,
        audio: false
    });
}

// Bounding box drawing
const overlayCanvas = document.getElementById('overlay-canvas');
const ctx = overlayCanvas.getContext('2d');

let isDrawing = false;
let startX = 0, startY = 0;
let currentRect = null; // { x, y, width, height }

videoCanvas.addEventListener('mousedown', (e) => {
    isDrawing = true;
    const rect = videoCanvas.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    currentRect = null; // Reset previous drawing
});

videoCanvas.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;

    const rect = videoCanvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const width = mouseX - startX;
    const height = mouseY - startY;

    currentRect = {
        x: width > 0 ? startX : mouseX,
        y: height > 0 ? startY : mouseY,
        width: Math.abs(width),
        height: Math.abs(height)
    };

    drawOverlay();
});

videoCanvas.addEventListener('mouseup', () => {
    isDrawing = false;
    if (currentRect && (currentRect.width < 10 || currentRect.height < 10)) {
        currentRect = null; // Ignore tiny clicks
    }
    drawOverlay();
});

function drawOverlay() {
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    if (currentRect) {
        ctx.strokeStyle = 'red';
        ctx.lineWidth = 2;
        ctx.strokeRect(currentRect.x, currentRect.y, currentRect.width, currentRect.height);
    }
}

// OpenCV Tracking Logic
let isTracking = false;
let tracker = null;
let src = null;
let dst = null;

// The OpenCV.js load is asynchronous, we must wait for it to be ready
function initTracker() {
    if (!tracker) {
        tracker = new cv.TrackerCSRT();
    }
    src = new cv.Mat(videoCanvas.height, videoCanvas.width, cv.CV_8UC4);
    dst = new cv.Mat(videoCanvas.height, videoCanvas.width, cv.CV_8UC4);

    const rect = new cv.Rect(currentRect.x, currentRect.y, currentRect.width, currentRect.height);
    const videoCtx = videoCanvas.getContext('2d');
    const imageData = videoCtx.getImageData(0, 0, videoCanvas.width, videoCanvas.height);
    src.data.set(imageData.data);

    tracker.init(src, rect);
    isTracking = true;
    requestAnimationFrame(processVideo);
}

function stopTracker() {
    isTracking = false;
    if (src) src.delete();
    if (dst) dst.delete();
    // if (tracker) tracker.delete(); // Might throw, better to just let GC or reset
    src = null;
    dst = null;
    currentRect = null;
    drawOverlay();
}

function processVideo() {
    if (!isTracking || !currentRect) return;

    try {
        const videoCtx = videoCanvas.getContext('2d');
        const imageData = videoCtx.getImageData(0, 0, videoCanvas.width, videoCanvas.height);
        src.data.set(imageData.data);

        // Update the tracker
        let newRect = new cv.Rect();
        const success = tracker.update(src, newRect);

        if (success) {
            currentRect = {
                x: newRect.x,
                y: newRect.y,
                width: newRect.width,
                height: newRect.height
            };
            drawOverlay();

            // Calculate center deviation
            const centerX = currentRect.x + currentRect.width / 2;
            const centerY = currentRect.y + currentRect.height / 2;
            const frameCenterX = videoCanvas.width / 2;
            const frameCenterY = videoCanvas.height / 2;

            // Normalized deviation (-1 to 1)
            const devX = (centerX - frameCenterX) / frameCenterX;
            const devY = (centerY - frameCenterY) / frameCenterY;

            // Send correction to server via WebSocket
            const controlProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const controlUrl = `${controlProtocol}//${window.location.host}/control`;
            if (!window.controlWs || window.controlWs.readyState !== WebSocket.OPEN) {
                window.controlWs = new WebSocket(controlUrl);
            } else {
                const camId = document.getElementById('cam-id').value;
                if (camId) {
                    window.controlWs.send(JSON.stringify({
                        type: 'ptz_correction',
                        camId: camId,
                        pan: devX,
                        tilt: -devY // Invert Y for tilt
                    }));
                }
            }

        } else {
            console.log("Tracking lost");
            // Optionally stop tracking or keep trying
        }
    } catch (err) {
        console.error(err);
    }

    if (isTracking) {
        requestAnimationFrame(processVideo);
    }
}

const controlProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const controlUrl = `${controlProtocol}//${window.location.host}/control`;

function initControlWs() {
    if (!window.controlWs || window.controlWs.readyState !== WebSocket.OPEN) {
        window.controlWs = new WebSocket(controlUrl);

        window.controlWs.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'state') {
                    // Update UI and tracker based on OSC state from server

                    // 1. Toggle tracking based on OSC state
                    const btn = document.getElementById('tracking-btn');
                    if (data.trackingEnabled && !isTracking && typeof cv !== 'undefined' && cv.TrackerCSRT && currentRect) {
                         initTracker();
                         btn.textContent = 'Disable Tracking';
                    } else if (!data.trackingEnabled && isTracking) {
                         stopTracker();
                         btn.textContent = 'Enable Tracking';
                    }

                    // 2. We can auto-fill and start video if cameras are setup via OSC
                    const camIdInput = document.getElementById('cam-id');
                    if (data.cameras && Object.keys(data.cameras).length > 0) {
                        const firstCamId = Object.keys(data.cameras)[0];
                        const camData = data.cameras[firstCamId];

                        if (!player) {
                             camIdInput.value = firstCamId;
                             document.getElementById('cam-ip').value = camData.ip;
                             document.getElementById('cam-rtmp').value = camData.rtmp;
                             startVideo(firstCamId, camData.rtmp);
                        }
                    }
                }
            } catch (err) {
                console.error("Control WS parse error", err);
            }
        };

        window.controlWs.onclose = () => {
            setTimeout(initControlWs, 2000); // Reconnect
        };
    }
}

initControlWs();

document.getElementById('setup-btn').addEventListener('click', () => {
    const camId = document.getElementById('cam-id').value;
    const camIp = document.getElementById('cam-ip').value;
    const camRtmp = document.getElementById('cam-rtmp').value;

    if (camId && camIp && camRtmp) {
        if (!window.controlWs || window.controlWs.readyState !== WebSocket.OPEN) {
            initControlWs();
            window.controlWs.onopen = () => {
                window.controlWs.send(JSON.stringify({ type: 'setup', camId, camIp, camRtmp }));
            };
        } else {
            window.controlWs.send(JSON.stringify({ type: 'setup', camId, camIp, camRtmp }));
        }

        startVideo(camRtmp);
    } else {
        alert("Please fill all fields");
    }
});

document.getElementById('tracking-btn').addEventListener('click', () => {
    const btn = document.getElementById('tracking-btn');
    if (isTracking) {
        stopTracker();
        btn.textContent = 'Enable Tracking';
    } else {
        if (typeof cv !== 'undefined' && cv.TrackerCSRT && currentRect) {
            initTracker();
            btn.textContent = 'Disable Tracking';
        } else {
            alert('Please draw a bounding box first or wait for OpenCV to load.');
        }
    }
});
