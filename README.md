# HandBlock

HandBlock is a browser-based 3D building world. Build grid-aligned structures with mouse controls or use MediaPipe hand tracking as a virtual construction tool. The world runs locally in the browser; no backend, database, package manager, or build step is required.

Website Is Live Here : https://preetham078.github.io/Handblock/

## Features

- Perspective Three.js world with a 30 × 30 ground grid, lighting, fog, and shadows.
- Unit cubes snap to grid cells and to adjacent faces of existing cubes.
- Basic, wood, glass, grass, and stone block materials.
- BUILD, EDIT, and DELETE modes with a transparent placement preview and hover outline.
- Mouse orbit, pan, zoom, place, move, and delete controls.
- MediaPipe tracking for up to two hands, with a mirrored webcam tile and landmark skeleton.
- Undo/redo, keyboard shortcuts, clear-world confirmation, and JSON save/load.

## Technologies

- HTML, CSS, and vanilla JavaScript modules.
- Three.js and OrbitControls loaded from jsDelivr.
- MediaPipe Tasks Vision Hand Landmarker loaded from jsDelivr; the model is downloaded from Google's MediaPipe model storage.
- Browser camera access through `getUserMedia`.

## Run with VS Code Live Server

1. Open the `handblock` folder in VS Code.
2. Install the **Live Server** extension if needed.
3. Right-click `index.html` and select **Open with Live Server**.
4. Build immediately with the mouse, or select **START** in the camera tile and grant camera access.

Internet access is needed to load Three.js and MediaPipe. A current browser with WebGL enabled is recommended.

## Mouse controls

| Input | Action |
| --- | --- |
| Left-click in BUILD | Place the preview block |
| Left-drag in EDIT, starting on a block | Move the selected block; release to drop |
| Click a block in DELETE | Delete the block |
| Left-drag outside an EDIT block | Orbit the camera |
| Right-drag | Pan the camera |
| Scroll | Zoom |

The preview snaps to the ground grid or the adjacent cell of the block face under the pointer. Occupied and out-of-bounds cells are invalid and shown in red.

## Hand gestures

| Gesture | Action |
| --- | --- |
| ✌️ Index and middle fingers extended | Enter BUILD mode and aim the preview |
| 🤏 Pinch in BUILD | Place one preview block per pinch transition |
| 🤏 Pinch in EDIT | Grab the block under the cursor; move and release to drop |
| 🖐 Open hand | Aim the virtual cursor with the index fingertip |
| ✊ Hold a fist over a block | Highlight, then delete after about 500 ms |

The hand's mirrored index position is converted to normalized screen coordinates and cast as a ray through the Three.js perspective camera. The ray hits the ground or a block face; the hit face normal selects an adjacent grid cell. The 3D cursor and preview use that snapped cell.

## Undo, redo, and files

- Use the HUD arrows or **Ctrl/Cmd+Z** to undo.
- Use **Ctrl/Cmd+Shift+Z** to redo.
- **SAVE** downloads `handblock-build.json` with each block's type, cell position, rotation, and scale.
- **LOAD** imports a previously saved JSON build.
- **CLEAR** asks for confirmation before removing all blocks.

## Camera permissions and mapping limits

Camera access requires user permission and a secure origin such as `localhost` or HTTPS. If access is denied, change the browser's site camera setting and try again. Close other apps using the webcam if it is unavailable. Video is mirrored for a selfie-style view; the landmark overlay uses the same crop and mirror transform.

The camera provides 2D fingertip coordinates, not hand depth. HandBlock maps the finger to a ray from the 3D camera and uses the first ground/block surface hit, so the cursor can target visible surfaces but cannot infer a precise 3D point behind an occluding block. EDIT-mode dragging stays on the selected block's horizontal layer. Use mouse controls for fine camera positioning and precise placement.

## Future improvements

- Multi-level drag controls for moving blocks vertically.
- Two-hand scaling and rotation.
- Block connections, drawing tools, voice commands, and layout persistence between sessions.
- Additional world themes and configurable gesture thresholds.
