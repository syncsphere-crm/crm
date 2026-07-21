/**
 * network.js - Interactive Pan/Zoom Force-Directed Graph
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
  
  // Resize to match crisp resolution
  canvas.width = wrapper.clientWidth * window.devicePixelRatio;
  canvas.height = wrapper.clientHeight * window.devicePixelRatio;
  const ctx = canvas.getContext('2d');
  
  const width = canvas.width;
  const height = canvas.height;
  
  // Default camera center
  if (offsetX === 0) {
    offsetX = width / 2;
    offsetY = height / 2;
  }

  const activeContacts = contacts.filter(c => !c.isDeleted);
  if (activeContacts.length === 0) return;

  // Initialize nodes randomly around center
  const nodes = activeContacts.map(c => ({
    id: c.id, 
    label: c.fullName, 
    x: (Math.random() - 0.5) * 500, 
    y: (Math.random() - 0.5) * 500,
    vx: 0, vy: 0
  }));

  const edges = [];
  activeContacts.forEach(c => {
    (c.relationships || []).forEach(r => {
      const target = nodes.find(n => n.id === r.targetContactId);
      const source = nodes.find(n => n.id === c.id);
      if (target && source) edges.push({ source, target });
    });
  });

  // Pan and Zoom Event Listeners (Added only once)
  if (!canvas.dataset.mapped) {
    canvas.dataset.mapped = "true";
    
    canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX - offsetX;
      startY = e.clientY - offsetY;
    });
    window.addEventListener('mouseup', () => { isDragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      offsetX = e.clientX - startX;
      offsetY = e.clientY - startY;
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomAdjust = e.deltaY * -0.001;
      zoom = Math.min(Math.max(0.2, zoom + zoomAdjust), 4);
    });

    document.getElementById('zoomInBtn').addEventListener('click', () => zoom = Math.min(zoom + 0.2, 4));
    document.getElementById('zoomOutBtn').addEventListener('click', () => zoom = Math.max(zoom - 0.2, 0.2));
    document.getElementById('resetZoomBtn').addEventListener('click', () => {
      zoom = 1.0; offsetX = width / 2; offsetY = height / 2;
    });
  }

  // Simulation loop
  function simulate() {
    // 1. Repulsion (Push nodes apart heavily)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        let dist = Math.sqrt(dx*dx + dy*dy) || 1;
        if (dist < 400) { // Large repulsion radius for better spacing
          let force = 600 / (dist * dist); 
          nodes[i].vx -= (dx / dist) * force;
          nodes[i].vy -= (dy / dist) * force;
          nodes[j].vx += (dx / dist) * force;
          nodes[j].vy += (dy / dist) * force;
        }
      }
    }
    
    // 2. Attraction (Pull connected edges together, resting length 200)
    edges.forEach(e => {
      let dx = e.target.x - e.source.x;
      let dy = e.target.y - e.source.y;
      let dist = Math.sqrt(dx*dx + dy*dy) || 1;
      let force = (dist - 200) * 0.003; 
      e.source.vx += (dx / dist) * force;
      e.source.vy += (dy / dist) * force;
      e.target.vx -= (dx / dist) * force;
      e.target.vy -= (dy / dist) * force;
    });

    // 3. Draw
    ctx.save();
    ctx.clearRect(0, 0, width, height);
    
    // Apply camera transform
    ctx.translate(offsetX, offsetY);
    ctx.scale(zoom, zoom);

    // Draw Edges
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 2 / zoom; // keep lines from getting too thick when zooming
    edges.forEach(e => {
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);
      ctx.stroke();
    });

    // Update Node Physics and Draw Nodes
    ctx.font = "14px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    
    nodes.forEach(n => {
      // Gentle gravity towards center (0,0) so they don't fly away infinitely
      n.vx -= n.x * 0.0005;
      n.vy -= n.y * 0.0005;

      n.x += n.vx;
      n.y += n.vy;
      
      // Friction
      n.vx *= 0.85; 
      n.vy *= 0.85;

      ctx.beginPath();
      ctx.arc(n.x, n.y, 12, 0, Math.PI * 2);
      ctx.fillStyle = '#3b82f6';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.stroke();
      
      ctx.fillStyle = '#1e293b';
      ctx.fillText(n.label, n.x, n.y + 28);
    });

    ctx.restore();
    animFrame = requestAnimationFrame(simulate);
  }
  
  simulate();
};
