const EPS = 0.001;
const spot = token => ({x:token.document.x, y:token.document.y, elevation:token.document.elevation});
const center = (token,p=spot(token)) => token.document.getCenterPoint(p);
const gridded = () => !canvas.grid.isGridless;

export function sceneLength(value, unit="ft") {
  const units = CONFIG.DND5E.movementUnits;
  const sceneUnit = String(canvas.scene.grid.units || "ft").trim().toLowerCase().replace(/\.$/,"");
  const aliases = {feet:"ft",foot:"ft","呎":"ft","英尺":"ft","英呎":"ft",meters:"m",metres:"m","公尺":"m","米":"m"};
  const scale = units[aliases[sceneUnit] || sceneUnit]?.conversion ?? 1;
  return Number(value || 0) * (units[unit]?.conversion ?? 1) / scale;
}

function cells(token, p) {
  const d = token.document;
  const offsets = d.getOccupiedGridSpaceOffsets(p);
  return offsets.map(o=>({...canvas.grid.getCenterPoint(o), elevation:p.elevation ?? d.elevation}));
}

export function distance(a,b,p=spot(a)) {
  if (gridded()) {
    const left = cells(a,p), right = cells(b,spot(b));
    let best = Infinity;
    for (const s of left) for (const t of right) best = Math.min(best, canvas.grid.measurePath([s,t]).distance);
    return best;
  }
  const s = center(a,p), t = center(b);
  const cell = canvas.grid.size;
  const dx = Math.max(0, Math.abs(s.x-t.x) - Math.max(0,(a.w+b.w)/2-cell));
  const dy = Math.max(0, Math.abs(s.y-t.y) - Math.max(0,(a.h+b.h)/2-cell));
  return Math.hypot(Math.hypot(dx,dy)*canvas.grid.distance/cell, a.document.elevation-b.document.elevation);
}

export function lineOpen(a,b,p=spot(a)) {
  const start = center(a,p), end = center(b);
  // A solid transparent barrier can block the attack even when the target is visible.
  return ["sight","move"].every(type=>!a.checkCollision(end,{origin:start, type, mode:"any"}));
}

export function canReach(a,b,range,p=spot(a)) {
  return distance(a,b,p) <= range + EPS && lineOpen(a,b,p);
}

export function walkSpeed(token) {
  const s = token.actor.statuses;
  if (["grappled","restrained","paralyzed","petrified","unconscious","dead","stunned"].some(id=>s.has(id))) return 0;
  const move = token.actor.system.attributes.movement;
  return Math.max(0, sceneLength(move.walk, move.units));
}

// Foundry clears recorded movement at the start of the token's turn. It may
// already contain a GM's movement if automation was enabled partway through.
export function turnMovement(token) {
  const spent = (token.document.movementHistory ?? []).reduce((sum, p) => sum + p.cost, 0);
  return {history: [spot(token)], spent, dashed: false, triedStanding: false};
}

function remaining(token, movement) {
  const allowance = walkSpeed(token) * (movement.dashed ? 2 : 1);
  return Math.max(0, allowance - movement.spent);
}

export async function standIfPossible(token, movement) {
  if (movement.triedStanding || !token.actor.statuses.has("prone")) return;
  const cost = walkSpeed(token) / 2;
  if (cost <= 0 || remaining(token, movement) + EPS < cost) return;
  movement.triedStanding = true;
  await token.actor.toggleStatusEffect("prone", {active: false});
  if (!token.actor.statuses.has("prone")) movement.spent += cost;
}

const walkingCost = token => token.actor.statuses.has("prone") ? 2 : 1;

export function routeBudget(token, movement) {
  return travelCost(token, movement.history) + remaining(token, movement) / walkingCost(token);
}

export async function followRoute(token, target, range, route, movement, canContinue) {
  const history = movement.history;
  for (const dest of route) {
    if (!canContinue() || canReach(token, target, range)) break;
    const before = travelCost(token, history);
    const rate = walkingCost(token);
    if ((travelCost(token, [...history, dest]) - before) * rate > remaining(token, movement) + EPS) break;
    if (!stepOpen(token, spot(token), dest)) break;
    const moved = await token.document.move({...dest, action: rate === 2 ? "crawl" : "walk"}, {method:"api", showRuler:false});
    await token.movementAnimationPromise;
    const actual = spot(token);
    if (!moved || (actual.x === history.at(-1).x && actual.y === history.at(-1).y)) break;
    history.push(actual);
    movement.spent += (travelCost(token, history) - before) * rate;
    if (actual.x !== dest.x || actual.y !== dest.y) break;
  }
}

function overlaps(a,p,other) {
  if (Math.abs(a.document.elevation-other.document.elevation) >= canvas.grid.distance - EPS) return false;
  if (gridded() && !canvas.grid.isSquare) {
    const occupied = new Set(other.document.getOccupiedGridSpaceOffsets().map(o=>o.i+","+o.j));
    return a.document.getOccupiedGridSpaceOffsets(p).some(o=>occupied.has(o.i+","+o.j));
  }
  const q = spot(other);
  return p.x < q.x + other.w-EPS && p.x+a.w > q.x+EPS && p.y < q.y+other.h-EPS && p.y+a.h > q.y+EPS;
}

export function stepOpen(a,from,to) {
  const r = canvas.dimensions.sceneRect;
  if (to.x < r.x || to.y < r.y || to.x + a.w > r.right + EPS || to.y + a.h > r.bottom + EPS) return false;
  if (canvas.tokens.placeables.some(t => t !== a && t.actor && !t.actor.statuses.has("dead") && overlaps(a,to,t))) return false;
  const s=center(a,from), d=center(a,to);
  if (a.checkCollision(d,{origin:s,type:"move"})) return false;
  // Check the swept footprint too, so large creatures cannot cut through a wall with a side.
  const dx = Math.max(0,a.w/2-2), dy = Math.max(0,a.h/2-2);
  for (const x of [-dx,dx]) for (const y of [-dy,dy]) {
    if (a.checkCollision({...d,x:d.x+x,y:d.y+y},{origin:{...s,x:s.x+x,y:s.y+y},type:"move"})) return false;
  }
  return true;
}

function neighbours(a,p,target) {
  if (gridded()) {
    const anchor = canvas.grid.getOffset(center(a,p));
    const c = canvas.grid.getCenterPoint(anchor);
    return canvas.grid.getAdjacentOffsets(anchor).map(o=>{
      const n = canvas.grid.getCenterPoint(o);
      return {x:p.x+n.x-c.x, y:p.y+n.y-c.y, elevation:a.document.elevation};
    });
  }
  const c = center(a,p), goal = center(target), angle = Math.atan2(goal.y-c.y,goal.x-c.x);
  const size = canvas.grid.size / 2;
  return Array.from({length:8},(_,i)=>({
    x:Math.round(p.x+Math.cos(angle+i*Math.PI/4)*size),
    y:Math.round(p.y+Math.sin(angle+i*Math.PI/4)*size), elevation:a.document.elevation
  }));
}

export function travelCost(token, steps) {
  return steps.length < 2 ? 0 : canvas.grid.measurePath(steps.map(p=>center(token,p))).distance;
}

// Search one route beyond this turn's speed, then walk only its affordable prefix.
export function planRoute(a,b,range,history,budget) {
  const start = spot(a);
  if (budget <= travelCost(a, history) + EPS || canReach(a,b,range,start)) return [];
  const key = p => Math.round(p.x)+","+Math.round(p.y);
  const gap = p=>Math.max(0,distance(a,b,p)-range);
  const goal=center(b);
  const straight=p=>{ const c=center(a,p); return Math.hypot(c.x-goal.x,c.y-goal.y); };
  const initial = {p:start,path:[],cost:0,gap:gap(start),straight:straight(start)};
  const open=[initial], visited=new Map([[key(start),0]]);
  let best=initial;
  for (let i=0; open.length && i<650; i++) {
    open.sort((x,y)=>(y.cost+y.gap)-(x.cost+x.gap) || y.gap-x.gap || y.straight-x.straight);
    const curr=open.pop();
    if (curr.cost > visited.get(key(curr.p))+EPS) continue;
    if (curr.gap < best.gap || (curr.gap === best.gap && curr.cost < best.cost)) best=curr;
    if (curr.gap <= EPS && canReach(a,b,range,curr.p)) { best=curr; break; }
    for (const p of neighbours(a,curr.p,b)) {
      const k=key(p);
      if ((visited.get(k) ?? Infinity) <= curr.cost+EPS || !stepOpen(a,curr.p,p)) continue;
      const path=[...curr.path,p];
      const cost=travelCost(a,[...history,...path]);
      if (cost+EPS >= (visited.get(k) ?? Infinity)) continue;
      visited.set(k,cost);
      open.push({p,path,cost,gap:gap(p),straight:straight(p)});
    }
  }
  const payable=[];
  for (const p of best.path) {
    if (travelCost(a,[...history,...payable,p]) > budget+EPS) break;
    payable.push(p);
  }
  return payable;
}

