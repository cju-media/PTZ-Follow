import sys
import os
import json
import threading
import time

# Force RTSP over TCP for OpenCV's FFmpeg backend, mirroring the "-rtsp_transport tcp" server.js
# already passes to its own ffmpeg invocation for the browser video stream. Without this, some
# cameras (confirmed with this project's own camera) reject the RTSP control channel outright
# over UDP with "405 Method Not Allowed" on DESCRIBE, so cv2.VideoCapture() never even gets to
# the point of reading a frame. Must be set before any cv2.VideoCapture() call - OpenCV's FFmpeg
# backend only reads this env var at capture-open time.
os.environ.setdefault('OPENCV_FFMPEG_CAPTURE_OPTIONS', 'rtsp_transport;tcp')

try:
    import cv2
except ImportError:
    print(json.dumps({'type': 'error', 'message': 'Cannot import cv2. Please install opencv-contrib-python.'}))
    sys.stdout.flush()
    sys.exit(1)

# Anti-drift tuning. CSRT doesn't always cleanly report failure when it loses the real
# subject - it can quietly lock onto something else nearby and keep reporting success. These
# guard against that:
#   - MAX_JUMP_RATIO: reject a single-frame relock further than this fraction of the frame
#     diagonal from the last good position. Real subject motion between adjacent frames is
#     rarely this large; a big jump is almost always CSRT drifting onto the wrong thing.
#   - LOST_GRACE_SECONDS: how long to keep trying to reacquire (handles brief occlusions)
#     before giving up entirely and requiring a freshly drawn box, rather than letting CSRT
#     keep hunting indefinitely.
# (We also tried gating on tracker.getTrackingScore(), but it's not reliably calibrated
# across OpenCV builds and was rejecting valid tracks outright - removed.)
MAX_JUMP_RATIO = 0.25
LOST_GRACE_SECONDS = 1.5

# OpenCV's FFmpeg backend defaults to a ~30s internal timeout for both opening an RTSP stream
# and for each individual read - so if the camera is unreachable (e.g. mid-reboot), cap.read()
# can block for the full 30s before the reconnect loop below even gets a chance to try again.
# Capping both much lower means a dead/rebooting camera is retried far more often, so tracking
# resumes within a few seconds of the camera actually coming back online instead of being stuck
# waiting out whichever multi-attempt timeout happened to be in progress.
OPEN_TIMEOUT_MS = 5000
READ_TIMEOUT_MS = 5000

def open_capture(rtsp_link):
    # Must pass cv2.CAP_FFMPEG explicitly - confirmed by testing that without it, OpenCV's
    # backend auto-detection for an "rtsp://" URL doesn't consistently route through the FFmpeg
    # backend that reads OPENCV_FFMPEG_CAPTURE_OPTIONS above, silently ignoring the forced TCP
    # transport and hitting the same "405 Method Not Allowed" as leaving both unset.
    cap = cv2.VideoCapture(rtsp_link, cv2.CAP_FFMPEG)
    try:
        cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, OPEN_TIMEOUT_MS)
        cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, READ_TIMEOUT_MS)
    except Exception:
        # Not supported on this OpenCV build - falls back to its (longer) default timeout.
        pass
    return cap

def process_stdin(tracker_state):
    for line in sys.stdin:
        try:
            data = json.loads(line)
            if data.get('type') == 'update_rect':
                tracker_state['rect'] = data['rect']
                tracker_state['needs_init'] = True
                tracker_state['active'] = True
            elif data.get('type') == 'stop_tracking':
                # Pause tracking but keep the process/RTSP connection alive and warm,
                # so the next 'update_rect' can start tracking with no connection setup delay.
                tracker_state['active'] = False
            elif data.get('type') == 'stop':
                tracker_state['running'] = False
                break
        except Exception as e:
            pass

def main():
    if len(sys.argv) < 2:
        sys.exit(1)

    rtsp_link = sys.argv[1]

    # rect (arg 2) is optional: if omitted, the process starts in standby - it keeps the
    # RTSP connection warm by reading frames, but doesn't track anything until an
    # 'update_rect' message arrives over stdin.
    initial_rect_data = None
    if len(sys.argv) >= 3:
        try:
            initial_rect_data = json.loads(sys.argv[2])
        except Exception:
            initial_rect_data = None

    tracker_state = {
        'running': True,
        'active': initial_rect_data is not None,
        'rect': initial_rect_data,
        'needs_init': initial_rect_data is not None
    }

    # Start thread to read stdin
    t = threading.Thread(target=process_stdin, args=(tracker_state,), daemon=True)
    t.start()

    # Some cameras' embedded RTSP servers are simply flaky on connection setup - this project's
    # own camera rejects a fresh DESCRIBE/SETUP with "405 Method Not Allowed" roughly 1 in 3
    # attempts, at random, even though the exact same request succeeds moments later. The read
    # loop below already tolerates this after a successful open (reconnect on a failed read), but
    # the very first open had no such tolerance - one unlucky attempt at process startup meant an
    # immediate fatal exit. Retry the initial open a few times before actually giving up.
    INITIAL_OPEN_RETRIES = 5
    INITIAL_OPEN_RETRY_DELAY_SECONDS = 1
    cap = open_capture(rtsp_link)
    attempt = 1
    while not cap.isOpened() and attempt < INITIAL_OPEN_RETRIES:
        attempt += 1
        cap.release()
        time.sleep(INITIAL_OPEN_RETRY_DELAY_SECONDS)
        cap = open_capture(rtsp_link)
    if not cap.isOpened():
        print(json.dumps({'type': 'error', 'message': f'Cannot open video stream after {INITIAL_OPEN_RETRIES} attempts'}))
        sys.stdout.flush()
        sys.exit(1)

    tracker = None
    last_good_bbox = None  # (x, y, w, h) of the last accepted match, for the jump-distance check
    lost_since = None      # wall-clock time we started failing to get a good match, or None

    while tracker_state['running']:
        ret, frame = cap.read()
        if not ret:
            # Reconnect
            cap.release()
            time.sleep(1)
            cap = open_capture(rtsp_link)
            continue

        if not tracker_state['active']:
            # Standby: keep reading frames to hold the RTSP connection open and current,
            # but skip CSRT init/update entirely so this costs no extra tracking work.
            tracker = None
            continue

        if tracker_state['needs_init']:
            try:
                tracker = cv2.TrackerCSRT_create()
            except AttributeError:
                print(json.dumps({'type': 'error', 'message': 'cv2.TrackerCSRT_create not found. Ensure you installed opencv-contrib-python, not just opencv-python.'}))
                sys.stdout.flush()
                sys.exit(1)
            rect = tracker_state['rect']

            # The OpenCV Tracking API in some versions requires explicitly passing a list or tuple of ints.
            # To be safe across versions, a tuple of ints is usually the best approach.
            bbox = (int(rect['x']), int(rect['y']), int(rect['width']), int(rect['height']))

            try:
                tracker.init(frame, bbox)
            except Exception as e:
                print(json.dumps({'type': 'error', 'message': f'Tracker init error: {str(e)}'}))
                sys.stdout.flush()
                # Instead of exiting on bad rect, just wait for a new one.
                tracker_state['needs_init'] = False
                tracker = None
                continue

            tracker_state['needs_init'] = False
            # A fresh box is always trusted as-is, and resets the drift/loss tracking.
            last_good_bbox = bbox
            lost_since = None

        if tracker is not None:
            ok, bbox = tracker.update(frame)

            if ok and last_good_bbox is not None:
                frame_height, frame_width = frame.shape[:2]
                diag = (frame_width ** 2 + frame_height ** 2) ** 0.5
                prev_cx = last_good_bbox[0] + last_good_bbox[2] / 2
                prev_cy = last_good_bbox[1] + last_good_bbox[3] / 2
                cx = bbox[0] + bbox[2] / 2
                cy = bbox[1] + bbox[3] / 2
                jump = ((cx - prev_cx) ** 2 + (cy - prev_cy) ** 2) ** 0.5
                if jump > MAX_JUMP_RATIO * diag:
                    print(f'REJECTED (jump): {jump:.1f}px > {MAX_JUMP_RATIO * diag:.1f}px (25% of {diag:.1f}px diagonal)', file=sys.stderr)
                    sys.stderr.flush()
                    ok = False

            if ok:
                last_good_bbox = bbox
                lost_since = None

                x, y, w, h = bbox

                # frame dimensions
                frame_height, frame_width = frame.shape[:2]

                centerX = x + w / 2
                centerY = y + h / 2
                frameCenterX = frame_width / 2
                frameCenterY = frame_height / 2

                devX = (centerX - frameCenterX) / frameCenterX
                devY = (centerY - frameCenterY) / frameCenterY

                out_data = {
                    'type': 'tracking',
                    'pan': devX,
                    'tilt': -devY, # Note: original JS code used -devY
                    'rect': {
                        'x': float(x),
                        'y': float(y),
                        'width': float(w),
                        'height': float(h)
                    },
                    'frameWidth': frame_width,
                    'frameHeight': frame_height
                }
                print(json.dumps(out_data))
                sys.stdout.flush()
            else:
                if lost_since is None:
                    lost_since = time.time()

                if time.time() - lost_since > LOST_GRACE_SECONDS:
                    # Give up rather than let CSRT keep hunting and potentially drift onto
                    # a different subject. Tracking stays paused until a fresh box is drawn.
                    print(json.dumps({'type': 'lost', 'permanent': True}))
                    sys.stdout.flush()
                    tracker = None
                    tracker_state['active'] = False
                    last_good_bbox = None
                    lost_since = None
                else:
                    print(json.dumps({'type': 'lost', 'permanent': False}))
                    sys.stdout.flush()

        # Don't spin too fast if nothing is happening, but usually cap.read() blocks.

    cap.release()

if __name__ == "__main__":
    main()
