'use strict';

// ===== 調整用定数 =====
const MAX_DIM = 2048;      // 読み込み時にこの長辺まで縮小(iOS の canvas メモリ上限と Undo メモリ対策)
const MAX_HISTORY = 10;    // Undo 履歴の最大数
const MIN_SCALE = 0.05;
const MAX_SCALE = 40;

// ===== 要素 =====
const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const canvas = $('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const emptyScreen = $('empty');
const toast = $('toast');
const fileInput = $('fileInput');
const colorPicker = $('colorPicker');
const sizeSlider = $('sizeSlider');
const sizeValue = $('sizeValue');

// ===== 状態 =====
let hasImage = false;
let origType = 'image/png';   // 読み込んだ画像の MIME(保存形式に引き継ぐ)
let brushShape = 'round';      // 'round' | 'square'
let brushSize = 24;            // 画像ピクセル基準
let eyedropper = false;

let view = { s: 1, tx: 0, ty: 0 };   // 表示変換(canvas CSS transform)

let mode = 'idle';             // 'idle' | 'stroke' | 'pinch'
const pointers = new Map();    // pointerId -> {x, y}(viewport 座標)
let strokeSnapshot = null;     // ストローク開始時点の ImageData(Undo 用 / 2本指キャンセル用)
let lastPt = null;
let pinchStart = null;

const undoStack = [];
const redoStack = [];

// ===== ユーティリティ =====
function showToast(msg, ms = 1800) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.hidden = true; }, ms);
}

function applyView() {
  canvas.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`;
}

function fitView() {
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  const s = Math.min(vw / canvas.width, vh / canvas.height) * 0.98;
  view.s = s;
  view.tx = (vw - canvas.width * s) / 2;
  view.ty = (vh - canvas.height * s) / 2;
  applyView();
}

function toImagePt(vx, vy) {
  return { x: (vx - view.tx) / view.s, y: (vy - view.ty) / view.s };
}

function viewportXY(e) {
  const r = viewport.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function updateButtons() {
  $('undoBtn').disabled = undoStack.length === 0;
  $('redoBtn').disabled = redoStack.length === 0;
  $('saveBtn').disabled = !hasImage;
  $('eyedropBtn').disabled = !hasImage;
  $('fitBtn').disabled = !hasImage;
}

// ===== 画像の読み込み =====
async function openImage(file) {
  if (!file) return;
  try {
    let bmp = await createImageBitmap(file);
    let w = bmp.width, h = bmp.height;
    const scale = Math.min(1, MAX_DIM / Math.max(w, h));
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();

    origType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    hasImage = true;
    undoStack.length = 0;
    redoStack.length = 0;
    canvas.hidden = false;
    emptyScreen.hidden = true;
    setEyedropper(false);
    fitView();
    updateButtons();
    if (scale < 1) showToast(`長辺 ${MAX_DIM}px に縮小して読み込みました`);
  } catch (err) {
    console.error(err);
    showToast('画像を読み込めませんでした');
  }
}

// ===== 描画 =====
function drawDot(p) {
  ctx.fillStyle = colorPicker.value;
  if (brushShape === 'round') {
    ctx.beginPath();
    ctx.arc(p.x, p.y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillRect(p.x - brushSize / 2, p.y - brushSize / 2, brushSize, brushSize);
  }
}

function drawSegment(a, b) {
  if (brushShape === 'round') {
    ctx.strokeStyle = colorPicker.value;
    ctx.lineWidth = brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  } else {
    // 四角ペン先: 軸平行の正方形を補間しながらスタンプ
    ctx.fillStyle = colorPicker.value;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(1, brushSize / 4);
    const n = Math.ceil(dist / step);
    for (let i = 1; i <= n; i++) {
      const x = a.x + (dx * i) / n;
      const y = a.y + (dy * i) / n;
      ctx.fillRect(x - brushSize / 2, y - brushSize / 2, brushSize, brushSize);
    }
  }
}

// ===== Undo / Redo =====
function snapshot() {
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function commitStroke() {
  if (!strokeSnapshot) return;
  undoStack.push(strokeSnapshot);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  strokeSnapshot = null;
  updateButtons();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  ctx.putImageData(undoStack.pop(), 0, 0);
  updateButtons();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  ctx.putImageData(redoStack.pop(), 0, 0);
  updateButtons();
}

// ===== スポイト =====
function setEyedropper(on) {
  eyedropper = on && hasImage;
  $('eyedropBtn').classList.toggle('active', eyedropper);
  viewport.style.cursor = eyedropper ? 'crosshair' : '';
}

function samplePixel(p) {
  const x = Math.round(p.x), y = Math.round(p.y);
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const d = ctx.getImageData(x, y, 1, 1).data;
  const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  colorPicker.value = hex;
  selectSwatch('picker');
  setEyedropper(false);
  showToast(`色を取得: ${hex}`);
}

// ===== ポインタ操作 =====
viewport.addEventListener('pointerdown', (e) => {
  if (!hasImage) return;
  e.preventDefault();
  try { viewport.setPointerCapture(e.pointerId); } catch {}
  const v = viewportXY(e);
  pointers.set(e.pointerId, v);

  if (pointers.size === 1) {
    const p = toImagePt(v.x, v.y);
    if (eyedropper) {
      samplePixel(p);
      return;
    }
    strokeSnapshot = snapshot();
    lastPt = p;
    drawDot(p);
    mode = 'stroke';
  } else if (pointers.size === 2) {
    // 2本目の指 → 進行中のストロークを取り消してピンチへ
    if (mode === 'stroke' && strokeSnapshot) {
      ctx.putImageData(strokeSnapshot, 0, 0);
      strokeSnapshot = null;
    }
    mode = 'pinch';
    startPinch();
  }
});

viewport.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  e.preventDefault();

  if (mode === 'stroke') {
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const events = coalesced.length ? coalesced : [e];
    for (const ev of events) {
      const v = viewportXY(ev);
      const p = toImagePt(v.x, v.y);
      drawSegment(lastPt, p);
      lastPt = p;
    }
    pointers.set(e.pointerId, viewportXY(e));
  } else if (mode === 'pinch') {
    pointers.set(e.pointerId, viewportXY(e));
    movePinch();
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);

  if (mode === 'stroke' && pointers.size === 0) {
    commitStroke();
    mode = 'idle';
  } else if (mode === 'pinch') {
    if (pointers.size >= 1) {
      startPinch(); // 残った指でパン継続(基準を取り直す)
    } else {
      mode = 'idle';
    }
  }
}
viewport.addEventListener('pointerup', endPointer);
viewport.addEventListener('pointercancel', endPointer);

function pinchInfo() {
  const pts = [...pointers.values()];
  if (pts.length >= 2) {
    const [a, b] = pts;
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      dist: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }
  return { cx: pts[0].x, cy: pts[0].y, dist: 0 };
}

function startPinch() {
  pinchStart = { ...pinchInfo(), view: { ...view } };
}

function movePinch() {
  if (!pinchStart) return;
  const cur = pinchInfo();
  let s = pinchStart.view.s;
  if (pinchStart.dist > 0 && cur.dist > 0) {
    s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchStart.view.s * (cur.dist / pinchStart.dist)));
  }
  // ピンチ開始時に中点の下にあった画像上の点を、現在の中点の下に保つ
  const ix = (pinchStart.cx - pinchStart.view.tx) / pinchStart.view.s;
  const iy = (pinchStart.cy - pinchStart.view.ty) / pinchStart.view.s;
  view.s = s;
  view.tx = cur.cx - ix * s;
  view.ty = cur.cy - iy * s;
  applyView();
}

// PC 用: ホイールでズーム
viewport.addEventListener('wheel', (e) => {
  if (!hasImage) return;
  e.preventDefault();
  const v = viewportXY(e);
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.s * factor));
  const ix = (v.x - view.tx) / view.s;
  const iy = (v.y - view.ty) / view.s;
  view.s = s;
  view.tx = v.x - ix * s;
  view.ty = v.y - iy * s;
  applyView();
}, { passive: false });

viewport.addEventListener('contextmenu', (e) => e.preventDefault());

// ===== 保存 =====
async function saveImage() {
  if (!hasImage) return;
  const ext = origType === 'image/jpeg' ? 'jpg' : 'png';
  const ts = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `nurikeshi_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.${ext}`;

  const blob = await new Promise((res) => canvas.toBlob(res, origType, 0.92));
  if (!blob) { showToast('保存に失敗しました'); return; }

  const file = new File([blob], name, { type: origType });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // ユーザーがキャンセル
      // 共有に失敗したらダウンロードにフォールバック
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast('ダウンロードしました');
}

// ===== ツールバー =====
function selectSwatch(which) {
  $('swatchBlack').classList.toggle('selected', which === 'black');
  $('swatchWhite').classList.toggle('selected', which === 'white');
  $('colorWrap').classList.toggle('selected', which === 'picker');
}

$('openBtn').addEventListener('click', () => fileInput.click());
$('emptyOpenBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  openImage(fileInput.files[0]);
  fileInput.value = '';
});

$('saveBtn').addEventListener('click', saveImage);
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('fitBtn').addEventListener('click', fitView);

$('swatchBlack').addEventListener('click', () => { colorPicker.value = '#000000'; selectSwatch('black'); setEyedropper(false); });
$('swatchWhite').addEventListener('click', () => { colorPicker.value = '#ffffff'; selectSwatch('white'); setEyedropper(false); });
colorPicker.addEventListener('input', () => { selectSwatch('picker'); setEyedropper(false); });

$('eyedropBtn').addEventListener('click', () => setEyedropper(!eyedropper));

$('shapeRound').addEventListener('click', () => {
  brushShape = 'round';
  $('shapeRound').classList.add('active');
  $('shapeSquare').classList.remove('active');
});
$('shapeSquare').addEventListener('click', () => {
  brushShape = 'square';
  $('shapeSquare').classList.add('active');
  $('shapeRound').classList.remove('active');
});

sizeSlider.addEventListener('input', () => {
  brushSize = Number(sizeSlider.value);
  sizeValue.textContent = brushSize;
});

selectSwatch('black');
updateButtons();

// ===== Service Worker =====
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
