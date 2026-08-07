const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${window.location.host}/stream`;
const controlUrl = `${wsProtocol}//${window.location.host}/control`;

class CameraTracker {
    constructor(camId, rtspLink, containerId) {
        this.camId = camId;
        this.rtspLink = rtspLink;
        this.container = document.getElementById(containerId);

        this.player = null;
        this.isDrawing = false;
        this.startX = 0;
        this.startY = 0;
        this.currentRect = null;

        this.isTracking = false;
        this.movementPaused = false;
        this.tracker = null;
        this.src = null;
        this.dst = null;

        this.initUI();
        this.initVideo();
        this.initEvents();
    }

    initUI() {
        this.container.innerHTML = `
            <div class="camera-card" id="card-${this.camId}">
                <h3>${this.camId}</h3>
                <div class="camera-canvas-container">
                    <canvas id="video-${this.camId}" width="640" height="480"></canvas>
                    <canvas id="overlay-${this.camId}" width="640" height="480" style="position: absolute; top: 0; left: 0; pointer-events: none;"></canvas>
                </div>
                <div class="camera-controls">
                    <button id="track-btn-${this.camId}">Enable Tracking</button>
                    <button id="pause-btn-${this.camId}" disabled>Pause Movement</button>
                </div>
            </div>
        `;

        this.videoCanvas = document.getElementById(`video-${this.camId}`);
        this.overlayCanvas = document.getElementById(`overlay-${this.camId}`);
        this.ctx = this.overlayCanvas.getContext('2d');
        this.trackBtn = document.getElementById(`track-btn-${this.camId}`);
        this.pauseBtn = document.getElementById(`pause-btn-${this.camId}`);
    }

    initVideo() {
        if (this.player) this.player.destroy();
        const streamUrl = `${wsUrl}?id=${encodeURIComponent(this.camId)}&rtsp=${encodeURIComponent(this.rtspLink)}`;
        this.player = new JSMpeg.Player(streamUrl, {
            canvas: this.videoCanvas,
            autoplay: true,
            audio: false,
            disableGl: false
        });
    }

    initEvents() {
        this.videoCanvas.addEventListener('mousedown', (e) => {
            this.isDrawing = true;
            const rect = this.videoCanvas.getBoundingClientRect();
            // Calculate scale
            const scaleX = this.videoCanvas.width / rect.width;
            const scaleY = this.videoCanvas.height / rect.height;

            this.startX = (e.clientX - rect.left) * scaleX;
            this.startY = (e.clientY - rect.top) * scaleY;
            this.currentRect = null;
        });

        this.videoCanvas.addEventListener('mousemove', (e) => {
            if (!this.isDrawing) return;

            const rect = this.videoCanvas.getBoundingClientRect();
            const scaleX = this.videoCanvas.width / rect.width;
            const scaleY = this.videoCanvas.height / rect.height;

            const mouseX = (e.clientX - rect.left) * scaleX;
            const mouseY = (e.clientY - rect.top) * scaleY;

            const width = mouseX - this.startX;
            const height = mouseY - this.startY;

            this.currentRect = {
                x: width > 0 ? this.startX : mouseX,
                y: height > 0 ? this.startY : mouseY,
                width: Math.abs(width),
                height: Math.abs(height)
            };

            this.drawOverlay();
        });

        this.videoCanvas.addEventListener('mouseup', () => {
            this.isDrawing = false;
            if (this.currentRect && (this.currentRect.width < 10 || this.currentRect.height < 10)) {
                this.currentRect = null;
            }
            this.drawOverlay();

            // Auto-start tracking as soon as a valid box is drawn, so there's no extra click
            // (and thus no extra delay) between drawing the box and the camera acting on it.
            if (this.currentRect) {
                this.enableTracking();
            }
        });

        this.trackBtn.addEventListener('click', () => {
            if (this.isTracking) {
                this.disableTracking();
            } else if (this.currentRect) {
                this.enableTracking();
            } else {
                alert('Please draw a bounding box first.');
            }
        });

        this.pauseBtn.addEventListener('click', () => {
            this.setMovementPaused(!this.movementPaused);
        });
    }

    // Pausing does NOT stop object tracking - the box keeps following the subject - it just
    // withholds the VISCA pan/tilt commands so the camera itself stops moving.
    setMovementPaused(paused) {
        if (window.controlWs && window.controlWs.readyState === WebSocket.OPEN) {
            window.controlWs.send(JSON.stringify({ type: 'movement_pause', camId: this.camId, paused }));
        }
        this.movementPaused = paused;
        this.pauseBtn.textContent = paused ? 'Resume Movement' : 'Pause Movement';
        this.pauseBtn.classList.toggle('paused', paused);
    }

    enableTracking() {
        if (!this.currentRect) return;
        if (window.controlWs && window.controlWs.readyState === WebSocket.OPEN) {
            window.controlWs.send(JSON.stringify({
                type: 'tracking_toggle',
                camId: this.camId,
                enabled: true,
                rect: this.currentRect
            }));
        }
        this.isTracking = true;
        this.trackBtn.textContent = 'Disable Tracking';
        this.trackBtn.classList.add('tracking-active');
        this.pauseBtn.disabled = false;
        // A fresh enable always starts unpaused, mirroring the server's reset-on-enable behavior.
        this.movementPaused = false;
        this.pauseBtn.textContent = 'Pause Movement';
        this.pauseBtn.classList.remove('paused');
    }

    disableTracking() {
        if (window.controlWs && window.controlWs.readyState === WebSocket.OPEN) {
            window.controlWs.send(JSON.stringify({ type: 'tracking_toggle', camId: this.camId, enabled: false }));
        }
        this.stopTracker();
        this.trackBtn.textContent = 'Enable Tracking';
        this.trackBtn.classList.remove('tracking-active');
        this.pauseBtn.disabled = true;
        this.movementPaused = false;
        this.pauseBtn.textContent = 'Pause Movement';
        this.pauseBtn.classList.remove('paused');
    }

    drawOverlay() {
        this.ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
        if (this.currentRect) {
            this.ctx.strokeStyle = 'red';
            this.ctx.lineWidth = 2;
            this.ctx.strokeRect(this.currentRect.x, this.currentRect.y, this.currentRect.width, this.currentRect.height);
        }
    }

    stopTracker() {
        this.isTracking = false;

        this.drawOverlay();
    }

    destroy() {
        this.isTracking = false;
        if (this.player) {
            this.player.destroy();
        }
        this.container.remove();
    }



    setServerTrackingState(enabled) {
        if (enabled && !this.isTracking) {
             this.isTracking = true;
             this.trackBtn.textContent = 'Disable Tracking';
             this.trackBtn.classList.add('tracking-active');
             this.pauseBtn.disabled = false;
        } else if (!enabled && this.isTracking) {
             this.stopTracker();
             this.trackBtn.textContent = 'Enable Tracking';
             this.trackBtn.classList.remove('tracking-active');
             this.pauseBtn.disabled = true;
        }
    }

    // Syncs the pause button to server state - lets OSC-triggered pause/resume (or another
    // browser tab) reflect here without a page reload.
    setServerMovementPaused(paused) {
        if (paused === this.movementPaused) return;
        this.movementPaused = paused;
        this.pauseBtn.textContent = paused ? 'Resume Movement' : 'Pause Movement';
        this.pauseBtn.classList.toggle('paused', paused);
    }
}

// Global State
let cameraTrackers = {};
let serverCameras = {};

function syncCameraGrid(cameras) {
    const grid = document.getElementById('camera-grid');

    // Check for removed cameras
    Object.keys(cameraTrackers).forEach(id => {
        if (!cameras[id]) {
            cameraTrackers[id].destroy();
            delete cameraTrackers[id];
        }
    });

    // Check for new/updated cameras
    Object.keys(cameras).forEach(id => {
        if (!cameraTrackers[id]) {
            // Create container for new camera
            const container = document.createElement('div');
            container.id = `tracker-container-${id}`;
            grid.appendChild(container);

            // Init new tracker
            cameraTrackers[id] = new CameraTracker(id, cameras[id].rtsp, container.id);
        } else if (cameraTrackers[id].rtspLink !== cameras[id].rtsp) {
            // Re-init video if RTSP changed
            cameraTrackers[id].rtspLink = cameras[id].rtsp;
            cameraTrackers[id].initVideo();
        }

        // Sync tracking state
        cameraTrackers[id].setServerTrackingState(cameras[id].trackingEnabled);
        cameraTrackers[id].setServerMovementPaused(!!cameras[id].movementPaused);
    });
}

// Modal Logic
const modal = document.getElementById("camera-modal");
const btn = document.getElementById("open-modal-btn");
const span = document.getElementsByClassName("camera-modal-close")[0];
const addCamBtn = document.getElementById("add-cam-btn");
const cameraList = document.getElementById("camera-list");
const rescanNetworkBtn = document.getElementById("rescan-network-btn");

rescanNetworkBtn.onclick = function() {
    if (window.controlWs && window.controlWs.readyState === WebSocket.OPEN) {
        window.controlWs.send(JSON.stringify({ type: 'rescan_network' }));
        rescanNetworkBtn.disabled = true;
        rescanNetworkBtn.textContent = 'Scanning...';
        // The scan typically finishes in a few seconds; re-enable regardless of when the
        // resulting 'discovered_cameras' broadcast actually arrives.
        setTimeout(() => {
            rescanNetworkBtn.disabled = false;
            rescanNetworkBtn.textContent = 'Rescan Network for Cameras';
        }, 5000);
    }
};

btn.onclick = function() {
  modal.style.display = "block";
  renderCameraList();
}

span.onclick = function() {
  modal.style.display = "none";
}

window.onclick = function(event) {
  if (event.target == modal) {
    modal.style.display = "none";
  }
  if (event.target == consoleModal) {
    closeConsole();
  }
}

// Console Logic - the packaged app has no visible Terminal window, so this is the only way to
// see server-side log output (VISCA sends, tracker status, errors, etc).
const consoleModal = document.getElementById("console-modal");
const openConsoleBtn = document.getElementById("open-console-btn");
const consoleCloseBtn = document.getElementsByClassName("console-close")[0];
const consoleClearBtn = document.getElementById("console-clear-btn");
const consoleOutput = document.getElementById("console-output");
let consoleWs = null;

function appendConsoleLine(line) {
    const div = document.createElement('div');
    div.className = 'log-line';
    const levelMatch = line.match(/\[(LOG|WARN|ERROR)\]/);
    if (levelMatch) div.classList.add(`level-${levelMatch[1]}`);
    div.textContent = line;
    consoleOutput.appendChild(div);
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function openConsole() {
    consoleModal.style.display = "block";
    consoleOutput.innerHTML = '';

    consoleWs = new WebSocket(`${wsProtocol}//${window.location.host}/console`);
    consoleWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'history') {
                data.lines.forEach(appendConsoleLine);
            } else if (data.type === 'log') {
                appendConsoleLine(data.line);
            }
        } catch (err) {
            console.error("Console WS parse error", err);
        }
    };
}

function closeConsole() {
    consoleModal.style.display = "none";
    if (consoleWs) {
        consoleWs.close();
        consoleWs = null;
    }
}

openConsoleBtn.onclick = openConsole;
consoleCloseBtn.onclick = closeConsole;
consoleClearBtn.onclick = () => { consoleOutput.innerHTML = ''; };

// Quit App Logic - removing the visible Terminal window (the old way to stop the app) means
// the GUI needs its own way to shut the server down cleanly.
const quitAppBtn = document.getElementById("quit-app-btn");
quitAppBtn.onclick = () => {
    if (!confirm('Quit PTZ Follow? This will stop the server and all camera tracking.')) return;
    if (window.controlWs && window.controlWs.readyState === WebSocket.OPEN) {
        window.controlWs.send(JSON.stringify({ type: 'shutdown' }));
    }
    quitAppBtn.disabled = true;
    quitAppBtn.textContent = 'Shutting down...';
};

function renderCameraList() {
    cameraList.innerHTML = '';
    Object.keys(serverCameras).forEach(id => {
        const cam = serverCameras[id];
        const statusClass = cam.trackingEnabled ? 'connected' : 'disconnected'; // Or real ping status if implemented
        // We will just use 'connected' as a placeholder for it exists in state

        const camItem = document.createElement('div');
        camItem.className = 'cam-list-item';
        camItem.innerHTML = `
            <div class="cam-list-header" onclick="this.nextElementSibling.classList.toggle('expanded')">
                <span><span class="cam-status connected"></span> ${id}</span>
                <span>▼</span>
            </div>
            <div class="cam-details">
                <div class="form-group">
                    <label>Camera IP:</label>
                    <input type="text" id="edit-ip-${id}" value="${cam.ip}">
                </div>
                <div class="modal-actions">
                    <button class="btn btn-remove" onclick="removeCamera('${id}')">Remove</button>
                    <button class="btn btn-save" onclick="updateCamera('${id}')">Save Changes</button>
                </div>
            </div>
        `;
        cameraList.appendChild(camItem);
    });
}

addCamBtn.onclick = function() {
    const newId = `cam${Object.keys(serverCameras).length + 1}`;

    const camItem = document.createElement('div');
    camItem.className = 'cam-list-item';
    camItem.innerHTML = `
        <div class="cam-list-header" onclick="this.nextElementSibling.classList.toggle('expanded')">
            <span><span class="cam-status disconnected"></span> New Camera</span>
            <span>▼</span>
        </div>
        <div class="cam-details expanded">
            <div class="form-group">
                <label>Camera ID:</label>
                <input type="text" id="new-id" value="${newId}">
            </div>
            <div class="form-group">
                <label>Camera IP:</label>
                <input type="text" id="new-ip" list="discovered-ips" placeholder="192.168.1.100">
            </div>
            <div class="modal-actions">
                <button class="btn btn-save" onclick="addNewCamera(this)">Add</button>
            </div>
        </div>
    `;
    cameraList.appendChild(camItem);
};

window.addNewCamera = function(btnElem) {
    const parent = btnElem.closest('.cam-details');
    const id = parent.querySelector('#new-id').value;
    const ip = parent.querySelector('#new-ip').value;

    if (id && ip) {
        const rtsp = `rtsp://${ip}:554/live/av0`;
        if (window.controlWs && window.controlWs.readyState === WebSocket.OPEN) {
            window.controlWs.send(JSON.stringify({ type: 'setup', camId: id, camIp: ip, camRtsp: rtsp }));
        }
    } else {
        alert("Please fill all fields");
    }
};

window.updateCamera = function(id) {
    const ip = document.getElementById(`edit-ip-${id}`).value;

    if (ip) {
        const rtsp = `rtsp://${ip}:554/live/av0`;
        if (window.controlWs && window.controlWs.readyState === WebSocket.OPEN) {
            window.controlWs.send(JSON.stringify({ type: 'setup', camId: id, camIp: ip, camRtsp: rtsp }));
        }
    } else {
        alert("Please fill all fields");
    }
};

window.removeCamera = function(id) {
    if (window.controlWs && window.controlWs.readyState === WebSocket.OPEN) {
        window.controlWs.send(JSON.stringify({ type: 'remove_camera', camId: id }));
    }
};

function initControlWs() {
    if (!window.controlWs || window.controlWs.readyState !== WebSocket.OPEN) {
        window.controlWs = new WebSocket(controlUrl);

        window.controlWs.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'state') {
                    serverCameras = data.cameras;
                    syncCameraGrid(serverCameras);
                    if (modal.style.display === "block") {
                        // Re-render modal if open to show changes
                        renderCameraList();
                    }
                } else if (data.type === 'tracking_update') {
                    if (cameraTrackers[data.camId]) {
                        cameraTrackers[data.camId].currentRect = data.rect;
                        cameraTrackers[data.camId].drawOverlay();
                    }
                } else if (data.type === 'discovered_cameras') {
                    const datalist = document.getElementById('discovered-ips');
                    if (datalist) {
                        datalist.innerHTML = ''; // clear old
                        data.ips.forEach(ip => {
                            const opt = document.createElement('option');
                            opt.value = ip;
                            datalist.appendChild(opt);
                        });
                    }
                } else if (data.type === 'shutting_down') {
                    window.intentionalShutdown = true;
                    document.body.innerHTML = '<div style="text-align:center; margin-top:15%; font-family:sans-serif; color:#666;"><h1>PTZ Follow has been shut down</h1><p>You can close this window.</p></div>';
                }
            } catch (err) {
                console.error("Control WS parse error", err);
            }
        };

        window.controlWs.onclose = () => {
            // Don't keep trying to reconnect to a server we deliberately just told to quit.
            if (!window.intentionalShutdown) {
                setTimeout(initControlWs, 2000); // Reconnect
            }
        };
    }
}

initControlWs();

// Save and Load Config Logic
document.getElementById('save-config-btn').addEventListener('click', () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(serverCameras, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", dataStr);
    dlAnchorElem.setAttribute("download", "ptz_tracker_config.json");
    dlAnchorElem.click();
});

const loadConfigBtn = document.getElementById('load-config-btn');
const loadConfigInput = document.getElementById('load-config-input');

loadConfigBtn.addEventListener('click', () => {
    loadConfigInput.click();
});

loadConfigInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const config = JSON.parse(e.target.result);

                if (window.controlWs && window.controlWs.readyState === WebSocket.OPEN) {
                    // Remove existing cameras
                    Object.keys(serverCameras).forEach(id => {
                         window.controlWs.send(JSON.stringify({ type: 'remove_camera', camId: id }));
                    });

                    // Add new cameras from config
                    setTimeout(() => {
                        Object.keys(config).forEach(id => {
                            const camData = config[id];
                            if (camData && camData.ip && camData.rtsp) {
                                window.controlWs.send(JSON.stringify({
                                    type: 'setup',
                                    camId: id,
                                    camIp: camData.ip,
                                    camRtsp: camData.rtsp
                                }));
                            }
                        });
                    }, 500); // Wait a moment for removes to process
                } else {
                    alert("Not connected to server.");
                }
            } catch (err) {
                console.error("Error parsing config JSON", err);
                alert("Invalid configuration file.");
            }
        };
        reader.readAsText(file);
        loadConfigInput.value = ''; // Reset input
    }
});
