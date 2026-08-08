# PTZ Follow

Packages [PTZ-Follow-Node](https://github.com/cju-media/PTZ-Follow-Node) (a Node.js server that tracks a subject using a PTZ camera via VISCA over IP, with a web GUI and OSC control) into a standalone macOS app, and provides a Max/MSP integration patch for driving it.

This repo holds the macOS build tooling and the Max patch. The server itself - `server.js`, `tracker.py`, the web GUI - lives in [cju-media/PTZ-Follow-Node](https://github.com/cju-media/PTZ-Follow-Node), embedded here as a git submodule at `server/`, and is usable on its own or from any other project the same way. See that repo's readme for server setup, the full OSC command reference, and the Python/OpenCV requirement.

## Getting the code

```bash
git clone --recurse-submodules git@github.com:cju-media/PTZ-follow.git
```

Already cloned without `--recurse-submodules`? Run:

```bash
git submodule update --init
```

## Standalone macOS App

`packaging/build_mac.sh` builds a fully self-contained **PTZ Follow.app**: it bundles the Node server ([`pkg`](https://github.com/yao-pkg/pkg)), the Python/OpenCV tracker ([PyInstaller](https://pyinstaller.org/)), a portable copy of ffmpeg (built from your own Homebrew install, made relocatable with `dylibbundler`), and a small native Swift/AppKit launcher (`packaging/AppWrapper.swift` - see its comments for why: a bare `pkg`-built executable can't participate in the normal macOS app lifecycle, so its Dock icon would bounce forever without one) into a normal double-clickable macOS app. It shows up in the Dock and quits the way any other Mac app does (Dock menu Quit, Cmd+Q), and its own GUI opens automatically in your browser. Since there's no window otherwise, the GUI itself gained two controls to compensate: an **"Open Console"** button that streams live server log output into the browser, and a **"Quit App"** button as an in-page alternative to the Dock/Cmd+Q. Configured cameras are saved to `~/Library/Application Support/PTZ Follow/`, not inside the app bundle itself, so replacing the app with a newer build doesn't lose them (a `server.log` also lives there, in case the app fails before you can open the in-browser console).

To build it (on a Mac, with Node.js, Python 3, and Homebrew already installed):

```bash
bash packaging/build_mac.sh
```

The result lands in `packaging/dist-mac/PTZ Follow.app` — zip the `packaging/dist-mac/` folder and hand it to any Mac with the same CPU architecture as the build machine (it targets whichever architecture it's built on; build once on Apple Silicon and once on Intel to support both). See `packaging/README-dist.txt` (also copied alongside the built app) for end-user instructions, including how to get past the macOS "unidentified developer" warning on first launch, since the app isn't code-signed with a paid Apple Developer certificate.

## Max/MSP Integration

`max/PTZ-Follow-Control.maxpat` spawns the dev server via Max's `shell` object and drives it over OSC (camera setup, tracking on/off, movement pause, GUI open) - see the comments in the patch itself for the exact commands and message-box layout.
