PTZ Follow - macOS App
======================

No installation needed - Node.js, Python, and ffmpeg are all bundled inside the app.

TO RUN:
  Double-click "PTZ Follow.app". It appears in the Dock like a normal app, but has no
  window of its own - after a moment your browser opens automatically to the app instead.

TO SEE LOGS / TROUBLESHOOT:
  Click "Open Console" in the app's web page to view live server log output (VISCA
  commands, tracker status, errors, etc.) right there in the browser - there's no separate
  Terminal window to check.

TO STOP THE APP:
  Quit it the way you'd quit any Mac app - right-click its Dock icon and choose Quit, or
  Cmd+Q while it's frontmost. "Quit App" in the web page does the same thing, as a
  fallback if you'd rather not switch away from the browser.

FIRST LAUNCH ("unidentified developer" warning):
  Since this app isn't signed with an Apple Developer certificate, macOS Gatekeeper will
  likely refuse to open it the first time, with a message like "cannot be opened because
  the developer cannot be verified" or "is damaged and can't be opened."
  To allow it:
    1. Right-click (or Control-click) "PTZ Follow.app" and choose "Open".
    2. Click "Open" again in the dialog that appears.
  You only need to do this once. If that still doesn't work, open Terminal, cd into this
  folder, and run:  xattr -cr "PTZ Follow.app"
  then try again.

CAMERA SETUP:
  Open the app, click "Edit Cameras", and add your PTZ camera's IP address (or use
  "Rescan Network for Cameras" to find it automatically). See the full project README for
  OSC command reference and other details.

YOUR CAMERA SETTINGS ARE SAVED SEPARATELY FROM THE APP:
  Configured cameras are stored in ~/Library/Application Support/PTZ Follow/, not inside
  the app itself - so replacing "PTZ Follow.app" with a newer build won't lose them. A full
  log file also lives there (server.log), in case the app fails before you can open the
  in-browser console.

WHAT'S BUNDLED (inside the app - right-click > Show Package Contents to look):
  - Contents/MacOS/ptz-tracker         the app server (Node.js runtime + app code)
  - Contents/MacOS/resources/tracker/  the object-tracking engine (Python + OpenCV)
  - Contents/MacOS/resources/ffmpeg/   a self-contained ffmpeg build for video preview

COMPATIBILITY:
  This build targets Apple Silicon (M1/M2/M3/M4) Macs running macOS. It will not run on
  an Intel Mac - that needs a separate build made on an Intel machine (see the project's
  packaging/build_mac.sh script).
