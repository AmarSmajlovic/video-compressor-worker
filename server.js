const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const { createClient } = require("@supabase/supabase-js");
const { promises: fs } = require("fs");
const path = require("path");
const os = require("os");

const app = express();
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function updateQueueStatus(queueId, status, error) {
  await admin
    .from("video_compression_queue")
    .update({ status, ...(error ? { error } : {}), updated_at: new Date().toISOString() })
    .eq("id", queueId);
}

function logMemory(label) {
  const mem = process.memoryUsage();
  const totalMB = (mem.rss / 1024 / 1024).toFixed(1);
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
  console.log(`[MEM ${label}] RSS=${totalMB}MB, Heap=${heapMB}MB`);
}

function probeVideo(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata);
    });
  });
}

function compressVideo(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec("libx264")
      .audioCodec("aac")
      .audioBitrate("128k")
      .outputOptions([
        "-crf 28",
        "-preset veryfast",
        "-threads 1",
        "-movflags +faststart",
      ])
      .videoFilters([
        "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "format=yuv420p"
      ])
      .on("start", (cmd) => {
        console.log("[FFMPEG CMD]", cmd);
        logMemory("ffmpeg-start");
      })
      .on("progress", (p) => {
        logMemory(`progress-${p.percent?.toFixed(0) || '?'}%`);
      })
      .on("end", () => {
        logMemory("ffmpeg-done");
        resolve();
      })
      .on("error", reject)
      .save(outputPath);
  });
}

// ── Webhook endpoint ──────────────────────────────────────────────────────────

app.post("/compress", async (req, res) => {
  if (WEBHOOK_SECRET && req.headers["x-webhook-secret"] !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const record = req.body?.record ?? req.body;
  const queueId = record?.id;
  const mediaFileId = record?.media_file_id;
  const storagePath = record?.storage_path;

  if (!queueId || !mediaFileId || !storagePath) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Respond immediately so webhook doesn't timeout
  res.json({ ok: true, message: "Compression added to queue" });

  compressionQueue.push({ queueId, mediaFileId, storagePath });
  processQueue();
});

// ── Background Queue System ───────────────────────────────────────────────────

const compressionQueue = [];
let isProcessingQueue = false;

async function processQueue() {
  if (isProcessingQueue || compressionQueue.length === 0) return;
  isProcessingQueue = true;

  const { queueId, mediaFileId, storagePath } = compressionQueue.shift();

  try {
    await processVideoJob(queueId, mediaFileId, storagePath);
  } catch (err) {
    console.error(`[${queueId}] Unhandled queue error:`, err);
  } finally {
    isProcessingQueue = false;
    processQueue();
  }
}

async function processVideoJob(queueId, mediaFileId, storagePath) {
  const ext = path.extname(storagePath) || ".mp4";
  const inputPath = path.join("/app/data", `input_${queueId}${ext}`);
  const outputPath = path.join("/app/data", `output_${queueId}.mp4`);

  async function dbLog(msg) {
    console.log(`[${queueId}] ${msg}`);
    try {
      await admin.from("video_compression_queue").update({ error: `[PROGRESS] ${msg}` }).eq("id", queueId);
    } catch (e) {}
  }

  try {
    // Skip if already picked up
    const { data: queueRow } = await admin
      .from("video_compression_queue")
      .select("status")
      .eq("id", queueId)
      .single();

    if (queueRow?.status !== "pending") {
      console.log(`[${queueId}] Already processed, skipping`);
      return;
    }

    await updateQueueStatus(queueId, "processing");


    // 1. Stream download from expert-media directly to disk (avoids loading into memory)
    await dbLog(`Downloading ${storagePath}...`);
    const { data: signedData, error: signedError } = await admin.storage
      .from("expert-media")
      .createSignedUrl(storagePath, 300);

    if (signedError || !signedData?.signedUrl) {
      throw new Error(`Failed to get signed URL: ${signedError?.message}`);
    }

    const downloadRes = await fetch(signedData.signedUrl);
    if (!downloadRes.ok) throw new Error(`Download failed: ${downloadRes.status}`);

    const fileStream = require("fs").createWriteStream(inputPath);
    await new Promise((resolve, reject) => {
      const { Readable } = require("stream");
      Readable.fromWeb(downloadRes.body).pipe(fileStream)
        .on("finish", resolve)
        .on("error", reject);
    });
    await dbLog("Downloaded to disk");
    logMemory("after-download");

    // 2. Probe video to see what we're dealing with
    try {
      const probe = await probeVideo(inputPath);
      const vs = probe.streams?.find(s => s.codec_type === 'video');
      if (vs) {
        await dbLog(`Video: ${vs.width}x${vs.height}, codec=${vs.codec_name}, duration=${probe.format?.duration}s, size=${(probe.format?.size / 1024 / 1024).toFixed(1)}MB`);
      }
    } catch (e) {
      console.log("Probe failed:", e.message);
    }

    // 3. Compress
    await dbLog("Compressing...");
    await compressVideo(inputPath, outputPath);

    // 3. Get compressed file size (without loading into memory)
    const { size: compressedSize } = await fs.stat(outputPath);
    await dbLog(`Compressed to ${(compressedSize / 1024 / 1024).toFixed(1)} MB. Uploading...`);

    // 4. Replace original file in expert-media with compressed version (stream upload)
    const destPath = storagePath.replace(/\.[^.]+$/, ".mp4");
    const compressedStream = require("fs").createReadStream(outputPath);
    const { error: uploadError } = await admin.storage
      .from("expert-media")
      .upload(destPath, compressedStream, { contentType: "video/mp4", upsert: true, duplex: "half" });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    // 5. Update file_size in DB (storage_path stays the same if ext was already .mp4,
    //    or update it if the extension changed e.g. .mov → .mp4)
    await admin
      .from("media_files")
      .update({ file_size: compressedSize, storage_path: destPath })
      .eq("id", mediaFileId);

    await updateQueueStatus(queueId, "done", null); // Wipe progress logs on success

    // 6. If original was a different format, remove it
    if (destPath !== storagePath) {
      await admin.storage.from("expert-media").remove([storagePath]);
    }

    dbLog("Done");
  } catch (err) {
    console.error(`[${queueId}] Error:`, err.message);
    // Don't mark media as failed — it's still accessible as the raw upload
    await updateQueueStatus(queueId, "failed", err.message).catch(() => {});
  } finally {
    await Promise.allSettled([fs.unlink(inputPath), fs.unlink(outputPath)]);
  }
}

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Video compressor listening on :${PORT}`));
