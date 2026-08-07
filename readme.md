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
| `/tracking` | `String` (id), `Integer` (1 or 0) | Toggles tracking on (1) or off (0) for a specific camera ID. Requires the camera to already be configured (via `/camera/setup` or the web GUI) **and** to have a bounding box already drawn on it at least once in the web GUI - OSC has no way to specify a box itself, so it reuses the last one drawn there. If either is missing, the camera stays disabled and the reason is logged to the server console. <br><br> *Example:* `/tracking "cam1" 1` |
| `/tracking/pause` | `String` (id), `Integer` (1 or 0) | Pauses (1) or resumes (0) camera *movement* without disengaging object tracking - the bounding box keeps following the subject, but no VISCA pan/tilt commands are sent while paused. Requires the camera to already be configured. <br><br> *Example:* `/tracking/pause "cam1" 1` |
| `/gui/open` | None | Opens the Web GUI (`http://localhost:9356`) in the default web browser of the machine running the server. |
| `/camera/setup` | `String` (id), `String` (ip) | Configures a camera and persists it to disk. <br> - **id**: A unique string ID for the camera. <br> - **ip**: The VISCA IP address of the camera. <br> *(The RTSP stream URL is automatically constructed from the IP address)* <br><br> *Example:* `/camera/setup "cam1" "192.168.1.100"` |

All commands broadcast the updated state to every connected web GUI client immediately, so changes made via OSC (or by another browser tab) show up live without needing a page refresh.

## Python OpenCV Requirement

This project now uses a python script for headless OpenCV object tracking.

You must install `opencv-contrib-python` on your system to use the tracking functionality:

```bash
pip install opencv-contrib-python
# or
pip3 install opencv-contrib-python
```

## Standalone macOS App (no dependencies)

For end users who shouldn't need to install Node, Python, or ffmpeg themselves, `packaging/build_mac.sh` builds a fully self-contained **PTZ Follow.app**: it bundles the Node server ([`pkg`](https://github.com/yao-pkg/pkg)), the Python/OpenCV tracker ([PyInstaller](https://pyinstaller.org/)), and a portable copy of ffmpeg (built from your own Homebrew install, made relocatable with `dylibbundler`) into a normal double-clickable macOS app. It runs silently in the background (no Dock icon, no Terminal window) and just opens your browser to the GUI. Since there's no window otherwise, the GUI itself gained two controls to compensate: an **"Open Console"** button that streams live server log output into the browser, and a **"Quit App"** button that's now the actual way to stop the server. Configured cameras are saved to `~/Library/Application Support/PTZ Follow/`, not inside the app bundle itself, so replacing the app with a newer build doesn't lose them (a `server.log` also lives there, in case the app fails before you can open the in-browser console).

To build it (on a Mac, with Node.js, Python 3, and Homebrew already installed):

```bash
bash packaging/build_mac.sh
```

The result lands in `packaging/dist-mac/PTZ Follow.app` — zip the `packaging/dist-mac/` folder and hand it to any Mac with the same CPU architecture as the build machine (it targets whichever architecture it's built on; build once on Apple Silicon and once on Intel to support both). See `packaging/README-dist.txt` (also copied alongside the built app) for end-user instructions, including how to get past the macOS "unidentified developer" warning on first launch, since the app isn't code-signed with a paid Apple Developer certificate.
