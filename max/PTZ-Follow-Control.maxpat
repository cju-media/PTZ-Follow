{
    "patcher": {
        "fileversion": 1,
        "appversion": {
            "major": 9,
            "minor": 1,
            "revision": 2,
            "architecture": "x64",
            "modernui": 1
        },
        "classnamespace": "box",
        "rect": [ 1479.0, 459.0, 680.0, 480.0 ],
        "boxes": [
            {
                "box": {
                    "fontface": 1,
                    "fontsize": 14.0,
                    "id": "obj-title",
                    "maxclass": "comment",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 40.0, 20.0, 500.0, 22.0 ],
                    "text": "PTZ Follow — Launch & OSC Control"
                }
            },
            {
                "box": {
                    "id": "obj-c1",
                    "maxclass": "comment",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 40.0, 55.0, 580.0, 20.0 ],
                    "text": "1. Start server (spawns node as a detached background process)"
                }
            },
            {
                "box": {
                    "id": "obj-start",
                    "maxclass": "message",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 40.0, 80.0, 405.0, 22.0 ],
                    "text": "/usr/local/bin/node /Users/c/Documents/Programming/PTZ-Follow/server.js"
                }
            },
            {
                "box": {
                    "id": "obj-shell",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 2,
                    "outlettype": [ "", "bang" ],
                    "patching_rect": [ 40.0, 118.0, 60.0, 22.0 ],
                    "saved_object_attributes": {
                        "shell": "(default)"
                    },
                    "text": "shell"
                }
            },
            {
                "box": {
                    "id": "obj-print-out",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 130.0, 118.0, 140.0, 22.0 ],
                    "text": "print shellOut"
                }
            },
            {
                "box": {
                    "id": "obj-print-status",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 280.0, 118.0, 150.0, 22.0 ],
                    "text": "print shellStatus"
                }
            },
            {
                "box": {
                    "id": "obj-c2",
                    "maxclass": "comment",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 40.0, 165.0, 580.0, 20.0 ],
                    "text": "2. Stop server (kills the matching node process)"
                }
            },
            {
                "box": {
                    "id": "obj-stop",
                    "maxclass": "message",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 40.0, 190.0, 320.0, 22.0 ],
                    "text": "pkill -f PTZ-Follow/server.js"
                }
            },
            {
                "box": {
                    "id": "obj-c3",
                    "maxclass": "comment",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 40.0, 235.0, 580.0, 20.0 ],
                    "text": "3. OSC control (UDP -> 127.0.0.1:9357, packed via @osc 1)"
                }
            },
            {
                "box": {
                    "id": "obj-udp",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 40.0, 260.0, 220.0, 22.0 ],
                    "text": "udpsend 127.0.0.1 9357 @osc 1"
                }
            },
            {
                "box": {
                    "id": "obj-setup",
                    "maxclass": "message",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 40.0, 295.0, 270.0, 22.0 ],
                    "text": "/camera/setup 1 192.168.7.246"
                }
            },
            {
                "box": {
                    "id": "obj-trackon",
                    "maxclass": "message",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 40.0, 325.0, 140.0, 22.0 ],
                    "text": "/tracking 1 1"
                }
            },
            {
                "box": {
                    "id": "obj-trackoff",
                    "maxclass": "message",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 190.0, 325.0, 140.0, 22.0 ],
                    "text": "/tracking 1 0"
                }
            },
            {
                "box": {
                    "id": "obj-pauseon",
                    "maxclass": "message",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 40.0, 355.0, 180.0, 22.0 ],
                    "text": "/tracking/pause 1 1"
                }
            },
            {
                "box": {
                    "id": "obj-pauseoff",
                    "maxclass": "message",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 230.0, 355.0, 180.0, 22.0 ],
                    "text": "/tracking/pause 1 0"
                }
            },
            {
                "box": {
                    "id": "obj-guiopen",
                    "maxclass": "message",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 40.0, 385.0, 110.0, 22.0 ],
                    "text": "/gui/open"
                }
            },
            {
                "box": {
                    "id": "obj-c4",
                    "linecount": 3,
                    "maxclass": "comment",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 40.0, 415.0, 600.0, 47.0 ],
                    "text": "Note: config.json already has camera id \"1\" at 192.168.7.246 — edit the id/IP in the message boxes above for other cameras. A camera needs a bounding box drawn once in the web GUI (http://localhost:9356) before /tracking can enable it via OSC."
                }
            }
        ],
        "lines": [
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-guiopen", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pauseoff", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pauseon", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-setup", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-print-out", 0 ],
                    "source": [ "obj-shell", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-print-status", 0 ],
                    "source": [ "obj-shell", 1 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-shell", 0 ],
                    "source": [ "obj-start", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-shell", 0 ],
                    "source": [ "obj-stop", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-trackoff", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-trackon", 0 ]
                }
            }
        ],
        "autosave": 0
    }
}