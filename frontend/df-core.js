/* ═══════════════════════════════════════════════════════════════
   DeskFlow AI — Core JS Engine
   Cursor · Particles · Three.js Orb · GSAP · Toast · Ripple
═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ─────────────────────────────────────────────
     1. CUSTOM AI CURSOR
  ───────────────────────────────────────────── */
  function initCursor() {
    const c = document.getElementById('df-cursor');
    const r = document.getElementById('df-cursor-ring');
    if (!c || !r) return;

    let mx = 0, my = 0, rx = 0, ry = 0;

    document.addEventListener('mousemove', e => {
      mx = e.clientX; my = e.clientY;
      c.style.left = mx + 'px';
      c.style.top  = my + 'px';
    });

    // Smooth ring follow
    (function loopRing() {
      rx += (mx - rx) * 0.1;
      ry += (my - ry) * 0.1;
      r.style.left = rx + 'px';
      r.style.top  = ry + 'px';
      requestAnimationFrame(loopRing);
    })();

    // Hover expand
    document.addEventListener('mouseover', e => {
      if (e.target.closest('a,button,[data-hover],.df-card,.df-ticket-card,.df-metric-card,.feat-card,.price-card,.testi-card')) {
        c.classList.add('cursor-hover');
        r.classList.add('ring-hover');
      }
    });
    document.addEventListener('mouseout', e => {
      if (e.target.closest('a,button,[data-hover],.df-card,.df-ticket-card,.df-metric-card,.feat-card,.price-card,.testi-card')) {
        c.classList.remove('cursor-hover');
        r.classList.remove('ring-hover');
      }
    });

    // Click burst
    document.addEventListener('mousedown', () => c.classList.add('cursor-click'));
    document.addEventListener('mouseup',   () => c.classList.remove('cursor-click'));
  }

  /* ─────────────────────────────────────────────
     2. ANIMATED BACKGROUND PARTICLES
  ───────────────────────────────────────────── */
  function initParticles(canvasId) {
    const canvas = document.getElementById(canvasId || 'df-particles');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W, H, particles = [], animId;

    function resize() {
      W = canvas.width  = canvas.offsetWidth;
      H = canvas.height = canvas.offsetHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    const GOLD   = 'rgba(212,175,55,';
    const EMRLD  = 'rgba(45,212,191,';

    for (let i = 0; i < 90; i++) {
      particles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 1.5 + 0.3,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        a: Math.random(),
        color: Math.random() > 0.5 ? GOLD : EMRLD,
        pulse: Math.random() * Math.PI * 2
      });
    }

    let mouseX = -999, mouseY = -999;
    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      mouseX = e.clientX - rect.left;
      mouseY = e.clientY - rect.top;
    });

    function draw() {
      ctx.clearRect(0, 0, W, H);

      particles.forEach((p, i) => {
        p.pulse += 0.015;
        p.a = 0.25 + Math.sin(p.pulse) * 0.2;

        // Mouse repulsion
        const dx = p.x - mouseX, dy = p.y - mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 100) {
          p.vx += dx / dist * 0.1;
          p.vy += dy / dist * 0.1;
        }
        p.vx *= 0.98; p.vy *= 0.98;
        p.x += p.vx; p.y += p.vy;

        if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.color + p.a + ')';
        ctx.fill();

        // Draw lines to nearby particles
        for (let j = i + 1; j < particles.length; j++) {
          const q = particles[j];
          const d = Math.hypot(p.x - q.x, p.y - q.y);
          if (d < 120) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.strokeStyle = GOLD + (0.06 * (1 - d / 120)) + ')';
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      });

      animId = requestAnimationFrame(draw);
    }
    draw();
  }

  /* ─────────────────────────────────────────────
     3. THREE.JS AI ORB
  ───────────────────────────────────────────── */
  function initThreeOrb(canvasId, options) {
    if (typeof THREE === 'undefined') return;
    const canvas = document.getElementById(canvasId || 'df-three-canvas');
    if (!canvas) return;

    const opts = Object.assign({
      orbColor1: 0xD4AF37,
      orbColor2: 0x0F5A5E,
      particleColor: 0xD4AF37,
      particleCount: 1200,
      wireframe: false,
      bgAlpha: true
    }, options);

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: opts.bgAlpha, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.offsetWidth || 500, canvas.offsetHeight || 500);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, canvas.offsetWidth / canvas.offsetHeight, 0.1, 100);
    camera.position.set(0, 0, 5);

    // ── AI Core Orb ──
    const geo = new THREE.IcosahedronGeometry(1.2, 4);
    const mat = new THREE.MeshPhongMaterial({
      color: opts.orbColor1,
      emissive: opts.orbColor1,
      emissiveIntensity: 0.3,
      wireframe: true,
      transparent: true,
      opacity: 0.6
    });
    const orb = new THREE.Mesh(geo, mat);
    scene.add(orb);

    // ── Inner Solid Core ──
    const innerGeo = new THREE.IcosahedronGeometry(0.85, 2);
    const innerMat = new THREE.MeshPhongMaterial({
      color: opts.orbColor2,
      emissive: opts.orbColor2,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.8
    });
    const innerOrb = new THREE.Mesh(innerGeo, innerMat);
    scene.add(innerOrb);

    // ── Particle Ring ──
    const pGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(opts.particleCount * 3);
    for (let i = 0; i < opts.particleCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = 1.8 + Math.random() * 1.2;
      positions[i*3]   = r * Math.sin(phi) * Math.cos(theta);
      positions[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i*3+2] = r * Math.cos(phi);
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const pMat = new THREE.PointsMaterial({
      size: 0.025,
      color: opts.particleColor,
      transparent: true,
      opacity: 0.7,
      sizeAttenuation: true
    });
    const particles3 = new THREE.Points(pGeo, pMat);
    scene.add(particles3);

    // ── Lights ──
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
    scene.add(ambientLight);
    const light1 = new THREE.PointLight(opts.orbColor1, 2, 10);
    light1.position.set(3, 3, 3);
    scene.add(light1);
    const light2 = new THREE.PointLight(opts.orbColor2, 1.5, 8);
    light2.position.set(-3, -2, 2);
    scene.add(light2);

    // ── Mouse tracking ──
    let mouseX = 0, mouseY = 0;
    document.addEventListener('mousemove', e => {
      mouseX = (e.clientX / window.innerWidth  - 0.5) * 2;
      mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
    });

    // ── Resize ──
    window.addEventListener('resize', () => {
      const w = canvas.offsetWidth, h = canvas.offsetHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });

    // ── Animate ──
    let t = 0;
    function animate() {
      requestAnimationFrame(animate);
      t += 0.008;

      orb.rotation.y      += 0.003 + mouseX * 0.002;
      orb.rotation.x      += 0.002 + mouseY * 0.001;
      innerOrb.rotation.y -= 0.005;
      innerOrb.rotation.z += 0.003;
      particles3.rotation.y += 0.001;

      // Breathing scale
      const scale = 1 + Math.sin(t) * 0.04;
      orb.scale.setScalar(scale);

      // Camera gentle drift
      camera.position.x += (mouseX * 0.5 - camera.position.x) * 0.02;
      camera.position.y += (-mouseY * 0.5 - camera.position.y) * 0.02;
      camera.lookAt(scene.position);

      // Pulse emissive
      mat.emissiveIntensity = 0.3 + Math.sin(t * 1.5) * 0.15;
      light1.intensity = 2 + Math.sin(t * 2) * 0.5;

      renderer.render(scene, camera);
    }
    animate();

    return { scene, camera, renderer, orb };
  }

  /* ─────────────────────────────────────────────
     4. THREE.JS HERO BACKGROUND (Particles Field)
  ───────────────────────────────────────────── */
  function initThreeHeroBg(canvasId) {
    if (typeof THREE === 'undefined') return;
    const canvas = document.getElementById(canvasId || 'df-hero-canvas');
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = 5;

    const count = 800;
    const geo   = new THREE.BufferGeometry();
    const pos   = new Float32Array(count * 3);
    const colors= new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i*3]   = (Math.random() - 0.5) * 20;
      pos[i*3+1] = (Math.random() - 0.5) * 20;
      pos[i*3+2] = (Math.random() - 0.5) * 10;
      const isGold = Math.random() > 0.6;
      colors[i*3]   = isGold ? 0.83 : 0.06;
      colors[i*3+1] = isGold ? 0.69 : 0.35;
      colors[i*3+2] = isGold ? 0.21 : 0.37;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({ size: 0.035, vertexColors: true, transparent: true, opacity: 0.75 });
    const pts = new THREE.Points(geo, mat);
    scene.add(pts);

    let mx = 0, my = 0;
    document.addEventListener('mousemove', e => {
      mx = (e.clientX / window.innerWidth  - 0.5);
      my = (e.clientY / window.innerHeight - 0.5);
    });

    const resize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', resize);
    resize();

    let frame = 0;
    (function loop() {
      requestAnimationFrame(loop);
      frame += 0.004;
      pts.rotation.y = frame * 0.08 + mx * 0.1;
      pts.rotation.x = frame * 0.04 + my * 0.06;
      renderer.render(scene, camera);
    })();
  }

  /* ─────────────────────────────────────────────
     5. GSAP SCROLL REVEAL
  ───────────────────────────────────────────── */
  function initScrollReveal() {
    if (typeof gsap === 'undefined') return;

    // Simple intersection observer for CSS classes
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -60px 0px' });

    document.querySelectorAll('.df-fade-up, .df-fade-left, .df-fade-right, .fade-in-up, .fade-in-left, .fade-in-right').forEach(el => observer.observe(el));

    // GSAP stagger for grids
    if (typeof ScrollTrigger !== 'undefined') {
      gsap.registerPlugin(ScrollTrigger);
      ['df-grid-3 > *', 'df-grid-4 > *', 'features-grid > *', 'pricing-grid > *', 'problem-grid > *'].forEach(sel => {
        const els = document.querySelectorAll('.' + sel.replace(' > *', '') + ' > *');
        if (els.length) {
          gsap.fromTo(els, { y: 40, opacity: 0 }, {
            y: 0, opacity: 1, duration: 0.7, ease: 'power2.out',
            stagger: 0.1,
            scrollTrigger: { trigger: els[0].parentElement, start: 'top 85%' }
          });
        }
      });
    }
  }

  /* ─────────────────────────────────────────────
     6. TOAST NOTIFICATIONS (Global)
  ───────────────────────────────────────────── */
  window.dfToast = function (message, type, duration) {
    type = type || 'info';
    duration = duration || 4000;
    let container = document.getElementById('df-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'df-toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'df-toast ' + type;
    const icons = { success: 'ti-check-circle', error: 'ti-alert-triangle', info: 'ti-info-circle', warning: 'ti-alert-circle' };
    toast.innerHTML = `<i class="ti ${icons[type] || 'ti-info-circle'}"></i><span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'dfToastOut 0.3s ease forwards';
      setTimeout(() => toast.remove(), 350);
    }, duration);
  };

  // Alias for pages that use showToast
  if (!window.showToast) {
    window.showToast = window.dfToast;
  }

  /* ─────────────────────────────────────────────
     7. RIPPLE EFFECT
  ───────────────────────────────────────────── */
  function initRipple() {
    document.addEventListener('click', e => {
      const btn = e.target.closest('.df-ripple-btn, .ripple-btn, .btn-gold, .btn-glass, .btn-emerald');
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const el = document.createElement('span');
      el.className = 'df-ripple-effect';
      const d = Math.max(rect.width, rect.height);
      el.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX-rect.left-d/2}px;top:${e.clientY-rect.top-d/2}px;`;
      btn.appendChild(el);
      setTimeout(() => el.remove(), 700);
    });
  }

  /* ─────────────────────────────────────────────
     8. CARD TILT EFFECT
  ───────────────────────────────────────────── */
  function initCardTilt() {
    const cards = document.querySelectorAll('.df-card-tilt, .feat-card, .price-card, .df-metric-card');
    cards.forEach(card => {
      card.addEventListener('mousemove', e => {
        const rect = card.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width  - 0.5;
        const y = (e.clientY - rect.top)  / rect.height - 0.5;
        card.style.transform = `perspective(600px) rotateY(${x*8}deg) rotateX(${-y*8}deg) translateY(-4px)`;
      });
      card.addEventListener('mouseleave', () => {
        card.style.transform = '';
      });
    });
  }

  /* ─────────────────────────────────────────────
     9. NAVBAR SCROLL BEHAVIOR
  ───────────────────────────────────────────── */
  function initNavbar() {
    const navbar = document.querySelector('.df-navbar, #navbar');
    if (!navbar) return;
    window.addEventListener('scroll', () => {
      navbar.classList.toggle('scrolled', window.scrollY > 20);
    });
  }

  /* ─────────────────────────────────────────────
     10. COUNTER ANIMATION
  ───────────────────────────────────────────── */
  window.dfCountUp = function (el, target, suffix, prefix, duration) {
    suffix = suffix || '';
    prefix = prefix || '';
    duration = duration || 1800;
    let start = 0, startTime = null;
    const isFloat = String(target).includes('.');
    function step(ts) {
      if (!startTime) startTime = ts;
      const progress = Math.min((ts - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3);
      const val = isFloat ? (ease * target).toFixed(1) : Math.floor(ease * target);
      el.textContent = prefix + val + suffix;
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  };

  /* ─────────────────────────────────────────────
     11. FLOATING CHAT NOTIFICATION
  ───────────────────────────────────────────── */
  function initFloatingNotifications() {
    const floaters = document.querySelectorAll('.df-float-notif');
    floaters.forEach((n, i) => {
      n.style.animationDelay = (i * 0.8) + 's';
    });
  }

  /* ─────────────────────────────────────────────
     12. MOBILE SIDEBAR TOGGLE
  ───────────────────────────────────────────── */
  window.dfToggleSidebar = function () {
    const sidebar = document.querySelector('.df-sidebar');
    const overlay = document.getElementById('df-sidebar-overlay');
    if (!sidebar) return;
    sidebar.classList.toggle('open');
    if (overlay) overlay.classList.toggle('open');
  };

  function initSidebarOverlay() {
    const overlay = document.getElementById('df-sidebar-overlay');
    if (overlay) {
      overlay.addEventListener('click', window.dfToggleSidebar);
    }
  }

  /* ─────────────────────────────────────────────
     INIT ALL
  ───────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    initCursor();
    initRipple();
    initNavbar();
    initScrollReveal();
    initCardTilt();
    initFloatingNotifications();
    initSidebarOverlay();

    // Auto-init Three.js hero background if canvas exists
    if (document.getElementById('df-hero-canvas')) {
      if (typeof THREE !== 'undefined') initThreeHeroBg('df-hero-canvas');
    }

    // Auto-init particle canvas
    if (document.getElementById('df-particles')) {
      initParticles('df-particles');
    }
  });

  // Expose init functions globally
  window.DeskFlowCore = {
    initCursor,
    initParticles,
    initThreeOrb,
    initThreeHeroBg,
    initScrollReveal,
    initCardTilt
  };

})();
