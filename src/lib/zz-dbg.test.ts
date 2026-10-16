import { it } from 'vitest';
import { buildHelpScene } from './shell/help-scene.js';
import { planRoad } from './enhancements/road-planner.js';
import { applyCommand } from './core/engine/commands.js';
import { colOf, rowOf } from './core/engine/position.js';
import { plannedRoadPaths } from './core/road-plan-layer.js';
it('dbg', () => {
  const st = buildHelpScene().state;
  const roadTiles: number[] = [];
  st.mapTiles.forEach((t, i) => { if ((t.paths & 0x3f) && t.object === 0 && t.owner === 1) roadTiles.push(i); });
  const rp = roadTiles[3]!;
  const rc = colOf(rp, st.geo), rr = rowOf(rp, st.geo);
  for (let dc = -6; dc <= 6; dc++) for (let dr = -6; dr <= 6; dr++) {
    const s = structuredClone(st);
    const c = (rc + dc + 64) % 64, r = (rr + dr + 64) % 64;
    if (!applyCommand(s, { kind: 'buildFlag', col: c, row: r, player: 0 })) continue;
    const res = planRoad(s, s.players[0]!, { col: c, row: r }, { col: rc, row: rr });
    if (!res.ok || !res.plan.newFlag) continue;
    const m = plannedRoadPaths(res.plan.from, res.plan.dirs, s.geo);
    console.log('PLAN', res.plan.dirs.length, [...m.entries()].map(([p, b]) => `${colOf(p, s.geo)},${rowOf(p, s.geo)}:${b.toString(2)}`).join(' '));
    return;
  }
});
