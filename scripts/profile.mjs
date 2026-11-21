export const ID = "minion-auto-combat";

export function marker(token) {
  return token?.actor?.effects.find(effect => effect.getFlag(ID, "token") === token.document.uuid);
}

export function enabled(token) {
  const effect = marker(token);
  return token?.actor?.type === "npc" && !!effect && effect.active && !effect.disabled;
}

export function available(actor) {
  const entries = [];
  for (const item of actor.items) {
    const spell = item.type === "spell";
    if (spell && item.system.level !== 0) continue;
    for (const activity of item.system.activities ?? []) {
      const save = spell && activity.type === "save" && activity.damage?.parts?.length;
      if (!(save || activity.type === "attack")) continue;
      if (activity.activation?.type && !["action", "attack"].includes(activity.activation.type)) continue;
      if (activity.target?.template?.type || activity.target?.affects?.type === "self") continue;
      if (activity.consumption?.targets?.some(t => t.type === "spellSlots")) continue;
      if (save && (activity.save?.ability?.size !== 1 || !Number.isFinite(activity.save.dc.value))) continue;
      entries.push({ key: item.id + "." + activity.id, item, activity });
    }
  }
  return entries;
}

const number = {a:1, an:1, one:1, two:2, three:3, four:4, five:5, six:6, 一:1, 兩:2, 二:2, 三:3, 四:4, 五:5, 六:6};
const countOf = s => number[s?.toLowerCase()] || Number(s) || 0;
const multiName = /multiattack|多重攻[擊击]|多段攻[擊击]/i;

function multiText(item, entries) {
  const box = document.createElement("template");
  // Detached plain-text parsing. Resolve system item links before removing markup.
  const html = item.system.description?.value ?? "";
  const byId = new Map(entries.map(e => [e.item.id, e.item.name]));
  const htmlText = html.replace(/@(?:UUID|Item)\[([^\]]+)\](?:\{([^}]+)\})?/gi,
    (_, path, label) => label || byId.get(path.split(".").pop()) || " ")
    .replace(/\[\[\/item\s+([^\]]+)\]\](?:\{([^}]+)\})?/gi, (_, raw, label) => {
      const ref = raw.trim().replace(/^["']|["']$/g, "");
      return label || byId.get(ref.split(".").pop()) || ref;
    });
  box.innerHTML = htmlText.replace(/<\/p>/gi, "。");
  return box.content.textContent.toLowerCase();
}

export function suggest(actor, entries) {
  if (!entries.length) return {steps: [], note: "沒有可用的攻擊活動或單體傷害戲法。"};
  const first = entries.find(e => e.item.type === "weapon") ?? entries[0];
  const multi = actor.items.find(i => multiName.test(i.system.identifier ?? "") || multiName.test(i.name));
  if (!multi) return {steps: [{key:first.key, count:1}], note:"預設使用第一個武器攻擊，沒有武器時使用第一個可用活動。"};
  const text = multiText(multi, entries);
  const words = "(one|two|three|four|five|six|an?\\b|[1-9]|[一兩二三四五六])";
  const hits = [];
  // Infer only explicit counts per named attack. Conditional alternatives need a GM choice.
  if (!/\bor\b|\breplace\b|\bin place of\b|或|取代|替[換换]/i.test(text)) {
    for (const entry of entries) {
      const name = entry.item.name.toLowerCase().replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, "\\$&");
      const patterns = [
        new RegExp(words + "\\s+(?:attacks?\\s+)?(?:with\\s+(?:its\\s+|the\\s+)?)?" + name + "(?=\\W|s\\b|$)", "gi"),
        new RegExp(words + "\\s*次\\s*(?:使用)?\\s*" + name, "gi"),
        new RegExp(name + "\\s*(?:攻擊)?\\s*" + words + "\\s*次", "gi")
      ];
      for (const re of patterns) {
        for (const m of text.matchAll(re)) hits.push({index:m.index, key:entry.key, count:countOf(m[1])});
      }
    }
    const total = text.match(new RegExp(words + "\\s+(?:melee\\s+|ranged\\s+|weapon\\s+)?attacks?\\b|" + words + "\\s*次攻[擊击]", "i"));
    const expected = total ? countOf(total[1] ?? total[2]) : 0;
    const sum = hits.reduce((a,b) => a+b.count,0);
    const allNamedAttacksCounted = entries.every(e => !text.includes(e.item.name.toLowerCase()) || hits.some(h => h.key === e.key));
    if (hits.length && allNamedAttacksCounted && (!expected || expected === sum) && new Set(hits.map(h=>h.index)).size === hits.length) {
      return {steps:hits.sort((a,b)=>a.index-b.index).map(({key,count})=>({key,count})),note:"已從多重攻擊描述讀出順序，可在下方調整。"};
    }
    if (expected && entries.length === 1 && !hits.length) {
      return {steps:[{key:first.key,count:expected}],note:"已從多重攻擊讀出次數，使用唯一的攻擊活動。"};
    }
  }
  return {steps:[], note:"這隻小怪有多重攻擊。請指定要執行的活動、次數與順序，再啟用效果。"};
}

export function profile(token) {
  const entries = available(token.actor);
  const saved = token.document.getFlag(ID, "sequence");
  const suggested = Array.isArray(saved) && saved.length ? {steps:saved, note:"使用這個 Token 儲存的順序。"} : suggest(token.actor, entries);
  const rows = suggested.steps.map(step => ({...step, entry:entries.find(e=>e.key === step.key)}));
  return { entries, rows, note:suggested.note, valid:rows.length > 0 && rows.every(row =>
    row.entry && Number.isInteger(row.count) && row.count >= 1 && row.count <= 20) };
}

export async function setEnabled(token, active) {
  const effect = marker(token);
  if (effect) {
    if (effect.disabled === active) await effect.update({disabled:!active});
  } else if (active) {
    await token.actor.createEmbeddedDocuments("ActiveEffect", [{
      name:"自動戰鬥 · " + token.document.name, img:"icons/svg/sword.svg", transfer:false,
      flags:{[ID]:{token:token.document.uuid}}
    }]);
  }
}

const esc = s => foundry.utils.escapeHTML(String(s));

export async function configure(token) {
  if (!game.user.isGM || token.actor?.type !== "npc") return;
  const {entries, rows, note} = profile(token);
  const options = key => entries.map(e => '<option value="' + esc(e.key) + '"' +
    (e.key === key ? ' selected' : '') + '>' + esc(e.item.name) + ' ／ ' + esc(e.activity.name || e.activity.type) + '</option>').join("");
  const row = (key="", count=1) => '<div class="flexrow" data-step><select aria-label="攻擊活動">' +
    (key && !entries.some(e=>e.key===key) ? '<option selected value="">原活動已移除，請重新指定</option>' : '') +
    options(key) + '</select><input type="number" aria-label="次數" min="1" max="20" required style="flex:0 0 4em" value="' +
    Number(count) + '"><button type="button" data-remove style="flex:0 0 2em" title="移除此列">×</button></div>';
  const content = '<label><input name="active" type="checkbox"' + (enabled(token) ? ' checked' : '') +
    '> 啟用此 Token 的自動戰鬥</label><p>' + esc(note) + '</p><fieldset><legend>由上往下執行 ／ 每列次數</legend><div data-rows>' +
    (rows.length ? rows.map(r=>row(r.key,r.count)).join("") : entries.length ? row() : '') +
    '</div><button type="button" data-add' + (!entries.length ? ' disabled' : '') + '>新增攻擊</button></fieldset>';
  const result = await foundry.applications.api.DialogV2.wait({
    window:{title: "小怪自動戰鬥 · " + token.document.name}, position:{width:490}, content,
    render: (_event, dlg) => {
      const el = dlg.element;
      el.querySelector("[data-add]").onclick = () => el.querySelector("[data-rows]").insertAdjacentHTML("beforeend",row());
      el.querySelector("[data-rows]").onclick = event => event.target.closest("[data-remove]")?.closest("[data-step]")?.remove();
    },
    buttons:[{action:"save", label:"儲存", default:true, callback:(_event, _button, dlg) => ({
      active:dlg.element.querySelector('[name="active"]').checked,
      steps:Array.from(dlg.element.querySelectorAll("[data-step]"), el=>({
        key:el.querySelector("select").value, count:el.querySelector("input").valueAsNumber
      }))
    })},{action:"cancel",label:"取消",callback:()=>false}]
  });
  if (!result) return;
  if (!result.active) await setEnabled(token,false);
  if ((result.active && !result.steps.length) || result.steps.some(s=>!entries.some(e=>e.key===s.key) || !Number.isInteger(s.count) || s.count < 1 || s.count > 20)) {
    return ui.notifications.warn("請為每列指定有效的活動和 1～20 次攻擊。");
  }
  await token.document.setFlag(ID,"sequence",result.steps);
  if (result.active) await setEnabled(token,true);
  canvas.tokens.hud.render({force:true});
}

export function renderHUD(hud, html) {
  const token = hud.object;
  if (!game.user.isGM || token?.actor?.type !== "npc" || html.querySelector("[data-minion-config]")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "control-icon" + (enabled(token) ? " active" : "");
  button.dataset.minionConfig = "";
  button.title = button.ariaLabel = "小怪自動戰鬥設定";
  button.innerHTML = '<i class="fa-solid fa-robot" inert></i>';
  button.onclick = event => {
    event.stopPropagation();
    configure(token).catch(err => {console.error(ID,err); ui.notifications.error("無法儲存小怪自動戰鬥設定。");});
  };
  html.querySelector(".col.left")?.append(button);
}

