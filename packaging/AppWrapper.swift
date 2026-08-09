// Minimal native launcher so PTZ Follow behaves like a normal Mac app in the Dock.
//
// The actual server (ptz-tracker, a bare `pkg`-built Node executable) has no AppKit/Cocoa
// involvement at all, so on its own it can't participate in the standard macOS app lifecycle:
// the Dock only stops bouncing an icon once the app signals "I'm a real GUI app and I'm ready"
// via AppKit, which a plain command-line binary never does - as CFBundleExecutable directly, its
// Dock icon bounces forever and never settles. Making it CFBundleExecutable instead, this tiny
// wrapper IS a real (albeit windowless) AppKit app: it settles in the Dock normally, and Cmd+Q /
// the Dock's Quit menu item deliver a proper Apple Event to applicationShouldTerminate(_:)
// instead of the OS's fallback of just sending SIGTERM to a non-cooperating process.
//
// It has no window of its own - the actual GUI is still the browser tab server.js opens - it
// only exists to give the process tree a real AppKit presence and a clean shutdown path.
import Cocoa

// Must match PORT in server.js.
private let serverURL = URL(string: "http://localhost:9356")!

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var child: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let execPath = Bundle.main.bundlePath + "/Contents/MacOS/ptz-tracker"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: execPath)

        // If the server exits on its own (crash, or something else signals it directly), don't
        // leave a dead, un-quittable Dock icon behind - quit the wrapper too.
        process.terminationHandler = { _ in
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }

        do {
            try process.run()
            child = process
        } catch {
            NSLog("PTZ Follow: failed to launch ptz-tracker: \(error)")
            NSApplication.shared.terminate(nil)
        }
    }

    // Fires when the user clicks the Dock icon (or double-clicks the app in Finder again)
    // while it's already running - e.g. they closed the browser tab but left the app itself
    // open. A bare Node process has no way to receive this (it's an AppKit/Apple Event
    // concept - "reopen" - that only a real NSApplication delegate gets), which is why this
    // wrapper exists at all rather than making ptz-tracker CFBundleExecutable directly. The
    // server is still alive as our child process, so just reopen the browser tab - no need to
    // restart anything.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        NSWorkspace.shared.open(serverURL)
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let child, child.isRunning else { return .terminateNow }

        // SIGTERM (what Process.terminate() sends) triggers server.js's own gracefulShutdown()
        // - stopping tracker child processes before it exits. Give that a bounded window to
        // actually finish before this wrapper itself finishes quitting, so Cmd+Q/Dock Quit don't
        // hand control back before cleanup has happened, but also don't hang forever if
        // something goes wrong.
        child.terminate()
        let deadline = DispatchTime.now() + .seconds(3)
        while child.isRunning && DispatchTime.now() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        if child.isRunning {
            NSLog("PTZ Follow: server didn't exit within 3s of SIGTERM - forcing it.")
            kill(child.processIdentifier, SIGKILL)
        }
        return .terminateNow
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
