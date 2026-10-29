import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { MASK, COLS, ROWS, NORTH } from './worldMask';

/**
 * The AbleSpeak logo as a turning 3D globe, for the sign-in page; the same
 * globe as the funding agent's welcome page. Land is a field of small pillars
 * standing on the sphere, gold in the north to teal in the south like the
 * logo, moving like a voice meter; a dotted ocean sits under it with a soft
 * gold rim. It turns slowly with Africa first, a wave runs round it from
 * Nairobi, and the gold microphone floats above. Drag to spin it; a click
 * sends a ripple out from where you clicked.
 *
 * It is decoration, so it stays cheap: 30 frames a second at most (the
 * speech engine shares this computer), nothing while the window or the
 * globe is out of sight, and one still frame for prefers-reduced-motion.
 *
 * mountGlobe(stage, host) draws into `stage` and listens for the pointer on
 * `host`. It returns a function that stops it and frees the GPU, or null
 * when the computer has no WebGL (the page then keeps its flat logo).
 */

const DEG = Math.PI / 180;
const HOME = { lon: 36.82, lat: -1.29 }; // Nairobi
const FACE_LON = 20;                      // the longitude facing you at the start: Africa
const TILT = 0.2;                         // radians: seen a little from the north
const TURN_SECONDS = 90;                  // one full turn
const R = 40;                             // globe radius, world units
const WAVE_EVERY = 6;                     // seconds between waves from Nairobi
const RIPPLE_SPEED = 0.9;                 // radians of arc per second
const RIPPLE_LIFE = 3;                    // seconds
const FRAME_MS = 1000 / 30;

const bits = Uint8Array.from(atob(MASK), c => c.charCodeAt(0));
function isLand(lon, lat) {
  const row = Math.floor(NORTH - lat);
  if (row < 0 || row >= ROWS) return false;
  const col = ((Math.floor(lon + 180) % COLS) + COLS) % COLS;
  const i = row * COLS + col;
  return (bits[i >> 3] >> (7 - (i & 7))) & 1;
}
const clamp01 = v => Math.min(1, Math.max(0, v));
const easeOut = v => 1 - Math.pow(1 - v, 3);
const easeBack = v => 1 + 2.2 * Math.pow(v - 1, 3) + 1.2 * Math.pow(v - 1, 2);
function unit(lon, lat) {
  const cl = Math.cos(lat * DEG);
  return new THREE.Vector3(cl * Math.sin(lon * DEG), Math.sin(lat * DEG), cl * Math.cos(lon * DEG));
}

function dotTexture(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  stops.forEach(([at, colour]) => grd.addColorStop(at, colour));
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function mountGlobe(stage, host) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.setAttribute('aria-hidden', 'true');
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  // Drawn on black and screened over the page, so the bloom glows into it
  renderer.domElement.style.mixBlendMode = 'screen';
  // Fade the top and sides so the glow never stops in a hard line at the canvas
  // edge. On the canvas itself: a mask on the stage would isolate the screen blend
  // and show the black backdrop as a box.
  renderer.domElement.style.maskImage =
    'linear-gradient(to bottom, transparent, #000 28px), linear-gradient(to right, transparent, #000 18%, #000 82%, transparent)';
  renderer.domElement.style.maskComposite = 'intersect';
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(32, 1, 1, 2000);
  const rig = new THREE.Group();   // leans towards the pointer
  const tilt = new THREE.Group();  // the globe's axis, tipped towards you
  const globe = new THREE.Group(); // spins
  tilt.rotation.x = TILT;
  scene.add(rig);
  rig.add(tilt);
  tilt.add(globe);

  // ---- the lattice: dots spread evenly over the sphere, land or sea ----
  const step = 0.78;
  const n = Math.round(4 * Math.PI * R * R / (step * step));
  const golden = Math.PI * (3 - Math.sqrt(5));
  const land = [], sea = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const ring = Math.sqrt(1 - y * y);
    const t = golden * i;
    const x = Math.cos(t) * ring, z = Math.sin(t) * ring;
    const lat = Math.asin(y) / DEG, lon = Math.atan2(x, z) / DEG;
    if (isLand(lon, lat)) land.push(x, y, z, lat, lon);
    else sea.push(x * R * 1.002, y * R * 1.002, z * R * 1.002);
  }
  const count = land.length / 5;

  // ---- land: one pillar per dot, standing along the sphere's normal ----
  const pillar = new THREE.CylinderGeometry(0.26, 0.26, 1, 8);
  pillar.translate(0, 0.5, 0);
  const landMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.12 });
  const landMesh = new THREE.InstancedMesh(pillar, landMat, count);
  landMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  globe.add(landMesh);

  const NX = new Float32Array(count), NY = new Float32Array(count), NZ = new Float32Array(count);
  const Q = new Float32Array(count * 4), T = new Float32Array(count), ANG = new Float32Array(count), PH = new Float32Array(count);
  const homeVec = unit(HOME.lon, HOME.lat);
  const up = new THREE.Vector3(0, 1, 0), nrm = new THREE.Vector3(), q = new THREE.Quaternion();
  let homeIndex = -1, best = Infinity;
  for (let i = 0; i < count; i++) {
    const x = land[i * 5], y = land[i * 5 + 1], z = land[i * 5 + 2], lat = land[i * 5 + 3], lon = land[i * 5 + 4];
    NX[i] = x; NY[i] = y; NZ[i] = z;
    nrm.set(x, y, z);
    q.setFromUnitVectors(up, nrm);
    Q[i * 4] = q.x; Q[i * 4 + 1] = q.y; Q[i * 4 + 2] = q.z; Q[i * 4 + 3] = q.w;
    // Gold north, teal south, as in the logo: a short blend across the tropics
    const v = clamp01((11.5 - lat) / 19);
    T[i] = v * v * (3 - 2 * v);
    ANG[i] = Math.acos(Math.max(-1, Math.min(1, x * homeVec.x + y * homeVec.y + z * homeVec.z)));
    PH[i] = (Math.sin(lon * 12.9898 + lat * 78.233) * 43758.5453) % (Math.PI * 2);
    if (ANG[i] < best) { best = ANG[i]; homeIndex = i; }
  }

  // ---- the ocean: a sphere, a dot field on it, and a soft gold rim ----
  const oceanMat = new THREE.MeshStandardMaterial({ color: 0x101634, emissive: 0x0A1030, roughness: 0.9, metalness: 0.05 });
  globe.add(new THREE.Mesh(new THREE.SphereGeometry(R * 0.996, 96, 64), oceanMat));
  const seaGeo = new THREE.BufferGeometry();
  seaGeo.setAttribute('position', new THREE.Float32BufferAttribute(sea, 3));
  const seaMat = new THREE.PointsMaterial({
    color: 0x4C86FF, opacity: 0.55, size: 0.34, sizeAttenuation: true, transparent: true, depthWrite: false,
    map: dotTexture([[0, 'rgba(255,255,255,1)'], [0.55, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]),
  });
  globe.add(new THREE.Points(seaGeo, seaMat));
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: { colour: { value: new THREE.Color(0xF5A623) }, strength: { value: 0.55 } },
    vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 colour; uniform float strength; varying vec3 vN; void main(){ float i = pow(max(0.0, 0.62 - dot(vN, vec3(0.0, 0.0, 1.0))), 4.0) * 2.2; gl_FragColor = vec4(colour, i * strength); }',
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  tilt.add(new THREE.Mesh(new THREE.SphereGeometry(R * 1.09, 64, 48), atmoMat));

  // ---- rings on the surface: one rides the Nairobi wave, the rest are clicks ----
  const RING_POINTS = 96;
  function makeRing() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((RING_POINTS + 1) * 3), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0xFFC14D, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    line.visible = false;
    globe.add(line);
    return line;
  }
  const u = new THREE.Vector3(), w = new THREE.Vector3(), xAxis = new THREE.Vector3(1, 0, 0);
  function placeRing(line, c, angle) {
    if (Math.abs(c.y) < 0.9) u.crossVectors(c, up).normalize(); else u.crossVectors(c, xAxis).normalize();
    w.crossVectors(c, u);
    const p = line.geometry.attributes.position.array;
    const ca = Math.cos(angle), sa = Math.sin(angle), r = R * 1.01;
    for (let k = 0; k <= RING_POINTS; k++) {
      const f = (k / RING_POINTS) * Math.PI * 2, cf = Math.cos(f), sf = Math.sin(f);
      p[k * 3] = (c.x * ca + (u.x * cf + w.x * sf) * sa) * r;
      p[k * 3 + 1] = (c.y * ca + (u.y * cf + w.y * sf) * sa) * r;
      p[k * 3 + 2] = (c.z * ca + (u.z * cf + w.z * sf) * sa) * r;
    }
    line.geometry.attributes.position.needsUpdate = true;
  }
  const waveRing = makeRing();
  const clickRings = [makeRing(), makeRing(), makeRing(), makeRing()];
  const ripples = []; // { c: Vector3 in the globe's space, t0, ring }

  // ---- the microphone, floating above the north pole, seen from a little above ----
  const mic = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({ color: 0xF5A623, metalness: 0.85, roughness: 0.28, emissive: 0xF5A623, emissiveIntensity: 0.1 });
  const head = new THREE.Mesh(new THREE.CapsuleGeometry(3.1, 5.2, 8, 24), gold);
  head.position.y = 10.5;
  mic.add(head);
  for (const y of [8.6, 10.5, 12.4]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.16, 8, 40), gold);
    band.rotation.x = Math.PI / 2;
    band.position.y = y;
    mic.add(band);
  }
  const cradle = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.42, 10, 40, Math.PI), gold);
  cradle.rotation.z = Math.PI;
  cradle.position.y = 10.2;
  mic.add(cradle);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 4.2, 12), gold);
  stem.position.y = 3.6;
  mic.add(stem);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.8, 0.7, 32), gold);
  foot.position.y = 1.2;
  mic.add(foot);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: dotTexture([[0, 'rgba(255,200,110,0.85)'], [0.35, 'rgba(245,166,35,0.35)'], [1, 'rgba(245,166,35,0)']]),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  halo.scale.set(21, 21, 1);
  halo.position.y = 10.5;
  mic.add(halo);
  mic.rotation.x = 0.66;
  const MIC_Y = R + 7;
  mic.position.set(0, MIC_Y, 0);
  rig.add(mic);

  // ---- gold dust drifting up off the globe ----
  const DUST = 260;
  const dustPos = new Float32Array(DUST * 3), dustDir = new Float32Array(DUST * 3), dustR = new Float32Array(DUST), dustV = new Float32Array(DUST);
  for (let k = 0; k < DUST; k++) {
    const i = Math.floor(Math.random() * count);
    dustDir[k * 3] = NX[i]; dustDir[k * 3 + 1] = NY[i]; dustDir[k * 3 + 2] = NZ[i];
    dustR[k] = R + Math.random() * 12;
    dustV[k] = 0.4 + Math.random() * 0.9;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({
    size: 0.6, sizeAttenuation: true, transparent: true, depthWrite: false, color: 0xFFD27A, blending: THREE.AdditiveBlending,
    map: dotTexture([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]),
  });
  globe.add(new THREE.Points(dustGeo, dustMat));

  // ---- light ----
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 0.95));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(-60, 80, 90);
  scene.add(sun);
  const glow = new THREE.PointLight(0xFFB347, 520, 90, 1.6); // the mic's own warm light, which follows it
  glow.position.set(0, MIC_Y + 12, 3);
  rig.add(glow);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.35, 0.74));
  composer.addPass(new OutputPass());

  const north = new THREE.Color(0xF5A623), south = new THREE.Color(0x2FBF8F), crest = new THREE.Color(0xFFF1D2), tmp = new THREE.Color();

  // ---- layout ----
  function resize() {
    const wpx = stage.clientWidth, hpx = stage.clientHeight;
    if (!wpx || !hpx) return;
    renderer.setSize(wpx, hpx, false);
    composer.setSize(wpx, hpx);
    camera.aspect = wpx / hpx;
    // Frame the globe, its rim and the mic above it, whatever the shape
    const fit = Math.max(212, 178 / Math.min(1, camera.aspect));
    camera.position.set(0, 14, fit);
    camera.lookAt(0, 12, 0);
    camera.updateProjectionMatrix();
  }

  // ---- the pointer: lean, lift, drag to spin, click for a ripple ----
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = { x: 0, y: 0 }, lean = { x: 0, y: 0 };
  const lift = { dir: new THREE.Vector3(), amount: 0, target: 0 };
  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const sphere = new THREE.Sphere(new THREE.Vector3(), R), hit = new THREE.Vector3();
  let spinOffset = 0, spinVel = 0;
  const drag = { on: false, x: 0, moved: 0, id: null };
  const t0 = performance.now();
  const clock = () => (performance.now() - t0) / 1000;

  function globePoint(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectSphere(sphere, hit)) return null;
    return globe.worldToLocal(hit.clone()).normalize();
  }
  function onMove(e) {
    const r = host.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = ((e.clientY - r.top) / r.height) * 2 - 1;
    if (drag.on) {
      const dx = e.clientX - drag.x;
      drag.x = e.clientX;
      drag.moved += Math.abs(dx);
      spinOffset += dx * 0.006;
      spinVel = dx * 0.006;
    }
    const p = globePoint(e);
    if (p) lift.dir.copy(p);
    lift.target = p && !drag.on ? 1 : 0;
  }
  function onLeave() { pointer.x = pointer.y = 0; lift.target = 0; }
  function onDown(e) {
    if (!globePoint(e)) return;
    drag.on = true; drag.x = e.clientX; drag.moved = 0; drag.id = e.pointerId;
    spinVel = 0;
    host.setPointerCapture(e.pointerId);
    host.dataset.dragging = 'true';
  }
  function onUp(e) {
    if (!drag.on) return;
    drag.on = false;
    delete host.dataset.dragging;
    try { host.releasePointerCapture(drag.id); } catch { /* already released */ }
    if (drag.moved < 5 && !still.matches && e.type === 'pointerup') {
      const p = globePoint(e);
      if (!p) return;
      if (ripples.length >= clickRings.length) ripples.shift().ring.visible = false;
      const ring = clickRings.find(rg => !ripples.some(rp => rp.ring === rg));
      ripples.push({ c: p, t0: clock(), ring });
    }
  }

  // ---- motion ----
  const m = new THREE.Matrix4(), pos = new THREE.Vector3(), scl = new THREE.Vector3(1, 1, 1), quat = new THREE.Quaternion();
  let last = 0;
  function draw() {
    const moving = !still.matches;
    const t = moving ? clock() : 30; // reduced motion: long after the intro, frozen
    const dt = Math.min(0.05, Math.max(0, t - last));
    last = t;
    if (!drag.on) { spinOffset += spinVel; spinVel *= 0.94; }
    globe.rotation.y = -FACE_LON * DEG - (moving ? (t / TURN_SECONDS) * Math.PI * 2 : 0) + spinOffset;

    const age = t % WAVE_EVERY;
    const front = (age / (WAVE_EVERY * 0.8)) * Math.PI;
    const fade = moving ? Math.max(0, 1 - age / (WAVE_EVERY * 0.9)) : 0;
    lift.amount += (lift.target - lift.amount) * 0.08;
    for (let k = ripples.length - 1; k >= 0; k--) {
      if ((t - ripples[k].t0) / RIPPLE_LIFE >= 1) { ripples[k].ring.visible = false; ripples.splice(k, 1); }
    }

    for (let i = 0; i < count; i++) {
      const rise = easeOut(clamp01((t - 0.15 - (ANG[i] / Math.PI) * 1.1) / 0.8));
      const nx = NX[i], ny = NY[i], nz = NZ[i];
      const meter = 0.5 + 0.5 * Math.sin(nx * 7 + t * 2.1) * Math.cos(ny * 6 - t * 1.3);
      const d = (ANG[i] - front) / 0.07;
      const wave = Math.exp(-d * d) * fade;
      let extra = 0;
      if (lift.amount > 0.01) {
        const c = nx * lift.dir.x + ny * lift.dir.y + nz * lift.dir.z;
        extra += 2.2 * lift.amount * Math.exp(-(1 - c) / 0.012);
      }
      for (const rp of ripples) {
        const a = Math.acos(Math.max(-1, Math.min(1, nx * rp.c.x + ny * rp.c.y + nz * rp.c.z)));
        const dr = (a - (t - rp.t0) * RIPPLE_SPEED) / 0.06;
        extra += 2.6 * Math.exp(-dr * dr) * (1 - (t - rp.t0) / RIPPLE_LIFE);
      }
      const h = (0.35 + 0.9 * meter + 0.2 * Math.sin(t * 1.7 + PH[i]) + 3.2 * wave + extra
                 + (i === homeIndex ? 2 : 0)) * rise;
      pos.set(nx * R, ny * R, nz * R);
      quat.set(Q[i * 4], Q[i * 4 + 1], Q[i * 4 + 2], Q[i * 4 + 3]);
      scl.y = Math.max(0.05, h);
      m.compose(pos, quat, scl);
      landMesh.setMatrixAt(i, m);
      tmp.copy(north).lerp(south, T[i]).lerp(crest, Math.min(1, wave * 0.75 + extra * 0.15 + (i === homeIndex ? 0.6 : 0)));
      landMesh.setColorAt(i, tmp);
    }
    landMesh.instanceMatrix.needsUpdate = true;
    landMesh.instanceColor.needsUpdate = true;

    const intro = clamp01((t - 1.6) / 0.8);
    waveRing.visible = fade > 0.02 && front > 0.05;
    if (waveRing.visible) {
      placeRing(waveRing, homeVec, Math.min(front, Math.PI - 0.01));
      waveRing.material.opacity = fade * 0.8 * intro * Math.pow(Math.max(0, 1 - front / Math.PI), 1.2);
    }
    for (const rp of ripples) {
      const life = (t - rp.t0) / RIPPLE_LIFE;
      rp.ring.visible = true;
      placeRing(rp.ring, rp.c, Math.min((t - rp.t0) * RIPPLE_SPEED, Math.PI - 0.01));
      rp.ring.material.opacity = 0.9 * (1 - life);
    }

    for (let k = 0; k < DUST; k++) {
      if (moving) {
        dustR[k] += dustV[k] * dt;
        if (dustR[k] > R + 12) dustR[k] = R + 0.5;
      }
      dustPos[k * 3] = dustDir[k * 3] * dustR[k];
      dustPos[k * 3 + 1] = dustDir[k * 3 + 1] * dustR[k];
      dustPos[k * 3 + 2] = dustDir[k * 3 + 2] * dustR[k];
    }
    dustGeo.attributes.position.needsUpdate = true;
    dustMat.opacity = 0.85 * intro;

    // the mic drops in, then floats
    const drop = easeBack(clamp01((t - 0.5) / 1.2));
    mic.position.y = MIC_Y + 26 * (1 - drop) + Math.sin(t * 1.1) * 0.8;
    glow.position.y = mic.position.y + 12;
    head.rotation.y = Math.sin(t * 0.6) * 0.25;
    halo.material.opacity = (0.45 + 0.1 * Math.sin(t * 2.4)) * clamp01(drop);

    lean.x += (pointer.x - lean.x) * 0.05;
    lean.y += (pointer.y - lean.y) * 0.05;
    if (!drag.on) rig.rotation.y = lean.x * 0.12;
    rig.rotation.x = lean.y * 0.06;
    composer.render();
  }

  let raf = 0, lastFrame = 0, onScreen = true;
  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - lastFrame < FRAME_MS) return;
    lastFrame = now;
    draw();
  }
  function run() {
    cancelAnimationFrame(raf);
    raf = 0;
    if (!onScreen || document.hidden) return;
    if (still.matches) draw();
    else raf = requestAnimationFrame(loop);
  }
  function onResize() { resize(); if (still.matches) run(); }
  function onContextLost(e) { e.preventDefault(); cancelAnimationFrame(raf); }
  function onContextRestored() { resize(); run(); }

  resize();
  run();
  const sizer = new ResizeObserver(onResize);
  sizer.observe(stage);
  const seen = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; run(); });
  seen.observe(stage);
  document.addEventListener('visibilitychange', run);
  still.addEventListener('change', run);
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerleave', onLeave);
  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onUp);
  renderer.domElement.addEventListener('webglcontextlost', onContextLost);
  renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);

  // Stop drawing, let go of every listener, and hand the GPU memory back
  return function dispose() {
    cancelAnimationFrame(raf);
    sizer.disconnect();
    seen.disconnect();
    document.removeEventListener('visibilitychange', run);
    still.removeEventListener('change', run);
    host.removeEventListener('pointermove', onMove);
    host.removeEventListener('pointerleave', onLeave);
    host.removeEventListener('pointerdown', onDown);
    host.removeEventListener('pointerup', onUp);
    host.removeEventListener('pointercancel', onUp);
    scene.traverse(obj => {
      obj.geometry?.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      mats.forEach(mat => { mat.map?.dispose(); mat.dispose(); });
    });
    composer.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
}
