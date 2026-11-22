import {ID, enabled, marker, profile, renderHUD} from "./profile.mjs";
import {reach, selectTarget, targetable, strike, incapacitated} from "./attack.mjs";
import {canReach, followRoute, planRoute, routeBudget, standIfPossible, turnMovement} from "./movement.mjs";

const jobs=new Map();
const chains=new Map();

function sameTurn(combat,combatant,round) {
  return game.user.isActiveGM && game.combat?.id===combat.id && combat.started &&
    combat.round===round && combat.combatant?.id===combatant.id && !game.paused &&
    canvas.ready && !!canvas.scene && combatant.token?.parent?.id===canvas.scene.id &&
    (!combat.scene || combat.scene.id===canvas.scene.id);
}

function routeForAttack(token, target, range, movement) {
  if (canReach(token, target, range.normal)) return [];
  const budget = routeBudget(token, movement);
  const route = planRoute(token, target, range.normal, movement.history, budget);
  // Take the closest affordable shot on this approach, including long range.
  const lastShot = route.findLastIndex(p => canReach(token, target, range.max, p));
  if (lastShot >= 0) return route.slice(0, lastShot + 1);
  if (canReach(token, target, range.max)) return [];
  if (range.normal < range.max) {
    const alternate = planRoute(token, target, range.max, movement.history, budget);
    if (alternate.length && canReach(token, target, range.max, alternate.at(-1))) return alternate;
  }
  return null;
}

async function reportDash(token) {
  const message = {
    speaker: ChatMessage.getSpeaker({actor:token.actor, token:token.document, scene:canvas.scene}),
    content: "疾走", flags: {[ID]: {action:"dash"}}
  };
  ChatMessage.applyRollMode(message, token.document.hidden ? "gmroll" : game.settings.get("core","rollMode"));
  await ChatMessage.create(message);
}

async function takeActions(token, rows, canAct) {
  const movement = turnMovement(token);
  await standIfPossible(token, movement);
  let usedAction = false;
  let pursuit;
  for (const row of rows) {
    const [itemId, activityId] = row.key.split(".");
    for (let n = 0; n < row.count; n++) {
      if (!canAct()) return;
      const target = selectTarget(token);
      if (!target) return;
      // Moving or spending a resource can refresh a synthetic actor's items.
      const item = token.actor.items.get(itemId);
      const activity = item?.system.activities.get(activityId);
      if (!activity) break;
      const entry = {item, activity};
      const range = reach(entry);
      if (range.max <= 0) break;
      const route = routeForAttack(token, target, range, movement);
      const canContinue = () => canAct() && targetable(token, target);
      if (route) await followRoute(token, target, range.normal, route, movement, canContinue);
      if (!canContinue()) return;
      if (!canReach(token, target, range.max)) {
        pursuit ??= {target, range};
        break; // Another configured weapon or cantrip may still be in range.
      }
      usedAction = true;
      pursuit = undefined;
      if (!await strike(token, target, entry, range, canAct)) return false;
    }
  }
  if (!pursuit || !canAct()) return;
  const {target, range} = pursuit;
  const canContinue = () => canAct() && targetable(token, target);
  if (!canContinue()) return;
  movement.dashed = !usedAction;
  const beforeStanding = movement.spent;
  if (movement.dashed) await standIfPossible(token, movement);
  if (!canContinue()) return;
  const route = planRoute(token, target, range.normal, movement.history, routeBudget(token, movement));
  if (movement.dashed && (route.length || movement.spent > beforeStanding)) await reportDash(token);
  await followRoute(token, target, range.normal, route, movement, canContinue);
}

async function play(combat,combatant,round,token,job) {
  const guard=()=>!job.cancelled && sameTurn(combat,combatant,round) &&
    canvas.tokens.get(token.id)===token && enabled(token);
  if (!guard() || combatant.getFlag(ID,"lastRound")===round) return;
  const canAct=()=>guard() && !combatant.defeated && token.actor.system.attributes.hp?.value>0 && !incapacitated(token.actor);
  const cfg=profile(token);
  if (canAct() && !cfg.valid) {
    ui.notifications.warn(token.name+"：請從 Token 的機器人按鈕指定攻擊順序。本回合交由 GM。");
    return;
  }
  // Persist before side effects. Reconnection after an interrupted attack leaves the turn to the GM.
  await combatant.setFlag(ID,"lastRound",round);
  if (canAct() && await takeActions(token, cfg.rows, canAct) === false) return;
  if (!guard()) return;
  const chain=chains.get(combat.id) ?? new Set();
  chain.add(combatant.id);
  chains.set(combat.id,chain);
  const manualTurn=combat.turns.some(c=>!c.defeated && !enabled(canvas.tokens.get(c.tokenId)));
  if (!manualTurn && combat.turns.filter(c=>!c.defeated).every(c=>chain.has(c.id))) {
    chains.delete(combat.id);
    ui.notifications.info("場上只剩自動小怪，已完成一輪。請由 GM 推進或結束戰鬥。");
    return;
  }
  await combat.nextTurn();
}

function schedule(combat) {
  const c=combat?.combatant;
  for (const job of jobs.values()) {
    if (job.combatId===combat?.id && (job.combatantId!==c?.id || job.round!==combat.round)) job.cancelled=true;
  }
  if (!c || !sameTurn(combat,c,combat.round)) return;
  const token=canvas.tokens.get(c.tokenId);
  if (!enabled(token)) { chains.delete(combat.id); return; }
  const round=combat.round;
  const key=[combat.id,round,c.id].join("/");
  if (jobs.has(key) || c.getFlag(ID,"lastRound")===round) return;
  const job={cancelled:false,combatId:combat.id,combatantId:c.id,round,tokenId:token.document.uuid,effectId:marker(token).id};
  jobs.set(key,job);
  play(combat,c,round,token,job).catch(error=>{
    console.error(ID,error);
    ui.notifications.error(token.name+" 的自動戰鬥已停止，請由 GM 接手。"+error.message);
  }).finally(()=>jobs.delete(key));
}

Hooks.once("init",()=>{
  if (game.release.generation!==13 || game.system.id!=="dnd5e" || !/^5\./.test(game.system.version)) return;
  game.settings.register(ID,"applyDamage",{name:"自動套用傷害",hint:"命中或豁免結算後，由 dnd5e 處理抗性、免疫與暫時生命值。使用 Midi-QOL 活動時，依 Midi-QOL 世界的扣血設定。",scope:"world",config:true,type:Boolean,default:true});
  Hooks.on("renderTokenHUD",renderHUD);
  Hooks.on("combatTurnChange",schedule);
  Hooks.on("canvasReady",()=>schedule(game.combat));
  Hooks.on("ready",()=>schedule(game.combat));
  Hooks.on("pauseGame",paused=>{
    if (!paused) return schedule(game.combat);
    for (const job of jobs.values()) job.cancelled=true;
  });
  const cancelEffect=effect=>{
    for (const job of jobs.values()) {
      if (job.tokenId===effect.getFlag(ID,"token") && job.effectId===effect.id) job.cancelled=true;
    }
  };
  Hooks.on("deleteActiveEffect",cancelEffect);
  const checkEffect = effect => {
    const combat = game.combat;
    if (combat?.combatant?.token?.uuid === effect.getFlag(ID,"token")) schedule(combat);
  };
  Hooks.on("createActiveEffect",checkEffect);
  Hooks.on("updateActiveEffect",(effect,changes)=>{
    if (changes.disabled) cancelEffect(effect);
    else if (changes.disabled === false) checkEffect(effect);
  });
  Hooks.on("updateToken",(token,changes)=>{
    if (changes.flags?.[ID]?.sequence && game.combat?.combatant?.token?.uuid === token.uuid) schedule(game.combat);
  });
  Hooks.on("deleteCombat",combat=>chains.delete(combat.id));
});

