import {distance, lineOpen, sceneLength} from "./movement.mjs";
import {ID, isAttack} from "./profile.mjs";

const hasAny = (actor,ids) => ids.some(id=>actor.statuses.has(id));
const dodgeNames = new Set(["閃避", "闪避", "dodge", "dodging"]);
function isDodging(actor) {
  return hasAny(actor, ["dodging", "dodge"]) ||
    actor.appliedEffects.some(effect => dodgeNames.has(effect.name.trim().toLowerCase()));
}
export const incapacitated = a => hasAny(a,["incapacitated","unconscious","dead","paralyzed","petrified","stunned"]);
export function targetable(source,t) {
  if (t === source || !t?.actor || t.document.hidden || t.combatant?.defeated || t.actor.statuses.has("dead")
    || t.actor.statuses.has("coverTotal") || !(t.actor.system.attributes.hp?.value > 0)) return false;
  const disp=t.document.disposition;
  return disp === CONST.TOKEN_DISPOSITIONS.FRIENDLY ||
    (t.actor.type === "character" && t.actor.hasPlayerOwner && disp !== CONST.TOKEN_DISPOSITIONS.HOSTILE);
}

export function selectTarget(source) {
  return canvas.tokens.placeables.filter(t=>targetable(source,t)).map(t=>({t,d:distance(source,t)}))
    .sort((a,b)=>a.d-b.d || a.t.id.localeCompare(b.t.id))[0]?.t;
}

export function reach({item,activity}) {
  const melee = isAttack(activity) && activity.attack.type.value === "melee";
  const weapon = item.type === "weapon" && !activity.range.override;
  const r = weapon ? item.system.range : activity.range;
  const unit = r?.units ?? "ft";
  const normal = melee && weapon ? (r?.reach ? sceneLength(r.reach,unit) : sceneLength(5))
    : unit === "touch" ? sceneLength(5) : sceneLength(r?.value,unit) || (melee ? sceneLength(5) : 0);
  return {normal, max:!melee && weapon ? Math.max(normal,sceneLength(r?.long,unit)) : normal, ranged:!melee};
}

export function attackModifiers(a,b,r,nearby) {
  const near = distance(a,b) <= sceneLength(5)+0.001;
  const prone = b.actor.statuses.has("prone");
  const advantage = hasAny(b.actor,["restrained","blinded","unconscious","paralyzed","stunned","petrified"]) || (near && prone);
  const disadvantage = isDodging(b.actor) || hasAny(a.actor,["restrained","prone","poisoned","blinded"]) || (!near && prone) ||
    distance(a,b) > r.normal+0.001 || (r.ranged && nearby.some(t=>targetable(a,t) && !incapacitated(t.actor) &&
    !t.actor.statuses.has("blinded") && distance(a,t)<=sceneLength(5)+0.001 && lineOpen(a,t)));
  return {advantage,disadvantage,closeCritical:near && hasAny(b.actor,["paralyzed","unconscious"])};
}

function speaker(t) {
  return ChatMessage.getSpeaker({actor:t.actor,token:t.document,scene:canvas.scene});
}

function msg(source,target) {
  const t=target.actor;
  return {data:{speaker:speaker(source), flags:{[ID]:{target:target.document.uuid},dnd5e:{targets:[
    {name:target.document.name,img:t.img,uuid:t.uuid,ac:t.system.attributes.ac.value}
  ]}}}};
}

function combineDamage(rolls) {
  const groups=new Map();
  for (const roll of rolls) {
    const type=roll.options.type, properties=[...(roll.options.properties ?? [])].sort();
    const key=JSON.stringify([type,properties]);
    if (!groups.has(key)) groups.set(key,{value:0,type,properties:new Set(properties)});
    groups.get(key).value+=roll.total;
  }
  return Array.from(groups.values(),g=>({...g,value:Math.max(0,g.value)}));
}

const quiet={configure:false};
export async function strike(source,target,entry,r,guard) {
  const {item,activity}=entry;
  if (!guard()) return false;
  if (item.type === "weapon" && item.system.quantity === 0) return true;
  const mode=item.system.attackModes?.find(m=>m.value)?.value;
  const choices=item.system.ammunitionOptions ?? [];
  const ammoId=choices.find(o=>o.value && source.actor.items.get(o.value)?.system.quantity > 0)?.value;
  if (choices.some(o=>o.value) && !ammoId) return true;
  const ammo=ammoId ? source.actor.items.get(ammoId) : undefined;
  if (game.modules.get("midi-qol")?.active && activity.midiProperties) {
    const midi = globalThis.MidiQOL;
    if (typeof midi?.completeActivityUse !== "function") throw Error("Midi-QOL 尚未提供活動執行介面。");
    const flags = isAttack(activity) ? attackModifiers(source,target,r,canvas.tokens.placeables) : {};
    const workflow = await midi.completeActivityUse(activity.uuid, {
      consume:{spellSlot:false},
      midiOptions:{
        targetUuids:[target.document.uuid], ignoreUserTargets:true,
        workflowOptions:{
          targetConfirmation:"none", autoRollAttack:true, autoRollDamage:"onHit",
          fastForwardAttack:true, fastForwardDamage:true, autoConsumeResource:"both",
          advantage:flags.advantage, disadvantage:flags.disadvantage
        }
      }
    }, {configure:false}, msg(source,target));
    if (!guard()) return false;
    if (!workflow || workflow.aborted) throw Error("Midi-QOL 的活動已取消或未完成，請檢查聊天卡。");
    return true;
  }
  const used=await activity.use({subsequentActions:false, create:false, consume:{spellSlot:false}},
    quiet, {create:false, ...msg(source,target)});
  if (!guard() || !targetable(source,target)) return false;
  if (!used) throw Error("系統取消了活動，請由 GM 接手此回合。");
  let critical=false, multiplier=1;
  if (isAttack(activity)) {
    const flags=attackModifiers(source,target,r,canvas.tokens.placeables);
    const ac=target.actor.system.attributes.ac.value;
    const rolls=await activity.rollAttack({advantage:flags.advantage,disadvantage:flags.disadvantage,
      target:ac, attackMode:mode, ammunition:ammoId ?? false},quiet,msg(source,target));
    if (!guard()) return false;
    if (!rolls?.length) throw Error("攻擊擲骰已取消。");
    const roll=rolls[0];
    if (roll.isFumble || (!roll.isCritical && roll.total<ac)) return true;
    critical=roll.isCritical || flags.closeCritical;
  } else {
    const ability=Array.from(activity.save.ability)[0], dc=activity.save.dc.value;
    const autoFail=["str","dex"].includes(ability) && hasAny(target.actor,["paralyzed","petrified","stunned","unconscious"]);
    if (!autoFail) {
      const saves=await target.actor.rollSavingThrow({ability,target:dc,disadvantage:ability==="dex" &&
        target.actor.statuses.has("restrained")},quiet,msg(target,target));
      if (!guard()) return false;
      if (!saves?.length) throw Error("豁免擲骰已取消。");
      if (saves[0].total>=dc) multiplier=({half:0.5,full:1,none:0})[activity.damage.onSave] ?? 0;
    }
  }
  if (!multiplier || !activity.damage?.parts?.length || !targetable(source,target)) return true;
  const damage=await activity.rollDamage({isCritical:critical,attackMode:mode,ammunition:ammo},quiet,msg(source,target));
  if (!guard()) return false;
  if (!damage?.length) throw Error("傷害擲骰已取消。");
  if (game.settings.get(ID,"applyDamage") && targetable(source,target)) {
    await target.actor.applyDamage(combineDamage(damage),{multiplier,isDelta:true});
  }
  return true;
}

