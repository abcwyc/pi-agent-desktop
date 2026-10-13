const chinese = navigator.language.startsWith("zh");
const text = (en, zh) => chinese ? zh : en;
document.documentElement.lang = chinese ? "zh-CN" : "en";
for (const element of document.querySelectorAll("[data-en]")) element.textContent = element.dataset[chinese ? "zh" : "en"];
const form = document.querySelector("form");
const nameInput = document.querySelector("#name");
const urlInput = document.querySelector("#url");
const error = document.querySelector("#error");
const status = document.querySelector("#status");
const servers = document.querySelector("#servers");
const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
let busy = false;
function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll("button")) button.disabled = value || button.dataset.current === "true";
}
async function act(command, args) {
  if (busy) return;
  setBusy(true);
  error.textContent = "";
  status.textContent = "";
  try {
    const config = await invoke(command, args);
    if (command === "activate_backend") {
      status.textContent = text("Restarting…", "正在重启…");
      return;
    }
    render(config);
    if (command === "save_backend") {
      form.reset();
      status.textContent = text("Saved. Choose Connect to switch.", "已保存，点击连接即可切换。");
    }
  } catch (reason) {
    error.textContent = String(reason);
    if (command === "get_backends") {
      const recover = document.createElement("button");
      recover.textContent = text("Reset saved backends to local and restart", "重置已保存后端并切回本地");
      recover.addEventListener("click", () => act("activate_backend", { url: "" }));
      servers.replaceChildren(recover);
    }
  }
  setBusy(false);
}
function render(config) {
  servers.replaceChildren();
  for (const remote of [{ name: text("Local", "本地"), url: "" }, ...config.remotes]) {
    const row = document.createElement("div"); row.className = "server";
    const info = document.createElement("div"); info.className = "server-info";
    const title = document.createElement("strong"); title.textContent = remote.name;
    const detail = document.createElement("small"); detail.textContent = remote.url || text("Built-in backend", "内置后端");
    info.append(title, detail); row.append(info);
    const active = config.active === remote.url;
    const connect = document.createElement("button");
    connect.textContent = active ? text("Current", "当前连接") : text("Connect", "连接");
    connect.dataset.current = String(active);
    connect.disabled = active;
    connect.addEventListener("click", () => act("activate_backend", { url: remote.url }));
    row.append(connect);
    if (remote.url) {
      const edit = document.createElement("button"); edit.textContent = text("Edit", "编辑");
      edit.addEventListener("click", () => { nameInput.value = remote.name; urlInput.value = remote.url; nameInput.focus(); });
      row.append(edit);
      if (!active) {
        const remove = document.createElement("button"); remove.textContent = text("Remove", "移除");
        remove.addEventListener("click", () => act("remove_backend", { url: remote.url }));
        row.append(remove);
      }
    }
    servers.append(row);
  }
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void act("save_backend", { name: nameInput.value.trim(), url: urlInput.value.trim() });
});
void act("get_backends");
