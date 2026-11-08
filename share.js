// Keep the original iOS share-sheet workflow for one-touch Save Video / Save to Files.
// The file is built directly from the cleaner's Blob; no canvas, transcoding, or remux.
export async function shareWithFallback(output, navigatorApi, download, FileConstructor = File) {
  if (!output?.blob) return "no-output";
  const mime = output.blob.type || (output.name.toLowerCase().endsWith(".mp4") ? "video/mp4" : "video/quicktime");
  const sharedFile = new FileConstructor([output.blob], output.name, { type: mime });

  try {
    if (typeof navigatorApi.share === "function" && navigatorApi.canShare?.({ files: [sharedFile] })) {
      await navigatorApi.share({ files: [sharedFile], title: output.name });
      return "shared";
    }
  } catch (error) {
    if (error?.name === "AbortError") return "cancelled";
    // Some browsers reject file sharing; download the exact Blob instead.
  }
  download();
  return "download";
}
