// Filtered sync stream — only emits state transitions, stalls, and 30s summary
import { createClient } from '@supabase/supabase-js';

const db = createClient(
  'https://ohacvuwzvuifpyqckise.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9oYWN2dXd6dnVpZnB5cWNraXNlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5ODc4NTcsImV4cCI6MjA5MjU2Mzg1N30.EX_DF-hFaQQuA1R9cZMKgR6TwjubwP61Ph4Gwa87beY'
);

const state  = {}; // deviceId:layer → { label, drift, ts }
let summary  = {}; // deviceId → { lastDrift, lastLabel, stalls:[] }
let lastSummaryAt = Date.now();

function getS(id) {
  if (!summary[id]) summary[id] = { lastDrift: null, lastLabel: null, stalls: [] };
  return summary[id];
}

db.channel('byob_debug')
  .on('broadcast', { event: 'hud_data' }, ({ payload: p }) => {
    const id = p.deviceId; if (!id) return;
    const drift = parseFloat(p.driftMs);
    if (!isFinite(drift) || Math.abs(drift) > 5000) return;

    const isTer  = !!p.terTritLabel;
    const layer  = isTer ? 'ter' : 'dev';
    const label  = isTer ? p.terTritLabel : (p.driftState || 'unknown');
    const rate   = parseFloat(p.playbackRate || 1).toFixed(3);
    const key    = `${id}:${layer}`;
    const prev   = state[key];
    const short  = id.slice(-6);

    // Stall: same layer, drift jumped > 60ms positive
    if (prev && layer === 'ter') {
      const jump = drift - prev.drift;
      if (jump > 60 && Math.abs(drift) < 3000) {
        const s = getS(id);
        s.stalls.push(jump);
        console.log(`STALL  ${short}[${layer}] +${Math.round(jump)}ms  now=${Math.round(drift)}ms`);
      }
    }

    // State transition (ter layer only — canonical)
    // Suppress C↔N boundary jitter (drift 10-15ms, rate=1.000)
    if (layer === 'ter' && prev && prev.label !== label) {
      const isBoundaryJitter = Math.abs(drift) <= 15
        && ((prev.label === 'CONVERGED' && label === 'NEGOTIATING') || (prev.label === 'NEGOTIATING' && label === 'CONVERGED'));
      if (!isBoundaryJitter) {
        const arrow = `${prev.label[0]}→${label[0]}`;
        console.log(`TRANS  ${short} ${arrow}  drift=${Math.round(drift)}ms rate=${rate}`);
      }
    }

    state[key] = { label, drift, ts: Date.now() };

    // 30s summary
    if (Date.now() - lastSummaryAt >= 30000) {
      lastSummaryAt = Date.now();
      const active = Object.entries(state)
        .filter(([k, v]) => k.endsWith(':ter') && Date.now() - v.ts < 10000)
        .map(([k, v]) => {
          const did = k.replace(':ter','').slice(-6);
          const s = getS(k.replace(':ter',''));
          const stallMed = s.stalls.length
            ? [...s.stalls].sort((a,b)=>a-b)[Math.floor(s.stalls.length/2)]
            : 0;
          s.stalls = []; // reset window
          return `${did}:${v.label[0]}/${Math.round(v.drift)}ms${stallMed?` stall~${Math.round(stallMed)}ms`:''}`;
        });
      console.log(`--- ${active.join('  ') || '(no active ter devices)'}`);
    }
  })
  .on('broadcast', { event: 'sync_event' }, ({ payload: p }) => {
    if (p?.kind !== 'ter_calibration') return;
    console.log(`CAL    ${p.deviceId?.slice(-6)} floor=${p.floorMs}ms corr=${p.correctionMs}ms #${p.calCount}`);
  })
  .subscribe();
