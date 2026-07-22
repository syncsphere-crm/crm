/**
 * network.js - Interactive Pan/Zoom Force-Directed Graph with PFPs and Dynamic Sizing
 */

let animFrame = null;
let zoom = 1.0;
let offsetX = 0;
let offsetY = 0;
let isDragging = false;
let startX, startY;

window.stopNetworkMap = function() {
  if (animFrame) cancelAnimationFrame(animFrame);
};

window.renderNetworkMap = function(contacts) {
  window.stopNetworkMap();
  const canvas = document.getElementById('networkCanvas');
  const wrapper = canvas.parentElement;
  
  canvas.width = wrapper.clientWidth * window.devicePixelRatio;
  canvas.height = wrapper.clientHeight * window.devicePixelRatio;
  const ctx = canvas.getContext('2d');
  
  const width = canvas.width;
  const height = canvas.height;
  
  if (offsetX === 0) {
    offsetX = width / 2;
    offsetY = height / 2;
  }

  const activeContacts = contacts.filter(c => !c.isDeleted);
  if (activeContacts.length === 0) return;

  // 1. Initialize nodes and load images
  const nodes = activeContacts.map(c => {
    const initials = (c.fullName || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() || '').join('');
    let img = null;
    
    if (c.pfpBase64) {
      img = new Image();
      img.src = c.pfpBase64;
    }
    
    return {
      id: c.id, 
      label: c.fullName, 
      initials: initials,
      img: img,
      x: (Math.random() - 0.5) * 500, 
      y: (Math.random() - 0.5) * 500,
      vx: 0, vy: 0,
      degree: 0 // Track number of connections
    };
  });

  const edges = [];
  activeContacts.forEach(c => {
    (c.relationships || []).forEach(r => {
      const target = nodes.find(n => n.id === r.targetContactId);
      const source = nodes.find(n => n.id === c.id);
      if (target && source) {
        edges.push({ source, target });
        source.degree++;
        target.degree++;
      }
    });
  });

  // 2. Set node radius based on connection degree
  nodes.forEach(n => {
    n.radius = 16 + (n.degree * 4); // Base 16px, +4px per connection
  });

  // Pan/Zoom Events
  if (!canvas.dataset.mapped) {
    canvas.dataset.mapped = "true";
    // Mouse events fire in CSS pixels, but canvas.width/height (and therefore
    // offsetX/offsetY) are in device pixels scaled by devicePixelRatio. Without
    // converting, dragging felt mismatched/too-slow on any Retina/high-DPI screen.
    const dpr = () => window.devicePixelRatio || 1;

    canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX * dpr() - offsetX;
      startY = e.clientY * dpr() - offsetY;
    });
    window.addEventListener('mouseup', () => { isDragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      offsetX = e.clientX * dpr() - startX;
      offsetY = e.clientY * dpr() - startY;
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoom = Math.min(Math.max(0.2, zoom + (e.deltaY * -0.001)), 4);
    });

    // Touch support (iOS/Android): one finger pans, two fingers pinch-zoom.
    let pinchStartDist = null;
    let pinchStartZoom = 1;
    function touchDist(t) {
      const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        isDragging = true;
        startX = e.touches[0].clientX * dpr() - offsetX;
        startY = e.touches[0].clientY * dpr() - offsetY;
      } else if (e.touches.length === 2) {
        isDragging = false;
        pinchStartDist = touchDist(e.touches);
        pinchStartZoom = zoom;
      }
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 1 && isDragging) {
        offsetX = e.touches[0].clientX * dpr() - startX;
        offsetY = e.touches[0].clientY * dpr() - startY;
      } else if (e.touches.length === 2 && pinchStartDist) {
        const scale = touchDist(e.touches) / pinchStartDist;
        zoom = Math.min(Math.max(0.2, pinchStartZoom * scale), 4);
      }
    }, { passive: false });
    canvas.addEventListener('touchend', () => { isDragging = false; pinchStartDist = null; });

    document.getElementById('zoomInBtn').addEventListener('click', () => zoom = Math.min(zoom + 0.2, 4));
    document.getElementById('zoomOutBtn').addEventListener('click', () => zoom = Math.max(zoom - 0.2, 0.2));
    document.getElementById('resetZoomBtn').addEventListener('click', () => {
      // Use the canvas's current size, not the size captured when this listener
      // was first attached — otherwise Reset recenters to a stale, pre-resize point.
      zoom = 1.0;
      offsetX = canvas.width / 2;
      offsetY = canvas.height / 2;
    });
  }

  // Simulation Loop
  function simulate() {
    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        let dist = Math.sqrt(dx*dx + dy*dy) || 1;
        // Increase repulsion for larger nodes
        let minDistance = nodes[i].radius + nodes[j].radius + 300; 
        if (dist < minDistance) {
          let force = 800 / (dist * dist); 
          nodes[i].vx -= (dx / dist) * force;
          nodes[i].vy -= (dy / dist) * force;
          nodes[j].vx += (dx / dist) * force;
          nodes[j].vy += (dy / dist) * force;
        }
      }
    }
    
    // Attraction
    edges.forEach(e => {
      let dx = e.target.x - e.source.x;
      let dy = e.target.y - e.source.y;
      let dist = Math.sqrt(dx*dx + dy*dy) || 1;
      let restingLength = e.source.radius + e.target.radius + 150;
      let force = (dist - restingLength) * 0.003; 
      e.source.vx += (dx / dist) * force;
      e.source.vy += (dy / dist) * force;
      e.target.vx -= (dx / dist) * force;
      e.target.vy -= (dy / dist) * force;
    });

    ctx.save();
    ctx.clearRect(0, 0, width, height);
    ctx.translate(offsetX, offsetY);
    ctx.scale(zoom, zoom);

    // Draw Edges
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 2 / zoom;
    edges.forEach(e => {
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);
      ctx.stroke();
    });

    // Draw Nodes
    nodes.forEach(n => {
      n.vx -= n.x * 0.0005; // Center gravity
      n.vy -= n.y * 0.0005;
      n.x += n.vx;
      n.y += n.vy;
      n.vx *= 0.85; // Friction
      n.vy *= 0.85;

      // Draw the Circle / Clipping mask
      ctx.save();
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.closePath();

      // Outline
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.clip(); // Mask content to circle

      if (n.img && n.img.complete) {
        // Draw PFP Image inside circle
        ctx.drawImage(n.img, n.x - n.radius, n.y - n.radius, n.radius * 2, n.radius * 2);
      } else {
        // Draw Fallback Initials
        ctx.fillStyle = '#3b82f6';
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.max(12, n.radius - 8)}px -apple-system, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(n.initials, n.x, n.y);
      }
      ctx.restore(); // Remove clipping mask

      // Draw Label (Outside the circle)
      ctx.fillStyle = '#1e293b';
      ctx.font = "600 13px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(n.label, n.x, n.y + n.radius + 18);
    });

    ctx.restore();
    animFrame = requestAnimationFrame(simulate);
  }
  
  simulate();
};