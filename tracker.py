import sys
import json
import cv2
import threading
import time

def process_stdin(tracker_state):
    for line in sys.stdin:
        try:
            data = json.loads(line)
            if data.get('type') == 'update_rect':
                tracker_state['rect'] = data['rect']
                tracker_state['needs_init'] = True
            elif data.get('type') == 'stop':
                tracker_state['running'] = False
                break
        except Exception as e:
            pass

def main():
    if len(sys.argv) < 3:
        sys.exit(1)

    rtsp_link = sys.argv[1]

    # rect should be a JSON string representing {x, y, width, height}
    try:
        initial_rect_data = json.loads(sys.argv[2])
    except Exception as e:
        sys.exit(1)

    tracker_state = {
        'running': True,
        'rect': initial_rect_data,
        'needs_init': True
    }

    # Start thread to read stdin
    t = threading.Thread(target=process_stdin, args=(tracker_state,), daemon=True)
    t.start()

    cap = cv2.VideoCapture(rtsp_link)
    if not cap.isOpened():
        print(json.dumps({'type': 'error', 'message': 'Cannot open video stream'}))
        sys.stdout.flush()
        sys.exit(1)

    tracker = None

    while tracker_state['running']:
        ret, frame = cap.read()
        if not ret:
            # Reconnect
            cap.release()
            time.sleep(1)
            cap = cv2.VideoCapture(rtsp_link)
            continue

        if tracker_state['needs_init']:
            tracker = cv2.TrackerCSRT_create()
            rect = tracker_state['rect']
            # Convert rect dict to tuple (x, y, w, h)
            bbox = (rect['x'], rect['y'], rect['width'], rect['height'])
            tracker.init(frame, bbox)
            tracker_state['needs_init'] = False

        if tracker is not None:
            ok, bbox = tracker.update(frame)
            if ok:
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
                print(json.dumps({'type': 'lost'}))
                sys.stdout.flush()

        # Don't spin too fast if nothing is happening, but usually cap.read() blocks.

    cap.release()

if __name__ == "__main__":
    main()
