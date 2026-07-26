import { cleanVideo } from "./cleaner.js";

const input = document.querySelector("#file-input");
const dropZone = document.querySelector("#drop-zone");
const result = document.querySelector("#result");
const fileName = document.querySelector("#file-name");
const status = document.querySelector("#status");
const saveButton = document.querySelector("#save-button");
const message = document.querySelector("#message");

let output = null;

function setBusy(busy) {
  dropZone.disabled = busy;
  dropZone.querySelector(".drop-title").textContent = busy ? "Cleaning video…" : "Drop a video here";
  dropZone.querySelector(".drop-subtitle").textContent = busy
    ? "The file stays on this device"
    : "or choose a MOV or MP4 file";
}

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("is-error", isError);
}

async function handleFile(file) {
  result.hidden = true;
  output = null;
  showMessage("");
  setBusy(true);

  try {
    const cleaned = await cleanVideo(file);

    if (!cleaned.changed) {
      showMessage("No matching CapCut or ByteDance identifiers were found.");
      return;
    }

    output = cleaned;
    fileName.textContent = cleaned.name;
    status.textContent = "Media streams unchanged";
    result.hidden = false;
    showMessage("Ready to save.");
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "The video could not be cleaned.", true);
  } finally {
    setBusy(false);
    input.value = "";
  }
}

function downloadOutput() {
  const url = URL.createObjectURL(output.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = output.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function saveOutput() {
  if (!output) return;

  const sharedFile = new File([output.blob], output.name, {
    type: output.blob.type || "video/quicktime"
  });

  try {
    if (navigator.canShare?.({ files: [sharedFile] })) {
      await navigator.share({ files: [sharedFile] });
      return;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
  }

  downloadOutput();
}

dropZone.addEventListener("click", () => input.click());
input.addEventListener("change", () => {
  const [file] = input.files;
  if (file) handleFile(file);
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
}

dropZone.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;
  if (file) handleFile(file);
});

saveButton.addEventListener("click", saveOutput);
