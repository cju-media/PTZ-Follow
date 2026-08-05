const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${window.location.host}/stream`;
const controlUrl = `${wsProtocol}//${window.location.host}/control`;

class CameraTracker {
    constructor(camId, rtmpLink, containerId) {
        this.camId = camId;
        this.rtmpLink = rtmpLink;
        this.container = document.getElementById(containerId);

        this.player = null;
        this.isDrawing = false;
        this.startX = 0;
        this.startY = 0;
        this.currentRect = null;

        this.isTracking = false;
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
                <button id="track-btn-${this.camId}">Enable Tracking</button>
            </div>
        `;

        this.videoCanvas = document.getElementById(`video-${this.camId}`);
        this.overlayCanvas = document.getElementById(`overlay-${this.camId}`);
        this.ctx = this.overlayCanvas.getContext('2d');
        this.trackBtn = document.getElementById(`track-btn-${this.camId}`);
    }

    initVideo() {
        if (this.player) this.player.destroy();
        const streamUrl = `${wsUrl}?id=${encodeURIComponent(this.camId)}&rtmp=${encodeURIComponent(this.rtmpLink)}`;
        this.player = new JSMpeg.Player(streamUrl, {
            canvas: this.videoCanvas,
            autoplay: true,
            audio: false,
            disableGl: true
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
        });

        this.trackBtn.addEventListener('click', () => {
            if (this.isTracking) {
                if (window.controlWs && window.controlWs.readyState === WebSocket.OPEN) {
                     window.controlWs.send(JSON.stringify({ type: 'tracking_toggle', camId: this.camId, enabled: false }));
                }
                this.stopTracker();
                this.trackBtn.textContent = 'Enable Tracking';
                this.trackBtn.classList.remove('tracking-active');
            } else {
                if (typeof cv !== 'undefined' && cv.TrackerCSRT && this.currentRect) {
                    if (window.controlWs && window.controlWs.readyState === WebSocket.OPEN) {
                         window.controlWs.send(JSON.stringify({ type: 'tracking_toggle', camId: this.camId, enabled: true }));
                    }
                    this.initTracker();
                    this.trackBtn.textContent = 'Disable Tracking';
                    this.trackBtn.classList.add('tracking-active');
                } else {
                    alert('Please draw a bounding box first or wait for OpenCV to load.');
                }
            }
        });
    }

    drawOverlay() {
        this.ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
        if (this.currentRect) {
            this.ctx.strokeStyle = 'red';
            this.ctx.lineWidth = 2;
            this.ctx.strokeRect(this.currentRect.x, this.currentRect.y, this.currentRect.width, this.currentRect.height);
        }
    }

    initTracker() {
        if (!this.tracker) {
            this.tracker = new cv.TrackerCSRT();
        }
        this.src = new cv.Mat(this.videoCanvas.height, this.videoCanvas.width, cv.CV_8UC4);
        this.dst = new cv.Mat(this.videoCanvas.height, this.videoCanvas.width, cv.CV_8UC4);

        const rect = new cv.Rect(this.currentRect.x, this.currentRect.y, this.currentRect.width, this.currentRect.height);
        const videoCtx = this.videoCanvas.getContext('2d');
        const imageData = videoCtx.getImageData(0, 0, this.videoCanvas.width, this.videoCanvas.height);
        this.src.data.set(imageData.data);

        this.tracker.init(this.src, rect);
        this.isTracking = true;

        this.processVideo();
    }

    stopTracker() {
        this.isTracking = false;
        if (this.src) this.src.delete();
        if (this.dst) this.dst.delete();
        this.src = null;
        this.dst = null;
        this.currentRect = null;
        this.drawOverlay();
    }

    processVideo() {
        if (!this.isTracking || !this.currentRect) return;

        try {
            const videoCtx = this.videoCanvas.getContext('2d');
            const imageData = videoCtx.getImageData(0, 0, this.videoCanvas.width, this.videoCanvas.height);
            this.src.data.set(imageData.data);

            let newRect = new cv.Rect();
            const success = this.tracker.update(this.src, newRect);

            if (success) {
                this.currentRect = {
                    x: newRect.x,
                    y: newRect.y,
                    width: newRect.width,
                    height: newRect.height
                };
                this.drawOverlay();

                const centerX = this.currentRect.x + this.currentRect.width / 2;
                const centerY = this.currentRect.y + this.currentRect.height / 2;
                const frameCenterX = this.videoCanvas.width / 2;
                const frameCenterY = this.videoCanvas.height / 2;

                const devX = (centerX - frameCenterX) / frameCenterX;
                const devY = (centerY - frameCenterY) / frameCenterY;

                if (window.controlWs && window.controlWs.readyState === WebSocket.OPEN) {
                    window.controlWs.send(JSON.stringify({
                        type: 'ptz_correction',
                        camId: this.camId,
                        pan: devX,
                        tilt: -devY
                    }));
                }
            } else {
                console.log(`Tracking lost for ${this.camId}`);
                if (window.controlWs && window.controlWs.readyState === WebSocket.OPEN) {
                     window.controlWs.send(JSON.stringify({
                         type: 'ptz_correction',
                         camId: this.camId,
                         pan: 0,
                         tilt: 0
                     }));
                }
            }
        } catch (err) {
            console.error(err);
        }

        if (this.isTracking) {
            setTimeout(() => this.processVideo(), 100);
        }
    }

    destroy() {
        this.isTracking = false;
        if (this.player) {
            this.player.destroy();
        }
        this.container.innerHTML = '';
    }

    setServerTrackingState(enabled) {
        if (enabled && !this.isTracking && typeof cv !== 'undefined' && cv.TrackerCSRT && this.currentRect) {
             this.initTracker();
             this.trackBtn.textContent = 'Disable Tracking';
             this.trackBtn.classList.add('tracking-active');
        } else if (!enabled && this.isTracking) {
             this.stopTracker();
             this.trackBtn.textContent = 'Enable Tracking';
             this.trackBtn.classList.remove('tracking-active');
        }
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
            cameraTrackers[id] = new CameraTracker(id, cameras[id].rtmp, container.id);
        } else if (cameraTrackers[id].rtmpLink !== cameras[id].rtmp) {
            // Re-init video if RTMP changed
            cameraTrackers[id].rtmpLink = cameras[id].rtmp;
            cameraTrackers[id].initVideo();
        }

        // Sync tracking state
        cameraTrackers[id].setServerTrackingState(cameras[id].trackingEnabled);
    });
}

// Modal Logic
const modal = document.getElementById("camera-modal");
const btn = document.getElementById("open-modal-btn");
const span = document.getElementsByClassName("close")[0];
const addCamBtn = document.getElementById("add-cam-btn");
const cameraList = document.getElementById("camera-list");

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
}

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
                    <label>VISCA IP:</label>
                    <input type="text" id="edit-ip-${id}" value="${cam.ip}">
                </div>
                <div class="form-group">
                    <label>RTMP Link:</label>
                    <input type="text" id="edit-rtmp-${id}" value="${cam.rtmp}">
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
                <label>VISCA IP:</label>
                <input type="text" id="new-ip" list="discovered-ips" placeholder="192.168.1.100">
            </div>
            <div class="form-group">
                <label>RTMP Link:</label>
                <input type="text" id="new-rtmp" placeholder="rtmp://...">
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
    const rtmp = parent.querySelector('#new-rtmp').value;

    if (id && ip && rtmp) {
        if (window.controlWs && window.controlWs.readyState === WebSocket.OPEN) {
            window.controlWs.send(JSON.stringify({ type: 'setup', camId: id, camIp: ip, camRtmp: rtmp }));
        }
    } else {
        alert("Please fill all fields");
    }
};

window.updateCamera = function(id) {
    const ip = document.getElementById(`edit-ip-${id}`).value;
    const rtmp = document.getElementById(`edit-rtmp-${id}`).value;

    if (ip && rtmp) {
        if (window.controlWs && window.controlWs.readyState === WebSocket.OPEN) {
            window.controlWs.send(JSON.stringify({ type: 'setup', camId: id, camIp: ip, camRtmp: rtmp }));
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
                            if (camData && camData.ip && camData.rtmp) {
                                window.controlWs.send(JSON.stringify({
                                    type: 'setup',
                                    camId: id,
                                    camIp: camData.ip,
                                    camRtmp: camData.rtmp
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
