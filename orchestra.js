
// ── SPATIAL ORCHESTRA ─────────────────────────────────────
// Each listener is a living cell. The sweep beam is the baton.

class SpatialOrchestra {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;cursor:crosshair;border-radius:50%;';
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.W = 0; this.H = 0; this.cx = 0; this.cy = 0; this.R = 0;
    this.dots = new Map();

    // Sweep state
    this.sweepAngle  = 0;     // degrees, 0=north
    this.sweepSpeed  = 0;     // degrees per second
    this.sweepDir    = 1;     // 1=clockwise -1=counter
    this.sweepActive = false;
    this._snapFlash  = 0;

    // Drag
    this.dragLast = null;
    this.dragT    = null;

    this.frame = 0;
    this.lastT = performance.now();
    this.raf   = null;

    this.COLORS = [
      '#f57e20','#00cc99','#ef3c23','#a78bfa',
      '#f472b6','#34d399','#60a5fa','#fbbf24'
    ];

    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._bindInput();
    this._animate();
  }

  _resize() {
    const rect = this.container.getBoundingClientRect();
    const size = Math.min(rect.width || 300, rect.height || 300);
    const dpr  = window.devicePixelRatio || 1;
    this.canvas.width  = size * dpr;
    this.canvas.height = size * dpr;
    this.canvas.style.width  = size + 'px';
    this.canvas.style.height = size + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = size; this.H = size;
    this.cx = size / 2; this.cy = size / 2;
    this.R  = size / 2 - 16;
  }

  sync() {
    const listeners   = Object.values(window.liveListeners || {});
    const zoneRadius  = window.activeZone?.radius_m || 200;
    const voices      = parseInt(document.getElementById('scatter-voices')?.value || 4);

    // Prune gone listeners
    const live = new Set(listeners.map(l => l.id || l.name));
    for (const id of this.dots.keys()) if (!live.has(id)) this.dots.delete(id);

    listeners.forEach(l => {
      const id      = l.id || l.name;
      const bearing = l.bearing || 0;
      const distM   = (l.dist || 0) * 1609.34;
      const ratio   = Math.min(distM / zoneRadius, 0.9);
      const rad     = (bearing - 90) * Math.PI / 180;
      const tx      = this.cx + Math.cos(rad) * ratio * this.R;
      const ty      = this.cy + Math.sin(rad) * ratio * this.R;
      const slot    = Math.floor(((bearing % 360) + 360/voices/2) % 360 / (360/voices)) % voices;
      const color   = this.COLORS[slot % this.COLORS.length];

      if (this.dots.has(id)) {
        const d = this.dots.get(id);
        d.targetX = tx; d.targetY = ty;
        d.slot = slot; d.color = color; d.bearing = bearing;
      } else {
        this.dots.set(id, {
          id, x: tx, y: ty, targetX: tx, targetY: ty,
          slot, color, bearing,
          vx: 0, vy: 0,
          flash: 0,
          phase: Math.random() * Math.PI * 2,
        });
      }
    });
  }

  _bindInput() {
    const c = this.canvas;
    const pos = e => {
      const r = c.getBoundingClientRect();
      return { x:(e.clientX-r.left)*(this.W/r.width), y:(e.clientY-r.top)*(this.H/r.height) };
    };
    const down = e => {
      const p = pos(e);
      const dx = p.x-this.cx, dy = p.y-this.cy;
      // Centre tap = SNAP
      if (Math.sqrt(dx*dx+dy*dy) < this.R*0.22) { this._snap(); return; }
      this.dragLast = p; this.dragT = performance.now();
    };
    const move = e => {
      if (!this.dragLast) return;
      const p   = pos(e);
      const now = performance.now();
      const dt  = Math.max((now - this.dragT) / 1000, 0.001);
      const a0  = Math.atan2(this.dragLast.y-this.cy, this.dragLast.x-this.cx)*180/Math.PI;
      const a1  = Math.atan2(p.y-this.cy, p.x-this.cx)*180/Math.PI;
      let da = a1 - a0;
      if (da > 180) da -= 360; if (da < -180) da += 360;
      this.sweepSpeed  = Math.min(Math.abs(da/dt), 720);
      this.sweepDir    = Math.sign(da) || 1;
      this.sweepActive = this.sweepSpeed > 8;
      this.sweepAngle  = (a1 + 90 + 360) % 360;
      this.dragLast = p; this.dragT = now;
    };
    const up = () => {
      if (this.sweepSpeed < 12) this.sweepActive = false;
      this.dragLast = null;
    };
    c.addEventListener('touchstart', e=>{e.preventDefault();down(e.touches[0]);},{passive:false});
    c.addEventListener('touchmove',  e=>{e.preventDefault();move(e.touches[0]);},{passive:false});
    c.addEventListener('touchend',   e=>{e.preventDefault();up();},{passive:false});
    c.addEventListener('mousedown',  down);
    c.addEventListener('mousemove',  move);
    c.addEventListener('mouseup',    up);
  }

  _snap() {
    this._snapFlash = 1.0;
    for (const d of this.dots.values()) {
      d.flash = 1;
      d.vx += (this.cx - d.x) * 0.25;
      d.vy += (this.cy - d.y) * 0.25;
    }
    if (window._djSyncChannel) {
      window._djSyncChannel.send({
        type:'broadcast', event:'hard_sync',
        payload:{ resyncAt:Date.now()+600, playback_started_at:window.activeZone?.playback_started_at, resetOffsets:false }
      });
    }
    typeof showToast==='function' && showToast('⚡ SNAP — all speakers locked');
  }

  startSweep(rpm, dir) {
    this.sweepActive = true;
    this.sweepSpeed  = (rpm/60)*360;
    this.sweepDir    = dir;
    if (window._djSyncChannel) {
      window._djSyncChannel.send({
        type:'broadcast', event:'sweep_start',
        payload:{ startAngle:this.sweepAngle, rpm, dir, startedAt:new Date().toISOString(), playback_started_at:window.activeZone?.playback_started_at }
      });
    }
    typeof showToast==='function' && showToast('◎ Sweep '+rpm+' RPM '+(dir>0?'↻':'↺'));
  }

  stopSweep() {
    this.sweepActive = false; this.sweepSpeed = 0;
    if (window._djSyncChannel) {
      window._djSyncChannel.send({ type:'broadcast', event:'sweep_stop', payload:{} });
    }
    typeof showToast==='function' && showToast('◼ Sweep stopped');
  }

  _animate() {
    this.raf = requestAnimationFrame(() => this._animate());
    const now = performance.now();
    const dt  = Math.min((now - this.lastT)/1000, 0.05);
    this.lastT = now;
    this.frame++;

    if (this.frame % 18 === 0) this.sync();

    // Advance sweep beam
    if (this.sweepActive) {
      this.sweepAngle = (this.sweepAngle + this.sweepDir * this.sweepSpeed * dt + 360) % 360;
      // Flash listeners the beam crosses
      for (const d of this.dots.values()) {
        let diff = Math.abs(((d.bearing - this.sweepAngle + 180 + 360) % 360) - 180);
        if (diff < 5) d.flash = Math.max(d.flash, 0.9);
      }
    }

    // Physics
    for (const d of this.dots.values()) {
      // Spring to target
      d.vx += (d.targetX - d.x) * 0.07;
      d.vy += (d.targetY - d.y) * 0.07;

      // Cluster cohesion (same slot, close-ish)
      for (const o of this.dots.values()) {
        if (o===d) continue;
        const ex=o.x-d.x, ey=o.y-d.y, ed=Math.sqrt(ex*ex+ey*ey)||1;
        if (o.slot===d.slot && ed<70) { d.vx+=ex/ed*0.018; d.vy+=ey/ed*0.018; }
        if (ed<18) { d.vx-=ex/ed*0.5; d.vy-=ey/ed*0.5; }
      }

      // Damping
      d.vx *= 0.8; d.vy *= 0.8;
      d.x += d.vx; d.y += d.vy;
      d.flash *= 0.87;
    }

    this._snapFlash *= 0.88;
    this._draw(now);
  }

  _draw(now) {
    const { ctx, W, H, cx, cy, R } = this;
    if (R <= 0) return;
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#020305';
    ctx.fillRect(0, 0, W, H);

    // Snap flash
    if (this._snapFlash > 0.01) {
      ctx.fillStyle = `rgba(245,126,32,${this._snapFlash*0.25})`;
      ctx.fillRect(0,0,W,H);
    }

    // Clip to circle
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI*2); ctx.clip();

    // Distance rings
    [0.25,0.5,0.75,1].forEach((r,i)=>{
      ctx.beginPath(); ctx.arc(cx, cy, R*r, 0, Math.PI*2);
      ctx.strokeStyle = `rgba(0,204,153,${0.04+i*0.025})`; ctx.lineWidth=0.8; ctx.stroke();
    });

    // Radial lines every 45°
    for (let a=0;a<360;a+=45){
      const rad=(a-90)*Math.PI/180;
      ctx.beginPath(); ctx.moveTo(cx,cy);
      ctx.lineTo(cx+Math.cos(rad)*R, cy+Math.sin(rad)*R);
      ctx.strokeStyle='rgba(0,204,153,0.035)'; ctx.lineWidth=0.5; ctx.stroke();
    }

    // Cardinals
    const fs = Math.max(10, Math.floor(R*0.08));
    ctx.font = `700 ${fs}px 'Barlow Condensed',sans-serif`;
    ctx.fillStyle = 'rgba(0,204,153,0.2)';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    const lo = R*0.92;
    ctx.fillText('N',cx,cy-lo); ctx.fillText('S',cx,cy+lo);
    ctx.fillText('E',cx+lo,cy); ctx.fillText('W',cx-lo,cy);

    // ── SWEEP BEAM ───────────────────────────────────────
    if (this.sweepActive || this.sweepSpeed>0) {
      const bRad = (this.sweepAngle-90)*Math.PI/180;

      // Trail — fading wedge behind beam
      const TRAIL_DEG = 55;
      for (let i=0;i<24;i++){
        const t  = i/24;
        const ta = bRad - this.sweepDir*(t*(TRAIL_DEG*Math.PI/180));
        const sp = (TRAIL_DEG/24)*Math.PI/180;
        ctx.beginPath(); ctx.moveTo(cx,cy);
        ctx.arc(cx,cy,R,ta-sp,ta+sp); ctx.closePath();
        ctx.fillStyle=`rgba(0,204,153,${(1-t)*0.12})`;
        ctx.fill();
      }

      // Leading edge
      ctx.beginPath(); ctx.moveTo(cx,cy);
      ctx.lineTo(cx+Math.cos(bRad)*R, cy+Math.sin(bRad)*R);
      ctx.strokeStyle='rgba(255,255,255,0.75)'; ctx.lineWidth=2; ctx.stroke();

      // Tip glow
      const tx2=cx+Math.cos(bRad)*R*0.94, ty2=cy+Math.sin(bRad)*R*0.94;
      const tg=ctx.createRadialGradient(tx2,ty2,0,tx2,ty2,R*0.12);
      tg.addColorStop(0,'rgba(255,255,255,0.5)'); tg.addColorStop(1,'rgba(0,204,153,0)');
      ctx.beginPath(); ctx.arc(tx2,ty2,R*0.12,0,Math.PI*2);
      ctx.fillStyle=tg; ctx.fill();
    }

    // ── CLUSTER HALOS ────────────────────────────────────
    const clusters = new Map();
    for (const d of this.dots.values()){
      if(!clusters.has(d.slot)) clusters.set(d.slot,[]);
      clusters.get(d.slot).push(d);
    }
    for (const [,dots] of clusters){
      if(dots.length<2) continue;
      const ax=dots.reduce((s,d)=>s+d.x,0)/dots.length;
      const ay=dots.reduce((s,d)=>s+d.y,0)/dots.length;
      const spread=Math.max(...dots.map(d=>Math.hypot(d.x-ax,d.y-ay)))+28;
      const hex=dots[0].color.replace('#','');
      const r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);
      const hg=ctx.createRadialGradient(ax,ay,0,ax,ay,spread);
      hg.addColorStop(0,`rgba(${r},${g},${b},0.09)`);
      hg.addColorStop(1,`rgba(${r},${g},${b},0)`);
      ctx.beginPath(); ctx.arc(ax,ay,spread,0,Math.PI*2);
      ctx.fillStyle=hg; ctx.fill();
    }

    // ── LISTENER DOTS ────────────────────────────────────
    for (const d of this.dots.values()){
      const hex=d.color.replace('#','');
      const dr=parseInt(hex.slice(0,2),16),dg=parseInt(hex.slice(2,4),16),db=parseInt(hex.slice(4,6),16);
      const energy = 0.6+0.4*Math.sin(now/800+d.phase);
      const base   = 6+energy*3;
      const fr     = base+d.flash*9;

      // Glow
      const gr=ctx.createRadialGradient(d.x,d.y,0,d.x,d.y,fr+14);
      gr.addColorStop(0,`rgba(${dr},${dg},${db},${0.12+d.flash*0.35+energy*0.08})`);
      gr.addColorStop(1,`rgba(${dr},${dg},${db},0)`);
      ctx.beginPath(); ctx.arc(d.x,d.y,fr+14,0,Math.PI*2);
      ctx.fillStyle=gr; ctx.fill();

      // Core
      ctx.beginPath(); ctx.arc(d.x,d.y,fr,0,Math.PI*2);
      ctx.fillStyle = d.flash>0.12
        ? `rgba(255,255,255,${d.flash})`
        : `rgba(${dr},${dg},${db},${0.82+energy*0.18})`;
      ctx.fill();

      // Highlight
      ctx.beginPath(); ctx.arc(d.x-fr*0.28,d.y-fr*0.28,fr*0.32,0,Math.PI*2);
      ctx.fillStyle=`rgba(255,255,255,${0.18+d.flash*0.25})`; ctx.fill();
    }

    // ── ZONE CENTER — 4-dot hub (matches deck platter) ──
    const pulse=0.5+0.5*Math.sin(now/380);
    [[-5,-5],[5,-5],[-5,5],[5,5]].forEach(([dx,dy])=>{
      const gx=cx+dx, gy=cy+dy;
      const cg=ctx.createRadialGradient(gx,gy,0,gx,gy,16);
      cg.addColorStop(0,`rgba(245,126,32,${0.28+pulse*0.22})`);
      cg.addColorStop(1,'rgba(245,126,32,0)');
      ctx.beginPath(); ctx.arc(gx,gy,16,0,Math.PI*2); ctx.fillStyle=cg; ctx.fill();
      ctx.beginPath(); ctx.arc(gx,gy,5+pulse*1.8,0,Math.PI*2); ctx.fillStyle='#f57e20'; ctx.fill();
      ctx.beginPath(); ctx.arc(gx,gy,2,0,Math.PI*2); ctx.fillStyle='#000'; ctx.fill();
    });

    ctx.restore(); // end clip

    // HUD
    ctx.textAlign='center';
    if (this.sweepActive){
      const rpm=((this.sweepSpeed/360)*60).toFixed(1);
      ctx.fillStyle='rgba(0,204,153,0.85)';
      ctx.font=`900 ${Math.max(11,Math.floor(W*0.046))}px 'Barlow Condensed',sans-serif`;
      ctx.textBaseline='top';
      ctx.fillText(`${this.sweepDir>0?'↻':'↺'} ${rpm} RPM`, cx, 10);
    }
    ctx.fillStyle='rgba(255,255,255,0.18)';
    ctx.font=`700 ${Math.max(10,Math.floor(W*0.038))}px 'Barlow Condensed',sans-serif`;
    ctx.textBaseline='bottom';
    ctx.fillText(`${this.dots.size} speakers`, cx, H-8);
  }

  destroy(){ if(this.raf) cancelAnimationFrame(this.raf); }
}

let _orchestra = null;

function initOrchestra(){
  if(_orchestra) _orchestra.destroy();
  // Re-init after panel switch so canvas has correct dimensions
  setTimeout(()=>{
    _orchestra = new SpatialOrchestra('sp-radar');
  }, 80);
}
