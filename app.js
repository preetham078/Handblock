import * as THREE from "three";
import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/controls/OrbitControls.js";

const VISION_MODULE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs";
const VISION_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm";
const HAND_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const GRID_SIZE = 30;
const GRID_HALF = GRID_SIZE / 2;
const CELL_SIZE = 1;
const GESTURE_STABLE_MS = 100;
const FIST_DELETE_MS = 500;
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
];

const BLOCK_TYPES = {
  basic: { label: "BASIC BLOCK", color: 0xc9f278, roughness: 0.62, metalness: 0.03 },
  wood: { label: "WOOD", color: 0xb98051, roughness: 0.78, metalness: 0 },
  glass: { label: "GLASS", color: 0x67d5d2, roughness: 0.14, metalness: 0.08, transparent: true, opacity: 0.62 },
  grass: { label: "GRASS", color: 0x66b979, roughness: 0.9, metalness: 0 },
  stone: { label: "STONE", color: 0xa2b2ad, roughness: 0.88, metalness: 0.04 }
};

const elements = {
  worldCanvas: document.querySelector("#world-canvas"),
  cameraVideo: document.querySelector("#camera-video"),
  handCanvas: document.querySelector("#hand-canvas"),
  cameraDock: document.querySelector(".camera-dock"),
  cameraStatus: document.querySelector("#camera-status"),
  cameraStatusPill: document.querySelector("#camera-status-pill"),
  cameraLive: document.querySelector("#camera-live"),
  cameraNote: document.querySelector("#camera-note"),
  startCamera: document.querySelector("#start-camera"),
  stopCamera: document.querySelector("#stop-camera"),
  handCount: document.querySelector("#hand-count"),
  fps: document.querySelector("#fps-value"),
  modeReadout: document.querySelector("#mode-readout"),
  gestureReadout: document.querySelector("#gesture-readout"),
  blockCount: document.querySelector("#block-count"),
  selectedBlock: document.querySelector("#selected-block"),
  selectedSwatch: document.querySelector("#selected-swatch"),
  tipText: document.querySelector("#tip-text"),
  handTip: document.querySelector("#hand-tip"),
  undoButton: document.querySelector("#undo-button"),
  redoButton: document.querySelector("#redo-button"),
  clearWorld: document.querySelector("#clear-world"),
  saveButton: document.querySelector("#save-button"),
  loadButton: document.querySelector("#load-button"),
  loadFile: document.querySelector("#load-file"),
  toast: document.querySelector("#toast")
};

const state = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  raycaster: new THREE.Raycaster(),
  ndc: new THREE.Vector2(0, 0),
  pointerActive: false,
  inputSource: "mouse",
  handLandmarker: null,
  cameraStream: null,
  hands: [],
  lastVideoTime: -1,
  handContext: elements.handCanvas.getContext("2d"),
  blockManager: null,
  materials: {},
  blockGeometry: new THREE.BoxGeometry(CELL_SIZE, CELL_SIZE, CELL_SIZE),
  ground: null,
  preview: null,
  cursorOrb: null,
  highlight: null,
  removalMeshes: [],
  mode: "build",
  selectedType: "basic",
  hoveredBlockId: null,
  previewCell: null,
  previewValid: false,
  pointerPoint: null,
  draggingBlockId: null,
  dragPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
  gesture: "MOUSE",
  candidateGesture: "",
  candidateSince: 0,
  stableGesture: "",
  previousGesture: "",
  fistTargetId: null,
  fistStartedAt: 0,
  fistDeleted: false,
  nextBlockId: 1,
  undoStack: [],
  redoStack: [],
  lastFrameAt: performance.now(),
  fpsFrames: 0,
  lastFpsUpdate: performance.now(),
  toastTimer: 0,
  cameraLoadInProgress: false,
  cameraSession: 0
};

function setText(element, value) {
  const nextValue = String(value);
  if (element.textContent !== nextValue) element.textContent = nextValue;
}

function showToast(message) {
  setText(elements.toast, message);
  elements.toast.hidden = false;
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 4200);
}

function setCameraStatus(label, status, detail = "") {
  setText(elements.cameraStatus, label);
  elements.cameraStatusPill.dataset.state = status;
  elements.cameraDock.dataset.ready = String(status === "ready");
  if (detail) setText(elements.cameraNote, detail);
}

function cellKey(cell) {
  return `${cell.x},${cell.y},${cell.z}`;
}

function cellToWorld(cell) {
  return new THREE.Vector3(cell.x - GRID_HALF + 0.5, cell.y + 0.5, cell.z - GRID_HALF + 0.5);
}

function isCellInWorld(cell) {
  return Number.isInteger(cell.x) && Number.isInteger(cell.y) && Number.isInteger(cell.z)
    && cell.x >= 0 && cell.x < GRID_SIZE
    && cell.z >= 0 && cell.z < GRID_SIZE
    && cell.y >= 0 && cell.y < 80;
}

class BlockManager {
  constructor(scene, geometry, materials) {
    this.scene = scene;
    this.geometry = geometry;
    this.materials = materials;
    this.blocks = new Map();
    this.occupied = new Map();
  }

  create({ id, type, position, rotation = [0, 0, 0], scale = [1, 1, 1] }, animate = true) {
    if (!BLOCK_TYPES[type] || !isCellInWorld(position) || this.occupied.has(cellKey(position))) return null;
    const blockId = id || `cube-${state.nextBlockId++}`;
    const mesh = new THREE.Mesh(this.geometry, this.materials[type]);
    mesh.position.copy(cellToWorld(position));
    mesh.rotation.set(...rotation);
    mesh.scale.set(...scale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.blockId = blockId;
    mesh.userData.targetScale = new THREE.Vector3(...scale);
    mesh.userData.animatingIn = animate;
    this.scene.add(mesh);
    const block = { id: blockId, type, position: { ...position }, rotation: [...rotation], scale: [...scale], mesh };
    this.blocks.set(blockId, block);
    this.occupied.set(cellKey(position), blockId);
    const numericId = Number(blockId.match(/\d+$/)?.[0]);
    if (Number.isFinite(numericId)) state.nextBlockId = Math.max(state.nextBlockId, numericId + 1);
    if (animate) mesh.scale.setScalar(0.06);
    updateWorldCounts();
    return block;
  }

  canPlace(position, ignoredId = null) {
    if (!isCellInWorld(position)) return false;
    const occupiedBy = this.occupied.get(cellKey(position));
    return !occupiedBy || occupiedBy === ignoredId;
  }

  move(id, position) {
    const block = this.blocks.get(id);
    if (!block || !this.canPlace(position, id)) return false;
    this.occupied.delete(cellKey(block.position));
    block.position = { ...position };
    block.mesh.position.copy(cellToWorld(position));
    this.occupied.set(cellKey(position), id);
    return true;
  }

  remove(id) {
    const block = this.blocks.get(id);
    if (!block) return null;
    this.blocks.delete(id);
    this.occupied.delete(cellKey(block.position));
    block.mesh.userData.deleting = true;
    state.removalMeshes.push(block.mesh);
    updateWorldCounts();
    return block;
  }

  get(id) {
    return this.blocks.get(id) || null;
  }

  serialize() {
    return [...this.blocks.values()].map((block) => ({
      id: block.id,
      type: block.type,
      position: { ...block.position },
      rotation: [...block.rotation],
      scale: [...block.scale]
    }));
  }

  restore(savedBlocks) {
    for (const block of this.blocks.values()) this.scene.remove(block.mesh);
    for (const mesh of state.removalMeshes) this.scene.remove(mesh);
    state.removalMeshes = [];
    this.blocks.clear();
    this.occupied.clear();
    for (const block of savedBlocks) this.create(block, false);
    updateWorldCounts();
    refreshHover();
  }
}

function updateWorldCounts() {
  setText(elements.blockCount, state.blockManager?.blocks.size || 0);
  elements.undoButton.disabled = state.undoStack.length === 0;
  elements.redoButton.disabled = state.redoStack.length === 0;
}

function captureHistory() {
  state.undoStack.push(state.blockManager.serialize());
  if (state.undoStack.length > 80) state.undoStack.shift();
  state.redoStack.length = 0;
  updateWorldCounts();
}

function undo() {
  if (!state.undoStack.length) return;
  state.redoStack.push(state.blockManager.serialize());
  state.blockManager.restore(state.undoStack.pop());
  updateWorldCounts();
}

function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push(state.blockManager.serialize());
  state.blockManager.restore(state.redoStack.pop());
  updateWorldCounts();
}

function initializeWorld() {
  state.renderer = new THREE.WebGLRenderer({ canvas: elements.worldCanvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  state.renderer.setSize(window.innerWidth, window.innerHeight, false);
  state.renderer.outputColorSpace = THREE.SRGBColorSpace;
  state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  state.renderer.toneMappingExposure = 1.12;
  state.renderer.shadowMap.enabled = true;
  state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  state.scene = new THREE.Scene();
  state.scene.background = new THREE.Color(0x13201b);
  state.scene.fog = new THREE.FogExp2(0x13201b, 0.009);
  state.camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 150);
  state.camera.position.set(24, 24, 31);

  state.scene.add(new THREE.HemisphereLight(0xd9f2de, 0x29362d, 2.0));
  const keyLight = new THREE.DirectionalLight(0xffe9c8, 3.1);
  keyLight.position.set(-12, 24, 11);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.left = -23;
  keyLight.shadow.camera.right = 23;
  keyLight.shadow.camera.top = 23;
  keyLight.shadow.camera.bottom = -23;
  keyLight.shadow.bias = -0.0005;
  state.scene.add(keyLight);

  const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x425748, roughness: 0.96, metalness: 0 });
  state.ground = new THREE.Mesh(new THREE.PlaneGeometry(GRID_SIZE, GRID_SIZE), groundMaterial);
  state.ground.rotation.x = -Math.PI / 2;
  state.ground.position.y = -0.025;
  state.ground.receiveShadow = true;
  state.scene.add(state.ground);

  const grid = new THREE.GridHelper(GRID_SIZE, GRID_SIZE, 0xacc49d, 0x6d8673);
  grid.position.y = 0.004;
  grid.material.transparent = true;
  grid.material.opacity = 0.28;
  state.scene.add(grid);

  const platform = new THREE.Mesh(
    new THREE.BoxGeometry(GRID_SIZE + 0.35, 0.18, GRID_SIZE + 0.35),
    new THREE.MeshStandardMaterial({ color: 0x25392e, roughness: 0.82 })
  );
  platform.position.set(0, -0.13, 0);
  platform.receiveShadow = true;
  state.scene.add(platform);

  for (const [type, options] of Object.entries(BLOCK_TYPES)) {
    state.materials[type] = new THREE.MeshStandardMaterial({
      color: options.color,
      roughness: options.roughness,
      metalness: options.metalness,
      transparent: options.transparent || false,
      opacity: options.opacity || 1
    });
  }
  state.blockManager = new BlockManager(state.scene, state.blockGeometry, state.materials);

  const previewMaterial = new THREE.MeshStandardMaterial({ color: BLOCK_TYPES.basic.color, transparent: true, opacity: 0.38, roughness: 0.4, depthWrite: false });
  state.preview = new THREE.Mesh(state.blockGeometry, previewMaterial);
  state.preview.visible = false;
  state.preview.renderOrder = 2;
  state.scene.add(state.preview);

  state.cursorOrb = new THREE.Mesh(
    new THREE.SphereGeometry(0.095, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xe5ffab, toneMapped: false })
  );
  state.cursorOrb.visible = false;
  state.scene.add(state.cursorOrb);

  state.highlight = new THREE.BoxHelper(new THREE.Object3D(), 0xc9f278);
  state.highlight.visible = false;
  state.scene.add(state.highlight);

  state.controls = new OrbitControls(state.camera, state.renderer.domElement);
  state.controls.target.set(0, 0, 0);
  state.controls.enableDamping = true;
  state.controls.dampingFactor = 0.075;
  state.controls.minDistance = 9;
  state.controls.maxDistance = 65;
  state.controls.maxPolarAngle = Math.PI * 0.49;
  state.controls.update();
}

function setMode(mode) {
  if (!Object.hasOwn(BLOCK_TYPES, state.selectedType) || !["build", "edit", "delete"].includes(mode)) return;
  state.mode = mode;
  setText(elements.modeReadout, mode.toUpperCase());
  document.querySelectorAll(".mode-button").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  state.preview.visible = mode === "build" && Boolean(state.previewCell);
  refreshHover();
}

function selectBlockType(type) {
  if (!BLOCK_TYPES[type]) return;
  state.selectedType = type;
  const material = BLOCK_TYPES[type];
  state.preview.material.color.setHex(material.color);
  elements.selectedSwatch.style.backgroundColor = `#${material.color.toString(16).padStart(6, "0")}`;
  setText(elements.selectedBlock, material.label);
  document.querySelectorAll(".material-button").forEach((button) => {
    const active = button.dataset.blockType === type;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setGesture(label) {
  if (state.gesture === label) return;
  state.gesture = label;
  setText(elements.gestureReadout, label.toUpperCase());
  setText(elements.tipText, label === "MOUSE" ? "MOVE TO AIM" : label.toUpperCase());
}

function getCellFromHit(hit) {
  if (hit.object === state.ground) {
    return {
      x: Math.floor(hit.point.x + GRID_HALF),
      y: 0,
      z: Math.floor(hit.point.z + GRID_HALF)
    };
  }
  const block = state.blockManager.get(hit.object.userData.blockId);
  if (!block || !hit.face) return null;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
  const normal = hit.face.normal.clone().applyMatrix3(normalMatrix);
  const axis = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
  const face = axis.indexOf(Math.max(...axis));
  const nextCell = { ...block.position };
  if (face === 0) nextCell.x += Math.sign(normal.x);
  else if (face === 1) nextCell.y += Math.sign(normal.y);
  else nextCell.z += Math.sign(normal.z);
  return nextCell;
}

function updatePointer(ndcX = state.ndc.x, ndcY = state.ndc.y) {
  state.ndc.set(ndcX, ndcY);
  state.raycaster.setFromCamera(state.ndc, state.camera);
  const blockMeshes = [...state.blockManager.blocks.values()].map((block) => block.mesh);
  const hits = state.raycaster.intersectObjects([...blockMeshes, state.ground], false);
  const hit = hits[0] || null;
  state.hoveredBlockId = hit?.object !== state.ground ? hit?.object.userData.blockId || null : null;
  state.pointerPoint = hit ? hit.point.clone() : null;
  state.previewCell = hit ? getCellFromHit(hit) : null;
  state.previewValid = Boolean(state.previewCell && state.blockManager.canPlace(state.previewCell, state.draggingBlockId));

  if (state.previewCell) {
    const cellPosition = cellToWorld(state.previewCell);
    state.preview.position.copy(cellPosition);
    state.preview.material.color.setHex(state.previewValid ? BLOCK_TYPES[state.selectedType].color : 0xff5e57);
    state.preview.visible = state.mode === "build";
    state.cursorOrb.position.copy(hit.point).add(new THREE.Vector3(0, 0.06, 0));
    state.cursorOrb.visible = true;
  } else {
    state.preview.visible = false;
    state.cursorOrb.visible = false;
  }
  refreshHover();
}

function refreshHover() {
  if (!state.highlight || !state.blockManager) return;
  const highlightedId = state.fistTargetId || state.hoveredBlockId;
  const block = state.blockManager.get(highlightedId);
  state.highlight.visible = Boolean(block);
  if (block) {
    state.highlight.setFromObject(block.mesh);
    state.highlight.material.color.set(state.gesture === "FIST" || state.mode === "delete" ? 0xff8068 : 0xf3ffe2);
  }
  if (state.draggingBlockId) {
    const selected = state.blockManager.get(state.draggingBlockId);
    if (selected) {
      state.highlight.visible = true;
      state.highlight.setFromObject(selected.mesh);
      state.highlight.material.color.set(0xc9f278);
    }
  }
  const active = state.blockManager.get(state.hoveredBlockId);
  const type = active ? BLOCK_TYPES[active.type] : BLOCK_TYPES[state.selectedType];
  setText(elements.selectedBlock, active ? `${type.label} · ${active.id.toUpperCase()}` : type.label);
  elements.selectedSwatch.style.backgroundColor = `#${type.color.toString(16).padStart(6, "0")}`;
}

function placeBlock(cell = state.previewCell) {
  if (!cell || !state.blockManager.canPlace(cell)) {
    showToast("Choose an open grid cell to place a block.");
    return false;
  }
  captureHistory();
  state.blockManager.create({ type: state.selectedType, position: cell });
  return true;
}

function beginDrag(blockId, source) {
  const block = state.blockManager.get(blockId);
  if (!block) return false;
  captureHistory();
  state.draggingBlockId = blockId;
  state.dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), block.mesh.position);
  if (source === "mouse") state.controls.enabled = false;
  refreshHover();
  return true;
}

function updateDrag() {
  if (!state.draggingBlockId) return;
  const block = state.blockManager.get(state.draggingBlockId);
  if (!block || !state.raycaster.ray.intersectPlane(state.dragPlane, dragPoint)) return;
  const nextCell = {
    x: Math.max(0, Math.min(GRID_SIZE - 1, Math.round(dragPoint.x + GRID_HALF - 0.5))),
    y: block.position.y,
    z: Math.max(0, Math.min(GRID_SIZE - 1, Math.round(dragPoint.z + GRID_HALF - 0.5)))
  };
  if (state.blockManager.canPlace(nextCell, block.id)) state.blockManager.move(block.id, nextCell);
}

function endDrag() {
  if (!state.draggingBlockId) return;
  state.draggingBlockId = null;
  state.controls.enabled = true;
  refreshHover();
}

const dragPoint = new THREE.Vector3();

function deleteBlock(id) {
  if (!id || !state.blockManager.get(id)) return false;
  captureHistory();
  state.blockManager.remove(id);
  if (state.fistTargetId === id) state.fistTargetId = null;
  refreshHover();
  return true;
}

function onWorldPointerMove(event) {
  state.inputSource = "mouse";
  state.pointerActive = true;
  const rect = elements.worldCanvas.getBoundingClientRect();
  const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  updatePointer(ndcX, ndcY);
  if (state.draggingBlockId) updateDrag();
}

function bindWorldInputs() {
  elements.worldCanvas.addEventListener("pointermove", onWorldPointerMove);
  elements.worldCanvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    onWorldPointerMove(event);
    if (state.mode === "edit" && state.hoveredBlockId) {
      beginDrag(state.hoveredBlockId, "mouse");
      elements.worldCanvas.setPointerCapture(event.pointerId);
    }
  }, { capture: true });
  elements.worldCanvas.addEventListener("pointerup", () => endDrag());
  elements.worldCanvas.addEventListener("pointercancel", () => endDrag());
  elements.worldCanvas.addEventListener("click", () => {
    if (state.mode === "build") placeBlock();
    else if (state.mode === "delete" && state.hoveredBlockId) deleteBlock(state.hoveredBlockId);
  });

  document.querySelectorAll(".mode-button").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  document.querySelectorAll(".material-button").forEach((button) => button.addEventListener("click", () => selectBlockType(button.dataset.blockType)));
  elements.undoButton.addEventListener("click", undo);
  elements.redoButton.addEventListener("click", redo);
  elements.clearWorld.addEventListener("click", () => {
    if (!state.blockManager.blocks.size) return;
    if (!window.confirm("Clear every block in this world?")) return;
    captureHistory();
    state.blockManager.restore([]);
  });
  elements.saveButton.addEventListener("click", saveBuild);
  elements.loadButton.addEventListener("click", () => elements.loadFile.click());
  elements.loadFile.addEventListener("change", loadBuildFile);
  window.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
  });
  window.addEventListener("resize", resizeWorld);
}

function saveBuild() {
  const saveData = { version: 1, gridSize: GRID_SIZE, blocks: state.blockManager.serialize() };
  const blob = new Blob([JSON.stringify(saveData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "handblock-build.json";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  showToast("Build saved as handblock-build.json");
}

async function loadBuildFile(event) {
  const [file] = event.target.files || [];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.blocks)) throw new Error("The file does not contain a block list.");
    const validBlocks = data.blocks.filter((block) => BLOCK_TYPES[block.type] && block.position && isCellInWorld(block.position));
    if (validBlocks.length !== data.blocks.length) throw new Error("The build contains invalid block data.");
    const occupied = new Set();
    for (const block of validBlocks) {
      const key = cellKey(block.position);
      if (occupied.has(key)) throw new Error("The build contains overlapping blocks.");
      occupied.add(key);
    }
    captureHistory();
    state.blockManager.restore([]);
    for (const block of validBlocks) state.blockManager.create(block, false);
    showToast(`Loaded ${validBlocks.length} blocks.`);
  } catch (error) {
    showToast(error.message || "That build file could not be loaded.");
  }
  elements.loadFile.value = "";
}

function resizeWorld() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  state.camera.aspect = width / height;
  state.camera.updateProjectionMatrix();
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  state.renderer.setSize(width, height, false);
  resizeHandCanvas();
}

function resizeHandCanvas() {
  const bounds = elements.handCanvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(bounds.width * ratio);
  const height = Math.round(bounds.height * ratio);
  if (elements.handCanvas.width !== width || elements.handCanvas.height !== height) {
    elements.handCanvas.width = width;
    elements.handCanvas.height = height;
  }
  state.handContext.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function cameraPoint(point, width, height) {
  const videoWidth = elements.cameraVideo.videoWidth;
  const videoHeight = elements.cameraVideo.videoHeight;
  if (!videoWidth || !videoHeight) return { x: 0, y: 0 };
  const scale = Math.max(width / videoWidth, height / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  return {
    x: (width - renderedWidth) / 2 + (1 - point.x) * renderedWidth,
    y: (height - renderedHeight) / 2 + point.y * renderedHeight
  };
}

function drawHandLandmarks() {
  resizeHandCanvas();
  const bounds = elements.handCanvas.getBoundingClientRect();
  const context = state.handContext;
  context.clearRect(0, 0, bounds.width, bounds.height);
  state.hands.forEach((landmarks, handIndex) => {
    const points = landmarks.map((point) => cameraPoint(point, bounds.width, bounds.height));
    const color = handIndex === 0 ? "#c9f278" : "#7de2d4";
    context.strokeStyle = color;
    context.lineWidth = 1.35;
    context.globalAlpha = 0.85;
    for (const [start, end] of HAND_CONNECTIONS) {
      context.beginPath();
      context.moveTo(points[start].x, points[start].y);
      context.lineTo(points[end].x, points[end].y);
      context.stroke();
    }
    context.globalAlpha = 1;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      context.beginPath();
      context.arc(point.x, point.y, [4, 8, 12, 16, 20].includes(index) ? 2.5 : 1.5, 0, Math.PI * 2);
      context.fillStyle = index === 8 ? "#ffffff" : color;
      context.fill();
    }
  });
}

function landmarkToNdc(point) {
  return { x: (1 - point.x) * 2 - 1, y: 1 - point.y * 2 };
}

function landmarkDistance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function classifyGesture(landmarks) {
  const wrist = landmarks[0];
  const palmScale = Math.max(landmarkDistance(wrist, landmarks[9]), 0.001);
  if (landmarkDistance(landmarks[4], landmarks[8]) / palmScale < 0.38) return "Pinch";
  const extended = [[8, 6], [12, 10], [16, 14], [20, 18]].map(([tip, joint]) =>
    landmarkDistance(wrist, landmarks[tip]) > landmarkDistance(wrist, landmarks[joint]) * 1.12
  );
  if (extended.filter((value) => !value).length >= 3) return "Fist";
  if (extended[0] && extended[1] && !extended[2] && !extended[3]) return "Two fingers";
  if (extended.every(Boolean)) return "Open hand";
  return "Pointing";
}

function beginHandDrag() {
  if (state.mode !== "edit" || !state.hoveredBlockId || state.draggingBlockId) return;
  beginDrag(state.hoveredBlockId, "hand");
}

function updateFistDelete(now, gesture) {
  const hoveredId = state.hoveredBlockId;
  if (gesture !== "Fist") {
    state.fistTargetId = null;
    state.fistStartedAt = 0;
    state.fistDeleted = false;
    elements.handTip.classList.remove("is-deleting");
    elements.handTip.style.setProperty("--delete-progress", "0%");
    refreshHover();
    return;
  }
  if (!hoveredId) {
    state.fistTargetId = null;
    state.fistStartedAt = 0;
    elements.handTip.classList.remove("is-deleting");
    setText(elements.tipText, state.fistDeleted ? "BLOCK REMOVED" : "FIST · AIM AT BLOCK");
    refreshHover();
    return;
  }
  if (state.fistDeleted) {
    refreshHover();
    return;
  }
  if (state.fistTargetId !== hoveredId) {
    state.fistTargetId = hoveredId;
    state.fistStartedAt = now;
  }
  const elapsed = now - state.fistStartedAt;
  const progress = Math.min(1, elapsed / FIST_DELETE_MS);
  elements.handTip.style.setProperty("--delete-progress", `${Math.round(progress * 100)}%`);
  elements.handTip.classList.add("is-deleting");
  setText(elements.tipText, `HOLD TO DELETE ${Math.ceil(Math.max(0, FIST_DELETE_MS - elapsed) / 100) / 10}s`);
  refreshHover();
  if (elapsed >= FIST_DELETE_MS) {
    state.fistDeleted = deleteBlock(hoveredId);
    setText(elements.tipText, "BLOCK REMOVED");
  }
}

function processHandGesture(now) {
  const observed = state.hands.length ? classifyGesture(state.hands[0]) : "Waiting";
  if (observed !== state.candidateGesture) {
    state.candidateGesture = observed;
    state.candidateSince = now;
  }
  if (now - state.candidateSince >= GESTURE_STABLE_MS) state.stableGesture = state.candidateGesture;
  const gesture = state.stableGesture || (state.hands.length ? "Pointing" : "Waiting");
  const label = state.hands.length ? gesture : "MOUSE";
  setGesture(label);

  if (gesture === "Two fingers" && state.previousGesture !== gesture) setMode("build");
  if (gesture === "Pinch" && state.previousGesture !== gesture) {
    if (state.mode === "edit") beginHandDrag();
    else if (state.mode === "build" && state.previewValid) placeBlock(state.previewCell);
  }
  if (gesture === "Pinch" && state.draggingBlockId) updateDrag();
  if (state.previousGesture === "Pinch" && gesture !== "Pinch" && state.draggingBlockId) endDrag();
  updateFistDelete(now, gesture);
  if (gesture !== "Fist") elements.handTip.classList.remove("is-deleting");
  state.previousGesture = gesture;
}

async function loadHandTracker() {
  const { FilesetResolver, HandLandmarker } = await import(VISION_MODULE_URL);
  const fileset = await FilesetResolver.forVisionTasks(VISION_WASM_URL);
  const options = {
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5
  };
  try {
    return await HandLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: "GPU" }
    });
  } catch {
    return HandLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: "CPU" }
    });
  }
}

async function startCamera() {
  if (state.cameraLoadInProgress) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    setCameraStatus("Camera unavailable", "error", "Use a current browser on localhost or HTTPS.");
    showToast("Camera access requires a supported browser and a secure page such as localhost or HTTPS.");
    return;
  }
  state.cameraLoadInProgress = true;
  const session = ++state.cameraSession;
  elements.startCamera.disabled = true;
  setCameraStatus("Requesting camera", "loading", "Waiting for camera permission…");
  try {
    if (!state.cameraStream) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
      });
      if (session !== state.cameraSession) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      state.cameraStream = stream;
      elements.cameraVideo.srcObject = stream;
      await elements.cameraVideo.play();
    }
    if (session !== state.cameraSession) return;
    elements.cameraDock.dataset.active = "true";
    elements.stopCamera.disabled = false;
    setCameraStatus("Loading tracker", "loading", "Loading hand tracking model…");
    if (!state.handLandmarker) {
      const tracker = await loadHandTracker();
      if (session !== state.cameraSession) {
        tracker.close();
        return;
      }
      state.handLandmarker = tracker;
    }
    if (session !== state.cameraSession) return;
    elements.cameraDock.dataset.active = "true";
    elements.cameraLive.textContent = "LIVE";
    elements.startCamera.disabled = true;
    elements.stopCamera.disabled = false;
    setCameraStatus("Camera ready", "ready", "Camera and tracking are active on this device.");
  } catch (error) {
    if (session !== state.cameraSession) return;
    const message = cameraErrorMessage(error);
    const trackerFailed = Boolean(state.cameraStream && !state.handLandmarker);
    setCameraStatus(trackerFailed ? "Tracker unavailable" : "Camera permission needed", "error", message);
    showToast(message);
    elements.cameraLive.textContent = trackerFailed ? "OFFLINE" : "STANDBY";
    elements.startCamera.disabled = false;
    elements.stopCamera.disabled = !state.cameraStream;
  } finally {
    if (session === state.cameraSession) state.cameraLoadInProgress = false;
  }
}

function cameraErrorMessage(error) {
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") return "Camera permission was blocked. Allow camera access in browser settings, then try again.";
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") return "No camera was found. Connect a webcam and try again.";
  if (error?.name === "NotReadableError" || error?.name === "TrackStartError") return "The camera is busy in another app. Close that app and retry.";
  if (state.cameraStream && !state.handLandmarker) return "The hand tracker could not load. Check your internet connection and restart the camera.";
  if (!state.cameraStream && error instanceof TypeError) return "Camera access needs localhost or HTTPS. Open this page through Live Server.";
  return "Camera startup failed. Check browser permissions and try again.";
}

function stopCamera() {
  state.cameraSession += 1;
  state.cameraLoadInProgress = false;
  state.cameraStream?.getTracks().forEach((track) => track.stop());
  state.cameraStream = null;
  elements.cameraVideo.srcObject = null;
  elements.cameraDock.dataset.active = "false";
  elements.cameraLive.textContent = "STANDBY";
  elements.startCamera.disabled = false;
  elements.stopCamera.disabled = true;
  state.hands = [];
  state.lastVideoTime = -1;
  state.inputSource = "mouse";
  state.candidateGesture = "";
  state.stableGesture = "";
  state.previousGesture = "";
  state.fistTargetId = null;
  state.fistStartedAt = 0;
  state.fistDeleted = false;
  endDrag();
  setGesture("MOUSE");
  setCameraStatus("Camera off", "idle", "Camera frames stay on this device.");
  drawHandLandmarks();
}

function detectHands() {
  if (!state.handLandmarker || !state.cameraStream || elements.cameraVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  if (elements.cameraVideo.currentTime === state.lastVideoTime) return;
  state.lastVideoTime = elements.cameraVideo.currentTime;
  try {
    const result = state.handLandmarker.detectForVideo(elements.cameraVideo, performance.now());
    state.hands = result.landmarks || [];
    setText(elements.handCount, state.hands.length);
    drawHandLandmarks();
    if (state.hands.length) {
      const point = landmarkToNdc(state.hands[0][8]);
      state.inputSource = "hand";
      state.pointerActive = true;
      updatePointer(point.x, point.y);
    } else if (state.inputSource === "hand") {
      state.inputSource = "mouse";
      state.pointerActive = false;
      state.hoveredBlockId = null;
      state.preview.visible = false;
      state.cursorOrb.visible = false;
      refreshHover();
    }
  } catch (error) {
    console.error("Hand tracking paused:", error);
    state.hands = [];
    setText(elements.handCount, 0);
    setCameraStatus("Tracking paused", "error", "Tracking paused. Stop and restart the camera to retry.");
  }
}

function updateAnimations(delta) {
  const amount = Math.min(1, delta * 12);
  for (const block of state.blockManager.blocks.values()) {
    if (block.mesh.userData.animatingIn) {
      block.mesh.scale.lerp(block.mesh.userData.targetScale, amount);
      if (block.mesh.scale.distanceTo(block.mesh.userData.targetScale) < 0.02) {
        block.mesh.scale.copy(block.mesh.userData.targetScale);
        block.mesh.userData.animatingIn = false;
      }
    }
  }
  state.removalMeshes = state.removalMeshes.filter((mesh) => {
    mesh.scale.multiplyScalar(Math.max(0, 1 - delta * 5.5));
    if (mesh.scale.x < 0.055) {
      state.scene.remove(mesh);
      return false;
    }
    return true;
  });
}

function updateFps(now) {
  state.fpsFrames += 1;
  const elapsed = now - state.lastFpsUpdate;
  if (elapsed >= 500) {
    setText(elements.fps, Math.round(state.fpsFrames * 1000 / elapsed));
    state.fpsFrames = 0;
    state.lastFpsUpdate = now;
  }
}

function animate(now) {
  requestAnimationFrame(animate);
  const delta = Math.min((now - state.lastFrameAt) / 1000, 0.05);
  state.lastFrameAt = now;
  detectHands();
  processHandGesture(now);
  state.controls.update();
  updateAnimations(delta);
  if (state.hoveredBlockId || state.draggingBlockId) refreshHover();
  state.renderer.render(state.scene, state.camera);
  updateFps(now);
}

try {
  initializeWorld();
  bindWorldInputs();
  selectBlockType("basic");
  setMode("build");
  elements.startCamera.addEventListener("click", startCamera);
  elements.stopCamera.addEventListener("click", stopCamera);
  resizeHandCanvas();
  requestAnimationFrame(animate);
} catch (error) {
  console.error("HandBlock could not initialize the 3D world:", error);
  setCameraStatus("3D unavailable", "error", "Enable WebGL in a current browser to open the building world.");
  showToast("The 3D world could not start. Try a browser with WebGL enabled.");
}