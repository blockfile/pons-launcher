import { useEffect, useRef } from 'react';
import { EdgesGeometry, IcosahedronGeometry, LineBasicMaterial, LineSegments, PerspectiveCamera, Scene, WebGLRenderer } from 'three';

function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

/**
 * The empty "paste a CA" screen's only decoration: a slow wireframe
 * icosahedron in the hairline colour. Loaded lazily (App: React.lazy) and
 * rendered only while no token is open and the visitor has not asked for
 * reduced motion. It pauses while the tab is hidden, and on unmount it stops
 * the loop, frees the GPU objects, drops the WebGL context and removes its
 * canvas — so it can never run while selling.
 *
 * The canvas is created here rather than in JSX: a canvas whose context was
 * force-lost cannot give a new renderer a live context, and React StrictMode
 * mounts effects twice in development.
 */
export default function EmptyScene() {
  const hostRef = useRef(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    let renderer;
    try {
      renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      canvas.remove(); // no WebGL: the empty screen simply has no scene
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new Scene();
    const camera = new PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0, 6);
    const solid = new IcosahedronGeometry(1.6, 1);
    const edges = new EdgesGeometry(solid);
    const material = new LineBasicMaterial({ color: cssVar('--rule-strong', '#6e6e7c'), transparent: true, opacity: 0.55 });
    const shape = new LineSegments(edges, material);
    scene.add(shape);

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    let last = performance.now();
    const loop = (time) => {
      const dt = Math.min(0.1, (time - last) / 1000);
      last = time;
      shape.rotation.x += dt * 0.08;
      shape.rotation.y += dt * 0.12;
      renderer.render(scene, camera);
    };
    const run = () => {
      last = performance.now();
      renderer.setAnimationLoop(loop);
    };
    const pause = () => renderer.setAnimationLoop(null);
    const onVisibility = () => (document.hidden ? pause() : run());
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) run();

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      pause();
      ro.disconnect();
      scene.remove(shape);
      edges.dispose();
      solid.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, []);
  return <div className="scene" ref={hostRef} aria-hidden="true" />;
}
