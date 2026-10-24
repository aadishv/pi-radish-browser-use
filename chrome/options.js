const urlInput = document.querySelector("#bridge-url");
const tokenInput = document.querySelector("#bridge-token");
const status = document.querySelector("#status");

async function load() {
  const stored = await chrome.storage.local.get(["bridgeUrl", "bridgeToken"]);
  urlInput.value = stored.bridgeUrl || "ws://127.0.0.1:32123";
  tokenInput.value = stored.bridgeToken || "";
  const current = await chrome.runtime.sendMessage({ type: "status" });
  status.textContent = current?.connected ? "Connected" : "Disconnected";
}

document.querySelector("#save").addEventListener("click", async () => {
  const bridgeUrl = urlInput.value.trim();
  const bridgeToken = tokenInput.value.trim();
  try {
    const parsed = new URL(bridgeUrl);
    if (parsed.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(parsed.hostname)) {
      throw new Error("Use a ws:// loopback URL");
    }
    if (bridgeToken.length < 32) throw new Error("Pairing token is too short");
    await chrome.storage.local.set({ bridgeUrl, bridgeToken });
    status.textContent = "Reconnecting…";
    await chrome.runtime.sendMessage({ type: "reconnect" });
    setTimeout(load, 500);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
});

load();
