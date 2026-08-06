# PTZ Auto Tracker

A Node.js server that tracks a subject using a PTZ camera via the VISCA over IP protocol. It features a web GUI for drawing a tracking bounding box over an RTSP video stream and supports OSC commands for integration with other software.

## Features

- **Web UI Tracking:** Draw a bounding box around a subject on the web interface to automatically track them.
- **VISCA over IP:** Uses `visca-over-ip` for pan/tilt control.
- **Low Latency Video:** Transcodes RTSP to MPEG1 using `fluent-ffmpeg` and streams to the browser via WebSockets (JSMpeg).
- **OSC Control:** Full control over tracking and camera setup via OSC.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the server:
   ```bash
   node server.js
   ```
3. Open the GUI at `http://localhost:9356` or use the `/gui/open` OSC command.

## OSC Commands

The server listens for OSC messages on port **9357**.

| Address | Arguments | Description |
| :--- | :--- | :--- |
| `/tracking` | `String` (id), `Integer` (1 or 0) | Toggles tracking on (1) or off (0) for a specific camera ID. <br><br> *Example:* `/tracking "cam1" 1` |
| `/gui/open` | None | Opens the Web GUI (`http://localhost:9356`) in the default web browser of the machine running the server. |
| `/camera/setup` | `String` (id), `String` (ip), `String` (rtsp) | Configures a camera. <br> - **id**: A unique string ID for the camera. <br> - **ip**: The VISCA IP address of the camera. <br> - **rtsp**: The RTSP stream URL of the camera. <br><br> *Example:* `/camera/setup "cam1" "192.168.1.100" "rtsp://192.168.1.100:554/live/av0"` |

## Python OpenCV Requirement

This project now uses a python script for headless OpenCV object tracking.

You must install `opencv-contrib-python` on your system to use the tracking functionality:

```bash
pip install opencv-contrib-python
# or
pip3 install opencv-contrib-python
```
