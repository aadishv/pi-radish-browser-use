const tokenInput = document.querySelector("#bridge-token");
const status = document.querySelector("#status");

async function load() {
  const { bridgeToken } = await chrome.storage.local.get("bridgeToken");
  tokenInput.value = bridgeToken || "";
  const current = await chrome.runtime.sendMessage({ type: "status" });
  status.textContent = current?.connected ? "Connected" : "Disconnected";
}

document.querySelector("#save").addEventListener("click", async () => {
  await chrome.storage.local.set({ bridgeToken: tokenInput.value.trim() });
  status.textContent = "Reconnecting…";
  await chrome.runtime.sendMessage({ type: "reconnect" });
  setTimeout(load, 500);
});

load();
